import { supabase } from "./supabaseClient";
import type { MarketCategory } from "./types";

export type MyAgent = {
  id: string;
  slug: string;
  name: string;
  market: MarketCategory;
  status: "live" | "vetting" | "paused";
  description: string;
  agent_score: number;
  total_return: number;
  win_rate: number;
  max_drawdown: number;
  created_at: string;
  last_reported_at: string | null;
};

export type MyListing = {
  id: string;
  agent_slug: string;
  agent_name: string;
  agent_market: string;
  allocated_capital: number;
  current_value: number;
  position_cap_pct: number;
  max_drawdown_limit_pct: number;
  auto_pause: boolean;
  status: "active" | "paused" | "closed";
  listed_at: string;
};

function raiseIfError(error: { message: string } | null): asserts error is null {
  if (error) throw new Error(error.message);
}

export async function submitAgentAuthed(
  token: string,
  input: {
    builderName: string;
    agentName: string;
    market: MarketCategory;
    description: string;
  }
): Promise<string> {
  const { data, error } = await supabase.rpc("submit_agent", {
    p_token: token,
    p_builder_name: input.builderName,
    p_agent_name: input.agentName,
    p_market: input.market,
    p_description: input.description,
  });
  raiseIfError(error);
  return data as string;
}

export async function getMyAgents(token: string): Promise<MyAgent[]> {
  const { data, error } = await supabase.rpc("get_my_agents", { p_token: token });
  raiseIfError(error);
  return (data as MyAgent[]) ?? [];
}

export async function updateAgentDescription(
  token: string,
  agentId: string,
  description: string
): Promise<void> {
  const { error } = await supabase.rpc("update_my_agent_description", {
    p_token: token,
    p_agent_id: agentId,
    p_description: description,
  });
  raiseIfError(error);
}

export async function getMyListings(token: string): Promise<MyListing[]> {
  const { data, error } = await supabase.rpc("get_my_listings", { p_token: token });
  raiseIfError(error);
  return (data as MyListing[]) ?? [];
}
