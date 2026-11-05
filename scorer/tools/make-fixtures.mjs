// Builds the scorer's fixtures with the TypeScript engine, so the Python scorer is tested
// against what the engine actually does rather than against what we think it does.
//
//     node scorer/tools/make-fixtures.mjs [recorded-slice.jsonl]
//
// For each fixture it writes, in scorer/fixtures/:
//   <name>.jsonl[.gz]               the input log, encoded by the engine's own `encodeEvent`
//   <name>.jsonl[.gz].season.json   the season file, with the engine's `rulesHash(SEASON_0)`
//   <name>.expected.txt             stdout of `npm run arena:replay -- <log>`
//   <name>.ts.json                  per-entry state from the engine, for a deeper comparison
//
// The recorded fixture needs a slice of a real recorded day, cut with
// `scorer/tools/slice_recording.py`; without one, it keeps the committed copy.
//
// Needs `npm install` in services/ (the replay script loads the Supabase client).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { ArenaEngine } from "../../services/src/arena/engine.ts";
import { decodeEvent, encodeEvent } from "../../services/src/arena/inputlog.ts";
import { SEASON_0, TIF } from "../../services/src/arena/rules.ts";
import { rank, score } from "../../services/src/arena/scoring.ts";
import { rulesHash } from "../../services/src/arena/season.ts";
import { formatScaled } from "../../services/src/shared/units.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "fixtures");
const services = join(here, "..", "..", "services");

const SECOND = 1_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** A decimal string at 1e8, without passing through a float. */
function e8(text) {
  const [whole, fraction = ""] = String(text).split(".");
  const negative = whole.startsWith("-");
  const digits = BigInt((negative ? whole.slice(1) : whole) + fraction.padEnd(8, "0").slice(0, 8));
  return negative ? -digits : digits;
}

const level = (px, sz) => ({ px: e8(px), sz: e8(sz) });

function book(atMs, coin, bids, asks, lagMs = 300) {
  return { kind: "book", atMs, book: { coin, timeMs: atMs - lagMs, bids: bids.map(([p, s]) => level(p, s)), asks: asks.map(([p, s]) => level(p, s)) } };
}

const trade = (atMs, coin, px, sz, side) => ({ kind: "trade", atMs, trade: { coin, timeMs: atMs - 300, px: e8(px), sz: e8(sz), side, tid: atMs } });

const ctx = (atMs, coin, mark, oracle, rate) => ({
  kind: "ctx",
  atMs,
  ctx: { coin, timeMs: atMs, markPx: e8(mark), oraclePx: e8(oracle), fundingRate: BigInt(rate) },
});

const register = (atMs, entryId) => ({ kind: "register", atMs, entryId });
const cancel = (atMs, entryId, cloid) => ({ kind: "cancel", atMs, entryId, cloid: BigInt(cloid) });

function submit(atMs, entryId, cloid, asset, side, sz, limit, tif, reduceOnly = false) {
  return {
    kind: "submit",
    atMs,
    entryId,
    order: { asset, isBuy: side === "buy", limitPx: e8(limit), sz: e8(sz), reduceOnly, tif, cloid: BigInt(cloid) },
  };
}

/**
 * Events in time order, then in the order they were added, fed through an `ArenaEngine` as
 * they are written, exactly as a live season appends then applies.
 */
class Season {
  constructor({ name, slug, startMs, endMs, instruments }) {
    Object.assign(this, { name, slug, startMs, endMs, instruments });
    this.pending = [];
  }

  add(event) {
    this.pending.push(event);
  }

  /** An event decided when its time comes, from the books seen so far. */
  later(atMs, decide) {
    this.pending.push({ atMs, decide });
  }

