import { supabase, isSupabaseConfigured } from "./supabaseClient";
import type { FeedFailure } from "./agents";

/**
 * Circle Arena reads: a season and its leaderboard.
 *
 * Kept apart from `lib/agents.ts` on purpose. Arena seasons are paper (Season 0) or lite
 * (Season 1) and their numbers are not on-chain track records; the marketplace
 * leaderboard ranks on-chain fills only. Nothing here may feed `agents.agent_score`, and
 * nothing in `lib/agents.ts` may read the Arena tables (plans/arena-season0.md §4).
 *
 * The ranks come from the `arena_leaderboard` view, which carries the engine's own rank
 * and eligibility as published to `scores`. The page never re-ranks: a second ordering
 * would be a second set of tie-breaks, and the replay is the authority.
 */

export const PAPER_LABEL =
  "Paper trading. Simulated fills on live Hyperliquid prices. No funds at risk. Not an on-chain track record.";

export type ArenaSeason = {
  slug: string;
  name: string;
  number: number;
  mode: "paper" | "lite" | "vault" | "fast";
  status: "draft" | "open" | "running" | "scored" | "closed";
  startsAt: string;
  endsAt: string;
  rulesHash: string | null;
  scoringNotes: string | null;
};

export type ArenaRow = {
  entryId: string;
  rank: number | null;
  displayName: string;
  builderWallet: string;
  day: string;
  netReturnBps: number;
  maxDrawdownBps: number;
  score: string;
  eligible: boolean;
  computedAt: string;
};

export type ArenaSeasonFeed =
  | { ok: true; season: ArenaSeason | null; rows: ArenaRow[] }
  | { ok: false; reason: FeedFailure };

type SeasonRow = {
  slug: string;
  name: string;
  number: number;
  mode: ArenaSeason["mode"];
  status: ArenaSeason["status"];
  starts_at: string;
  ends_at: string;
  rules_hash: string | null;
  scoring_notes: string | null;
};

type LeaderboardRow = {
  entry_id: string;
  rank: number | null;
  display_name: string;
  builder_wallet: string;
  day: string;
  net_return_bps: number;
  max_drawdown_bps: number;
  score: string;
  eligible: boolean;
  computed_at: string;
};

export async function getArenaSeason(slug: string): Promise<ArenaSeasonFeed> {
  if (!isSupabaseConfigured) return { ok: false, reason: "unconfigured" };

  const season = await supabase
    .from("seasons")
    .select("slug, name, number, mode, status, starts_at, ends_at, rules_hash, scoring_notes")
    .eq("slug", slug)
    .maybeSingle();
  if (season.error) return { ok: false, reason: "unavailable" };
  if (!season.data) return { ok: true, season: null, rows: [] };

  const board = await supabase
    .from("arena_leaderboard")
    .select("entry_id, rank, display_name, builder_wallet, day, net_return_bps, max_drawdown_bps, score, eligible, computed_at")
    .eq("season_slug", slug)
    .order("rank", { ascending: true, nullsFirst: false });
  if (board.error || !board.data) return { ok: false, reason: "unavailable" };

  const s = season.data as SeasonRow;
  return {
    ok: true,
    season: {
      slug: s.slug,
      name: s.name,
      number: s.number,
      mode: s.mode,
      status: s.status,
      startsAt: s.starts_at,
      endsAt: s.ends_at,
      rulesHash: s.rules_hash,
      scoringNotes: s.scoring_notes,
    },
    rows: (board.data as LeaderboardRow[]).map((r) => ({
      entryId: r.entry_id,
      rank: r.rank,
      displayName: r.display_name,
      builderWallet: r.builder_wallet,
      day: r.day,
      netReturnBps: r.net_return_bps,
      maxDrawdownBps: r.max_drawdown_bps,
      score: r.score,
      eligible: r.eligible,
      computedAt: r.computed_at,
    })),
  };
}

/** Signed basis points as a percentage, two decimals, without going through a float. */
export function formatBpsPct(bps: number): string {
  const negative = bps < 0;
  const abs = Math.abs(Math.trunc(bps));
  return `${negative ? "−" : bps > 0 ? "+" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}%`;
}

export function shortWallet(wallet: string): string {
  return wallet.length > 12 ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : wallet;
}
