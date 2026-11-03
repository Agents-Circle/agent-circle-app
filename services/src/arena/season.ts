import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import type { Instrument } from "./market.ts";
import { canonicalRules, type SeasonRules } from "./rules.ts";

/**
 * Everything besides the input log that a replay needs, frozen at first start.
 *
 * The asset index of a coin is its position in Hyperliquid's `meta.universe`, which is not
 * documented as stable. If a restart re-read it and Hyperliquid had inserted a coin, every
 * replayed order would land on a different market. So the mapping, the season window and
 * a hash of the rules are written once, beside the log, and every later start — and every
 * independent replay — reads them from here instead of from the network.
 */
export type SeasonFile = {
  slug: string;
  startMs: number;
  endMs: number;
  instruments: Instrument[];
  /** SHA-256 of `canonicalRules(rules)`, published on the season page. */
  rulesHash: string;
};

export function rulesHash(rules: SeasonRules): string {
  return createHash("sha256").update(canonicalRules(rules)).digest("hex");
}

export function seasonFilePath(logPath: string): string {
  return `${logPath}.season.json`;
}

export async function readSeasonFile(path: string): Promise<SeasonFile | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as SeasonFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * The frozen season if there is one, after checking it still describes this season;
 * otherwise `fresh`, written down. A mismatch is fatal: carrying on would replay a log
 * under different rules from the ones it was recorded under.
 */
export async function freezeSeason(path: string, fresh: SeasonFile): Promise<SeasonFile> {
  const existing = await readSeasonFile(path);
  if (!existing) {
    await writeFile(path, JSON.stringify(fresh, null, 2) + "\n", { flag: "wx" });
    return fresh;
  }
  const problems: string[] = [];
  if (existing.slug !== fresh.slug) problems.push(`slug ${existing.slug} != ${fresh.slug}`);
  if (existing.rulesHash !== fresh.rulesHash) problems.push("the rules changed since the season started");
  if (existing.startMs !== fresh.startMs || existing.endMs !== fresh.endMs) {
    problems.push("the season window changed since the season started");
  }
  if (problems.length > 0) {
    throw new Error(`${path} does not match this season: ${problems.join("; ")}. Refusing to replay.`);
  }
  return existing;
}
