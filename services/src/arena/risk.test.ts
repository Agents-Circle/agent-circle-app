import assert from "node:assert/strict";
import { test } from "node:test";

import type { Instrument } from "./market.ts";
import { checkOrder, type Order, type Reservation, type RiskState } from "./risk.ts";
import { SEASON_0, TIF } from "./rules.ts";

const usd = (whole: number) => BigInt(whole) * 1_000_000n;
const px = (whole: number) => BigInt(whole) * 100_000_000n;
const size = (value: number) => BigInt(Math.round(value * 1e8));

const BTC: Instrument = { coin: "BTC", asset: 0, szDecimals: 5 };
const ETH: Instrument = { coin: "ETH", asset: 1, szDecimals: 4 };
const instruments = new Map([
  [0, BTC],
  [1, ETH],
]);

function state(overrides: Partial<RiskState> = {}): RiskState {
  return {
    active: true,
    equity: usd(10_000),
    peak: usd(10_000),
    positions: new Map(),
    marks: new Map([
      [0, px(100_000)],
      [1, px(4_000)],
    ]),
    reservations: new Map(),
    ...overrides,
  };
}

function order(overrides: Partial<Order> = {}): Order {
  // 0.01 BTC at 100,000 is $1,000: inside a 12% cap on $10,000.
  return { asset: 0, isBuy: true, limitPx: px(100_000), sz: size(0.01), reduceOnly: false, tif: TIF.gtc, cloid: 1n, ...overrides };
}

test("an order inside every limit is accepted and reserves its worst-case cost", () => {
  const verdict = checkOrder(order(), state(), instruments, SEASON_0);
  assert.deepEqual(verdict, { ok: true, maxCost: usd(1_000) });
});

test("a paused entry places nothing", () => {
  assert.deepEqual(checkOrder(order(), state({ active: false }), instruments, SEASON_0), {
    ok: false,
    reason: "VaultNotActive",
  });
});

test("zero size, zero price and zero cloid are refused, as the contract refuses them", () => {
  for (const bad of [{ sz: 0n }, { limitPx: 0n }, { cloid: 0n }]) {
    assert.deepEqual(checkOrder(order(bad), state(), instruments, SEASON_0), { ok: false, reason: "ZeroAmount" });
  }
});

test("a cloid still holding a reservation cannot be reused", () => {
  const reservations = new Map<bigint, Reservation>([[1n, { asset: 0, maxCost: usd(100) }]]);
  assert.deepEqual(checkOrder(order(), state({ reservations }), instruments, SEASON_0), {
    ok: false,
    reason: "OrderAlreadyExists",
  });
});

test("an asset outside the season universe is not whitelisted", () => {
  assert.deepEqual(checkOrder(order({ asset: 7 }), state(), instruments, SEASON_0), {
    ok: false,
    reason: "VenueNotWhitelisted",
  });
});

test("the ninth open order is refused, and a filled order still counts until it is released", () => {
  const reservations = new Map<bigint, Reservation>();
  for (let i = 10n; i < 18n; i += 1n) reservations.set(i, { asset: 0, maxCost: 0n });
  assert.deepEqual(checkOrder(order(), state({ reservations }), instruments, SEASON_0), {
    ok: false,
    reason: "TooManyOpenOrders",
  });
});

test("an entry already past its drawdown limit is refused before the cap is measured", () => {
  // 15% below the peak is the limit itself, and the contract's comparison is >=.
  const verdict = checkOrder(order(), state({ equity: usd(8_500), peak: usd(10_000) }), instruments, SEASON_0);
  assert.deepEqual(verdict, { ok: false, reason: "DrawdownLimitBreached" });
});

test("an order that would take exposure over the cap is refused", () => {
  // $1,300 is 13% of $10,000.
  assert.deepEqual(checkOrder(order({ sz: size(0.013) }), state(), instruments, SEASON_0), {
    ok: false,
    reason: "PositionCapExceeded",
  });
});

test("exactly at the cap is allowed", () => {
  assert.equal(checkOrder(order({ sz: size(0.012) }), state(), instruments, SEASON_0).ok, true);
});

test("aggregate mode counts every position and every reservation, as the vault does", () => {
  // $800 of ETH held plus $300 reserved leaves room for $100, not $1,000.
  const positions = new Map([[1, size(0.2)]]);
  const reservations = new Map<bigint, Reservation>([[5n, { asset: 1, maxCost: usd(300) }]]);
  const s = state({ positions, reservations });
  assert.equal(checkOrder(order({ sz: size(0.001) }), s, instruments, SEASON_0).ok, true);
  assert.deepEqual(checkOrder(order({ sz: size(0.002) }), s, instruments, SEASON_0), {
    ok: false,
    reason: "PositionCapExceeded",
  });
});

test("per-position mode measures only the asset being ordered", () => {
  const positions = new Map([[1, size(0.2)]]);
  const rules = { ...SEASON_0, capMode: "per_position" as const };
  assert.equal(checkOrder(order({ sz: size(0.012) }), state({ positions }), instruments, rules).ok, true);
});

test("a short counts at its absolute value", () => {
  const positions = new Map([[0, -size(0.012)]]);
  assert.deepEqual(checkOrder(order({ sz: size(0.001) }), state({ positions }), instruments, SEASON_0), {
    ok: false,
    reason: "PositionCapExceeded",
  });
});

test("reduce-only skips the cap, so an entry over its cap can always get back under it", () => {
  const positions = new Map([[0, size(0.05)]]);
  const verdict = checkOrder(order({ isBuy: false, reduceOnly: true, sz: size(0.05) }), state({ positions }), instruments, SEASON_0);
  assert.deepEqual(verdict, { ok: true, maxCost: 0n });
});

test("a position with no mark price is not valued at zero; the order is refused", () => {
  const positions = new Map([[1, size(0.2)]]);
  const marks = new Map([[0, px(100_000)]]);
  assert.deepEqual(checkOrder(order(), state({ positions, marks }), instruments, SEASON_0), {
    ok: false,
    reason: "NoMarkPrice",
  });
});

test("prices and sizes HyperCore would silently drop are rejected loudly", () => {
  assert.deepEqual(checkOrder(order({ limitPx: 10_000_050_000_000n }), state(), instruments, SEASON_0), {
    ok: false,
    reason: "InvalidPrice",
  });
  assert.deepEqual(checkOrder(order({ sz: 1_500n }), state(), instruments, SEASON_0), {
    ok: false,
    reason: "InvalidSize",
  });
  assert.deepEqual(checkOrder(order({ tif: 4 as never }), state(), instruments, SEASON_0), {
    ok: false,
    reason: "InvalidTif",
  });
});
