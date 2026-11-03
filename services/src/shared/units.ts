/**
 * Fixed-point conversion between what Hyperliquid's API returns and what the database
 * stores.
 *
 * ## The two representations, and why they differ
 *
 * The **contracts** work in integers throughout: order `sz` and `limitPx` at 1e8, USDC at
 * 1e6, and the Core precompiles return `szi` already scaled by the asset's `szDecimals`.
 *
 * The **info API** returns decimal strings — `"0.03451"`, `"109342.0"`. They are exact
 * decimals, and the only safe way to read them is digit by digit. `parseFloat` on a
 * notional of 109342.5 * 3.45 is fine right up to the day it is not, and the failure is a
 * leaderboard that is wrong in the sixth decimal place and cannot be reconciled against
 * the chain.
 *
 * So: nothing here touches a float.
 *
 * ## The scales the database uses
 *
 * | Column | Scale |
 * |---|---|
 * | `hl_fills.size` | 1e8, signed |
 * | `hl_fills.price` | 1e8 |
 * | `hl_fills.notional`, `venue_fee`, `execution_fee`, `closed_pnl` | 1e6 (USDC) |
 *
 * Size and price at 1e8 to match the order encoding the contracts use, so a fill can be
 * compared against the `OrderPlaced` event that caused it without converting either.
 * Everything denominated in money at 1e6, because that is what USDC is and what the
 * vault's own accounting uses.
 */

export const SIZE_DECIMALS = 8;
export const PRICE_DECIMALS = 8;
export const USDC_DECIMALS = 6;

export const BPS = 10_000n;

/**
 * Parse a decimal string to a scaled integer, truncating toward zero.
 *
 * Truncation rather than rounding, and toward zero rather than down, so the error is
 * always *against* us and never against a trader: a fee reads very slightly low, a loss
 * reads very slightly small, and neither can be inflated by a cleverly chosen number of
 * decimal places. The lost magnitude is below 1e-6 USDC.
 *
 * Accepts `"-1.5"`, `"1"`, `".5"`, `"1."`, `"1e-3"` is **rejected** — the info API does
 * not return exponent notation and accepting it would mean guessing at a format we have
 * never seen.
 */
export function parseDecimal(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (!match || (match[2] === "" && (match[3] ?? "") === "")) {
    throw new Error(`not a plain decimal: ${JSON.stringify(value)}`);
  }

  const sign = match[1] === "-" ? -1n : 1n;
  const whole = match[2] === "" ? "0" : match[2]!;
  const fraction = match[3] ?? "";

  const padded = fraction.padEnd(decimals, "0").slice(0, decimals);
  return sign * (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded === "" ? "0" : padded));
}

/** Render a scaled integer as a decimal string. For logs and nothing else. */
export function formatScaled(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? "" : `.${digits.slice(digits.length - decimals)}`;
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/**
 * Notional in USDC (1e6) from a size at 1e8 and a price at 1e8.
 *
 * `1e8 * 1e8 / 1e10 = 1e6`. The same divisor the vault uses as `SZ_PX_TO_USDC`, and it
 * has to stay the same: the reservation a vault took at `placeOrder` and the notional
 * this computes from the resulting fill are compared against each other by the keeper.
 */
export function notionalUsdc(size: bigint, price: bigint): bigint {
  const magnitude = size < 0n ? -size : size;
  return (magnitude * price) / 10n ** 10n;
}

/**
 * Drawdown from the high-water mark, in bps. Mirrors `HighWaterMark.drawdownBps`.
 *
 * Duplicated from Solidity rather than read from the chain because the keeper has to
 * decide whether a vault is *near* its limit, which is not a question the contract
 * answers — it only acts at the breach. A test pins the two against each other.
 */
export function drawdownBps(equity: bigint, highWaterMark: bigint): bigint {
  if (highWaterMark === 0n || equity >= highWaterMark) return 0n;
  return ((highWaterMark - equity) * BPS) / highWaterMark;
}

/** Return in bps from `from` to `to`. Zero when there was nothing to start with. */
export function returnBps(from: bigint, to: bigint): bigint {
  if (from === 0n) return 0n;
  return ((to - from) * BPS) / from;
}
