import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { once } from "node:events";
import { parseArgs } from "node:util";
import { createGzip } from "node:zlib";

import { formatScaled } from "../shared/units.ts";
import { DAY_TIMING, isHouseEntry, withHouseEntries } from "./baselines.ts";
import { ArenaEngine, type InputEvent, type OutputEvent } from "./engine.ts";
import { encodeEvent, readLog } from "./inputlog.ts";
import type { Instrument } from "./market.ts";
import { rankEntries } from "./publish.ts";
import { type Manifest, manifestPath } from "./recording.ts";
import { DAY_MS, MINUTE_MS, SEASON_0 } from "./rules.ts";
import { scoreNumeric } from "./scoring.ts";
import { rulesHash, seasonFilePath, type SeasonFile } from "./season.ts";

/**
 * The house baselines over a recorded day: the week-2 check, "a replay of one recorded
 * day reproduces the expected fills".
 *
 *     npm run arena:baselines -- ../arena-data/recorder/mainnet/2026-11-04.jsonl.gz
 *     npm run arena:baselines -- <day> --coins BTC,ETH,SOL --seed house-0 --random 3 --out season.jsonl.gz
 *
 * Merges the house entries into the day, replays the result through the engine, and
 * prints every fill, the final ranking, and a SHA-256 over every output event. Run it
 * twice, or on another machine: the digest must not change. `--out` also writes the
 * merged season log and its `.season.json`, so `npm run arena:replay -- <out>` ranks the
 * same entries from the log alone.
 *
 * The instruments come from the `recorder.json` beside the day. The season runs from the
 * minute of the day's first event to the end of its UTC day. The day is streamed, so
 * nothing but the engine's own state is held in memory.
 */

const USAGE = "usage: arena:baselines <day.jsonl[.gz]> [--coins BTC,ETH,SOL] [--seed house-0] [--random 3] [--out season.jsonl[.gz]]";

