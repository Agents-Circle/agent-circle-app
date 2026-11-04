import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

import type { Logger } from "../shared/log.ts";
import { ArenaEngine, type InputEvent } from "./engine.ts";
import { decodeEvent, lastEventMs, readLog, repairTornTail, type Sink } from "./inputlog.ts";
import type { Instrument } from "./market.ts";
import type { SeasonRules } from "./rules.ts";

/**
 * The market-data recorder: Hyperliquid's public feed, written to disk before any season
 * exists, in exactly the format a season's input log uses.
 *
 * `plans/arena-season0.md` §8 wants it running for seven days before the start, for two
 * reasons: replay tests on real data (the week-2 exit criterion), and evidence that the
 * feed is stable enough to score a season on. So a recorded day is an input log in all but
 * name — the same `InputEvent` lines, the same encoding, the same monotonic clock — and
 * replays through `ArenaEngine` unchanged.
 *
 * ## A superset, not the season
 *
 * The season's universe is "BTC, ETH, SOL and the next roughly seven perps by open
 * interest", frozen at the start, and that list is not decided yet. The recorder takes the
 * top N by open interest at its first start — more than the season will use — and freezes
 * that list in `recorder.json`, so a restart never changes what a day contains. The
 * engine ignores coins outside its instruments, so any season drawn from the superset
 * replays from these files.
 *
 * ## Days
 *
 * One file per UTC day, `YYYY-MM-DD.jsonl`, chosen by each event's own stamped time. A
 * finished day is gzipped to `.jsonl.gz` (which `readLog` reads directly) and its plain
 * file removed only once the archive is complete. A day's `.meta.json` holds the
 * `metaAndAssetCtxs` snapshot taken when it opened: tick and lot rules, and open interest.
 */

export const ALWAYS_RECORDED = ["BTC", "ETH", "SOL"] as const;

export type Manifest = {
  network: "mainnet" | "testnet";
  /** Ranked by open interest at `chosenAtMs`, `ALWAYS_RECORDED` first. */
  instruments: Instrument[];
  chosenAtMs: number;
  rankedBy: string;
};

type UniverseEntry = { name: string; szDecimals: number; isDelisted?: boolean };
type AssetCtx = { openInterest: string; markPx: string };
export type MetaAndAssetCtxs = [{ universe: UniverseEntry[] }, AssetCtx[]];

/**
 * The coins to record: `ALWAYS_RECORDED`, then the most open interest (in notional,
 * `openInterest × markPx`) until there are `top`. Delisted perps are never chosen.
 * `explicit`, if given, replaces the ranking and every coin in it must exist.
 */
export function chooseInstruments(snapshot: MetaAndAssetCtxs, top: number, explicit?: readonly string[]): Instrument[] {
  const [meta, contexts] = snapshot;
  const listed = meta.universe
    .map((u, asset) => ({ u, asset, oi: Number(contexts[asset]?.openInterest ?? 0) * Number(contexts[asset]?.markPx ?? 0) }))
    .filter(({ u }) => !u.isDelisted);
  const byName = new Map(listed.map((row) => [row.u.name, row]));
  const instrument = (row: (typeof listed)[number]): Instrument => ({ coin: row.u.name, asset: row.asset, szDecimals: row.u.szDecimals });

  if (explicit && explicit.length > 0) {
    return explicit.map((coin) => {
      const row = byName.get(coin);
      if (!row) throw new Error(`${coin} is not a listed perp`);
      return instrument(row);
    });
  }

  const chosen: Instrument[] = [];
  for (const coin of ALWAYS_RECORDED) {
    const row = byName.get(coin);
    if (row) chosen.push(instrument(row));
  }
  for (const row of [...listed].sort((a, b) => b.oi - a.oi)) {
    if (chosen.length >= top) break;
    if (!chosen.some((c) => c.coin === row.u.name)) chosen.push(instrument(row));
  }
  return chosen;
}

export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export function manifestPath(dir: string): string {
  return join(dir, "recorder.json");
}