  build() {
    const outputs = [];
    const engine = new ArenaEngine({
      rules: SEASON_0,
      instruments: this.instruments,
      startMs: this.startMs,
      endMs: this.endMs,
      emit: (event) => outputs.push(event),
    });
    const books = new Map();
    const events = [];
    const ordered = this.pending.map((event, i) => ({ event, i })).sort((a, b) => a.event.atMs - b.event.atMs || a.i - b.i);
    for (const { event: item } of ordered) {
      const event = item.decide ? item.decide(books, item.atMs) : item;
      if (!event) continue;
      if (event.kind === "book") books.set(event.book.coin, event.book);
      engine.handle(event);
      events.push(event);
    }
    return { engine, events, outputs };
  }
}

function details(engine, outputs) {
  const counts = new Map();
  const of = (id) => {
    if (!counts.has(id)) counts.set(id, { fills: 0, rejections: {}, autoPausedAtMs: null });
    return counts.get(id);
  };
  for (const event of outputs) {
    if (event.kind === "fill") of(event.entryId).fills += 1;
    if (event.kind === "rejected") {
      const r = of(event.entryId).rejections;
      r[event.reason] = (r[event.reason] ?? 0) + 1;
    }
    if (event.kind === "auto_paused") of(event.entryId).autoPausedAtMs = event.atMs;
  }

  const scored = engine.entryIds().map((entryId) => {
    const input = engine.scoreInput(entryId);
    return { entryId, input, registeredAtMs: input.registeredAtMs, score: score(input, SEASON_0) };
  });
  return rank(scored).map(({ entryId, input, score: s }, i) => {
    const snap = engine.snapshot(entryId);
    const last = input.marks[input.marks.length - 1];
    const c = of(entryId);
    return {
      rank: i + 1,
      entryId,
      scoreBps: Number(s.scoreBps),
      netReturnBps: Number(s.netReturnBps),
      maxDrawdownBps: Number(s.maxDrawdownBps),
      feesPaid: formatScaled(s.feesPaid, 6),
      fees: {
        venue: formatScaled(snap.fees.venue, 6),
        execution: formatScaled(snap.fees.execution, 6),
        performance: formatScaled(snap.fees.performance, 6),
      },
      fundingPaid: formatScaled(snap.fundingPaid, 6),
      finalEquity: formatScaled(last ? last.equity : SEASON_0.startingEquity, 6),
      cash: formatScaled(snap.cash, 6),
      positions: Object.fromEntries(snap.positions.map((p) => [String(p.asset), formatScaled(p.size, 8)])),
      eligible: s.eligible,
      activeDays: s.activeDays,
      presenceBps: Number(s.presenceBps),
      turnover: formatScaled(s.turnover, 4),
      marks: input.marks.length,
      fills: c.fills,
      notionalTraded: formatScaled(input.notionalTraded, 6),
      registeredAtMs: input.registeredAtMs,
      autoPausedAtMs: c.autoPausedAtMs,
      rejections: Object.fromEntries(Object.entries(c.rejections).sort()),
    };
  });
}

function write(season, { gzip = false } = {}) {
  const { engine, events, outputs } = season.build();
  const logName = `${season.name}.jsonl${gzip ? ".gz" : ""}`;
  const logPath = join(fixtures, logName);
  const text = events.map(encodeEvent).join("\n") + "\n";
  writeFileSync(logPath, gzip ? gzipSync(text, { level: 9 }) : text);
  writeFileSync(
    `${logPath}.season.json`,
    JSON.stringify(
      { slug: season.slug, startMs: season.startMs, endMs: season.endMs, instruments: season.instruments, rulesHash: rulesHash(SEASON_0) },
      null,
      2
    ) + "\n"
  );

  const expected = execFileSync("npm", ["run", "--silent", "arena:replay", "--", logPath], { cwd: services, encoding: "utf8" });
  writeFileSync(join(fixtures, `${season.name}.expected.txt`), expected);
  writeFileSync(join(fixtures, `${season.name}.ts.json`), JSON.stringify({ events: events.length, entries: details(engine, outputs) }, null, 2) + "\n");

  const kinds = {};
  for (const o of outputs) kinds[o.kind] = (kinds[o.kind] ?? 0) + 1;
  console.log(`${logName}: ${events.length} events, engine output ${JSON.stringify(kinds)}`);
}

