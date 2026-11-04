"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useSignMessage } from "wagmi";
import { supabase } from "@/lib/supabaseClient";
import { vettingMessage, type VettingAction } from "@/lib/adminVetting";
import { AgentAvatar } from "@/components/AgentAvatar";
import { MarketChip } from "@/components/Badge";
import { EvmWalletButton } from "@/components/EvmWalletButton";
import { PageHeader } from "@/components/PageHeader";

type VettingAgent = {
  id: string;
  slug: string;
  name: string;
  market: string;
  description: string;
  created_at: string;
  builders: { name: string; wallet_address: string | null } | null;
};

export default function AdminPage() {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  // A connected wallet only unlocks the view. Whether it is an admin is decided by the
  // server on every action, against `ADMIN_WALLETS`; nothing here grants anything.
  const { isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const unlocked = isConnected;

  // react-query rather than an effect plus two pieces of state.
  //
  // The effect version called `setLoading(true)` synchronously on entry, which React 19
  // flags as a cascading render — and the hand-rolled loading flag could disagree with
  // the data it was describing. `enabled` ties the fetch to being unlocked, so there is
  // no "if (unlocked)" branch to keep in step either.
  const {
    data: agents = [],
    isFetching: loading,
    refetch: loadQueue,
  } = useQuery({
    queryKey: ["admin", "vetting-queue"],
    enabled: unlocked,
    queryFn: async (): Promise<VettingAgent[]> => {
      const { data, error } = await supabase
        .from("agents")
        .select(
          "id, slug, name, market, description, created_at, builders ( name, wallet_address )"
        )
        .eq("status", "vetting")
        .order("created_at", { ascending: true });
      if (error) throw new Error(error.message);
      return (data as unknown as VettingAgent[]) ?? [];
    },
  });

  // Each action is signed on its own, naming the agent, so a signature cannot be reused
  // to approve something else. `approve_agent` / `reject_agent` are service-role only
  // (migration 20261104000200); the browser reaches them through the server route.
  const act = async (agent: VettingAgent, action: VettingAction) => {
    setBusyId(agent.id);
    setMessage("");

    try {
      const issuedAt = new Date().toISOString();
      const signature = await signMessageAsync({
        message: vettingMessage(action, agent.id, issuedAt),
      });
      const res = await fetch("/api/admin/vetting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, agentId: agent.id, issuedAt, signature }),
      });
      const body = (await res.json().catch(() => ({}))) as { handled?: boolean; error?: string };

      if (!res.ok) {
        setMessage(`Could not ${action} ${agent.name}: ${body.error ?? res.statusText}`);
        return;
      }

      setMessage(
        body.handled
          ? `${agent.name} ${action === "approve" ? "approved and now live" : "rejected and removed"}.`
          : `${agent.name} was already handled elsewhere.`
      );
      loadQueue();
    } catch (e) {
      // Most often the wallet's "user rejected" — not worth more than a line.
      setMessage(e instanceof Error ? e.message.split("\n")[0] : `Could not ${action} ${agent.name}.`);
    } finally {
      setBusyId(null);
    }
  };

  if (!unlocked) {
    return (
      <div className="mx-auto max-w-md px-6 py-24">
        <PageHeader
          eyebrow="Admin"
          title="Vetting queue"
          description="Connect an admin wallet. Each approval or rejection is signed by it and checked against the server's admin list."
        />
        <div className="mt-6">
          <EvmWalletButton />
        </div>
        {message && (
          <p className="mt-4 text-sm" role="alert" style={{ color: "var(--negative)" }}>
            {message}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-14">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <PageHeader
          eyebrow="Admin"
          title={
            <>
              Vetting <span className="accent-text">queue.</span>
            </>
          }
          description="Approving an agent sets it live on the leaderboard with standard fees (1.25% listing / 9% performance) unless custom fees were already set. Rejecting removes the submission."
        />
        <EvmWalletButton />
      </div>

      {message && (
        <div
          className="mt-6 rounded-xl border p-4 text-sm"
          style={{ borderColor: "var(--border-strong)", color: "var(--foreground)", background: "var(--card)" }}
          role="status"
        >
          {message}
        </div>
      )}

      <div className="mt-8 space-y-4">
        {loading && (
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Loading queue…
          </p>
        )}

        {!loading && agents.length === 0 && (
          <div
            className="rounded-2xl border p-8 text-center text-sm"
            style={{ borderColor: "var(--border)", background: "var(--card)", color: "var(--muted)" }}
          >
            The vetting queue is empty.
          </div>
        )}

        {agents.map((agent) => (
          <div
            key={agent.id}
            className="rounded-2xl border p-6"
            style={{ borderColor: "var(--border)", background: "var(--card)" }}
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <AgentAvatar name={agent.name} size={44} />
                <div>
                  <div className="text-sm font-semibold">{agent.name}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
                    <span>{agent.builders?.name ?? "Unknown builder"}</span>
                    {agent.builders?.wallet_address && (
                      <>
                        <span>·</span>
                        <span className="tabular">
                          {agent.builders.wallet_address.slice(0, 4)}…{agent.builders.wallet_address.slice(-4)}
                        </span>
                      </>
                    )}
                    <span>·</span>
                    <span>Submitted {new Date(agent.created_at).toLocaleDateString()}</span>
                  </div>
                </div>
              </div>
              <MarketChip market={agent.market} />
            </div>

            <p className="mt-4 text-sm leading-relaxed" style={{ color: "var(--muted)" }}>
              {agent.description}
            </p>

            <div className="mt-5 flex gap-3">
              <button
                type="button"
                disabled={busyId === agent.id}
                onClick={() => act(agent, "approve")}
                className="rounded-full px-5 py-2.5 text-xs font-semibold disabled:opacity-40"
                style={{ background: "var(--positive)", color: "#04140c" }}
              >
                {busyId === agent.id ? "Working…" : "Approve — set live"}
              </button>
              <button
                type="button"
                disabled={busyId === agent.id}
                onClick={() => act(agent, "reject")}
                className="rounded-full border px-5 py-2.5 text-xs font-semibold disabled:opacity-40"
                style={{ borderColor: "var(--negative)", color: "var(--negative)" }}
              >
                Reject — remove
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