/** The manifest from an earlier start, or this start's choice written as the manifest. */
export async function freezeManifest(dir: string, fresh: () => Promise<Manifest>): Promise<{ manifest: Manifest; created: boolean }> {
  try {
    return { manifest: JSON.parse(await readFile(manifestPath(dir), "utf8")) as Manifest, created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const manifest = await fresh();
  await mkdir(dir, { recursive: true });
  const tmp = `${manifestPath(dir)}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  await rename(tmp, manifestPath(dir));
  return { manifest, created: true };
}

/** gzip `path` to `path.gz`, then remove `path`. A half-written archive is never left as the only copy. */
export async function compressDay(path: string): Promise<string> {
  const archive = `${path}.gz`;
  const partial = `${archive}.partial`;
  await pipeline(createReadStream(path), createGzip({ level: 6 }), createWriteStream(partial));
  await rename(partial, archive);
  await unlink(path);
  return archive;
}

/**
 * Where a restart picks up: the newest plain day file, its torn tail repaired, and the
 * time of its last event so the clock never steps back. Any older plain day is a day a
 * crash left uncompressed, returned for compressing.
 */
export async function resumePoint(dir: string): Promise<{ resumeAfterMs: number | null; stale: string[] }> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { resumeAfterMs: null, stale: [] };
    throw error;
  }
  const days = names.filter((n) => DAY_FILE.test(n)).sort();
  const latest = days[days.length - 1];
  if (latest === undefined) return { resumeAfterMs: null, stale: [] };
  const path = join(dir, latest);
  await repairTornTail(path);
  return { resumeAfterMs: await lastEventMs(path), stale: days.slice(0, -1).map((n) => join(dir, n)) };
}

/**
 * A sink that writes each line to the file for its event's UTC day. Called by the
 * `Sequencer` in stamp order, so a day's file is closed for good the moment the first
 * line of the next day is written, and `onDayClosed` runs then.
 */
export function daySink(dir: string, onDayOpened: (day: string, closed: string | null) => void): Sink {
  let current: string | null = null;
  let ready: Promise<unknown> | null = null;
  return async (line) => {
    ready ??= mkdir(dir, { recursive: true });
    await ready;
    const day = dayOf(decodeEvent(line).atMs);
    if (day !== current) {
      const closed = current;
      current = day;
      onDayOpened(day, closed === null ? null : join(dir, `${closed}.jsonl`));
    }
    await appendFile(join(dir, `${day}.jsonl`), line + "\n", "utf8");
  };
}

export type RecordingCheck = {
  events: number;
  byKind: Record<string, number>;
  firstMs: number | null;
  lastMs: number | null;
  /** Per coin, the longest stretch with no book, in ms. Long ones are outages to note. */
  longestBookGapMs: Record<string, number>;
};

/**
 * Replay a recorded day through the engine, as a season would, and summarise it. Throws
 * exactly where a season replay would: on an unreadable line, or an event out of order.
 */
export async function checkRecording(path: string, instruments: readonly Instrument[], rules: SeasonRules): Promise<RecordingCheck> {
  const engine = new ArenaEngine({ rules, instruments, startMs: 0 });
  const byKind: Record<string, number> = {};
  const lastBook = new Map<string, number>();
  const longestBookGapMs: Record<string, number> = {};
  let events = 0;
  let firstMs: number | null = null;
  let lastMs: number | null = null;

  for await (const event of readLog(path)) {
    engine.handle(event);
    events += 1;
    byKind[event.kind] = (byKind[event.kind] ?? 0) + 1;
    firstMs ??= event.atMs;
    lastMs = event.atMs;
    if (event.kind === "book") {
      const coin = event.book.coin;
      const prev = lastBook.get(coin);
      if (prev !== undefined) longestBookGapMs[coin] = Math.max(longestBookGapMs[coin] ?? 0, event.atMs - prev);
      lastBook.set(coin, event.atMs);
    }
  }
  return { events, byKind, firstMs, lastMs, longestBookGapMs };
}

/** Counts and freshness for the heartbeat log line. */
export class RecorderStats {
  readonly #byKind = new Map<string, number>();
  #lastEventMs: number | null = null;

  count(event: InputEvent): void {
    this.#byKind.set(event.kind, (this.#byKind.get(event.kind) ?? 0) + 1);
    this.#lastEventMs = event.atMs;
  }

  /** The counts since the last call, and how long since any event. */
  drain(nowMs: number): { counts: Record<string, number>; silentMs: number | null } {
    const counts = Object.fromEntries(this.#byKind);
    this.#byKind.clear();
    return { counts, silentMs: this.#lastEventMs === null ? null : nowMs - this.#lastEventMs };
  }
}

export async function writeDayMeta(dir: string, day: string, snapshot: unknown, log: Logger): Promise<void> {
  const path = join(dir, `${day}.meta.json`);
  try {
    await stat(path);
    return; // the day's first snapshot is the one that counts
  } catch {
    // not written yet
  }
  await writeFile(path, JSON.stringify({ takenAtMs: Date.now(), metaAndAssetCtxs: snapshot }) + "\n");
  log.info("day meta written", { day });
}

/** Read a gzipped or plain day back as text lines. For tests and ad-hoc inspection. */
export async function readDayLines(path: string): Promise<string[]> {
  const chunks: Buffer[] = [];
  const source = createReadStream(path);
  const stream = path.endsWith(".gz") ? source.pipe(createGunzip()) : source;
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").split("\n").filter(Boolean);
}
