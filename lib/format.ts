/**
 * Display formatting for on-chain values.
 *
 * Centralised because every one of these is a place to be subtly wrong in a way a trader
 * would never catch: a USDC amount shown with six decimals of precision it does not have,
 * a basis-point value rendered as a percentage without dividing, a bigint coerced through
 * `Number` and losing its tail. The vault's numbers are the product, so they get one
 * implementation each.
 */

const USDC_DECIMALS = 6n;
const USDC_UNIT = 10n ** USDC_DECIMALS;

/**
 * USDC (1e6) as a human string.
 *
 * Integer arithmetic throughout rather than `Number(value) / 1e6`. A uint64 of USDC can
 * exceed `Number.MAX_SAFE_INTEGER` at around 9 trillion units, which is only $9M — well
 * inside what a tier-3 builder may hold — so the naive conversion silently loses accuracy
 * at a balance the product expects to see.
 */
export function formatUsdc(value: bigint, fractionDigits = 2): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;

  const whole = abs / USDC_UNIT;
  const scale = 10n ** BigInt(fractionDigits);
  // Round half-up on the fractional part rather than truncating, so a balance of
  // 9.999 USDC does not display as 9.99 and read like a rounding error in our favour.
  const fraction = ((abs % USDC_UNIT) * scale + USDC_UNIT / 2n) / USDC_UNIT;

  const carried = fraction >= scale;
  const wholePart = carried ? whole + 1n : whole;
  const fractionPart = carried ? 0n : fraction;

  const grouped = wholePart.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = negative ? "-" : "";

  if (fractionDigits === 0) return `${sign}${grouped}`;
  return `${sign}${grouped}.${fractionPart.toString().padStart(fractionDigits, "0")}`;
}

/** Parse a user-typed USDC amount to 1e6 units. Returns null for anything unusable. */
export function parseUsdc(input: string): bigint | null {
  const trimmed = input.trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") return null;

  const [whole = "0", fraction = ""] = trimmed.split(".");
  // Truncated, not rounded. Rounding a deposit *up* would ask for more than the trader
  // typed; rounding down by a millionth of a dollar is invisible and safe.
  const padded = fraction.slice(0, Number(USDC_DECIMALS)).padEnd(Number(USDC_DECIMALS), "0");
  return BigInt(whole || "0") * USDC_UNIT + BigInt(padded || "0");
}

/** Basis points as a percentage string. 1_200 → "12%". */
export function formatBps(bps: number, fractionDigits = 0): string {
  return `${(bps / 100).toFixed(fractionDigits)}%`;
}

/** A short address for display. Never used where the full value matters. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
