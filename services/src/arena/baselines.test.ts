import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { notionalUsdc } from "../shared/units.ts";
import {
  capSize,
  entrySeed,
  houseEntryIds,
  isHouseEntry,
  prng,
  roundPrice,
  withHouseEntries,
  type HouseOptions,
} from "./baselines.ts";
import { ArenaEngine, type InputEvent, type OutputEvent } from "./engine.ts";
import { encodeEvent, readLog } from "./inputlog.ts";
import type { Instrument } from "./market.ts";
import { rankEntries } from "./publish.ts";
import { SEASON_0, TIF } from "./rules.ts";
import { ArenaRuntime } from "./runtime.ts";

/**
 * Replay tests on recorded data: the plan's week-2 exit criterion, "a replay of one
 * recorded day reproduces the expected fills", on a slice small enough to commit.
 *
 * The fixture is four minutes of real mainnet data (BTC, ETH, SOL; see
 * `fixtures/README.md`). The house baselines are merged into it, and every fill, fee, mark
 * and rank below is the exact integer the engine must produce from that log. A change to
 * the fill model, the fees, the risk checks or the scoring that moves any of them fails
 * here, and has to be a deliberate, published change to the rules.
 */

const FIXTURE = fileURLToPath(new URL("./fixtures/mainnet-2026-11-04T0830Z.jsonl.gz", import.meta.url));
const T = Date.UTC(2026, 10, 4, 8, 30);

// From `arena-data/recorder/mainnet/recorder.json`: mainnet asset indices.
const BTC: Instrument = { coin: "BTC", asset: 0, szDecimals: 5 };
const ETH: Instrument = { coin: "ETH", asset: 1, szDecimals: 4 };
const SOL: Instrument = { coin: "SOL", asset: 5, szDecimals: 2 };

/** Seconds, not hours, so four minutes holds a few round trips per random entry. */
const OPTIONS: HouseOptions = {
  rules: SEASON_0,
  instruments: [BTC, ETH, SOL],
  startMs: T,
  seed: "house-0",
  timing: { waitMs: [5_000, 40_000], holdMs: [20_000, 90_000], passiveMs: 20_000, cancelAfterMs: 15_000 },
};

