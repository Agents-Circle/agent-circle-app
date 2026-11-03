import { BPS } from "../shared/units.ts";
import { toLots, type Book, type Instrument, type Trade } from "./market.ts";

/**
 * Fill simulation, conservative by design.
 *
 * Paper fills are the one place the Arena can flatter an agent, and every choice here is
 * made in the direction that cannot. The rules are published with the season, and they
 * are the whole of the simulation:
 *
 * - **Taking liquidity** walks the first book at or after the order's activation time, up
 *   to its limit, taking at most `depthShareBps` of the displayed size at each level. The
 *   book is not depleted for the next order, which is optimistic, and the season page
 *   says so.
 * - **Resting orders** fill only when a public trade prints *strictly through* their
 *   price, for at most `depthShareBps` of that print. A touch earns nothing and there is
 *   no queue credit, because a paper order is not in the real queue.
 * - Sizes are truncated to whole lots, never rounded up.
 *
 * Pure: a book or a trade in, sizes out. The engine owns the order state.
 */

export type Slice = { px: bigint; sz: bigint };

function shareOf(sz: bigint, depthShareBps: bigint, instrument: Instrument): bigint {
  return toLots(instrument, (sz * depthShareBps) / BPS);
}

/** Would this order take liquidity from this book right now? */
export function crosses(isBuy: boolean, limitPx: bigint, book: Book): boolean {
  const top = isBuy ? book.asks[0] : book.bids[0];
  if (!top) return false;
  return isBuy ? top.px <= limitPx : top.px >= limitPx;
}

export function takeFromBook(
  isBuy: boolean,
  limitPx: bigint,
  remaining: bigint,
  book: Book,
  instrument: Instrument,
  depthShareBps: bigint
): Slice[] {
  const slices: Slice[] = [];
  const levels = isBuy ? book.asks : book.bids;

  for (const level of levels) {
    if (remaining === 0n) break;
    if (isBuy ? level.px > limitPx : level.px < limitPx) break;

    const available = shareOf(level.sz, depthShareBps, instrument);
    const take = available < remaining ? available : remaining;
    if (take === 0n) continue;

    slices.push({ px: level.px, sz: take });
    remaining -= take;
  }

  return slices;
}

/**
 * How much of a resting order one public print fills. Zero unless the print went strictly
 * through the order's price, and always at the order's own price: a resting limit order
 * never gets price improvement.
 */
export function fillFromTrade(
  isBuy: boolean,
  limitPx: bigint,
  remaining: bigint,
  trade: Trade,
  instrument: Instrument,
  depthShareBps: bigint
): bigint {
  const through = isBuy ? trade.px < limitPx : trade.px > limitPx;
  if (!through) return 0n;

  const available = shareOf(trade.sz, depthShareBps, instrument);
  return available < remaining ? available : remaining;
}
