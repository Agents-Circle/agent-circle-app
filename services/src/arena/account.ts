import { BPS, PRICE_DECIMALS, SIZE_DECIMALS, USDC_DECIMALS, notionalUsdc } from "../shared/units.ts";
import { FUNDING_DECIMALS } from "./market.ts";
import type { SeasonRules } from "./rules.ts";

/**
 * A paper account: cash plus positions, and the fee and drawdown marks a vault keeps.
 *
 * Cash accounting rather than entry prices and realised PnL: buying spends cash, selling
 * raises it, and equity is cash plus every position at mark. Realised and unrealised PnL
 * then fall out of one subtraction and cannot drift apart, which is the property a
 * disputed score needs.
 *
 * All money at 1e6, sizes and prices at 1e8. Every division truncates toward zero, which
 * on a fee means slightly low and on a loss means slightly small: the error runs in the
 * entrant's favour, never against them, as it does everywhere else in `services/`.
 */

const PPM = 1_000_000n;
const SZ_PX_TO_USDC = 10n ** BigInt(SIZE_DECIMALS + PRICE_DECIMALS - USDC_DECIMALS);
const FUNDING_SCALE = SZ_PX_TO_USDC * 10n ** BigInt(FUNDING_DECIMALS);

export type Liquidity = "taker" | "maker";

export type Account = {
  cash: bigint;
  /** Signed size at 1e8, by asset. Zero entries are deleted, not kept. */
  positions: Map<number, bigint>;
  /** Performance-fee high-water mark. Fees are charged only on equity above it. */
  feeMark: bigint;
  /** Drawdown high-water mark: the highest equity seen at any minute mark. */
  peak: bigint;
  active: boolean;
  venueFees: bigint;
  executionFees: bigint;
  performanceFees: bigint;
  /** Net funding paid. Negative when the account has been paid funding. */
  fundingPaid: bigint;
  /** Unsigned notional of every fill, for turnover. */
  notionalTraded: bigint;
  lastAssessmentMs: number;
};

export function openAccount(rules: SeasonRules, startMs: number): Account {
  return {
    cash: rules.startingEquity,
    positions: new Map(),
    feeMark: rules.startingEquity,
    peak: rules.startingEquity,
    active: true,
    venueFees: 0n,
    executionFees: 0n,
    performanceFees: 0n,
    fundingPaid: 0n,
    notionalTraded: 0n,
    lastAssessmentMs: startMs,
  };
}

/** Signed mark-to-market value of one position: negative for a short. */
export function signedValue(size: bigint, px: bigint): bigint {
  return (size * px) / SZ_PX_TO_USDC;
}

export function equity(account: Account, marks: ReadonlyMap<number, bigint>): bigint {
  let total = account.cash;
  for (const [asset, size] of account.positions) {
    total += signedValue(size, marks.get(asset) ?? 0n);
  }
  return total;
}

export type FillCharges = { notional: bigint; venueFee: bigint; executionFee: bigint };

export function applyFill(
  account: Account,
  fill: { asset: number; isBuy: boolean; px: bigint; sz: bigint; liquidity: Liquidity },
  rules: SeasonRules
): FillCharges {
  const signed = fill.isBuy ? fill.sz : -fill.sz;
  const notional = notionalUsdc(fill.sz, fill.px);

  // Both fees on every fill: Hyperliquid's, at tier 0, and ours, as the vault would bill
  // it at `reconcile`. Net-of-fee is the only return the Arena ranks on.
  const venueFee = (notional * (fill.liquidity === "taker" ? rules.takerFeePpm : rules.makerFeePpm)) / PPM;
  const executionFee = (notional * rules.executionFeePpm) / PPM;

  account.cash -= signedValue(signed, fill.px) + venueFee + executionFee;
  account.venueFees += venueFee;
  account.executionFees += executionFee;
  account.notionalTraded += notional;

  const next = (account.positions.get(fill.asset) ?? 0n) + signed;
  if (next === 0n) account.positions.delete(fill.asset);
  else account.positions.set(fill.asset, next);

  return { notional, venueFee, executionFee };
}

/**
 * One hourly funding payment: `size × oracle price × rate`, longs paying shorts when the
 * rate is positive, which is Hyperliquid's own formula.
 */
export function applyFunding(account: Account, asset: number, oraclePx: bigint, fundingRate: bigint): bigint {
  const size = account.positions.get(asset) ?? 0n;
  if (size === 0n) return 0n;

  const payment = (size * oraclePx * fundingRate) / FUNDING_SCALE;
  account.cash -= payment;
  account.fundingPaid += payment;
  return payment;
}

/**
 * The weekly performance-fee assessment, as `HighWaterMark` does it: a share of equity
 * above the mark, and the mark raised to what is left after the fee.
 *
 * Without the mark an agent earns on every up-swing and returns nothing on the
 * down-swings, and a strategy that only produces variance gets paid for it.
 */
export function assessPerformanceFee(account: Account, currentEquity: bigint, rules: SeasonRules, nowMs: number): bigint {
  account.lastAssessmentMs = nowMs;
  const gain = currentEquity - account.feeMark;
  if (gain <= 0n) return 0n;

  const fee = (gain * rules.performanceFeeBps) / BPS;
  account.cash -= fee;
  account.performanceFees += fee;
  account.feeMark = currentEquity - fee;
  return fee;
}

export function totalFees(account: Account): bigint {
  return account.venueFees + account.executionFees + account.performanceFees;
}