async function collect(events: AsyncIterable<InputEvent>): Promise<InputEvent[]> {
  const all: InputEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

const market = () => collect(readLog(FIXTURE));
const seasonLog = (options: HouseOptions = OPTIONS) => collect(withHouseEntries(readLog(FIXTURE), options));

function replay(log: readonly InputEvent[]) {
  const out: OutputEvent[] = [];
  const engine = new ArenaEngine({ rules: SEASON_0, instruments: OPTIONS.instruments, startMs: T, emit: (e) => out.push(e) });
  for (const event of log) engine.handle(event);
  return { engine, out };
}

const isHouseInput = (e: InputEvent) => e.kind === "register" || e.kind === "submit" || e.kind === "cancel";

// ───────────────────────────────────────────────────────── the fixture

test("the fixture is the recorded slice, unchanged", async () => {
  const plain = gunzipSync(await readFile(FIXTURE));
  assert.equal(createHash("sha256").update(plain).digest("hex"), "7454f6b6a6c42e3a26aeb44cd909263f9ecf2de31d190af54d04b813304e454c");

  const events = await market();
  const kinds: Record<string, number> = {};
  for (const e of events) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  assert.deepEqual(kinds, { book: 135, trade: 1_747, ctx: 705 });
  assert.equal(events[0]!.atMs, T + 636);
  assert.equal(events[events.length - 1]!.atMs, T + 239_484);
});

// ───────────────────────────────────────────────────────── the scripts

test("the PRNG is pinned, so a published seed regenerates the house's orders anywhere", () => {
  const next = prng(1);
  assert.deepEqual([next(), next(), next()], [2_693_262_067, 11_749_833, 2_265_367_787]);
  assert.equal(entrySeed("house-0", "house:random-1"), 3_741_040_030);
});

test("prices round to a valid tick away from the touch, and cap sizes fit the reservation", () => {
  const PUMP: Instrument = { coin: "PUMP", asset: 200, szDecimals: 0 };
  assert.equal(roundPrice(BTC, 7_835_712_345_678n, true), 7_835_800_000_000n); // 78357.12 → 78358
  assert.equal(roundPrice(BTC, 7_835_712_345_678n, false), 7_835_700_000_000n);
  assert.equal(roundPrice(ETH, 231_812_345_678n, true), 231_820_000_000n); // five significant figures
  assert.equal(roundPrice(SOL, 9_330_151_234n, false), 9_330_100_000n);
  assert.equal(roundPrice(PUMP, 412_345n, true), 412_400n); // six decimals at most
  assert.equal(roundPrice(SOL, 999_995_000n, true), 1_000_000_000n); // 9.99995 → 10
  assert.equal(roundPrice(BTC, 12_345_678_000_000n, true), 12_345_700_000_000n); // an integer is always valid

  const budget = 1_200_000_000n;
  const limit = 7_855_300_000_000n;
  const sz = capSize(BTC, budget, limit);
  assert.equal(sz, 1_527_000n);
  assert.ok(notionalUsdc(sz, limit) <= budget);
  assert.ok(notionalUsdc(sz + 1_000n, limit) > budget, "one more lot would break the cap");
});

test("the season log is the market slice, unchanged, with the house merged in time order", async () => {
  const [slice, log] = [await market(), await seasonLog()];

  assert.deepEqual(log.filter((e) => !isHouseInput(e)), slice);
  for (let i = 1; i < log.length; i++) assert.ok(log[i]!.atMs >= log[i - 1]!.atMs, `event ${i} is out of order`);

  const house = log.filter(isHouseInput);
  assert.deepEqual(
    house.filter((e) => e.kind === "register").map((e) => [e.atMs, "entryId" in e && e.entryId]),
    houseEntryIds().map((id) => [T, id])
  );
  assert.equal(house.filter((e) => e.kind === "submit").length, 24);
  assert.equal(house.filter((e) => e.kind === "cancel").length, 23);
  assert.ok(houseEntryIds().every(isHouseEntry));

  // Each house event is stamped with the market event just before it: it saw nothing later.
  for (let i = 1; i < log.length; i++) {
    if (isHouseInput(log[i]!) && log[i]!.kind !== "register") assert.equal(log[i]!.atMs, log[i - 1]!.atMs);
  }
});

test("the same slice and seed give the same log, line for line; a new seed moves only the random entries", async () => {
  const lines = (log: InputEvent[]) => log.map(encodeEvent);
  const base = lines(await seasonLog());
  assert.deepEqual(lines(await seasonLog()), base);

  const other = await seasonLog({ ...OPTIONS, seed: "house-1" });
  const fixedEntries = (log: InputEvent[]) =>
    lines(log.filter((e) => isHouseInput(e) && "entryId" in e && (e.entryId === "house:cash" || e.entryId === "house:btc-long")));
  assert.deepEqual(fixedEntries(other), fixedEntries(await seasonLog()));
  assert.notDeepEqual(lines(other), base);
});

// ───────────────────────────────────────────────────────── the replay

type FillRow = [number, string, bigint, number, "buy" | "sell", bigint, bigint, "taker" | "maker", bigint, bigint, bigint];
type MarkRow = [number, string, bigint, bigint, boolean];
type RankRow = [string, bigint, bigint, bigint, bigint];

// [atMs, entry, cloid, asset, side, px, sz, liquidity, notional, venue fee, execution fee]
const FILLS: FillRow[] = [
  [T + 6931, "house:btc-long", 1n, 0, "buy", 7836600000000n, 1527000n, "taker", 1196648820n, 538491n, 239329n],
  [T + 12316, "house:random-3", 1n, 0, "sell", 7837000000000n, 1035000n, "taker", 811129500n, 365008n, 162225n],
  [T + 33718, "house:random-2", 1n, 0, "sell", 7835400000000n, 913000n, "taker", 715372020n, 321917n, 143074n],
  [T + 39298, "house:random-1", 1n, 0, "sell", 7835900000000n, 1176000n, "taker", 921501840n, 414675n, 184300n],
  // A passive close at the bid, filled by three prints strictly below it, 25% of each.
  [T + 48812, "house:random-3", 2n, 0, "buy", 7835400000000n, 214000n, "maker", 167677560n, 25151n, 33535n],
  [T + 48812, "house:random-3", 2n, 0, "buy", 7835400000000n, 664000n, "maker", 520270560n, 78040n, 104054n],
  [T + 49081, "house:random-3", 2n, 0, "buy", 7835400000000n, 157000n, "maker", 123015780n, 18452n, 24603n],
  // Five prints in 7 ms fill all of a 0.01176 BTC close.
  [T + 72607, "house:random-1", 2n, 0, "buy", 7835200000000n, 39000n, "maker", 30557280n, 4583n, 6111n],
  [T + 72607, "house:random-1", 2n, 0, "buy", 7835200000000n, 12000n, "maker", 9402240n, 1410n, 1880n],
  [T + 72608, "house:random-1", 2n, 0, "buy", 7835200000000n, 8000n, "maker", 6268160n, 940n, 1253n],
  [T + 72610, "house:random-1", 2n, 0, "buy", 7835200000000n, 57000n, "maker", 44660640n, 6699n, 8932n],
  [T + 72614, "house:random-1", 2n, 0, "buy", 7835200000000n, 1060000n, "maker", 830531200n, 124579n, 166106n],
  [T + 98654, "house:random-2", 3n, 0, "buy", 7833800000000n, 913000n, "taker", 715225940n, 321851n, 143045n],
  [T + 104596, "house:random-3", 4n, 1, "buy", 231810000000n, 45580000n, "taker", 1056589980n, 475465n, 211317n],
  [T + 114915, "house:random-1", 4n, 1, "sell", 231770000000n, 39940000n, "taker", 925689380n, 416560n, 185137n],
  [T + 131395, "house:random-2", 4n, 5, "sell", 9323800000n, 1078000000n, "taker", 1005105640n, 452297n, 201021n],
  // A taker close that walks three ETH levels, 25% of each.
  [T + 174129, "house:random-1", 6n, 1, "buy", 231940000000n, 10570000n, "taker", 245160580n, 110322n, 49032n],
  [T + 174129, "house:random-1", 6n, 1, "buy", 231950000000n, 5380000n, "taker", 124789100n, 56155n, 24957n],
  [T + 174129, "house:random-1", 6n, 1, "buy", 231960000000n, 23990000n, "taker", 556472040n, 250412n, 111294n],
  [T + 174129, "house:random-3", 6n, 1, "sell", 231930000000n, 45580000n, "taker", 1057136940n, 475711n, 211427n],
  [T + 185053, "house:random-1", 7n, 5, "sell", 9332200000n, 437000000n, "taker", 407817140n, 183517n, 81563n],
  [T + 190197, "house:random-3", 7n, 5, "buy", 9333500000n, 192000000n, "taker", 179203200n, 80641n, 35840n],
  [T + 217137, "house:random-2", 6n, 5, "buy", 9336800000n, 864000000n, "taker", 806699520n, 363014n, 161339n],
  [T + 217137, "house:random-2", 6n, 5, "buy", 9337400000n, 214000000n, "taker", 199820360n, 89919n, 39964n],
  [T + 227968, "house:random-1", 9n, 5, "buy", 9337400000n, 437000000n, "taker", 408044380n, 183619n, 81608n],
];

// [atMs, entry, equity, drawdown bps, present]. No mark at T itself: the entries register
// at T, just after the engine has passed that minute.
const MARKS: MarkRow[] = [
  [T + 60000, "house:cash", 10000000000n, 0n, false],
  [T + 60000, "house:btc-long", 9999016035n, 0n, true],
  [T + 60000, "house:random-1", 9999477465n, 0n, true],
  [T + 60000, "house:random-2", 9999548704n, 0n, true],
  [T + 60000, "house:random-3", 9999354532n, 0n, true],
  [T + 120000, "house:cash", 10000000000n, 0n, false],
  [T + 120000, "house:btc-long", 9998596110n, 1n, true],
  [T + 120000, "house:random-1", 9998559155n, 1n, true],
  [T + 120000, "house:random-2", 9999216193n, 0n, false],
  [T + 120000, "house:random-3", 9998485430n, 1n, true],
  [T + 180000, "house:cash", 10000000000n, 0n, false],
  [T + 180000, "house:btc-long", 9999252720n, 0n, true],
  [T + 180000, "house:random-1", 9997224643n, 2n, true],
  [T + 180000, "house:random-2", 9998207135n, 1n, true],
  [T + 180000, "house:random-3", 9998527572n, 1n, false],
];

// [entry, score bps, net return bps, max drawdown bps, fees paid]. random-2 and random-3
// tie on score and drawdown and registered in the same millisecond, so log order decides.
const RANKS: RankRow[] = [
  ["house:cash", 0n, 0n, 0n, 0n],
  ["house:btc-long", -1n, 0n, 1n, 777820n],
  ["house:random-2", -2n, -1n, 1n, 2237441n],
  ["house:random-3", -2n, -1n, 1n, 2301469n],
  ["house:random-1", -4n, -2n, 2n, 2655644n],
];

const fillRows = (out: OutputEvent[]): FillRow[] =>
  out.flatMap((e) =>
    e.kind === "fill"
      ? [[e.atMs, e.entryId, e.cloid, e.asset, e.isBuy ? "buy" : "sell", e.px, e.sz, e.liquidity, e.notional, e.venueFee, e.executionFee] as FillRow]
      : []
  );
const markRows = (out: OutputEvent[]): MarkRow[] =>
  out.flatMap((e) => (e.kind === "mark" ? [[e.atMs, e.entryId, e.equity, e.drawdownBps, e.present] as MarkRow] : []));
const rankRows = (engine: ArenaEngine): RankRow[] =>
  rankEntries(engine, SEASON_0).map(({ entryId, score: s }) => [entryId, s.scoreBps, s.netReturnBps, s.maxDrawdownBps, s.feesPaid]);

test("replaying the season log reproduces the expected fills, fees, marks and ranks, twice", async () => {
  const log = await seasonLog();
  const first = replay(log);
  const second = replay(log);

  assert.deepEqual(fillRows(first.out), FILLS);
  assert.deepEqual(markRows(first.out), MARKS);
  assert.deepEqual(rankRows(first.engine), RANKS);
  assert.deepEqual(second.out, first.out, "a second replay must produce every output event again, identically");

  const outcomes: Record<string, number> = {};
  for (const e of first.out) {
    if (e.kind === "order_done") outcomes[e.why] = (outcomes[e.why] ?? 0) + 1;
    if (e.kind === "rejected") outcomes[`rejected ${e.reason}`] = (outcomes[`rejected ${e.reason}`] ?? 0) + 1;
  }
  assert.deepEqual(outcomes, { filled: 16, reduce_only_nothing_to_reduce: 2, alo_would_cross: 2, cancelled: 3 });
});

test("the cap order fills against the first book at or after t_recv + 2 s, worked by hand from the raw lines", async () => {
  const log = await seasonLog();
  const submit = log.find((e) => e.kind === "submit" && e.entryId === "house:btc-long");
  assert.ok(submit?.kind === "submit");

  // Straight from the recorded JSON, without the engine's decoder.
  type RawBook = { atMs: number; book: { coin: string; asks: { px: { $n: string }; sz: { $n: string } }[] } };
  const books = gunzipSync(await readFile(FIXTURE))
    .toString("utf8")
    .split("\n")
    .filter((line) => line.startsWith('{"kind":"book"'))
    .map((line) => JSON.parse(line) as RawBook)
    .filter((b) => b.book.coin === "BTC");
  const pricedFrom = books.filter((b) => b.atMs <= submit.atMs).at(-1)!;
  const filledAgainst = books.find((b) => b.atMs >= submit.atMs + SEASON_0.activationDelayMs)!;

  // Priced 25 bps through the ask it could see, rounded up to a whole dollar (five
  // significant figures at 78,000), and sized so the reservation fits 12% of 10,000 USDC.
  const ask = BigInt(pricedFrom.book.asks[0]!.px.$n);
  const limitPx = (((ask * 10_025n) / 10_000n + 99_999_999n) / 100_000_000n) * 100_000_000n;
  const sz = (((1_200_000_000n * 10_000_000_000n) / limitPx) / 1_000n) * 1_000n;
  assert.deepEqual(submit.order, { asset: 0, isBuy: true, limitPx, sz, reduceOnly: false, tif: TIF.ioc, cloid: 1n });

  // It fills against the next book, not the one it was priced from, at that book's ask.
  const top = filledAgainst.book.asks[0]!;
  assert.ok(filledAgainst.atMs > pricedFrom.atMs);
  assert.ok(sz <= (BigInt(top.sz.$n) * 2_500n) / 10_000n, "the whole order fits in 25% of the top level");
  const notional = (sz * BigInt(top.px.$n)) / 10_000_000_000n;
  const fill = FILLS[0]!;
  assert.deepEqual(fill, [
    filledAgainst.atMs, "house:btc-long", 1n, 0, "buy", BigInt(top.px.$n), sz, "taker",
    notional, (notional * 450n) / 1_000_000n, (notional * 200n) / 1_000_000n,
  ]);
  // Sent on the first BTC book of the season; the 2 s delay runs out, and Hyperliquid's
  // next BTC book arrives 2.944 s after that.
  assert.equal(submit.atMs - T, 1_987);
  assert.equal(filledAgainst.atMs - submit.atMs, 4_944);
  assert.ok(BigInt(top.px.$n) > ask, "the ask moved between the two books");
});

test("ArenaRuntime.open on the written season log reproduces the same season", async () => {
  const log = await seasonLog();
  const direct = replay(log);

  const dir = await mkdtemp(join(tmpdir(), "arena-baselines-"));
  const logPath = join(dir, "season.jsonl");
  await writeFile(logPath, log.map((e) => encodeEvent(e) + "\n").join(""));

  const { runtime, replayed, repaired } = await ArenaRuntime.open({
    rules: SEASON_0,
    instruments: OPTIONS.instruments,
    startMs: T,
    logPath,
  });
  assert.equal(replayed, log.length);
  assert.equal(repaired, false);
  assert.deepEqual(rankRows(runtime.engine), RANKS);
  for (const id of houseEntryIds()) {
    assert.deepEqual(runtime.engine.snapshot(id), direct.engine.snapshot(id), id);
    assert.deepEqual(runtime.engine.scoreInput(id), direct.engine.scoreInput(id), id);
  }
});
