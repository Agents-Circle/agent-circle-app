import { supabase, isSupabaseConfigured } from "./supabaseClient";
import { MOCK_AGENTS } from "./mockData";
import type { Agent, MarketCategory } from "./types";

// Asks `supabaseClient` rather than re-deriving it from the URL. Two copies of this
// check is one copy too many: the duplicate here is what kept the build alive while the
// client itself threw on import.
function useMockAgents() {
  return !isSupabaseConfigured;
}

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

export async function getAllAgents(): Promise<Agent[]> {
  if (useMockAgents()) return MOCK_AGENTS;

  const { data, error } = await supabase
    .from("agents")
    .select(
      "id, slug, name, market, status, description, agent_score, win_rate, consistency, max_drawdown, total_return, trader_count, listing_fee_bps, performance_fee_bps, position_cap_pct, max_drawdown_limit_pct, auto_pause, builders ( name, builder_score )"
    )
    .order("agent_score", { ascending: false });

  if (error || !data) return MOCK_AGENTS;

  const rows = data as unknown as AgentRow[];
  const historyByAgent = await fetchHistoryByAgentId(rows.map((r) => r.id));

  let liveRank = 0;
  return rows.map((row) => {
    if (row.status === "live") liveRank += 1;
    return toAgent(row, row.status === "live" ? liveRank : 0, historyByAgent.get(row.id) ?? []);
  });
}

export async function getLeaderboardAgents(): Promise<Agent[]> {
  const agents = await getAllAgents();
  return agents.filter((agent) => agent.status === "live");
}

export async function getAgentBySlug(slug: string): Promise<Agent | undefined> {
  const agents = await getAllAgents();
  return agents.find((agent) => agent.slug === slug);
}
