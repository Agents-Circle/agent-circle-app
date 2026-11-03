import { PRICE_DECIMALS, SIZE_DECIMALS, parseDecimal } from "../shared/units.ts";

/**
 * Market data as the engine sees it: Hyperliquid's public feed, parsed once into integers.
 *
 * Everything the Arena knows about prices comes through here, from the info API's
 * WebSocket (`l2Book`, `trades`, `activeAssetCtx`), which needs no key. Parsed with
 * `parseDecimal` like every other number in `services/`, so a recorded message replays to
 * exactly the same integers on any machine.
 */

export type Level = {
  /** 1e8 */
  px: bigint;
  /** 1e8, unsigned */
  sz: bigint;
};

export type Book = {
  coin: string;
  timeMs: number;
  /** Best first: bids descending, asks ascending, as the API sends them. */
  bids: Level[];
  asks: Level[];
};

export type Trade = {
  coin: string;
  timeMs: number;
  px: bigint;
  sz: bigint;
  /** The aggressor. `B` bought, lifting an ask; `A` sold, hitting a bid. */
  side: "B" | "A";
  tid: number;
};

export type AssetContext = {
  coin: string;
  timeMs: number;
  markPx: bigint;
  oraclePx: bigint;
  /** Hourly funding rate at 1e12, signed. Positive means longs pay shorts. */
  fundingRate: bigint;
};

/** One perp the season trades, frozen at season start. */
export type Instrument = {
  coin: string;
  /** Perp asset index: the position in `meta.universe`. */
  asset: number;
  szDecimals: number;
};

export const FUNDING_DECIMALS = 12;

/**
 * Hyperliquid allows perp prices at most `6 − szDecimals` decimal places and five
 * significant figures, except that an integer price is always valid. Size must be a whole
 * number of lots of `10^−szDecimals`.
 *
 * On HyperCore an order that breaks either rule is rejected — and from a vault, through
 * CoreWriter, that rejection is silent: the vault sees an order it placed and never sees
 * it fill. The Arena rejects it loudly instead, because teaching an agent that lesson on
 * paper is cheaper than teaching it with a reservation stuck until expiry.
 */
const PERP_MAX_DECIMALS = 6;
const MAX_SIGNIFICANT_FIGURES = 5;

export function lotSize(instrument: Instrument): bigint {
  return 10n ** BigInt(SIZE_DECIMALS - instrument.szDecimals);
}

export function sizeIsValid(instrument: Instrument, sz: bigint): boolean {
  return sz > 0n && sz % lotSize(instrument) === 0n;
}

export function priceIsValid(instrument: Instrument, px: bigint): boolean {
  if (px <= 0n) return false;

  const scale = 10n ** BigInt(PRICE_DECIMALS);
  if (px % scale === 0n) return true;

  const allowedDecimals = Math.max(0, PERP_MAX_DECIMALS - instrument.szDecimals);
  const step = 10n ** BigInt(PRICE_DECIMALS - allowedDecimals);
  if (px % step !== 0n) return false;

  // Significant figures of the decimal, ignoring trailing zeros of the 1e8 scaling.
  let digits = px.toString();
  digits = digits.replace(/0+$/, "");
  return digits.length <= MAX_SIGNIFICANT_FIGURES;
}

/** Truncate a size down to whole lots. Never rounds up: a fill is never larger than asked. */
export function toLots(instrument: Instrument, sz: bigint): bigint {
  const lot = lotSize(instrument);
  return (sz / lot) * lot;
}

export function midPx(book: Book): bigint | null {
  const bid = book.bids[0];
  const ask = book.asks[0];
  if (!bid || !ask) return null;
  return (bid.px + ask.px) / 2n;
}

// ───────────────────────────────────────────────────────── parsing

type RawLevel = { px: string; sz: string; n?: number };

export function parseBook(data: { coin: string; time: number; levels: [RawLevel[], RawLevel[]] }): Book {
  const level = (raw: RawLevel): Level => ({
    px: parseDecimal(raw.px, PRICE_DECIMALS),
    sz: parseDecimal(raw.sz, SIZE_DECIMALS),
  });
  return {
    coin: data.coin,
    timeMs: data.time,
    bids: data.levels[0].map(level),
    asks: data.levels[1].map(level),
  };
}

export function parseTrade(raw: { coin: string; side: string; px: string; sz: string; time: number; tid: number }): Trade {
  if (raw.side !== "B" && raw.side !== "A") throw new Error(`unknown trade side ${raw.side}`);
  return {
    coin: raw.coin,
    timeMs: raw.time,
    px: parseDecimal(raw.px, PRICE_DECIMALS),
    sz: parseDecimal(raw.sz, SIZE_DECIMALS),
    side: raw.side,
    tid: raw.tid,
  };
}

/**
 * `activeAssetCtx` carries no timestamp of its own, so the receive time is stamped on by
 * the recorder and passed in here. That is the time the engine acted on it, which is the
 * one that matters for replay.
 */
export function parseAssetContext(
  raw: { coin: string; ctx: { markPx: string; oraclePx: string; funding: string } },
  timeMs: number
): AssetContext {
  return {
    coin: raw.coin,
    timeMs,
    markPx: parseDecimal(raw.ctx.markPx, PRICE_DECIMALS),
    oraclePx: parseDecimal(raw.ctx.oraclePx, PRICE_DECIMALS),
    fundingRate: parseDecimal(raw.ctx.funding, FUNDING_DECIMALS),
  };
}
