import Link from "next/link";
import { notFound } from "next/navigation";
import { getAgentBySlug } from "@/lib/agents";
import { FeedNotice } from "@/components/FeedNotice";
import { AgentAvatar } from "@/components/AgentAvatar";
import { StatusBadge, MarketChip, RankBadge } from "@/components/Badge";
import { Sparkline } from "@/components/Sparkline";

export const revalidate = 60;

export default async function AgentProfilePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const lookup = await getAgentBySlug(slug);

  // A failed read is not a 404: the agent may well exist. `notFound()` here would
  // assert it does not.
  if (!lookup.ok) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-14">
        <FeedNotice reason={lookup.reason} />
      </div>
    );
  }

  const agent = lookup.agent;

  if (!agent) notFound();

  const isLive = agent.status === "live";

  return (
    <div className="mx-auto max-w-4xl px-6 py-14">
      <Link href="/agents" className="text-xs font-semibold" style={{ color: "var(--muted)" }}>
        ← Back to agents
      </Link>

      <div className="mt-6 flex flex-wrap items-start justify-between gap-6">
        <div className="flex items-center gap-4">
          <AgentAvatar name={agent.name} size={64} ring={agent.rank > 0 && agent.rank <= 3} />
          <div>
            <div className="flex items-center gap-2">
              <h1 className="display-heading text-3xl font-semibold tracking-tight">{agent.name}</h1>
              {agent.rank > 0 && <RankBadge rank={agent.rank} />}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StatusBadge status={agent.status} />
              <MarketChip market={agent.market} />
              <span className="text-xs" style={{ color: "var(--muted)" }}>
                by {agent.builder.name} · Builder Score {agent.builder.builderScore}
              </span>
            </div>
          </div>
        </div>

        <Link href={`/agents/${agent.slug}/list`} className="btn-primary">
          List this agent
        </Link>
      </div>

      <p className="mt-6 max-w-2xl leading-relaxed" style={{ color: "var(--muted)" }}>
        {agent.description}
      </p>

      {isLive ? (
        <>
          <div className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[
              { label: "Agent Score", value: agent.agentScore.toFixed(1) },
              { label: "Win Rate", value: `${agent.winRate}%` },
              { label: "Consistency", value: agent.consistency },
              { label: "Max Drawdown", value: `${agent.maxDrawdown}%`, negative: true },
            ].map((stat) => (
              <div key={stat.label} className="card-surface p-5">
                <div
                  className="tabular text-2xl font-semibold"
                  style={{ color: stat.negative ? "var(--negative)" : "var(--foreground)" }}
                >
                  {stat.value}
                </div>
                <div className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
                  {stat.label}
                </div>
              </div>
            ))}
          </div>

          <div className="card-surface mt-6 p-6">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold">Cumulative return</div>
                <div className="tabular mt-1 text-2xl font-semibold" style={{ color: "var(--positive)" }}>
                  +{agent.totalReturn}%
                </div>
              </div>
              <Sparkline data={agent.history} width={200} height={64} />
            </div>
          </div>
        </>
      ) : (
        <div className="card-surface mt-10 p-8 text-sm" style={{ color: "var(--muted)" }}>
          This agent is completing Phase 1 vetting. Performance history and
          listing open once it&apos;s approved for the leaderboard.
        </div>
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className="card-surface p-6">
          <h2 className="text-sm font-semibold">Default risk controls</h2>
          <dl className="mt-4 flex flex-col gap-3 text-sm">
            <div className="flex justify-between">
              <dt style={{ color: "var(--muted)" }}>Position cap</dt>
              <dd className="tabular font-medium">{agent.riskDefaults.positionCapPct}%</dd>
            </div>
            <div className="flex justify-between">
              <dt style={{ color: "var(--muted)" }}>Max drawdown</dt>
              <dd className="tabular font-medium">{agent.riskDefaults.maxDrawdownPct}%</dd>
            </div>
            <div className="flex justify-between">
              <dt style={{ color: "var(--muted)" }}>Auto-pause on breach</dt>
              <dd className="font-medium">{agent.riskDefaults.autoPause ? "Enabled" : "Disabled"}</dd>
            </div>
          </dl>
        </div>

        <div className="card-surface p-6">
          <h2 className="text-sm font-semibold">Fees</h2>
          <dl className="mt-4 flex flex-col gap-3 text-sm">
            <div className="flex justify-between">
              <dt style={{ color: "var(--muted)" }}>Listing fee</dt>
              <dd className="tabular font-medium">{(agent.listingFeeBps / 100).toFixed(2)}%</dd>
            </div>
            <div className="flex justify-between">
              <dt style={{ color: "var(--muted)" }}>Performance fee</dt>
              <dd className="tabular font-medium">{(agent.performanceFeeBps / 100).toFixed(2)}%</dd>
            </div>
            <div className="flex justify-between">
              <dt style={{ color: "var(--muted)" }}>Active traders</dt>
              <dd className="tabular font-medium">{agent.traderCount}</dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}
