import assert from "node:assert/strict";
import { test } from "node:test";

import { ArenaEngine, type InputEvent, type OutputEvent } from "./engine.ts";
import type { Book, Instrument } from "./market.ts";
import type { Order } from "./risk.ts";
import { SEASON_0, TIF, type SeasonRules } from "./rules.ts";
import { score } from "./scoring.ts";

const px = (whole: number) => BigInt(whole) * 100_000_000n;
const size = (value: number) => BigInt(Math.round(value * 1e8));
const usd = (whole: number) => BigInt(whole) * 1_000_000n;

const T0 = Date.UTC(2026, 10, 10);
const BTC: Instrument = { coin: "BTC", asset: 0, szDecimals: 5 };

function book(atMs: number, bid: number, ask: number, depth = 2): InputEvent {
  const b: Book = {
    coin: "BTC",
    timeMs: atMs,
    bids: [{ px: px(bid), sz: size(depth) }],
    asks: [{ px: px(ask), sz: size(depth) }],
  };
  return { kind: "book", atMs, book: b };
}

function mark(atMs: number, price: number): InputEvent {
  return {
    kind: "ctx",
    atMs,
    ctx: { coin: "BTC", timeMs: atMs, markPx: px(price), oraclePx: px(price), fundingRate: 0n },
  };
}

function order(overrides: Partial<Order> = {}): Order {
  return { asset: 0, isBuy: true, limitPx: px(100_010), sz: size(0.01), reduceOnly: false, tif: TIF.gtc, cloid: 1n, ...overrides };
}

function run(events: InputEvent[], rules: SeasonRules = SEASON_0) {
  const out: OutputEvent[] = [];
  const engine = new ArenaEngine({ rules, instruments: [BTC], startMs: T0, emit: (event) => out.push(event) });
  for (const event of events) engine.handle(event);
  return { engine, out, of: <K extends OutputEvent["kind"]>(kind: K) => out.filter((e) => e.kind === kind) as Extract<OutputEvent, { kind: K }>[] };
}

const opening: InputEvent[] = [
  { kind: "register", atMs: T0 - 1_000, entryId: "e1" },
  mark(T0, 100_000),
  book(T0, 99_990, 100_010),
];

test("an order waits out the activation delay, then takes from the first book after it", () => {
  const { of } = run([
    ...opening,
    { kind: "submit", atMs: T0 + 1_000, entryId: "e1", order: order() },
    book(T0 + 2_500, 99_990, 100_010),
    book(T0 + 3_000, 99_990, 100_010),
  ]);

  assert.equal(of("accepted")[0]!.activatesAtMs, T0 + 3_000);
  const fills = of("fill");
  assert.equal(fills.length, 1);
  assert.equal(fills[0]!.atMs, T0 + 3_000);
  assert.equal(fills[0]!.px, px(100_010));
  assert.equal(fills[0]!.liquidity, "taker");
  assert.deepEqual(of("order_done").map((e) => e.why), ["filled"]);
});

test("a filled order keeps its reservation until it is cancelled, as in a vault", () => {
  const { engine, of } = run([
    ...opening,
    { kind: "submit", atMs: T0 + 1_000, entryId: "e1", order: order() },
    book(T0 + 3_000, 99_990, 100_010),
  ]);
  assert.equal(of("released").length, 0);
  assert.equal(engine.snapshot("e1")!.orders[0]!.state, "done");

  engine.handle({ kind: "cancel", atMs: T0 + 4_000, entryId: "e1", cloid: 1n });
  assert.equal(engine.snapshot("e1")!.orders.length, 0);
});

test("an IOC takes what the depth cap allows and drops the rest", () => {
  const { of } = run([
    ...opening,
    // 0.02 displayed, a quarter of it is 0.005.
    { kind: "submit", atMs: T0 + 1_000, entryId: "e1", order: order({ tif: TIF.ioc, sz: size(0.008) }) },
    book(T0 + 3_000, 99_990, 100_010, 0.02),
  ]);
  assert.equal(of("fill")[0]!.sz, size(0.005));
  assert.deepEqual(of("order_done").map((e) => e.why), ["ioc_remainder"]);
});

test("a post-only order that would cross is rejected by the venue, not filled", () => {
  const { of } = run([
    ...opening,
    { kind: "submit", atMs: T0 + 1_000, entryId: "e1", order: order({ tif: TIF.alo }) },
    book(T0 + 3_000, 99_990, 100_010),
  ]);
  assert.equal(of("fill").length, 0);
  assert.deepEqual(of("order_done").map((e) => e.why), ["alo_would_cross"]);
});

test("a resting bid fills as maker on a print through it, at its own price", () => {
  const { of } = run([
    ...opening,
    { kind: "submit", atMs: T0 + 1_000, entryId: "e1", order: order({ limitPx: px(99_950) }) },
    book(T0 + 3_000, 99_990, 100_010),
    { kind: "trade", atMs: T0 + 4_000, trade: { coin: "BTC", timeMs: T0 + 4_000, px: px(99_950), sz: size(1), side: "A", tid: 1 } },
    { kind: "trade", atMs: T0 + 5_000, trade: { coin: "BTC", timeMs: T0 + 5_000, px: px(99_940), sz: size(1), side: "A", tid: 2 } },
  ]);
  const fills = of("fill");
  assert.equal(fills.length, 1, "a touch at the limit earns nothing");
  assert.equal(fills[0]!.px, px(99_950));
  assert.equal(fills[0]!.liquidity, "maker");
});

