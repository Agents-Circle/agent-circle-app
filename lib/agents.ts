import { supabase, isSupabaseConfigured } from "./supabaseClient";
import type { Agent, MarketCategory } from "./types";

/**
 * Why a read of the catalogue produced no rows.
 *
 * `unconfigured` means this deployment has no Supabase credentials. `unavailable` means it
 * has them and the query failed.
 *
 * Both of these used to resolve to `MOCK_AGENTS`: four invented agents with invented
 * returns, rendered with nothing to mark them as fictional. The second case was the worse
 * one, because it needed no misconfiguration at all — a single failed query in production
 * was enough to publish fabricated performance on the leaderboard.
 *
 * A marketplace that quotes track records cannot answer "we could not read the data" with
 * made-up data, so failure is part of the return type and every caller has to say something
 * true about it. The empty states in `LeaderboardTable` and `AgentsGrid` can then mean what
 * they say — that there are genuinely no agents — rather than standing in for a failure.
 */
export type FeedFailure = "unconfigured" | "unavailable";

export type AgentFeed = { ok: true; agents: Agent[] } | { ok: false; reason: FeedFailure };

/** `agent: null` is a real 404. A failure is not, which is why the two are separate. */
export type AgentLookup = { ok: true; agent: Agent | null } | { ok: false; reason: FeedFailure };

type AgentRow = {
  id: string;
  slug: string;
  name: string;
  market: MarketCategory;
  status: "live" | "vetting" | "paused";
  description: string;
  agent_score: number;
  win_rate: number;
  consistency: number;
  max_drawdown: number;
  total_return: number;
  trader_count: number;
  listing_fee_bps: number;
  performance_fee_bps: number;
  position_cap_pct: number;
  max_drawdown_limit_pct: number;
  auto_pause: boolean;
  builders: { name: string; builder_score: number } | null;
};

/**
 * History is best-effort: an unreadable snapshot table yields an empty series, which draws
 * no sparkline. That is a missing chart rather than a wrong one, so unlike the agent rows
 * themselves it does not need to fail the whole read.
 */
async function fetchHistoryByAgentId(agentIds: string[]) {
  if (agentIds.length === 0) return new Map<string, number[]>();

  const { data, error } = await supabase
    .from("performance_snapshots")
    .select("agent_id, recorded_at, return_pct")
    .in("agent_id", agentIds)
    .order("recorded_at", { ascending: true });

  if (error || !data) return new Map<string, number[]>();

  const byAgent = new Map<string, number[]>();
  for (const row of data) {
    const list = byAgent.get(row.agent_id) ?? [];
    if (row.return_pct !== null) list.push(Number(row.return_pct));
    byAgent.set(row.agent_id, list);
  }
  return byAgent;
}

function toAgent(row: AgentRow, rank: number, history: number[]): Agent {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    builder: {
      name: row.builders?.name ?? "Unknown builder",
      builderScore: row.builders?.builder_score ?? 0,
    },
    market: row.market,
    status: row.status,
    description: row.description,
    agentScore: Number(row.agent_score),
    winRate: Number(row.win_rate),
    consistency: Number(row.consistency),
    maxDrawdown: Number(row.max_drawdown),
    totalReturn: Number(row.total_return),
    rank,
    traderCount: row.trader_count,
    listingFeeBps: row.listing_fee_bps,
    performanceFeeBps: row.performance_fee_bps,
    history,
    riskDefaults: {
      positionCapPct: Number(row.position_cap_pct),
      maxDrawdownPct: Number(row.max_drawdown_limit_pct),
      autoPause: row.auto_pause,
    },
  };
}

export async function getAllAgents(): Promise<AgentFeed> {
  if (!isSupabaseConfigured) return { ok: false, reason: "unconfigured" };

  const { data, error } = await supabase
    .from("agents")
    .select(
      "id, slug, name, market, status, description, agent_score, win_rate, consistency, max_drawdown, total_return, trader_count, listing_fee_bps, performance_fee_bps, position_cap_pct, max_drawdown_limit_pct, auto_pause, builders ( name, builder_score )"
    )
    .order("agent_score", { ascending: false });

  if (error || !data) return { ok: false, reason: "unavailable" };

  const rows = data as unknown as AgentRow[];
  const historyByAgent = await fetchHistoryByAgentId(rows.map((r) => r.id));

  let liveRank = 0;
  const agents = rows.map((row) => {
    if (row.status === "live") liveRank += 1;
    return toAgent(row, row.status === "live" ? liveRank : 0, historyByAgent.get(row.id) ?? []);
  });

  return { ok: true, agents };
}

export async function getLeaderboardAgents(): Promise<AgentFeed> {
  const feed = await getAllAgents();
  if (!feed.ok) return feed;
  return { ok: true, agents: feed.agents.filter((agent) => agent.status === "live") };
}

export async function getAgentBySlug(slug: string): Promise<AgentLookup> {
  const feed = await getAllAgents();
  if (!feed.ok) return feed;
  return { ok: true, agent: feed.agents.find((agent) => agent.slug === slug) ?? null };
}
