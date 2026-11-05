/**
 * Prices, sizes and cloids, without a float anywhere.
 *
 * ## One scale for both venues
 *
 * `HLAgentVault.placeOrder` takes `limitPx` and `sz` as integers scaled by 1e8, which is
 * what CoreWriter's limit-order action carries. The Arena's order API takes the same two
 * numbers as decimal strings ("65000.5", "0.01") and parses them to the same 1e8
 * integers. So an order in this SDK is written once, as decimal strings, and each client
 * converts it the same way: exactly, or not at all.
 *
 * ## Why refuse rather than round
 *
 * A price with more than eight decimal places cannot be represented, and silently
 * truncating it changes the order the agent meant to send. The Arena refuses those with a
 * 400; `toE8` refuses them before they leave the process. Rounding is something an agent
 * asks for, through `roundPrice` and `roundSize`, with the direction stated.
 *
 * ## Hyperliquid's tick rules
 *
 * A perp price may have at most five significant figures and at most `6 − szDecimals`
 * decimal places, and an integer price is always valid. A size must be a whole number of
 * lots of `10^−szDecimals`. HyperCore rejects anything else — and through CoreWriter the
 * rejection is **silent**: the vault records an order, reserves cap headroom for it, and
 * never sees it reach the book. The Arena rejects the same orders loudly
 * (`InvalidPrice`, `InvalidSize`). Round with these helpers and neither happens.
 */

export const DECIMALS = 8;
const SCALE = 10n ** BigInt(DECIMALS);

const PERP_MAX_DECIMALS = 6;
const MAX_SIGNIFICANT_FIGURES = 5;
const MAX_UINT128 = (1n << 128n) - 1n;

/** A positive decimal string to an integer at 1e8. Throws rather than truncate. */
export function toE8(value: string, name = "value"): bigint {
  if (typeof value !== "string" || !/^[0-9]+(\.[0-9]+)?$/.test(value)) {
    throw new RangeError(`${name} must be a positive decimal string, got ${JSON.stringify(value)}`);
  }
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > DECIMALS) {
    throw new RangeError(`${name} has more than ${DECIMALS} decimal places: ${value}`);
  }
  const scaled = BigInt(whole!) * SCALE + BigInt(fraction.padEnd(DECIMALS, "0"));
  if (scaled <= 0n) throw new RangeError(`${name} must be greater than zero`);
  return scaled;
}

/** An integer at 1e8 to the shortest decimal string that says the same thing. */
export function fromE8(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / SCALE;
  const fraction = (abs % SCALE).toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction === "" ? "" : `.${fraction}`}`;
}

/** Round toward the passive side: down for a bid, up for an ask. */
export type Rounding = "down" | "up";

function roundTo(value: bigint, step: bigint, mode: Rounding): bigint {
  const floor = (value / step) * step;
  return mode === "up" && floor !== value ? floor + step : floor;
}

/** The number of decimal places a price near `pxE8` may carry. */
function priceDecimals(pxE8: bigint, szDecimals: number): number {
  const digits = pxE8.toString().length;
  const integerDigits = Math.max(0, digits - DECIMALS);
  const bySignificance =
    integerDigits >= MAX_SIGNIFICANT_FIGURES
      ? 0
      : integerDigits > 0
        ? MAX_SIGNIFICANT_FIGURES - integerDigits
        : DECIMALS - digits + MAX_SIGNIFICANT_FIGURES;
  return Math.max(0, Math.min(bySignificance, PERP_MAX_DECIMALS - szDecimals));
}

/** Whether HyperCore (and the Arena) would accept this perp price. Mirrors `market.ts`. */
export function priceIsValid(pxE8: bigint, szDecimals: number): boolean {
  if (pxE8 <= 0n) return false;
  if (pxE8 % SCALE === 0n) return true;
  const allowed = Math.max(0, PERP_MAX_DECIMALS - szDecimals);
  if (pxE8 % 10n ** BigInt(DECIMALS - allowed) !== 0n) return false;
  return pxE8.toString().replace(/0+$/, "").length <= MAX_SIGNIFICANT_FIGURES;
}

/** Whether `szE8` is a whole, non-zero number of lots. */
export function sizeIsValid(szE8: bigint, szDecimals: number): boolean {
  return szE8 > 0n && szE8 % 10n ** BigInt(DECIMALS - szDecimals) === 0n;
}

/**
 * The nearest valid perp price on the stated side of `px`.
 *
 * `"down"` for a bid and `"up"` for an ask keep a quote passive: rounding never moves it
 * toward the other side of the book.
 */
export function roundPrice(px: string | bigint, szDecimals: number, mode: Rounding): string {
  const pxE8 = typeof px === "bigint" ? px : toE8(px, "price");
  if (pxE8 <= 0n) throw new RangeError("price must be greater than zero");
  let rounded = roundTo(pxE8, 10n ** BigInt(DECIMALS - priceDecimals(pxE8, szDecimals)), mode);
  // Rounding up can carry into a new digit (99999.5 → 100000), which only ever relaxes
  // the rule; rounding down can reach zero for a price below one tick.
  if (rounded <= 0n || !priceIsValid(rounded, szDecimals)) {
    rounded = roundTo(rounded, 10n ** BigInt(DECIMALS - priceDecimals(rounded, szDecimals)), mode);
  }
  if (rounded <= 0n) throw new RangeError(`price ${fromE8(pxE8)} rounds to zero`);
  return fromE8(rounded);
}

/** `sz` truncated to whole lots. Never rounds up: an order is never larger than asked. */
export function roundSize(sz: string | bigint, szDecimals: number): string {
  const szE8 = typeof sz === "bigint" ? sz : toE8(sz, "size");
  const lot = 10n ** BigInt(DECIMALS - szDecimals);
  const rounded = (szE8 / lot) * lot;
  if (rounded <= 0n) throw new RangeError(`size ${fromE8(szE8)} is below one lot (${fromE8(lot)})`);
  return fromE8(rounded);
}

/**
 * The smallest valid size whose notional at `px` is at least `notionalUsd`.
 *
 * Hyperliquid refuses orders under $10 of notional, so an agent sizing by dollars wants
 * the size rounded *up* to a lot, not down.
 */
export function sizeForNotional(notionalUsd: string, px: string, szDecimals: number): string {
  const notional = toE8(notionalUsd, "notional");
  const pxE8 = toE8(px, "price");
  const lot = 10n ** BigInt(DECIMALS - szDecimals);
  const raw = (notional * SCALE + pxE8 - 1n) / pxE8;
  return fromE8(roundTo(raw, lot, "up"));
}

/** Worst-case USDC (1e6) if the order fills completely: the vault's `maxCost`. */
export function maxCostUsdc(limitPxE8: bigint, szE8: bigint): bigint {
  return (limitPxE8 * szE8) / 10n ** 10n;
}

/** A random client order id: non-zero, below 2^128, as both venues require. */
export function newCloid(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const cloid = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  return cloid === 0n ? newCloid() : cloid;
}

/** Hyperliquid's wire form for a cloid: `0x` and exactly 32 hex digits. */
export function cloidHex(cloid: bigint): `0x${string}` {
  assertCloid(cloid);
  return `0x${cloid.toString(16).padStart(32, "0")}`;
}

export function assertCloid(cloid: bigint): void {
  if (cloid <= 0n || cloid > MAX_UINT128) throw new RangeError("cloid must be non-zero and below 2^128");
}
