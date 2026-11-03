"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSiws } from "@/hooks/useSiws";
import {
  getMyAgents,
  updateAgentDescription,
  reportPerformance,
  type MyAgent,
} from "@/lib/builderApi";
import { isSessionInvalidError } from "@/lib/auth";
import { AgentAvatar } from "./AgentAvatar";
import { StatusBadge, MarketChip } from "./Badge";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

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

  const [ret, setRet] = useState("");
  const [winRate, setWinRate] = useState("");
  const [drawdown, setDrawdown] = useState("");

  const lastReported = agent.last_reported_at ? new Date(agent.last_reported_at).getTime() : 0;

  // Captured once per mount rather than read during render. `Date.now()` in a render
  // body is impure — the same props produce different output depending on when React
  // happened to run, which is what breaks under concurrent rendering. A cooldown is a
  // UI affordance and the list refetches after a report, so a per-mount reading is
  // accurate whenever it matters.
  const [mountedAt] = useState(() => Date.now());
  const isInReportCooldown = lastReported > 0 && mountedAt - lastReported < SIX_HOURS_MS;

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

      {agent.status === "live" && (
        <div className="mt-5 border-t pt-5" style={{ borderColor: "var(--border)" }}>
          <div className="text-xs font-semibold" style={{ color: "var(--muted)" }}>
            Report performance{" "}
            <span className="font-normal">
              (self-reported, marked as unverified until on-chain verification lands)
            </span>
          </div>
          {isInReportCooldown ? (
            <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
              Reported recently — next report available 6 hours after the last one.
            </p>
          ) : (
            <div className="mt-3 flex flex-wrap items-end gap-3">
              {[
                { label: "Cumulative return %", value: ret, set: setRet, placeholder: "42.8" },
                { label: "Win rate %", value: winRate, set: setWinRate, placeholder: "71" },
                { label: "Drawdown % (≤ 0)", value: drawdown, set: setDrawdown, placeholder: "-8.4" },
              ].map((f) => (
                <div key={f.label}>
                  <label className="text-[11px]" style={{ color: "var(--muted)" }}>
                    {f.label}
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={f.value}
                    onChange={(e) => f.set(e.target.value)}
                    placeholder={f.placeholder}
                    className="tabular mt-1 block w-32 rounded-xl border bg-transparent px-3 py-2 text-sm outline-none"
                    style={{ borderColor: "var(--border)", color: "var(--foreground)" }}
                  />
                </div>
              ))}
              <button
                type="button"
                disabled={busy || !ret || !winRate || !drawdown}
                onClick={() =>
                  run(async () => {
                    await reportPerformance(token, agent.id, {
                      returnPct: Number(ret),
                      winRate: Number(winRate),
                      drawdown: Number(drawdown),
                    });
                    setRet("");
                    setWinRate("");
                    setDrawdown("");
                  }, "Performance reported.")
                }
                className="btn-primary px-4 py-2.5 text-xs"
              >
                {busy ? "Reporting…" : "Report"}
              </button>
            </div>
          )}
        </div>
      )}

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
