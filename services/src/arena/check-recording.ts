import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { checkRecording, type Manifest, manifestPath } from "./recording.ts";
import { SEASON_0 } from "./rules.ts";

/**
 * Replay a recorded day through the engine and summarise it.
 *
 *     npm run arena:check-recording -- ./arena-data/recorder/mainnet/2026-11-04.jsonl.gz
 *
 * Exits non-zero exactly where a season replay would fail: an unreadable line, or an
 * event out of order. The instruments come from the `recorder.json` beside the file.
 */

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) throw new Error("usage: check-recording <day.jsonl[.gz]>");
  const manifest = JSON.parse(await readFile(manifestPath(dirname(path)), "utf8")) as Manifest;

  const result = await checkRecording(path, manifest.instruments, SEASON_0);
  const span = result.firstMs === null || result.lastMs === null ? 0 : result.lastMs - result.firstMs;
  console.log(`${path}: ${result.events} events in order over ${(span / 60_000).toFixed(1)} min (${manifest.network})`);
  console.log(`  by kind: ${JSON.stringify(result.byKind)}`);
  if (result.firstMs !== null) console.log(`  from ${new Date(result.firstMs).toISOString()} to ${new Date(result.lastMs!).toISOString()}`);
  const gaps = Object.entries(result.longestBookGapMs).sort((a, b) => b[1] - a[1]);
  console.log(`  longest book gap: ${gaps.slice(0, 5).map(([coin, ms]) => `${coin} ${(ms / 1000).toFixed(1)}s`).join(", ") || "n/a"}`);
  const missing = manifest.instruments.map((i) => i.coin).filter((coin) => !(coin in result.longestBookGapMs));
  if (missing.length > 0) console.log(`  no books at all for: ${missing.join(", ")}`);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
