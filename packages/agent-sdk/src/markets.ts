import { cloidHex } from "./units.ts";

/**
 * Hyperliquid's public info API: the market data an agent needs and the order status a
 * vault cannot see.
 *
 * ## Never hardcode an asset index
 *
 * A perp's asset index is its position in `meta.universe`, and it differs by network:
 * on testnet SOL is 0, BTC 3 and ETH 4; on mainnet BTC is 0. An index remembered from
 * one network sends the order to a different market on the other, and the contract
 * cannot tell — it checks that the index is whitelisted, not that it is the coin you
 * meant. So `market(coin)` reads it from `meta` every time a client starts.
 *
 * Read-only and keyless. Nothing here signs.
 */

export type Network = "mainnet" | "testnet";

export const HYPERLIQUID_API: Record<Network, string> = {
  mainnet: "https://api.hyperliquid.xyz",
  testnet: "https://api.hyperliquid-testnet.xyz",
};

export type Market = {
  coin: string;
  /** Perp asset index on this network. */
  asset: number;
  szDecimals: number;
  maxLeverage: number;
};

export type BookTop = {
  coin: string;
  timeMs: number;
  /** Decimal strings, exactly as Hyperliquid sends them. */
  bid: string;
  ask: string;
};

export type CoreOrder = { coin: string; side: "B" | "A"; limitPx: string; sz: string; origSz: string; oid: number; cloid?: string };

/**
 * HyperCore's answer to `orderStatus`. `status` is Hyperliquid's own word for the order:
 * `open`, `filled`, `canceled`, or one of its rejection reasons.
 */
export type CoreOrderStatus = { status: "unknownOid" } | { status: string; order: CoreOrder; statusTimestamp: number };

type MetaResponse = { universe: { name: string; szDecimals: number; maxLeverage: number; isDelisted?: boolean }[] };

export class InfoClient {
  readonly url: string;
  readonly #fetch: typeof fetch;

  constructor(options: { network: Network; url?: string; fetch?: typeof fetch }) {
    this.url = options.url ?? `${HYPERLIQUID_API[options.network]}/info`;
    this.#fetch = options.fetch ?? fetch;
  }

  async #post<T>(body: unknown): Promise<T> {
    const response = await this.#fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`info api ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return (await response.json()) as T;
  }

  /** Every perp on the first dex, with its index on this network. */
  async markets(): Promise<Market[]> {
    const meta = await this.#post<MetaResponse>({ type: "meta" });
    return meta.universe.map((u, asset) => ({ coin: u.name, asset, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage }));
  }

  async market(coin: string): Promise<Market> {
    const found = (await this.markets()).find((m) => m.coin === coin);
    if (!found) throw new Error(`${coin} is not a perp on ${this.url}`);
    return found;
  }

  async bookTop(coin: string): Promise<BookTop> {
    const book = await this.#post<{ coin: string; time: number; levels: [{ px: string }[], { px: string }[]] }>({ type: "l2Book", coin });
    const bid = book.levels[0][0]?.px;
    const ask = book.levels[1][0]?.px;
    if (bid === undefined || ask === undefined) throw new Error(`${coin} has an empty side`);
    return { coin, timeMs: book.time, bid, ask };
  }

  /** An order's state on HyperCore, looked up by the cloid the agent chose. */
  async orderStatus(user: `0x${string}`, cloid: bigint): Promise<CoreOrderStatus> {
    const answer = await this.#post<{ status: string; order?: { order: CoreOrder; status: string; statusTimestamp: number } }>({
      type: "orderStatus",
      user,
      oid: cloidHex(cloid),
    });
    if (answer.status !== "order" || !answer.order) return { status: "unknownOid" };
    return answer.order;
  }
}
