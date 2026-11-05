import { encodeOrder, type OrderRequest } from "./orders.ts";
import { fromE8 } from "./units.ts";

/**
 * A client for the Circle Arena order API: Season 0, paper trading.
 *
 * **Paper trading. Simulated fills on live Hyperliquid prices. No funds at risk. Not an
 * on-chain track record.** Anything that shows results from this client must carry that
 * label (`plans/arena-season0.md` §4).
 *
 *     POST   /v1/orders          { asset, isBuy, limitPx, sz, reduceOnly?, tif, cloid }
 *     DELETE /v1/orders/:cloid
 *     GET    /v1/account
 *     GET    /v1/health          (no key)
 *
 * The API is shaped like `HLAgentVault`, not like Hyperliquid's exchange endpoint, and so
 * is this client: `placeOrder` takes the same `OrderRequest` a `VaultClient` does.
 *
 * ## What the verdict means
 *
 * `accepted` is the engine's immediate answer — the order passed the vault's checks and
 * holds a reservation. It is not a fill. The order activates `activationDelayMs` later
 * (2 s in Season 0, standing in for CoreWriter's delay) against the next book, and fills
 * show up in `account()` and in later responses' events.
 *
 * As in a vault, a filled order keeps its open-order slot and cap headroom until it is
 * cancelled or expires (one hour). **Cancel what you are done with**, or the eighth
 * resting order is the last one you can place.
 *
 * ## Retries
 *
 * A 429 is retried: refused requests never reach the season's input log, so a retry
 * cannot place an order twice. Nothing else is retried. A 5xx after a `POST` may or may
 * not have been logged; re-sending the same cloid is safe (it is refused as
 * `OrderAlreadyExists` if the first one landed), re-sending with a new one is not.
 */

export type PaperEvent = { kind: string; atMs: number; cloid?: string; reason?: string; [field: string]: unknown };

export type PaperVerdict = {
  accepted: boolean;
  cloid: bigint;
  /** The engine's rejection, e.g. `PositionCapExceeded`, `InvalidPrice`, `OrderNotFound`. */
  reason?: string;
  /** Everything the engine produced for this cloid in the same step, fills included. */
  events: PaperEvent[];
};

export type PaperAccount = {
  entryId: string;
  active: boolean;
  /** USDC at 1e6, marked to the latest mark price. */
  equity: bigint;
  cash: bigint;
  peak: bigint;
  drawdownBps: bigint;
  /** `size` at 1e8, signed: positive is long. `markPx` at 1e8, null before the first mark. */
  positions: { asset: number; size: bigint; markPx: bigint | null }[];
  /** Every order still holding a reservation, filled or not. */
  orders: {
    cloid: bigint;
    asset: number;
    isBuy: boolean;
    limitPx: bigint;
    sz: bigint;
    remaining: bigint;
    state: "pending" | "resting" | "done";
    maxCost: bigint;
    expiresAtMs: number;
  }[];
  fees: { venue: bigint; execution: bigint; performance: bigint };
  fundingPaid: bigint;
};

export class ArenaApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(`arena ${status}: ${message}`);
    this.status = status;
  }
}

export type PaperClientOptions = {
  /** e.g. `http://127.0.0.1:8787`. No trailing `/v1`. */
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  /** How many times to retry a 429. Default 3. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
};

type RawAccount = {
  entryId: string;
  active: boolean;
  equity: string;
  cash: string;
  peak: string;
  drawdownBps: string;
  positions: { asset: number; size: string; markPx: string | null }[];
  orders: {
    cloid: string;
    asset: number;
    isBuy: boolean;
    limitPx: string;
    sz: string;
    remaining: string;
    state: "pending" | "resting" | "done";
    maxCost: string;
    expiresAtMs: number;
  }[];
  fees: { venue: string; execution: string; performance: string };
  fundingPaid: string;
};

export class PaperClient {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #retries: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: PaperClientOptions) {
    if (options.apiKey === "") throw new Error("an Arena API key is required");
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
    this.#retries = options.retries ?? 3;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async #call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const json: unknown = await response.json().catch(() => null);
      if (response.status === 429 && attempt < this.#retries) {
        // The limit is 20 requests per 10 s per entry.
        await this.#sleep(2_500 * 2 ** attempt);
        continue;
      }
      if (response.status === 200 || response.status === 422) return { status: response.status, json };
      const message = (json as { error?: string } | null)?.error ?? response.statusText;
      throw new ArenaApiError(response.status, message);
    }
  }

  async health(): Promise<{ ok: boolean; nowMs: number }> {
    const response = await this.#fetch(`${this.#baseUrl}/v1/health`);
    if (!response.ok) throw new ArenaApiError(response.status, response.statusText);
    return (await response.json()) as { ok: boolean; nowMs: number };
  }

  /** Validates and normalises the order exactly as a vault would, then submits it. */
  async placeOrder(order: OrderRequest): Promise<PaperVerdict> {
    const encoded = encodeOrder(order);
    const { status, json } = await this.#call("POST", "/v1/orders", {
      asset: encoded.asset,
      isBuy: encoded.isBuy,
      limitPx: fromE8(encoded.limitPx),
      sz: fromE8(encoded.sz),
      reduceOnly: encoded.reduceOnly,
      tif: order.tif,
      cloid: encoded.cloid.toString(),
    });
    return verdict(status, encoded.cloid, json);
  }

  async cancelOrder(cloid: bigint): Promise<PaperVerdict> {
    const { status, json } = await this.#call("DELETE", `/v1/orders/${cloid.toString()}`);
    return verdict(status, cloid, json);
  }

  /** Cancel every order still holding a reservation. Returns the cloids it cancelled. */
  async cancelAll(): Promise<bigint[]> {
    const cancelled: bigint[] = [];
    for (const order of (await this.account()).orders) {
      if ((await this.cancelOrder(order.cloid)).accepted) cancelled.push(order.cloid);
    }
    return cancelled;
  }

  async account(): Promise<PaperAccount> {
    const { json } = await this.#call("GET", "/v1/account");
    return parseAccount(json as RawAccount);
  }
}

function verdict(status: number, cloid: bigint, json: unknown): PaperVerdict {
  const events = ((json as { events?: PaperEvent[] } | null)?.events ?? []) as PaperEvent[];
  const rejected = events.find((e) => e.kind === "rejected");
  return {
    accepted: status === 200,
    cloid,
    ...(rejected?.reason === undefined ? {} : { reason: rejected.reason }),
    events,
  };
}

function parseAccount(raw: RawAccount): PaperAccount {
  return {
    entryId: raw.entryId,
    active: raw.active,
    equity: BigInt(raw.equity),
    cash: BigInt(raw.cash),
    peak: BigInt(raw.peak),
    drawdownBps: BigInt(raw.drawdownBps),
    positions: raw.positions.map((p) => ({ asset: p.asset, size: BigInt(p.size), markPx: p.markPx === null ? null : BigInt(p.markPx) })),
    orders: raw.orders.map((o) => ({
      cloid: BigInt(o.cloid),
      asset: o.asset,
      isBuy: o.isBuy,
      limitPx: BigInt(o.limitPx),
      sz: BigInt(o.sz),
      remaining: BigInt(o.remaining),
      state: o.state,
      maxCost: BigInt(o.maxCost),
      expiresAtMs: o.expiresAtMs,
    })),
    fees: { venue: BigInt(raw.fees.venue), execution: BigInt(raw.fees.execution), performance: BigInt(raw.fees.performance) },
    fundingPaid: BigInt(raw.fundingPaid),
  };
}
