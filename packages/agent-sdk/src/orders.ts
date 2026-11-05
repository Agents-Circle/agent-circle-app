import { assertCloid, newCloid, toE8 } from "./units.ts";

/**
 * One order, in the shape `HLAgentVault.placeOrder` takes.
 *
 * The same object goes to the Arena's paper API and to a vault, which is the point: an
 * agent that trades Season 0 is rehearsing the exact call it will make on a real vault.
 * Prices and sizes are decimal strings; see `units.ts` for why.
 */
export type Tif = "alo" | "gtc" | "ioc";

export type OrderRequest = {
  /** Perp asset index on the network being traded. Read it from `meta`; see `markets.ts`. */
  asset: number;
  isBuy: boolean;
  limitPx: string;
  sz: string;
  reduceOnly?: boolean;
  tif: Tif;
  /** Generated when omitted. Keep it: a cancel is by cloid. */
  cloid?: bigint;
};

/** CoreWriter action 1 time-in-force codes (`HLConstants.LIMIT_ORDER_TIF_*`). */
export const TIF_CODE = { alo: 1, gtc: 2, ioc: 3 } as const;

/** An order with its cloid fixed and its numbers at 1e8: exactly what a vault is sent. */
export type EncodedOrder = {
  asset: number;
  isBuy: boolean;
  limitPx: bigint;
  sz: bigint;
  reduceOnly: boolean;
  tif: (typeof TIF_CODE)[Tif];
  cloid: bigint;
};

export function encodeOrder(order: OrderRequest): EncodedOrder {
  if (!Number.isInteger(order.asset) || order.asset < 0 || order.asset > 0xffff_ffff) {
    throw new RangeError("asset must be a uint32");
  }
  if (!Object.hasOwn(TIF_CODE, order.tif)) throw new RangeError("tif must be one of alo, gtc, ioc");
  const cloid = order.cloid ?? newCloid();
  assertCloid(cloid);
  const limitPx = toE8(order.limitPx, "limitPx");
  const sz = toE8(order.sz, "sz");
  // uint64 on the contract. A real price or size is nowhere near, but the encoder would
  // throw a less readable error than this.
  if (limitPx >= 1n << 64n || sz >= 1n << 64n) throw new RangeError("limitPx and sz must fit a uint64 at 1e8");
  return { asset: order.asset, isBuy: order.isBuy, limitPx, sz, reduceOnly: order.reduceOnly ?? false, tif: TIF_CODE[order.tif], cloid };
}
