import { formatScaled } from "../shared/units.ts";
import { ArenaEngine } from "./engine.ts";
import { readLog } from "./inputlog.ts";
import { rankEntries } from "./publish.ts";
import { SEASON_0 } from "./rules.ts";
import { scoreNumeric } from "./scoring.ts";
import { readSeasonFile, rulesHash, seasonFilePath } from "./season.ts";

/**
 * The independent scorer: replay a season's log and print the final ranking.
 *
 *     npm run arena:replay -- ./arena-data/season-0.jsonl
 *
 * Needs nothing but the log and its `.season.json`: no network, no database, no keys.
 * Run it before any prize is paid, ideally on a different machine from the live
 * process. A ranking that differs from the published one means the published one is wrong.
 */

async function main(): Promise<void> {
  const logPath = process.argv[2];
  if (!logPath) throw new Error("usage: replay <input-log.jsonl>");

  const season = await readSeasonFile(seasonFilePath(logPath));
  if (!season) throw new Error(`${seasonFilePath(logPath)} not found; it is written at the season's first start`);
  if (season.rulesHash !== rulesHash(SEASON_0)) {
    throw new Error("these rules are not the ones the season was recorded under (rules hash differs)");
  }

  const engine = new ArenaEngine({
    rules: SEASON_0,
    instruments: season.instruments,
    startMs: season.startMs,
    endMs: season.endMs,
  });
  let events = 0;
  for await (const event of readLog(logPath)) {
    engine.handle(event);
    events += 1;
  }

  console.log(`season ${season.slug}: ${events} events replayed, rules ${season.rulesHash.slice(0, 16)}…`);
  for (const { entryId, rank, score } of rankEntries(engine, SEASON_0)) {
    console.log(
      [
        String(rank).padStart(3),
        entryId,
        `score ${scoreNumeric(score.scoreBps)}`,
        `return ${score.netReturnBps}bps`,
        `mdd ${score.maxDrawdownBps}bps`,
        `fees ${formatScaled(score.feesPaid, 6)}`,
        score.eligible ? "eligible" : "not eligible",
      ].join("  ")
    );
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
