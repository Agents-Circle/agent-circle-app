"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSiws } from "@/hooks/useSiws";
import {
  getMyAgents,
  updateAgentDescription,
  type MyAgent,
} from "@/lib/builderApi";
import { isSessionInvalidError } from "@/lib/auth";
import { AgentAvatar } from "./AgentAvatar";
import { StatusBadge, MarketChip } from "./Badge";

function AgentCard({
  agent,
  token,
  onSessionInvalid,
  onChanged,
}: {
  agent: MyAgent;
  token: string;
  onSessionInvalid: () => void;
  onChanged: () => void;
}) {
  const [description, setDescription] = useState(agent.description);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const run = async (fn: () => Promise<void>, success: string) => {
    setBusy(true);
    setMessage("");
    try {
      await fn();
      setMessage(success);
      onChanged();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Something went wrong";
      if (isSessionInvalidError(msg)) onSessionInvalid();
      setMessage(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="rounded-2xl border p-6"
      style={{ borderColor: "var(--border)", background: "var(--card)" }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <AgentAvatar name={agent.name} size={44} />
          <div>
            <Link href={`/agents/${agent.slug}`} className="text-sm font-semibold hover:underline">
              {agent.name}
            </Link>
            <div className="mt-1 flex items-center gap-2">
              <StatusBadge status={agent.status} />
              <MarketChip market={agent.market} />
            </div>
          </div>
        </div>
        {agent.status === "live" && (
          <div className="text-right text-xs" style={{ color: "var(--muted)" }}>
            <div>
              Return{" "}
              <span className="tabular font-semibold" style={{ color: "var(--positive)" }}>
                {agent.total_return >= 0 ? "+" : ""}
                {agent.total_return}%
              </span>
            </div>
            <div className="mt-0.5">
              Win rate <span className="tabular font-semibold">{agent.win_rate}%</span>
            </div>
          </div>
        )}
      </div>

      <div className="mt-4">
        {editing ? (
          <div>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full resize-none rounded-xl border bg-transparent px-4 py-3 text-sm outline-none"
              style={{ borderColor: "var(--border)", color: "var(--foreground)" }}
            />
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={busy || description.trim().length < 20}
                onClick={() =>
                  run(async () => {
                    await updateAgentDescription(token, agent.id, description);
                    setEditing(false);
                  }, "Description updated.")
                }
                className="btn-accent px-4 py-2 text-xs"
              >
                {busy ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setDescription(agent.description);
                }}
                className="btn-ghost px-4 py-2 text-xs"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-4">
            <p className="text-sm leading-relaxed" style={{ color: "var(--muted)" }}>
              {description}
            </p>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="btn-ghost shrink-0 px-3 py-1.5 text-xs"
              >
                Edit
              </button>
          </div>
        )}
      </div>

      {/* No self-reporting. Return, win rate and drawdown come from the indexer, which
          computes them from on-chain fills; `report_performance` is revoked for every
          browser role (migration 20261104000200). */}
      {message && (
        <p className="mt-3 text-xs" role="status" style={{ color: "var(--muted)" }}>
          {message}
        </p>
      )}
    </div>
  );
}

export function MyAgents() {
  const { session, signOut } = useSiws();
  const [agents, setAgents] = useState<MyAgent[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(() => {
    if (!session) return;
    getMyAgents(session.token)
      .then(setAgents)
      .catch((e) => {
        if (e instanceof Error && isSessionInvalidError(e.message)) signOut();
      })
      .finally(() => setLoaded(true));
  }, [session, signOut]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const handler = () => refresh();
    window.addEventListener("ac:agents-updated", handler);
    return () => window.removeEventListener("ac:agents-updated", handler);
  }, [refresh]);

  if (!session || (loaded && agents.length === 0)) return null;

  return (
    <div className="mt-12">
      <h2 className="display-heading text-xl font-semibold tracking-tight">
        Your <span className="accent-text">agents.</span>
      </h2>
      <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
        Edit descriptions any time. Live agents can report performance while
        on-chain verification is still in development.
      </p>
      <div className="mt-5 space-y-4">
        {agents.map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            token={session.token}
            onSessionInvalid={signOut}
            onChanged={refresh}
          />
        ))}
      </div>
    </div>
  );
}