test("reduce-only is clamped to the open position", () => {
  const { engine, of } = run([
    ...opening,
    { kind: "submit", atMs: T0 + 1_000, entryId: "e1", order: order() },
    book(T0 + 3_000, 99_990, 100_010),
    { kind: "submit", atMs: T0 + 4_000, entryId: "e1", order: order({ cloid: 2n, isBuy: false, limitPx: px(99_990), sz: size(0.05), reduceOnly: true, tif: TIF.ioc }) },
    book(T0 + 6_000, 99_990, 100_010),
  ]);
  assert.equal(of("fill")[1]!.sz, size(0.01));
  assert.equal(engine.snapshot("e1")!.positions.length, 0);
});

test("an unfilled order expires after an hour and frees its slot", () => {
  const { engine, of } = run([
    ...opening,
    { kind: "submit", atMs: T0 + 1_000, entryId: "e1", order: order({ limitPx: px(90_000) }) },
    book(T0 + 3_000, 99_990, 100_010),
    { kind: "clock", atMs: T0 + 1_000 + 3_600_000 },
  ]);
  assert.equal(of("released").length, 0, "at the expiry instant it is still live");

  engine.handle({ kind: "clock", atMs: T0 + 1_001 + 3_600_000 });
  assert.deepEqual(of("released").map((e) => e.why), ["expired"]);
  assert.equal(engine.snapshot("e1")!.orders.length, 0);
});

test("a drawdown breach pauses the entry, releases its orders and exits through the book", () => {
  // A 0.3% limit, because under a 12% aggregate cap a long cannot lose 15% of equity: the
  // whole position going to zero costs 12%. Worth knowing when the cap reading is decided.
  const rules = { ...SEASON_0, maxDrawdownBps: 30n };
  const { engine, of } = run(
    [
      ...opening,
      { kind: "submit", atMs: T0 + 1_000, entryId: "e1", order: order({ sz: size(0.005) }) },
      book(T0 + 3_000, 99_990, 100_010),
      { kind: "submit", atMs: T0 + 4_000, entryId: "e1", order: order({ cloid: 2n, limitPx: px(80_000), sz: size(0.001) }) },
      book(T0 + 5_000, 99_990, 100_010),
      mark(T0 + 30_000, 90_000),
      { kind: "clock", atMs: T0 + 60_000 },
      book(T0 + 62_000, 89_990, 90_010),
      { kind: "submit", atMs: T0 + 63_000, entryId: "e1", order: order({ cloid: 3n }) },
    ],
    rules
  );

  assert.equal(of("auto_paused").length, 1);
  assert.deepEqual(
    of("released").map((e) => e.why),
    ["paused", "paused"]
  );
  const exit = of("fill").at(-1)!;
  assert.equal(exit.cloid, 0n);
  assert.equal(exit.isBuy, false);
  assert.equal(engine.snapshot("e1")!.positions.length, 0);
  assert.equal(of("rejected").at(-1)!.reason, "VaultNotActive");
});

test("funding is paid on the hour, by the side the rate says", () => {
  const { of } = run([
    ...opening,
    { kind: "submit", atMs: T0 + 1_000, entryId: "e1", order: order() },
    book(T0 + 3_000, 99_990, 100_010),
    { kind: "ctx", atMs: T0 + 10_000, ctx: { coin: "BTC", timeMs: T0 + 10_000, markPx: px(100_000), oraclePx: px(100_000), fundingRate: 100_000_000n } },
    { kind: "clock", atMs: T0 + 3_600_000 },
  ]);
  // 0.0001 on $1,000 is $0.10.
  assert.deepEqual(
    of("funding").map((e) => e.payment),
    [100_000n]
  );
});

test("orders outside the season, and from unknown entries, are refused", () => {
  const { of } = run([
    { kind: "register", atMs: T0 - 2_000, entryId: "e1" },
    { kind: "submit", atMs: T0 - 1_000, entryId: "e1", order: order() },
    { kind: "submit", atMs: T0 + 1_000, entryId: "nobody", order: order() },
  ]);
  assert.deepEqual(
    of("rejected").map((e) => e.reason),
    ["SeasonNotRunning", "VaultNotFound"]
  );
});

test("out-of-order input is an error, not a guess", () => {
  const { engine } = run(opening);
  assert.throws(() => engine.handle({ kind: "clock", atMs: T0 - 1 }), /out of order/);
});

test("the same input log always produces the same season", () => {
  const events: InputEvent[] = [
    ...opening,
    { kind: "submit", atMs: T0 + 1_000, entryId: "e1", order: order() },
    book(T0 + 3_000, 99_990, 100_010),
    mark(T0 + 90_000, 101_000),
    { kind: "submit", atMs: T0 + 95_000, entryId: "e1", order: order({ cloid: 2n, isBuy: false, limitPx: px(100_990), reduceOnly: true }) },
    book(T0 + 97_000, 100_990, 101_010),
    { kind: "clock", atMs: T0 + 300_000 },
  ];

  const first = run(events);
  const second = run(events);
  assert.deepEqual(first.out, second.out);

  const input = first.engine.scoreInput("e1")!;
  const result = score(input, SEASON_0);
  // Bought at 100,010, sold at 100,990: +$9.80 before $1.30 of fees.
  assert.equal(input.marks.at(-1)!.equity, usd(10_000) + 9_800_000n - input.feesPaid);
  assert.ok(result.netReturnBps > 0n);
});