function encode(event: OutputEvent): string {
  return JSON.stringify(event, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
}

/** A 1e8 price or size without its trailing zeros: `78366`, `0.01527`. */
function decimal(value: bigint): string {
  return formatScaled(value, 8).replace(/\.?0+$/, "");
}

async function* peeked(first: InputEvent, rest: AsyncIterator<InputEvent>): AsyncGenerator<InputEvent> {
  yield first;
  for (;;) {
    const next = await rest.next();
    if (next.done) return;
    yield next.value;
  }
}

/** Writes lines with backpressure, gzipped if the path ends `.gz`. */
function lineWriter(path: string) {
  const file = createWriteStream(path);
  const gzip = path.endsWith(".gz") ? createGzip({ level: 6 }) : null;
  if (gzip) gzip.pipe(file);
  const sink = gzip ?? file;
  return {
    async write(line: string): Promise<void> {
      if (!sink.write(line + "\n")) await once(sink, "drain");
    },
    async close(): Promise<void> {
      sink.end();
      await once(file, "finish");
    },
  };
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      coins: { type: "string" },
      seed: { type: "string", default: "house-0" },
      random: { type: "string", default: "3" },
      out: { type: "string" },
    },
  });
  const path = positionals[0];
  if (!path) throw new Error(USAGE);

  const manifest = JSON.parse(await readFile(manifestPath(dirname(path)), "utf8")) as Manifest;
  let instruments: Instrument[] = manifest.instruments;
  if (values.coins) {
    const wanted = values.coins.split(",").map((coin) => coin.trim());
    instruments = wanted.map((coin) => {
      const instrument = manifest.instruments.find((i) => i.coin === coin);
      if (!instrument) throw new Error(`${coin} is not in ${manifestPath(dirname(path))}`);
      return instrument;
    });
  }
  const randomEntries = Number(values.random);
  if (!Number.isInteger(randomEntries) || randomEntries < 0) throw new Error(`--random must be a whole number, not ${values.random}`);

  const events = readLog(path)[Symbol.asyncIterator]();
  const first = await events.next();
  if (first.done) throw new Error(`${path} has no events`);
  const startMs = Math.floor(first.value.atMs / MINUTE_MS) * MINUTE_MS;
  const endMs = Math.floor(first.value.atMs / DAY_MS) * DAY_MS + DAY_MS;

  const coinOf = new Map(instruments.map((i) => [i.asset, i.coin]));
  const seasonCoins = new Set(instruments.map((i) => i.coin));
  const digest = createHash("sha256");
  const fills = new Map<string, number>();
  const outcomes = new Map<string, number>();
  /// What the engine refused under the stale-book rule. The authoritative count, because
  /// it is the engine's own decision rather than this file's reconstruction of it.
  let staleRefusals = 0;
  /// Prints that arrived before the asset's first book. Expected at the open, and not a
  /// stale book - kept separate so it cannot be mistaken for the rule binding.
  let noBookRefusals = 0;
  const engine = new ArenaEngine({
    rules: SEASON_0,
    instruments,
    startMs,
    endMs,
    emit: (event) => {
      digest.update(encode(event) + "\n");
      if (event.kind === "rejected") outcomes.set(`rejected ${event.reason}`, (outcomes.get(`rejected ${event.reason}`) ?? 0) + 1);
      if (event.kind === "order_done") outcomes.set(event.why, (outcomes.get(event.why) ?? 0) + 1);
      if (event.kind === "gap" && event.what === "stale_book") staleRefusals += 1;
      if (event.kind === "gap" && event.what === "no_book") noBookRefusals += 1;
      if (event.kind !== "fill") return;
      fills.set(event.entryId, (fills.get(event.entryId) ?? 0) + 1);
      console.log(
        [
          new Date(event.atMs).toISOString(),
          event.entryId.padEnd(16),
          `#${event.cloid}`.padEnd(4),
          (coinOf.get(event.asset) ?? String(event.asset)).padEnd(5),
          event.isBuy ? "buy " : "sell",
          event.liquidity,
          `${decimal(event.sz)} @ ${decimal(event.px)}`,
          `notional ${formatScaled(event.notional, 6)}`,
          `fees ${formatScaled(event.venueFee, 6)} + ${formatScaled(event.executionFee, 6)}`,
        ].join("  ")
      );
    },
  });

  const out = values.out ? lineWriter(values.out) : null;
  const lastBook = new Map<string, number>();
  const longestGap = new Map<string, number>();
  /// Books that were already past `staleBookMs` when they arrived, by their own
  /// timestamp. This is the quantity the rule tests; the gap between consecutive books
  /// below is a different thing and is reported separately.
  const staleOnArrival = new Map<string, number>();
  let count = 0;
  let houseInputs = 0;
  let lastMs = startMs;

  console.log(`${path}: ${instruments.length} coins (${instruments.map((i) => i.coin).join(", ")}), seed ${values.seed}, ${randomEntries} random entries`);
  console.log(`season ${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}, rules ${rulesHash(SEASON_0).slice(0, 16)}…\n`);

  const merged = withHouseEntries(peeked(first.value, events), {
    rules: SEASON_0,
    instruments,
    startMs,
    endMs,
    seed: values.seed,
    randomEntries,
    timing: DAY_TIMING,
  });
  for await (const event of merged) {
    if (out) await out.write(encodeEvent(event));
    engine.handle(event);
    count += 1;
    lastMs = event.atMs;
    if (event.kind === "register" || event.kind === "submit" || event.kind === "cancel") houseInputs += 1;
    if (event.kind === "book" && seasonCoins.has(event.book.coin)) {
      const coin = event.book.coin;
      const prev = lastBook.get(coin);
      if (prev !== undefined) {
        const gap = event.atMs - prev;
        if (gap > (longestGap.get(coin) ?? 0)) longestGap.set(coin, gap);
      }
      if (event.atMs - event.book.timeMs > SEASON_0.staleBookMs) {
        staleOnArrival.set(coin, (staleOnArrival.get(coin) ?? 0) + 1);
      }
      lastBook.set(coin, event.atMs);
    }
  }
  await out?.close();

  console.log(`\n${count} events replayed (${houseInputs} from the house) to ${new Date(lastMs).toISOString()}`);
  console.log(`orders: ${[...outcomes].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
  const gaps = [...longestGap].sort((a, b) => b[1] - a[1]);
  console.log(`longest book gap: ${gaps.slice(0, 3).map(([coin, ms]) => `${coin} ${(ms / 1000).toFixed(1)}s`).join(", ") || "n/a"}`);
  // Two different numbers, and conflating them is how the old version of this line came
  // to claim the rule did nothing. The gap between books is feed health: a long one means
  // the recorder or the socket stalled. What the rule tests is each book's own age on
  // arrival, and what it did is the engine's refusal count.
  const staleArrivals = [...staleOnArrival.values()].reduce((a, b) => a + b, 0);
  const limit = SEASON_0.staleBookMs / 1000;
  console.log(
    `stale books (older than ${limit}s when received): ${staleArrivals}; ` +
      `refused on a stale book ${staleRefusals} times, ` +
      `on no book yet ${noBookRefusals} times (prints before the first snapshot)\n`
  );

  for (const { entryId, rank, score } of rankEntries(engine, SEASON_0)) {
    console.log(
      [
        String(rank).padStart(3),
        entryId.padEnd(16),
        `score ${scoreNumeric(score.scoreBps)}`,
        `return ${score.netReturnBps}bps`,
        `mdd ${score.maxDrawdownBps}bps`,
        `fills ${fills.get(entryId) ?? 0}`,
        `fees ${formatScaled(score.feesPaid, 6)}`,
        isHouseEntry(entryId) ? "house, not prize-eligible" : score.eligible ? "eligible" : "not eligible",
      ].join("  ")
    );
  }
  console.log(`\noutput sha256 ${digest.digest("hex")}`);

  if (values.out) {
    const season: SeasonFile = { slug: `house-baselines-${new Date(startMs).toISOString().slice(0, 10)}`, startMs, endMs, instruments, rulesHash: rulesHash(SEASON_0) };
    await writeFile(seasonFilePath(values.out), JSON.stringify(season, null, 2) + "\n", { flag: "wx" });
    console.log(`season log written to ${values.out}; check it with: npm run arena:replay -- ${values.out}`);
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
