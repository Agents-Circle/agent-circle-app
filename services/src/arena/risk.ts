import { BPS, drawdownBps, notionalUsdc } from "../shared/units.ts";
import { priceIsValid, sizeIsValid, type Instrument } from "./market.ts";
import { TIF, type SeasonRules, type Tif } from "./rules.ts";

/**
 * The vault's six checks, run against a paper account before every order.
 *
 * A port of `HLAgentVault.placeOrder`, in the same order and with the same arithmetic, so
 * that an agent which never trips these on paper does not start tripping them in a vault.
 * The reasons are the contract's error names for the same reason: an agent's error
 * handling should not need rewriting between Season 0 and a live listing.
 *
 * Pure, like the keeper's policy, because this is the part a disputed result will be
 * argued over. It is tested without a feed, a clock or a database.
 */

/** Shaped like CoreWriter action 1, so agent code ports to vault mode unchanged. */
export type Order = {
  asset: number;
  isBuy: boolean;
  /** 1e8 */
  limitPx: bigint;
  /** 1e8, unsigned */
  sz: bigint;
  reduceOnly: boolean;
  tif: Tif;
  /** uint128, non-zero, unique per entry. */
  cloid: bigint;
};

export type Reservation = { asset: number; maxCost: bigint };

export type RiskState = {
  active: boolean;
  /** Net equity at current marks. USDC at 1e6. */
  equity: bigint;
  /** The drawdown high-water mark. */
  peak: bigint;
  /** Signed size at 1e8, by asset. */
  positions: ReadonlyMap<number, bigint>;
  /** Mark price at 1e8, by asset. */
  marks: ReadonlyMap<number, bigint>;
  /** Open orders, by cloid. */
  reservations: ReadonlyMap<bigint, Reservation>;
};

export type Rejection =
  | "VaultNotActive"
  | "ZeroAmount"
  | "OrderAlreadyExists"
  | "VenueNotWhitelisted"
  | "TooManyOpenOrders"
  | "DrawdownLimitBreached"
  | "PositionCapExceeded"
  // Paper-only. HyperCore would reject these silently; see `market.ts`.
  | "InvalidTif"
  | "InvalidPrice"
  | "InvalidSize"
  | "NoMarkPrice";

export type Verdict = { ok: true; maxCost: bigint } | { ok: false; reason: Rejection };

const UINT128_MAX = (1n << 128n) - 1n;

/** Every position at mark, unsigned, as `_positionValue` sums them. */
export function positionValue(positions: ReadonlyMap<number, bigint>, marks: ReadonlyMap<number, bigint>): bigint {
  let total = 0n;
  for (const [asset, size] of positions) {
    if (size === 0n) continue;
    total += notionalUsdc(size, marks.get(asset) ?? 0n);
  }
  return total;
}

export function reservedTotal(reservations: ReadonlyMap<bigint, Reservation>, asset?: number): bigint {
  let total = 0n;
  for (const reservation of reservations.values()) {
    if (asset === undefined || reservation.asset === asset) total += reservation.maxCost;
  }
  return total;
}

export function checkOrder(
  order: Order,
  state: RiskState,
  instruments: ReadonlyMap<number, Instrument>,
  rules: SeasonRules
): Verdict {
  // 1. Vault active. A paper entry that auto-paused stays paused for the season, as a
  //    vault stays paused until its trader resumes it.
  if (!state.active) return { ok: false, reason: "VaultNotActive" };

  if (order.sz === 0n || order.limitPx === 0n) return { ok: false, reason: "ZeroAmount" };
  if (order.cloid === 0n || order.cloid < 0n || order.cloid > UINT128_MAX) {
    return { ok: false, reason: "ZeroAmount" };
  }
  if (state.reservations.has(order.cloid)) return { ok: false, reason: "OrderAlreadyExists" };

  // 4. Asset whitelisted. The season universe plays the whitelist's part.
  const instrument = instruments.get(order.asset);
  if (!instrument) return { ok: false, reason: "VenueNotWhitelisted" };

  if (state.reservations.size >= rules.maxOpenOrders) return { ok: false, reason: "TooManyOpenOrders" };

  // 6, checked before 5 exactly as the contract does: an account already past its limit
  // is refused before its order is sized.
  if (drawdownBps(state.equity, state.peak) >= rules.maxDrawdownBps) {
    return { ok: false, reason: "DrawdownLimitBreached" };
  }

  if (order.tif !== TIF.alo && order.tif !== TIF.gtc && order.tif !== TIF.ioc) {
    return { ok: false, reason: "InvalidTif" };
  }
  if (!priceIsValid(instrument, order.limitPx)) return { ok: false, reason: "InvalidPrice" };
  if (!sizeIsValid(instrument, order.sz)) return { ok: false, reason: "InvalidSize" };

  // The same truncating division as the vault's `SZ_PX_TO_USDC`, so a paper reservation
  // and a vault reservation for the same order are the same number.
  const maxCost = notionalUsdc(order.sz, order.limitPx);

  // 5. Position cap. Reduce-only skips it: an account over its cap must never be blocked
  //    from getting back under it.
  if (order.reduceOnly) return { ok: true, maxCost: 0n };
  if (maxCost === 0n) return { ok: false, reason: "ZeroAmount" };

  // The cap is measured at mark, so an asset with no mark yet cannot be measured. Refusing
  // is the only answer that does not value an existing position at zero.
  for (const [asset, size] of state.positions) {
    if (size !== 0n && !state.marks.has(asset)) return { ok: false, reason: "NoMarkPrice" };
  }
  if (!state.marks.has(order.asset)) return { ok: false, reason: "NoMarkPrice" };

  let exposure: bigint;
  if (rules.capMode === "aggregate") {
    exposure = positionValue(state.positions, state.marks) + reservedTotal(state.reservations) + maxCost;
  } else {
    const size = state.positions.get(order.asset) ?? 0n;
    exposure =
      notionalUsdc(size, state.marks.get(order.asset)!) + reservedTotal(state.reservations, order.asset) + maxCost;
  }

  if (exposure * BPS > state.equity * rules.positionCapBps) return { ok: false, reason: "PositionCapExceeded" };

  return { ok: true, maxCost };
}