// ───────────────────────────────────────────────────────────── edge cases, synthetic

function edgeCases() {
  const T0 = Date.UTC(2026, 10, 10);
  const at = (seconds) => T0 + Math.round(seconds * SECOND);
  const BTC = 0, ETH = 1, SOL = 5, AVAX = 6;
  const season = new Season({
    name: "edge-cases",
    slug: "edge-cases",
    startMs: T0,
    endMs: at(3.5 * 3600),
    instruments: [
      { coin: "BTC", asset: BTC, szDecimals: 5 },
      { coin: "ETH", asset: ETH, szDecimals: 4 },
      { coin: "SOL", asset: SOL, szDecimals: 2 },
      // Listed but never quoted: orders on it have no mark.
      { coin: "AVAX", asset: AVAX, szDecimals: 2 },
    ],
  });

  // Thin BTC levels, so 25% of displayed size binds: 0.003, 0.005, 0.001, then 0.1 BTC.
  const btcMid = (s) => (s < 3000 ? 100_000 : 100_000 + 50 * ((Math.floor(s / 600) % 5) - 2));
  const btcBook = (s, lag) => {
    const m = btcMid(s);
    return book(at(s), "BTC", [[m - 10, "0.012"], [m - 20, "0.02"], [m - 30, "0.004"], [m - 40, "0.4"]], [[m + 10, "0.012"], [m + 20, "0.02"], [m + 30, "0.004"], [m + 40, "0.4"]], lag);
  };
  const ethMid = (s) => (s < 5400 ? 4000 : 4010);
  const ethBook = (s) => {
    const m = ethMid(s);
    return book(at(s), "ETH", [[m - 1, "2"], [m - 2, "4"]], [[m + 1, "2"], [m + 2, "4"]]);
  };
  // SOL never has an asset context, so its mark is the book mid. It spikes to 520 for
  // a while, which is what pushes the short past the drawdown limit.
  const solMid = (s) => (s < 1000 ? 201 : s < 2000 ? 520 : 210);
  const solBook = (s, asks) => {
    const m = solMid(s);
    return book(at(s), "SOL", [[m - 1, "8"], [m - 2, "40"]], asks ?? [[m + 1, "8"], [m + 2, "40"]]);
  };

  const end = 3.5 * 3600 + 120;
  const overridden = new Set([at(1025), at(7025), at(245)]);
  for (let s = 5; s <= end; s += 60) {
    if (!overridden.has(at(s))) season.add(btcBook(s));
    season.add(ethBook(s));
    if (!overridden.has(at(s)) || s === 245) season.add(solBook(s));
  }
  for (let s = 0; s <= end; s += 60) {
    season.add(ctx(at(s + 1), "BTC", btcMid(s), btcMid(s), 12_500_000));
    // Long ETH is paid in hour one and pays after; the oracle is deliberately not round.
    season.add(ctx(at(s + 1), "ETH", ethMid(s), `${ethMid(s)}.37`, s < 5400 ? -20_000_000 : 30_000_000));
  }
  // Books at the moments orders activate, and the ones the edge cases need.
  season.add(btcBook(12)); // exactly at taker's activation instant
  season.add(btcBook(25));
  season.add(btcBook(55));
  season.add(btcBook(245, 15_000)); // received fine, but stamped 15 s earlier by the exchange
  season.add(btcBook(246)); // and the fresh one the orders that waited for it fill on
  season.add(solBook(1005)); // the spike arrives
  season.add(solBook(1025, [[521, "8"], [522, "4"]])); // too thin to finish the exit at once
  season.add(book(at(7025), "SOL", [[209, "8"]], [])); // no asks: no mid, so no SOL mark
  season.add(btcBook(1025));
  // The per-minute books leave 3700 forty seconds after the last one, and `expiry_edge`
  // fills on a print there. Without a fresh book the stale-book rule refuses that fill
  // and the expiry boundary below stops being tested at all.
  season.add(btcBook(3699));
  season.add(btcBook(7025));

  // Registration: one before the season, two in the same millisecond.
  season.add(register(at(-60), "early_bird"));
  season.add(submit(at(-30), "early_bird", 1, BTC, "buy", "0.001", 100_030, TIF.ioc));
  for (const [s, id] of [[1, "taker"], [2, "ioc"], [3, "alo"], [4, "paused"], [5, "funding_long_eth"], [6, "funding_short_eth"], [7, "ties_a"], [8, "ties_b"], [9, "idle_z"], [9, "idle_y"], [9, "rejects"], [9.5, "cap_edge"], [10, "ro"], [11, "expiry_edge"], [12, "sol_long"]]) {
    season.add(register(at(s), id));
  }
  season.add(register(at(13), "taker")); // twice: a no-op

  // taker: GTC across three thin levels, rests the rest, then maker fills on prints.
  season.add(submit(at(10), "taker", 1, BTC, "buy", "0.01", 100_020, TIF.gtc));
  season.add(trade(at(14), "BTC", 100_020, "0.1", "B")); // a touch: nothing
  season.add(trade(at(15), "BTC", 100_015, "0.004", "A")); // through: 25% of 0.004
  season.add(trade(at(16), "BTC", 100_000, "0.1", "A")); // the rest
  season.add(submit(at(1800), "taker", 2, BTC, "sell", "0.004", 99_900, TIF.ioc, true));
  season.add(submit(at(1810), "taker", 3, BTC, "buy", "0.003", 100_020, TIF.gtc)); // cloid 1 still reserves
  season.add(submit(at(3720), "taker", 3, BTC, "buy", "0.003", 100_020, TIF.gtc)); // after it expired

  // ioc: an IOC remainder, cancels (one unknown), and a cloid reused after release.
  season.add(submit(at(20), "ioc", 7, BTC, "buy", "0.01", 100_030, TIF.ioc));
  season.add(cancel(at(30), "ioc", 7));
  season.add(cancel(at(40), "ioc", 99));
  // Closing with a plain order is refused: its notional adds to aggregate exposure.
  season.add(submit(at(45), "ioc", 6, BTC, "sell", "0.009", 99_980, TIF.ioc));
  season.add(submit(at(50), "ioc", 7, BTC, "sell", "0.009", 99_980, TIF.ioc, true));
  season.add(submit(at(200), "ioc", 8, BTC, "sell", "0.001", 99_900, TIF.ioc, true)); // waits out the stale book

  // alo: one would cross, one rests and fills, then the open-order limit.
  season.add(submit(at(60), "alo", 1, BTC, "buy", "0.002", 100_010, TIF.alo));
  season.add(submit(at(61), "alo", 2, BTC, "buy", "0.002", 99_950, TIF.alo));
  for (let cloid = 3; cloid <= 8; cloid++) season.add(submit(at(59 + cloid), "alo", cloid, BTC, "buy", "0.0001", 90_000, TIF.gtc));
  season.add(submit(at(68), "alo", 9, BTC, "buy", "0.0001", 90_000, TIF.gtc)); // ninth: refused
  season.add(trade(at(70), "BTC", 99_950, "1", "A"));
  season.add(trade(at(71), "BTC", 99_940, "0.004", "A"));
  season.add(trade(at(72), "BTC", 99_900, "0.1", "A"));
  season.add(submit(at(3800), "alo", 9, BTC, "buy", "0.0001", 90_000, TIF.gtc)); // slots free again

  // paused: short SOL, a resting reduce-only, the spike, refused mid-minute, auto-pause.
  season.add(submit(at(30), "paused", 1, SOL, "sell", "6", 198, TIF.ioc));
  season.add(submit(at(900), "paused", 2, SOL, "buy", "1", 150, TIF.gtc, true));
  season.add(submit(at(1010), "paused", 3, SOL, "buy", "1", 530, TIF.ioc, true)); // reduce-only, still refused
  season.add(submit(at(1100), "paused", 4, BTC, "buy", "0.001", 100_030, TIF.ioc));

  // funding: long and short ETH across three hours.
  season.add(submit(at(75), "funding_long_eth", 1, ETH, "buy", "0.25", 4_002, TIF.ioc));
  season.add(submit(at(76), "funding_short_eth", 1, ETH, "sell", "0.25", 3_998, TIF.ioc));

  // ties: identical trades, so registration order decides.
  for (const id of ["ties_a", "ties_b"]) {
    season.add(submit(at(150), id, 1, BTC, "buy", "0.001", 100_030, TIF.ioc));
    season.add(submit(at(300), id, 2, BTC, "sell", "0.001", 99_900, TIF.ioc, true));
  }

  // cap_edge: exactly 12% is allowed, one lot more is not.
  season.add(submit(at(400), "cap_edge", 1, BTC, "buy", "0.012", 100_000, TIF.gtc));
  season.add(cancel(at(401), "cap_edge", 1));
  season.add(submit(at(402), "cap_edge", 2, BTC, "buy", "0.01201", 100_000, TIF.gtc));

  // rejects: one of each paper and vault refusal.
  const r = (s, cloid, asset, sz, px, tif = TIF.gtc) => season.add(submit(at(s), "rejects", cloid, asset, "buy", sz, px, tif));
  r(500, 0, BTC, "0.001", 90_000);
  r(501, 1, BTC, "0", 90_000);
  r(502, 2, 99, "0.001", 90_000);
  r(503, 3, BTC, "0.001", "100000.5");
  r(504, 4, BTC, "0.000001", 90_000);
  r(505, 5, BTC, "0.001", 90_000, 4);
  r(506, 6, AVAX, "1", 30);
  r(507, 7, BTC, "0.0001", 90_000);
  r(508, 7, BTC, "0.0001", 90_000);
  season.add(submit(at(509), "ghost", 1, BTC, "buy", "0.001", 90_000, TIF.gtc));
  r(3.5 * 3600, 8, BTC, "0.001", 90_000); // at the end instant: closed

  // ro: reduce-only with nothing to reduce, and a resting one clamped then exhausted.
  season.add(submit(at(110), "ro", 1, BTC, "sell", "0.001", 99_000, TIF.ioc, true));
  season.add(submit(at(111), "ro", 2, BTC, "buy", "0.002", 100_030, TIF.ioc));
  season.add(submit(at(130), "ro", 3, BTC, "sell", "0.004", 101_000, TIF.alo, true));
  season.add(trade(at(190), "BTC", 101_500, "0.1", "B"));
  season.add(trade(at(191), "BTC", 100_000, "0.01", "A"));

  // expiry_edge: live at exactly submit + 1 h, gone a millisecond after.
  season.add(submit(at(99), "expiry_edge", 2, BTC, "buy", "0.005", 98_500, TIF.gtc));
  season.add(submit(at(100), "expiry_edge", 1, BTC, "buy", "0.005", 99_000, TIF.gtc));
  season.add(trade(at(3700), "BTC", 98_000, "0.008", "A")); // cloid 1 takes 0.002 of 0.005
  season.add(trade(at(3700.001), "BTC", 98_000, "0.008", "A")); // expired: nothing

  // sol_long: valued at zero for the minute SOL has no mid.
  season.add(submit(at(80), "sol_long", 1, SOL, "buy", "2", 203, TIF.ioc));

  // late: registers two hours in; its close activates after the season has ended.
  season.add(register(at(7200), "late"));
  season.add(submit(at(7300), "late", 1, BTC, "buy", "0.001", 100_100, TIF.ioc));
  season.add(submit(at(3.5 * 3600 - 1), "late", 2, BTC, "sell", "0.001", 99_000, TIF.ioc, true));

  season.add({ kind: "clock", atMs: at(end + 30) });
  return season;
}

