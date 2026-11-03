import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { InputEvent } from "./engine.ts";
import { decodeEvent } from "./inputlog.ts";
import type { Book, Instrument } from "./market.ts";
import { rankEntries, scoreRows } from "./publish.ts";
import { SEASON_0, TIF } from "./rules.ts";
import { ArenaRuntime } from "./runtime.ts";
import { freezeSeason, rulesHash } from "./season.ts";

const px = (whole: number) => BigInt(whole) * 100_000_000n;
const size = (value: number) => BigInt(Math.round(value * 1e8));
const T0 = Date.UTC(2026, 10, 10);
const BTC: Instrument = { coin: "BTC", asset: 0, szDecimals: 5 };

function bookAt(atMs: number, mid: number): Extract<InputEvent, { kind: "book" }> {
  const book: Book = {
    coin: "BTC",
    timeMs: atMs,
    bids: [{ px: px(mid - 10), sz: size(2) }],
    asks: [{ px: px(mid + 10), sz: size(2) }],
  };
  return { kind: "book", atMs, book };
}

function ctxAt(atMs: number, mid: number): Extract<InputEvent, { kind: "ctx" }> {
  return { kind: "ctx", atMs, ctx: { coin: "BTC", timeMs: atMs, markPx: px(mid), oraclePx: px(mid), fundingRate: 0n } };
}

/** A short live session through the runtime, with a controllable clock and an in-memory log. */
async function liveSession() {
  let now = T0;
  const lines: string[] = [];
  const runtime = new ArenaRuntime({
    rules: SEASON_0,
    instruments: [BTC],
    startMs: T0,
    sink: async (line) => void lines.push(line),
    now: () => now,
  });

  await runtime.register("alice");
  await runtime.register("bob");
  await runtime.market((at) => ctxAt(at, 100_000));
  await runtime.market((at) => bookAt(at, 100_000));

  now += 1_000;
  const accepted = await runtime.submit("alice", {
    asset: 0, isBuy: true, limitPx: px(100_100), sz: size(0.01), reduceOnly: false, tif: TIF.gtc, cloid: 1n,
  });
  const rejected = await runtime.submit("bob", {
    asset: 0, isBuy: true, limitPx: px(100_100), sz: size(50), reduceOnly: false, tif: TIF.gtc, cloid: 1n,
  });

  for (let i = 1; i <= 30; i++) {
    now += 10_000;
    const mid = 100_000 + i * 40;
    await runtime.market((at) => bookAt(at, mid));
    await runtime.market((at) => ctxAt(at, mid));
  }
  return { runtime, lines, accepted, rejected };
}

test("each caller gets the verdict for its own order", async () => {
  const { accepted, rejected } = await liveSession();
  assert.ok(accepted.some((e) => e.kind === "accepted" && e.entryId === "alice"));
  assert.ok(rejected.some((e) => e.kind === "rejected" && e.entryId === "bob"), "50 BTC is far over a 12% cap");
  assert.ok(!accepted.some((e) => "entryId" in e && e.entryId === "bob"));
});

test("registering twice is a no-op, and logs nothing the second time", async () => {
  const lines: string[] = [];
  const runtime = new ArenaRuntime({ rules: SEASON_0, instruments: [BTC], startMs: T0, sink: async (l) => void lines.push(l), now: () => T0 });
  assert.equal(await runtime.register("alice"), true);
  assert.equal(await runtime.register("alice"), false);
  assert.equal(lines.length, 1);
});

test("replaying the log reproduces the live season exactly", async () => {
  const { runtime, lines } = await liveSession();

  const replayed = new ArenaRuntime({
    rules: SEASON_0,
    instruments: [BTC],
    startMs: T0,
    sink: async () => assert.fail("a replay must not write"),
    prior: lines.map(decodeEvent),
  });

  const live = rankEntries(runtime.engine, SEASON_0);
  const again = rankEntries(replayed.engine, SEASON_0);
  assert.deepEqual(again, live);
  assert.deepEqual(replayed.engine.snapshot("alice"), runtime.engine.snapshot("alice"));
  assert.ok(live.find((e) => e.entryId === "alice")!.score.feesPaid > 0n, "alice actually traded");
});

test("score rows carry the published numeric formats", async () => {
  const { runtime } = await liveSession();
  const rows = scoreRows(rankEntries(runtime.engine, SEASON_0), "2026-11-10");
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.match(row.score, /^-?\d+\.\d{6}$/);
    assert.match(row.turnover_ratio, /^-?\d+\.\d{4}$/);
    assert.match(row.fees_paid, /^\d+$/);
    assert.equal(row.day, "2026-11-10");
  }
});

test("open() resumes from the file log, and live stamps never precede the last logged event", async () => {
  const logPath = join(await mkdtemp(join(tmpdir(), "arena-rt-")), "s.jsonl");
  {
    const { runtime } = await ArenaRuntime.open({ rules: SEASON_0, instruments: [BTC], startMs: T0, logPath, now: () => T0 + 5_000 });
    await runtime.register("alice");
    await runtime.market((at) => ctxAt(at, 100_000));
  }
  const { runtime, replayed } = await ArenaRuntime.open({
    rules: SEASON_0,
    instruments: [BTC],
    startMs: T0,
    logPath,
    now: () => T0, // the machine's clock is now behind the log
  });
  assert.equal(replayed, 2);
  assert.ok(runtime.engine.hasEntry("alice"));
  await runtime.clock(); // would throw "out of order" if stamped at T0
  assert.equal(runtime.engine.nowMs, T0 + 5_000);
});

test("a season file refuses to replay under changed rules", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "arena-season-")), "s.jsonl.season.json");
  const fresh = { slug: "season-0", startMs: T0, endMs: T0 + 1, instruments: [BTC], rulesHash: rulesHash(SEASON_0) };
  await freezeSeason(path, fresh);
  await freezeSeason(path, fresh); // same season: fine
  await assert.rejects(
    freezeSeason(path, { ...fresh, rulesHash: rulesHash({ ...SEASON_0, drawdownWeightBps: 5_000n }) }),
    /rules changed/
  );
});
