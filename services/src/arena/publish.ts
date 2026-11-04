import type { SupabaseClient } from "@supabase/supabase-js";

import { requireWrite } from "../shared/db.ts";
import type { ArenaEngine } from "./engine.ts";
import type { SeasonRules } from "./rules.ts";
import { rank, ratioNumeric, score, scoreNumeric, utcDay, type Score } from "./scoring.ts";

/**
 * The bridge from the engine to the tables the app reads.
 *
 * Scores are written as a *projection* of the engine, never as its state: everything in
 * `scores` can be recomputed from the input log, and a published row that disagrees with
 * a replay is the row that is wrong. So these writes are plain upserts, safe to repeat,
 * and losing one costs nothing but freshness.
 */

export type ScoreRow = {
  entry_id: string;
  day: string;
  net_return_bps: number;
  max_drawdown_bps: number;
  score: string;
  turnover_ratio: string;
  fees_paid: string;
  /** The engine's rank, with its tie-breaks. The leaderboard reads this, never re-ranks. */
  rank: number;
  eligible: boolean;
};

export type RankedEntry = { entryId: string; rank: number; score: Score };

/** Every entry's score as of now, best first, with the published tie-breaks applied. */
export function rankEntries(engine: ArenaEngine, rules: SeasonRules): RankedEntry[] {
  const scored = engine.entryIds().flatMap((entryId) => {
    const input = engine.scoreInput(entryId);
    if (!input) return [];
    return [{ entryId, registeredAtMs: input.registeredAtMs, score: score(input, rules) }];
  });
  return rank(scored).map((entry, i) => ({ entryId: entry.entryId, rank: i + 1, score: entry.score }));
}

/** One row per entry for `day`. The day is the UTC day of the engine's clock. */
export function scoreRows(ranked: readonly RankedEntry[], day: string): ScoreRow[] {
  return ranked.map(({ entryId, rank, score: s }) => ({
    entry_id: entryId,
    day,
    net_return_bps: Number(s.netReturnBps),
    max_drawdown_bps: Number(s.maxDrawdownBps),
    score: scoreNumeric(s.scoreBps),
    turnover_ratio: ratioNumeric(s.turnover),
    fees_paid: s.feesPaid.toString(),
    rank,
    eligible: s.eligible,
  }));
}

export async function publishScores(db: SupabaseClient, engine: ArenaEngine, rules: SeasonRules): Promise<number> {
  if (!Number.isFinite(engine.nowMs)) return 0; // nothing has happened yet
  const rows = scoreRows(rankEntries(engine, rules), utcDay(engine.nowMs));
  if (rows.length === 0) return 0;
  const result = await db.from("scores").upsert(rows, { onConflict: "entry_id,day", count: "exact" });
  requireWrite("scores upsert", result, rows.length);
  return rows.length;
}

export type SeasonRow = { id: number; slug: string; mode: string; starts_at: string; ends_at: string; status: string; rules_hash: string | null };

export async function loadSeason(db: SupabaseClient, slug: string): Promise<SeasonRow> {
  const { data, error } = await db
    .from("seasons")
    .select("id, slug, mode, starts_at, ends_at, status, rules_hash")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw new Error(`loading season ${slug}: ${error.message}`);
  if (!data) throw new Error(`season ${slug} does not exist. Create it in the seasons table first.`);
  const season = data as SeasonRow;
  if (season.mode !== "paper") {
    throw new Error(`season ${slug} is mode '${season.mode}'. This engine runs paper seasons only.`);
  }
  return season;
}

/**
 * API key hash → entry id, for the season's active entries.
 *
 * Reloaded on an interval rather than per request, so a database blip does not lock every
 * agent out mid-season, and a disqualification takes effect within one interval.
 */
export class EntryDirectory {
  readonly #db: SupabaseClient;
  readonly #seasonId: number;
  #byHash = new Map<string, string>();

  constructor(db: SupabaseClient, seasonId: number) {
    this.#db = db;
    this.#seasonId = seasonId;
  }

  get size(): number {
    return this.#byHash.size;
  }

  async reload(): Promise<void> {
    const { data, error } = await this.#db
      .from("entries")
      .select("id, api_key_hash")
      .eq("season_id", this.#seasonId)
      .eq("status", "active")
      .not("api_key_hash", "is", null);
    if (error) throw new Error(`loading entries: ${error.message}`);
    this.#byHash = new Map((data as { id: string; api_key_hash: string }[]).map((row) => [row.api_key_hash, row.id]));
  }

  resolve = (hash: string): string | null => this.#byHash.get(hash) ?? null;
}