// ───────────────────────────────────────────────────────────── twelve days, synthetic

function longSeason() {
  const T1 = Date.UTC(2026, 10, 11);
  const BTC = 0;
  const season = new Season({
    name: "long-season",
    slug: "long-season",
    startMs: T1,
    endMs: T1 + 12 * DAY,
    instruments: [{ coin: "BTC", asset: BTC, szDecimals: 5 }],
  });

  const step = 30 * MINUTE;
  const mid = (ms) => 100_000 + 10 * Math.floor((ms - T1) / step);
  for (let ms = T1; ms <= T1 + 12 * DAY + HOUR; ms += step) {
    const m = mid(ms);
    season.add(ctx(ms + SECOND, "BTC", m, m, 10_000_000));
    season.add(book(ms + 5 * SECOND, "BTC", [[m - 10, "0.2"], [m - 20, "0.4"]], [[m + 10, "0.2"], [m + 20, "0.4"]]));
  }

  const buy = (ms, id, cloid, sz) => season.add(submit(ms, id, cloid, BTC, "buy", sz, mid(ms) + 20, TIF.ioc));
  const sell = (ms, id, cloid, sz) => season.add(submit(ms, id, cloid, BTC, "sell", sz, mid(ms) - 20, TIF.ioc, true));

  // holder: one buy, held to the end. Best return, one fill day: not eligible.
  season.add(register(T1 + 1 * SECOND, "holder"));
  buy(T1 + MINUTE, "holder", 1, "0.011");

  // daily: trades every day and always holds something: eligible.
  season.add(register(T1 + 2 * SECOND, "daily"));
  for (let d = 0; d < 12; d++) {
    const ms = T1 + d * DAY + HOUR;
    if (d === 0) buy(ms, "daily", 1, "0.008");
    else if (d % 2 === 1) sell(ms, "daily", d + 1, "0.002");
    else buy(ms, "daily", d + 1, "0.002");
  }

  // late_joiner: two days late, then ten days of fills; its fee week is its own.
  season.add(register(T1 + 2 * DAY + 5 * SECOND, "late_joiner"));
  for (let d = 2; d < 12; d++) {
    const ms = T1 + d * DAY + 2 * HOUR;
    if (d === 2) buy(ms, "late_joiner", 1, "0.008");
    else if (d % 2 === 1) sell(ms, "late_joiner", d, "0.001");
    else buy(ms, "late_joiner", d, "0.001");
  }

  // after_end: nine days of fills in the season, and a tenth from an order that
  // activates after it has ended.
  season.add(register(T1 + 3 * SECOND, "after_end"));
  for (let d = 3; d < 12; d++) {
    const ms = T1 + d * DAY + 3 * HOUR;
    if (d === 3) buy(ms, "after_end", 1, "0.008");
    else if (d % 2 === 0) sell(ms, "after_end", d, "0.001");
    else buy(ms, "after_end", d, "0.001");
  }
  season.add(submit(T1 + 12 * DAY - SECOND, "after_end", 99, BTC, "buy", "0.001", mid(T1 + 12 * DAY) + 20, TIF.ioc));

  // idle_long: never trades.
  season.add(register(T1 + 4 * SECOND, "idle_long"));
  return season;
}

