import assert from "node:assert/strict";
import { test } from "node:test";

import { applyFill, applyFunding, assessPerformanceFee, equity, openAccount } from "./account.ts";
import { crosses, fillFromTrade, takeFromBook } from "./fills.ts";
import type { Book, Instrument } from "./market.ts";
import { SEASON_0 } from "./rules.ts";

const usd = (whole: number) => BigInt(whole) * 1_000_000n;
const px = (whole: number) => BigInt(whole) * 100_000_000n;
const size = (value: number) => BigInt(Math.round(value * 1e8));
const BTC: Instrument = { coin: "BTC", asset: 0, szDecimals: 5 };

const book: Book = {
  coin: "BTC",
  timeMs: 0,
  bids: [
    { px: px(99_990), sz: size(1) },
    { px: px(99_980), sz: size(2) },
  ],
  asks: [
    { px: px(100_010), sz: size(0.04) },
    { px: px(100_020), sz: size(2) },
  ],
};

test("a taker walks the book to its limit, at most a quarter of each level", () => {
  const slices = takeFromBook(true, px(100_020), size(0.5), book, BTC, SEASON_0.depthShareBps);
  assert.deepEqual(slices, [
    { px: px(100_010), sz: size(0.01) },
    { px: px(100_020), sz: size(0.49) },
  ]);
});

test("a taker stops at its limit price", () => {
  const slices = takeFromBook(true, px(100_010), size(0.5), book, BTC, SEASON_0.depthShareBps);
  assert.deepEqual(slices, [{ px: px(100_010), sz: size(0.01) }]);
});

test("depth shares are truncated to whole lots, never rounded up", () => {
  const thin: Book = { ...book, asks: [{ px: px(100_010), sz: 3_000n }] };
  // A quarter of three lots is 750 units, which is zero whole lots.
  assert.deepEqual(takeFromBook(true, px(100_010), size(1), thin, BTC, SEASON_0.depthShareBps), []);
});

test("crossing is judged against the top of the opposite side", () => {
  assert.equal(crosses(true, px(100_010), book), true);
  assert.equal(crosses(true, px(100_000), book), false);
  assert.equal(crosses(false, px(99_990), book), true);
});

test("a resting order fills only on a print strictly through its price", () => {
  const at = { coin: "BTC", timeMs: 0, px: px(99_000), sz: size(1), side: "A" as const, tid: 1 };
  assert.equal(fillFromTrade(true, px(99_000), size(1), at, BTC, SEASON_0.depthShareBps), 0n);
  const through = { ...at, px: px(98_999) };
  assert.equal(fillFromTrade(true, px(99_000), size(1), through, BTC, SEASON_0.depthShareBps), size(0.25));
});

test("a round trip at the same price loses exactly the fees", () => {
  const account = openAccount(SEASON_0, 0);
  applyFill(account, { asset: 0, isBuy: true, px: px(100_000), sz: size(0.01), liquidity: "taker" }, SEASON_0);
  applyFill(account, { asset: 0, isBuy: false, px: px(100_000), sz: size(0.01), liquidity: "maker" }, SEASON_0);

  // $1,000 each way: 4.5 bps + 2 bps taker, 1.5 bps + 2 bps maker = $1.00 in total.
  assert.equal(account.positions.size, 0);
  assert.equal(account.cash, usd(10_000) - usd(1));
  assert.equal(account.venueFees, 600_000n);
  assert.equal(account.executionFees, 400_000n);
  assert.equal(account.notionalTraded, usd(2_000));
});

test("equity is cash plus every position at mark, shorts included", () => {
  const account = openAccount(SEASON_0, 0);
  applyFill(account, { asset: 0, isBuy: false, px: px(100_000), sz: size(0.01), liquidity: "maker" }, SEASON_0);
  const fees = account.venueFees + account.executionFees;
  // The short gains $10 when the price falls 1%.
  assert.equal(equity(account, new Map([[0, px(99_000)]])), usd(10_000) + usd(10) - fees);
});

test("positive funding is paid by longs and received by shorts", () => {
  const long = openAccount(SEASON_0, 0);
  long.positions.set(0, size(0.1));
  // 0.0001 per hour on $10,000 of notional is $1.
  assert.equal(applyFunding(long, 0, px(100_000), 100_000_000n), usd(1));
  assert.equal(long.cash, usd(9_999));

  const short = openAccount(SEASON_0, 0);
  short.positions.set(0, -size(0.1));
  assert.equal(applyFunding(short, 0, px(100_000), 100_000_000n), -usd(1));
});

test("the performance fee is charged only above the mark, and the mark moves to what is left", () => {
  const account = openAccount(SEASON_0, 0);
  assert.equal(assessPerformanceFee(account, usd(9_000), SEASON_0, 1), 0n);
  assert.equal(account.feeMark, usd(10_000));

  // A recovery to the mark earns nothing: recovering a loss is not profit.
  assert.equal(assessPerformanceFee(account, usd(10_000), SEASON_0, 2), 0n);

  assert.equal(assessPerformanceFee(account, usd(11_000), SEASON_0, 3), usd(100));
  assert.equal(account.feeMark, usd(10_900));
  assert.equal(account.performanceFees, usd(100));
});
