import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { InputEvent } from "./engine.ts";
import { encodeEvent, lastEventMs, readLog, repairTornTail, Sequencer } from "./inputlog.ts";
import {
  checkRecording,
  chooseInstruments,
  compressDay,
  daySink,
  freezeManifest,
  type Manifest,
  type MetaAndAssetCtxs,
  resumePoint,
} from "./recording.ts";
import { SEASON_0 } from "./rules.ts";

async function scratchDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "arena-rec-"));
}

const snapshot: MetaAndAssetCtxs = [
  {
    universe: [
      { name: "BTC", szDecimals: 5 },
      { name: "ETH", szDecimals: 4 },
      { name: "OLD", szDecimals: 0, isDelisted: true },
      { name: "SOL", szDecimals: 2 },
      { name: "HYPE", szDecimals: 2 },
      { name: "TINY", szDecimals: 0 },
    ],
  },
  [
    { openInterest: "100", markPx: "100000" }, // 10M
    { openInterest: "1000", markPx: "3000" }, // 3M
    { openInterest: "1e9", markPx: "1" }, // largest, but delisted
    { openInterest: "10", markPx: "150" }, // tiny, but always recorded
    { openInterest: "200000", markPx: "40" }, // 8M
    { openInterest: "5", markPx: "1" },
  ],
];

const book = (coin: string, atMs: number): InputEvent => ({
  kind: "book",
  atMs,
  book: { coin, timeMs: atMs, bids: [{ px: 99n * 10n ** 8n, sz: 10n ** 8n }], asks: [{ px: 101n * 10n ** 8n, sz: 10n ** 8n }] },
});

test("BTC, ETH and SOL are always recorded, then open interest; delisted perps never are", () => {
  const chosen = chooseInstruments(snapshot, 4);
  assert.deepEqual(
    chosen.map((i) => [i.coin, i.asset]),
    [
      ["BTC", 0],
      ["ETH", 1],
      ["SOL", 3],
      ["HYPE", 4],
    ]
  );
  assert.equal(chooseInstruments(snapshot, 50).some((i) => i.coin === "OLD"), false);
});

test("an explicit coin list replaces the ranking, and an unknown coin is refused", () => {
  assert.deepEqual(chooseInstruments(snapshot, 4, ["TINY"]).map((i) => i.coin), ["TINY"]);
  assert.throws(() => chooseInstruments(snapshot, 4, ["NOPE"]), /NOPE is not a listed perp/);
  assert.throws(() => chooseInstruments(snapshot, 4, ["OLD"]), /OLD is not a listed perp/);
});

test("the manifest is frozen at first start and a restart reads it back", async () => {
  const dir = await scratchDir();
  const first: Manifest = { network: "mainnet", instruments: chooseInstruments(snapshot, 3), chosenAtMs: 1, rankedBy: "test" };
  assert.equal((await freezeManifest(dir, async () => first)).created, true);
  const again = await freezeManifest(dir, async () => ({ ...first, instruments: [] }));
  assert.equal(again.created, false);
  assert.deepEqual(again.manifest, first);
});

test("events land in the file for their own UTC day, and each closed day is reported once", async () => {
  const dir = await scratchDir();
  const opened: [string, string | null][] = [];
  const midnight = Date.parse("2026-11-05T00:00:00Z");
  const clock = [midnight - 2, midnight - 1, midnight, midnight + 1];
  const seq = new Sequencer({ sink: daySink(dir, (day, closed) => opened.push([day, closed])), apply: () => {}, now: () => clock.shift()! });
  for (let i = 0; i < 4; i += 1) await seq.accept((atMs) => book("BTC", atMs));

  assert.deepEqual(opened, [
    ["2026-11-04", null],
    ["2026-11-05", join(dir, "2026-11-04.jsonl")],
  ]);
  assert.equal((await readFile(join(dir, "2026-11-04.jsonl"), "utf8")).trim().split("\n").length, 2);
  assert.equal((await readFile(join(dir, "2026-11-05.jsonl"), "utf8")).trim().split("\n").length, 2);
});

test("a restart resumes after the last event of the newest day and hands back older plain days", async () => {
  const dir = await scratchDir();
  await writeFile(join(dir, "2026-11-04.jsonl"), encodeEvent(book("BTC", 10)) + "\n");
  await writeFile(join(dir, "2026-11-05.jsonl"), encodeEvent(book("BTC", 20)) + "\n" + encodeEvent(book("ETH", 30)) + "\n" + '{"kind":"bo');

  const { resumeAfterMs, stale } = await resumePoint(dir);
  assert.equal(resumeAfterMs, 30); // the torn tail was trimmed first
  assert.deepEqual(stale, [join(dir, "2026-11-04.jsonl")]);
  assert.equal(await resumePoint(await scratchDir()).then((r) => r.resumeAfterMs), null);
});

test("tail repair and last-event reads work on a file far larger than one read window", async () => {
  const dir = await scratchDir();
  const path = join(dir, "big.jsonl");
  const lines = Array.from({ length: 3_000 }, (_, i) => encodeEvent(book("BTC", i)));
  await writeFile(path, lines.join("\n") + "\n" + '{"kind":"book","atMs":99');
  assert.equal(await repairTornTail(path), true);
  assert.equal(await lastEventMs(path), 2_999);
  assert.equal(await repairTornTail(path), false);
});

test("a compressed day replays through readLog exactly as the plain one did", async () => {
  const dir = await scratchDir();
  const path = join(dir, "2026-11-04.jsonl");
  const events = [book("BTC", 1), book("ETH", 2), { kind: "clock", atMs: 3 } as InputEvent];
  await writeFile(path, events.map(encodeEvent).join("\n") + "\n");

  const archive = await compressDay(path);
  assert.deepEqual(await readdir(dir), ["2026-11-04.jsonl.gz"]);
  const back: InputEvent[] = [];
  for await (const e of readLog(archive)) back.push(e);
  assert.deepEqual(back, events);
});

test("a recorded day replays through the engine, and an out-of-order day refuses to", async () => {
  const dir = await scratchDir();
  const instruments = chooseInstruments(snapshot, 3);
  const good = join(dir, "good.jsonl");
  await writeFile(good, [book("BTC", 1_000), book("TINY", 1_500), book("BTC", 4_000), book("ETH", 4_500)].map(encodeEvent).join("\n") + "\n");
  const result = await checkRecording(good, instruments, SEASON_0);
  assert.equal(result.events, 4);
  assert.deepEqual(result.longestBookGapMs, { BTC: 3_000 });

  const bad = join(dir, "bad.jsonl");
  await writeFile(bad, [book("BTC", 2_000), book("BTC", 1_000)].map(encodeEvent).join("\n") + "\n");
  await assert.rejects(checkRecording(bad, instruments, SEASON_0), /input log is out of order/);
});