// ───────────────────────────────────────────────────────────── recorded mainnet data

function recorded(slicePath) {
  const market = readFileSync(slicePath, "utf8").split("\n").filter((line) => line.trim() !== "").map(decodeEvent);
  const startMs = Math.floor(market[0].atMs / MINUTE) * MINUTE;
  const endMs = startMs + 19 * MINUTE;
  const instruments = [
    { coin: "BTC", asset: 0, szDecimals: 5 },
    { coin: "ETH", asset: 1, szDecimals: 4 },
    { coin: "SOL", asset: 5, szDecimals: 2 },
  ];
  const season = new Season({ name: "recorded-mainnet", slug: "recorded-mainnet-2026-11-04", startMs, endMs, instruments });
  for (const event of market) season.add(event);

  const szDecimals = { BTC: 5, ETH: 4, SOL: 2 };
  const assetOf = { BTC: 0, ETH: 1, SOL: 5 };
  /** Whole lots worth about `usd` at `px` (1e8), as a decimal string. */
  const sizeFor = (coin, usd, px) => {
    const lots = (BigInt(usd) * 10n ** 16n) / px / 10n ** BigInt(8 - szDecimals[coin]);
    const scaled = lots * 10n ** BigInt(8 - szDecimals[coin]);
    return `${scaled / 100_000_000n}.${(scaled % 100_000_000n).toString().padStart(8, "0")}`;
  };
  const pxText = (px) => `${px / 100_000_000n}.${(px % 100_000_000n).toString().padStart(8, "0")}`;
  /** An order priced off the book as it stood: `levels` deep on the side it would take. */
  const order = (minutes, id, cloid, coin, side, usd, tif, depth, reduceOnly = false) =>
    season.later(startMs + minutes * MINUTE, (books, atMs) => {
      const b = books.get(coin);
      const levels = side === "buy" ? (tif === TIF.alo ? b.bids : b.asks) : tif === TIF.alo ? b.asks : b.bids;
      const px = levels[Math.min(depth, levels.length - 1)].px;
      return submit(atMs, id, cloid, assetOf[coin], side, sizeFor(coin, usd, px), pxText(px), tif, reduceOnly);
    });

  const r = (minutes, id) => season.add(register(startMs + minutes * MINUTE, id));
  r(0.1, "rec_taker");
  r(0.2, "rec_maker");
  r(0.3, "rec_short");
  r(0.4, "rec_alo_cross");
  r(0.5, "rec_idle");
  r(0.6, "rec_flipper");

  // rec_taker: ~$900 of BTC walking three levels, partly closed later.
  order(1, "rec_taker", 1, "BTC", "buy", 900, TIF.ioc, 3);
  order(14, "rec_taker", 2, "BTC", "sell", 400, TIF.ioc, 3, true);

  // rec_maker: resting bids at the touch on ETH and SOL; fills only on prints through.
  order(2, "rec_maker", 1, "ETH", "buy", 400, TIF.gtc, 0);
  order(2.5, "rec_maker", 2, "SOL", "buy", 300, TIF.alo, 0);
  season.add(cancel(startMs + 12 * MINUTE, "rec_maker", 1));

  // rec_short: short SOL across the 09:00 funding.
  order(3, "rec_short", 1, "SOL", "sell", 1_000, TIF.ioc, 2);

  // rec_alo_cross: an ALO priced at the far touch, which normally crosses.
  season.later(startMs + 4 * MINUTE, (books, atMs) => {
    const ask = books.get("ETH").asks[0].px;
    return submit(atMs, "rec_alo_cross", 1, 1, "buy", sizeFor("ETH", 300, ask), pxText(ask), TIF.alo);
  });

  // rec_flipper: in and out of ETH every three minutes.
  for (let k = 0; k < 5; k++) {
    order(5 + 3 * k, "rec_flipper", 1 + 2 * k, "ETH", "buy", 500, TIF.ioc, 1);
    // Cancelled once filled: a filled order keeps its reservation until then.
    season.add(cancel(startMs + (6 + 3 * k) * MINUTE, "rec_flipper", 1 + 2 * k));
    order(6.5 + 3 * k, "rec_flipper", 2 + 2 * k, "ETH", "sell", 500, TIF.ioc, 1, true);
  }
  return season;
}

write(edgeCases());
write(longSeason());
const slice = process.argv[2];
if (slice) write(recorded(slice), { gzip: true });
else console.log("recorded-mainnet: no slice given, keeping the committed fixture");
