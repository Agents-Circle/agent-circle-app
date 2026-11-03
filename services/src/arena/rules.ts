import { BPS } from "../shared/units.ts";

/**
 * The rules of a paper season, as data.
 *
 * ## Why every number lives here and nowhere else
 *
 * A season's rules are published before registration opens and must not change while it
 * runs. A constant buried in the fill simulator is a rule nobody can find, and a rule that
 * changes because somebody deployed is a competition that can be relitigated. So the
 * engine takes one of these at construction and never reads a number from anywhere else,
 * and `rulesDigest` gives the published page something to print beside the formula.
 *
 * ## Why the vault's numbers, not friendlier ones
 *
 * Season 0 exists to recruit builders whose agents will later run in real vaults. An agent
 * tuned against looser limits than the vault enforces learns the wrong thing, so the cap,
 * the drawdown limit, the open-order bound and the order lifetime are the contract's own
 * (`params/parameters.json`, `Constants.sol`). Returns look small under a 12% cap. The
 * copy must not apologise for that: it is the product.
 *
 * ## Units
 *
 * Money at 1e6 (USDC), size and price at 1e8, as everywhere in `services/`. Fee *rates*
 * are in parts per million, because Hyperliquid's taker fee is 4.5 bps and a rate in whole
 * bps cannot say that.
 */

/** CoreWriter action 1 time-in-force codes (`HLConstants.LIMIT_ORDER_TIF_*`). */
export const TIF = { alo: 1, gtc: 2, ioc: 3 } as const;
export type Tif = (typeof TIF)[keyof typeof TIF];

/**
 * How the position cap is measured.
 *
 * - `aggregate` is what `HLAgentVault._requireWithinPositionCap` does today: every tracked
 *   position at mark, plus every reservation, against `equity × cap`.
 * - `per_position` is what `params/parameters.json` describes: "Per position, against
 *   total vault value".
 *
 * The two disagree, and which one is intended is an open decision that belongs to the
 * protocol, not to the Arena. The engine follows the contract until that is settled,
 * because the contract is what an agent will eventually be held to.
 */
export type CapMode = "aggregate" | "per_position";

export type SeasonRules = {
  /** Every entry starts with the same paper balance. USDC at 1e6. */
  startingEquity: bigint;

  /**
   * An order takes effect at `receivedAt + activationDelayMs`, against the first book at
   * or after that instant. Approximates CoreWriter's "a few seconds" between a vault's
   * `placeOrder` and the order reaching the book. The exact figure is unverified on
   * mainnet, so it is published rather than claimed.
   */
  activationDelayMs: number;

  /** At most this share of displayed size per level (taker) or per print (maker). */
  depthShareBps: bigint;

  /** Hyperliquid tier 0. */
  takerFeePpm: bigint;
  makerFeePpm: bigint;

  /** Agent Circle's execution fee on notional: 2 bps in `params/parameters.json`. */
  executionFeePpm: bigint;

  /** On profit above the fee high-water mark, assessed every `assessmentIntervalMs`. */
  performanceFeeBps: bigint;
  assessmentIntervalMs: number;

  positionCapBps: bigint;
  capMode: CapMode;
  maxDrawdownBps: bigint;
  maxOpenOrders: number;
  orderLifetimeMs: number;

  /** A book older than this is not traded against; orders on that asset wait. */
  staleBookMs: number;

  /** λ in `S = R − λ·MDD`, in bps of 1. */
  drawdownWeightBps: bigint;

  /** Prize eligibility: fills on at least this many distinct UTC days... */
  minActiveDays: number;
  /** ...and a position or resting order in at least this share of minute marks. */
  minPresenceBps: bigint;
};

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export const SEASON_0: SeasonRules = {
  startingEquity: 10_000_000_000n,
  activationDelayMs: 2_000,
  depthShareBps: 2_500n,
  takerFeePpm: 450n,
  makerFeePpm: 150n,
  executionFeePpm: 200n,
  performanceFeeBps: 1_000n,
  assessmentIntervalMs: 7 * DAY_MS,
  positionCapBps: 1_200n,
  capMode: "aggregate",
  maxDrawdownBps: 1_500n,
  maxOpenOrders: 8,
  orderLifetimeMs: HOUR_MS,
  staleBookMs: 10_000,
  drawdownWeightBps: BPS,
  minActiveDays: 10,
  minPresenceBps: 2_000n,
};

/**
 * A canonical rendering of the rules, for hashing onto the season page.
 *
 * Keys sorted and bigints as strings, so the same rules always produce the same bytes and
 * a changed rule always produces different ones.
 */
export function canonicalRules(rules: SeasonRules): string {
  const entries = Object.entries(rules).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(
    Object.fromEntries(entries.map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value]))
  );
}
