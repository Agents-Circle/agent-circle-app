import assert from "node:assert/strict";
import { test } from "node:test";

import type { RawFill } from "../shared/hyperliquid.ts";
import { fillRow, nextFillCursor } from "./fills.ts";

const VAULT = "0x3333333333333333333333333333333333333333" as const;
const ASSETS = new Map([
  ["BTC", 0],
  ["ETH", 1],
]);

function raw(overrides: Partial<RawFill> = {}): RawFill {
  return {
    coin: "BTC",
    px: "100000.0",
    sz: "0.5",
    side: "B",
    time: 1_762_000_000_000,
    startPosition: "0.0",
    dir: "Open Long",
    closedPnl: "0.0",
    hash: "0xhash",
    oid: 42,
    crossed: true,
    fee: "1.25",
    tid: 7,
    ...overrides,
  };
}

test("a buy is positive size, a sell is negative", () => {
  assert.equal(fillRow(raw({ side: "B" }), VAULT, ASSETS).size, "50000000");
  assert.equal(fillRow(raw({ side: "A" }), VAULT, ASSETS).size, "-50000000");
});

test("side B is a buy, which reads backwards and is worth a test on its own", () => {
  // "B" is bid and "A" is ask. Getting this inverted would flip every position in the
  // mirror while leaving every notional and fee correct, which is the hardest kind of
  // wrong to notice.
  assert.equal(fillRow(raw({ side: "B" }), VAULT, ASSETS).is_buy, true);
  assert.equal(fillRow(raw({ side: "A" }), VAULT, ASSETS).is_buy, false);
});

test("notional is the money, at 1e6, regardless of direction", () => {
  const buy = fillRow(raw({ side: "B" }), VAULT, ASSETS);
  const sell = fillRow(raw({ side: "A" }), VAULT, ASSETS);
  assert.equal(buy.notional, "50000000000"); // 0.5 * 100,000 = 50,000 USDC
  assert.equal(sell.notional, buy.notional);
});

test("the venue fee is stored apart from ours, and ours is zero here", () => {
  const row = fillRow(raw({ fee: "1.25" }), VAULT, ASSETS);
  assert.equal(row.venue_fee, "1250000");
  // Agent Circle's execution fee is not a per-fill quantity: the vault charges it at
  // reconcile on net size change, so a position opened and closed between two reconciles
  // is never billed. Apportioning it across fills would be inventing a number.
  assert.equal(row.execution_fee, "0");
});

test("a closed fill keeps its sign", () => {
  assert.equal(fillRow(raw({ closedPnl: "-12.5" }), VAULT, ASSETS).closed_pnl, "-12500000");
});

test("an unknown coin is an error, not asset zero", () => {
  assert.throws(
    () => fillRow(raw({ coin: "DOGE" }), VAULT, ASSETS),
    /unknown coin DOGE/
  );
});

test("the vault address is lowercased, because the schema requires it", () => {
  const row = fillRow(raw(), "0xABCDEF0123456789ABCDEF0123456789ABCDEF01", ASSETS);
  assert.equal(row.vault_address, "0xabcdef0123456789abcdef0123456789abcdef01");
});

test("the fill cursor stops at the newest fill, not past it", () => {
  // Fills share timestamps. Advancing to `time + 1` would drop every other fill in that
  // millisecond; the unique index makes re-reading them free.
  const fills = [raw({ time: 100 }), raw({ time: 300 }), raw({ time: 200 })];
  assert.equal(nextFillCursor(fills, 0), 300);
});

test("the fill cursor never moves backwards", () => {
  assert.equal(nextFillCursor([], 500), 500);
  assert.equal(nextFillCursor([raw({ time: 100 })], 500), 500);
});
