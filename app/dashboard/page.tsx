"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { MOCK_LISTINGS } from "@/lib/mockData";
import { getAllAgents } from "@/lib/agents";
import { getMyListings, type MyListing } from "@/lib/builderApi";
import { isSessionInvalidError } from "@/lib/auth";
import { useSiws } from "@/hooks/useSiws";
import type { Agent } from "@/lib/types";
import { AgentAvatar } from "@/components/AgentAvatar";
import { PageHeader } from "@/components/PageHeader";
import { WalletButton } from "@/components/WalletButton";

type Row = {
  id: string;
  agentSlug: string;
  agentName: string;
  agentMarket: string;
  allocatedCapital: number;
  currentValue: number;
  pnlPct: number;
  maxDrawdownPct: number;
  status: string;
  listedAt: string;
};

export default function DashboardPage() {
  const { connected, wallet, session, verify, verifying, error: authError, signOut } = useSiws();
  const [agentsBySlug, setAgentsBySlug] = useState<Map<string, Agent>>(new Map());
  const [realListings, setRealListings] = useState<MyListing[] | null>(null);

  useEffect(() => {
    getAllAgents().then((agents) => {
      setAgentsBySlug(new Map(agents.map((agent) => [agent.slug, agent])));
    });
  }, []);

  // No `setRealListings(null)` on sign-out: `listings` below reads null whenever there
  // is no session, so the state does not need clearing and the effect does not need a
  // synchronous setState. Stale data cannot leak past a sign-out because the read is
  // gated on `session`, not on the fetch having been cleared.
  useEffect(() => {
    if (!session) return;
    getMyListings(session.token)
      .then(setRealListings)
      .catch((e) => {
        if (e instanceof Error && isSessionInvalidError(e.message)) signOut();
      });
  }, [session, signOut]);

  const authed = Boolean(session);
  const shortAddress = wallet ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : null;

  const rows: Row[] = authed
    ? (realListings ?? []).map((l) => ({
        id: l.id,
        agentSlug: l.agent_slug,
        agentName: l.agent_name,
        agentMarket: l.agent_market,
        allocatedCapital: Number(l.allocated_capital),
        currentValue: Number(l.current_value),
        pnlPct:
          Number(l.allocated_capital) > 0
            ? ((Number(l.current_value) - Number(l.allocated_capital)) /
                Number(l.allocated_capital)) *
              100
            : 0,
        maxDrawdownPct: Number(l.max_drawdown_limit_pct),
        status: l.status,
        listedAt: new Date(l.listed_at).toISOString().slice(0, 10),
      }))
    : MOCK_LISTINGS.map((l) => {
        const agent = agentsBySlug.get(l.agentSlug);
        return {
          id: l.id,
          agentSlug: l.agentSlug,
          agentName: agent?.name ?? l.agentSlug,
          agentMarket: agent?.market ?? "",
          allocatedCapital: l.allocatedCapital,
          currentValue: l.currentValue,
          pnlPct: l.pnlPct,
          maxDrawdownPct: l.maxDrawdownPct,
          status: l.status,
          listedAt: l.listedAt,
        };
      });

  const totalAllocated = rows.reduce((sum, r) => sum + r.allocatedCapital, 0);
  const totalValue = rows.reduce((sum, r) => sum + r.currentValue, 0);
  const totalPnlPct = totalAllocated > 0 ? ((totalValue - totalAllocated) / totalAllocated) * 100 : 0;

  return (
    <div className="mx-auto max-w-6xl px-6 py-14">
      <PageHeader
        eyebrow="Monitoring"
        title={
          <>
            Your <span className="accent-text">listed agents.</span>
          </>
        }
        description={
          <>
            Track performance, exposure, and risk-limit status for every agent
            you&apos;ve listed.{" "}
            {authed
              ? "Showing listings tied to your verified wallet."
              : "Sample data shown below — connect and verify a wallet to see your own."}
          </>
        }
      />

      {!connected && (
        <div
          className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl border p-5"
          style={{ borderColor: "var(--border)", background: "var(--card)" }}
        >
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Connect a wallet to check for listings tied to your address.
          </p>
          <WalletButton />
        </div>
      )}

      {connected && !authed && (
        <div
          className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl border p-5"
          style={{ borderColor: "var(--border)", background: "var(--card)" }}
        >
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Connected as <span style={{ color: "var(--foreground)" }}>{shortAddress}</span>. Sign a
            message (free, no transaction) to view listings tied to this wallet.
            {authError && (
              <span className="block" style={{ color: "var(--negative)" }}>
                {authError}
              </span>
            )}
          </p>
          <button type="button" onClick={verify} disabled={verifying} className="btn-accent px-5 py-2.5 text-xs">
            {verifying ? "Waiting for signature…" : "Verify wallet"}
          </button>
        </div>
      )}

      {authed && rows.length === 0 && (
        <div
          className="mt-8 rounded-2xl border p-10 text-center"
          style={{ borderColor: "var(--border)", background: "var(--card)" }}
        >
          <p className="text-sm font-semibold">No listings yet for {shortAddress}</p>
          <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: "var(--muted)" }}>
            Listing execution opens at Phase 1 launch once the on-chain programs
            are live. Browse the leaderboard in the meantime.
          </p>
          <Link href="/" className="btn-accent mt-5">
            Explore agents
          </Link>
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-2xl border p-6 accent-border" style={{ background: "var(--card)" }}>
              <div className="text-xs font-semibold" style={{ color: "var(--muted)" }}>
                Total Allocated
              </div>
              <div className="tabular mt-2 text-2xl font-semibold">
                ${totalAllocated.toLocaleString()}
              </div>
            </div>
            <div className="rounded-2xl border p-6" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
              <div className="text-xs font-semibold" style={{ color: "var(--muted)" }}>
                Current Value
              </div>
              <div className="tabular mt-2 text-2xl font-semibold">
                ${totalValue.toLocaleString()}
              </div>
            </div>
            <div className="rounded-2xl border p-6" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
              <div className="text-xs font-semibold" style={{ color: "var(--muted)" }}>
                Total P&amp;L
              </div>
              <div
                className="tabular mt-2 text-2xl font-semibold"
                style={{ color: totalPnlPct >= 0 ? "var(--positive)" : "var(--negative)" }}
              >
                {totalPnlPct >= 0 ? "+" : ""}
                {totalPnlPct.toFixed(1)}%
              </div>
            </div>
          </div>

          <div className="mt-10 space-y-4">
            {rows.map((row) => (
              <div
                key={row.id}
                className="flex flex-col gap-4 rounded-2xl border p-6 sm:flex-row sm:items-center sm:justify-between"
                style={{ borderColor: "var(--border)", background: "var(--card)" }}
              >
                <div className="flex items-center gap-4">
                  <AgentAvatar name={row.agentName} size={48} />
                  <div>
                    <Link href={`/agents/${row.agentSlug}`} className="text-sm font-semibold hover:underline">
                      {row.agentName}
                    </Link>
                    <div className="mt-1 flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
                      <span>{row.agentMarket}</span>
                      <span>·</span>
                      <span>Listed {row.listedAt}</span>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-6">
                  <div>
                    <div className="text-[11px]" style={{ color: "var(--muted)" }}>
                      Allocated
                    </div>
                    <div className="tabular text-sm font-semibold">
                      ${row.allocatedCapital.toLocaleString()}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px]" style={{ color: "var(--muted)" }}>
                      Current Value
                    </div>
                    <div className="tabular text-sm font-semibold">
                      ${row.currentValue.toLocaleString()}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px]" style={{ color: "var(--muted)" }}>
                      P&amp;L
                    </div>
                    <div
                      className="tabular text-sm font-semibold"
                      style={{ color: row.pnlPct >= 0 ? "var(--positive)" : "var(--negative)" }}
                    >
                      {row.pnlPct >= 0 ? "+" : ""}
                      {row.pnlPct.toFixed(1)}%
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px]" style={{ color: "var(--muted)" }}>
                      Max Drawdown Limit
                    </div>
                    <div className="tabular text-sm font-semibold">{row.maxDrawdownPct}%</div>
                  </div>

                  <span
                    className="rounded-full px-3 py-1.5 text-[11px] font-semibold"
                    style={
                      row.status === "active"
                        ? { background: "var(--positive)", color: "#04140c" }
                        : { border: "1px solid var(--border-strong)", color: "var(--muted)" }
                    }
                  >
                    {row.status.toUpperCase()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
