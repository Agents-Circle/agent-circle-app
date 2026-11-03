import type { Logger } from "./log.ts";

/**
 * Hyperliquid info-API client.
 *
 * ## Why this exists at all, given the precompiles
 *
 * The vault's own view of itself comes from HyperCore precompiles and is authoritative for
 * *state*: equity, position size, mark price. What the precompiles do not give is
 * *history* — there is no precompile that enumerates fills. The execution fee, the net
 * return and every ranking the product makes are history, so they come from here.
 *
 * Which means the leaderboard depends on an off-chain API. That is worth being plain
 * about: the claim is not "no server is involved", it is "every number traces to a fill
 * that Hyperliquid itself reports and anyone can re-fetch". The fills are stored with
 * their order ids so a third party can do exactly that.
 */

const MAX_ATTEMPTS = 4;

export type RawFill = {
  coin: string;
  px: string;
  sz: string;
  side: "A" | "B";
  time: number;
  startPosition: string;
  dir: string;
  closedPnl: string;
  hash: string;
  oid: number;
  crossed: boolean;
  fee: string;
  tid: number;
  cloid?: string | null;
  feeToken?: string;
};

export type AssetPosition = {
  position: {
    coin: string;
    szi: string;
    entryPx?: string;
    positionValue: string;
    unrealizedPnl: string;
    liquidationPx?: string | null;
  };
  type: string;
};

export type ClearinghouseState = {
  assetPositions: AssetPosition[];
  marginSummary: {
    accountValue: string;
    totalNtlPos: string;
    totalRawUsd: string;
    totalMarginUsed: string;
  };
  withdrawable: string;
  time: number;
};

export type PerpMeta = {
  universe: { name: string; szDecimals: number; maxLeverage: number }[];
};

export class InfoApi {
  readonly #url: string;
  readonly #log: Logger;

  constructor(url: string, log: Logger) {
    this.#url = url;
    this.#log = log;
  }

  /**
   * One POST, retried on transport failure and on 429/5xx with exponential backoff.
   *
   * A 429 is retried rather than dropped because the alternative is a gap in the fill
   * history, and a gap in the fill history is a wrong number on a leaderboard that nobody
   * notices. Better to be slow.
   */
  async #post<T>(body: unknown): Promise<T> {
    let delay = 500;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(this.#url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (cause) {
        if (attempt === MAX_ATTEMPTS) throw cause;
        this.#log.warn("info api transport error, retrying", { attempt, delay });
        await sleep(delay);
        delay *= 2;
        continue;
      }

      if (response.ok) return (await response.json()) as T;

      const retryable = response.status === 429 || response.status >= 500;
      const text = await response.text().catch(() => "");

      if (!retryable || attempt === MAX_ATTEMPTS) {
        throw new Error(`info api ${response.status}: ${text.slice(0, 200)}`);
      }

      this.#log.warn("info api retrying", { status: response.status, attempt, delay });
      await sleep(delay);
      delay *= 2;
    }

    throw new Error("unreachable");
  }

  async perpMeta(): Promise<PerpMeta> {
    return this.#post<PerpMeta>({ type: "meta" });
  }

  /**
   * Fills in `[startTime, endTime]`, inclusive, oldest first.
   *
   * Paginated by time rather than by cursor and capped at 2000 per response, so a window
   * that returns exactly 2000 is assumed truncated and is walked forward from the last
   * fill's timestamp. Fills share timestamps, so the walk re-requests from the same
   * millisecond rather than the next one and relies on the unique index to discard the
   * duplicates — overlap is cheap, a missing fill is not.
   */
  async userFills(user: string, startTime: number, endTime: number): Promise<RawFill[]> {
    const all: RawFill[] = [];
    let from = startTime;

    for (let page = 0; page < 50; page += 1) {
      const batch = await this.#post<RawFill[]>({
        type: "userFillsByTime",
        user,
        startTime: from,
        endTime,
      });

      all.push(...batch);
      if (batch.length < 2000) return all;

      const last = batch[batch.length - 1]!;
      if (last.time === from) {
        // 2000 fills inside one millisecond. Not a case we can page past, and pretending
        // otherwise would loop forever.
        this.#log.warn("fill page did not advance", { user, from });
        return all;
      }
      from = last.time;
    }

    this.#log.warn("fill pagination hit the page cap", { user, startTime, endTime });
    return all;
  }

  async clearinghouseState(user: string): Promise<ClearinghouseState> {
    return this.#post<ClearinghouseState>({ type: "clearinghouseState", user });
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `coin` name to perp asset index.
 *
 * The index **is** the position in `universe` — that is the whole mapping, and it is not
 * documented anywhere as a guarantee. Built fresh at start-up rather than cached to disk:
 * a new perp listing shifts nothing, but a stale map that silently assigns BTC's fills to
 * another asset would be undetectable in the data.
 */
export function assetIndexByCoin(meta: PerpMeta): Map<string, number> {
  const map = new Map<string, number>();
  meta.universe.forEach((asset, index) => map.set(asset.name, index));
  return map;
}
