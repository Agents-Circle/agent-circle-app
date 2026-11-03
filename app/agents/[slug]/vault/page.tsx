import Link from "next/link";
import { notFound } from "next/navigation";

import { getAgentBySlug } from "@/lib/agents";
import { FeedNotice } from "@/components/FeedNotice";
import { AgentAvatar } from "@/components/AgentAvatar";
import { VaultPanel } from "@/components/vault/VaultPanel";

export const revalidate = 60;

/**
 * The HyperEVM vault surface for one agent.
 *
 * `params` is awaited: Next 16 removed synchronous access entirely, and the repo's
 * `AGENTS.md` is explicit about checking the bundled docs before assuming otherwise.
 *
 * The on-chain listing id is not yet in the marketplace index — the registry mirror is
 * part of the indexer, which does not exist. Until it does, `VaultPanel` renders the
 * "no on-chain listing" state rather than guessing an id, because a wrong listing id
 * would open a vault against the wrong agent.
 */
export default async function AgentVaultPage({
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
      <div className="mx-auto max-w-3xl px-6 py-14">
        <FeedNotice reason={lookup.reason} />
      </div>
    );
  }

  const agent = lookup.agent;

  if (!agent) notFound();

  return (
    <div className="mx-auto max-w-3xl px-6 py-14">
      <Link
        href={`/agents/${slug}`}
        className="text-xs font-semibold"
        style={{ color: "var(--muted)" }}
      >
        ← Back to {agent.name}
      </Link>

      <div className="mt-6 flex items-center gap-3">
        <AgentAvatar name={agent.name} size={44} />
        <div>
          <p
            className="text-xs font-semibold uppercase tracking-widest"
            style={{ color: "var(--muted)" }}
          >
            Vault
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">{agent.name}</h1>
        </div>
      </div>

      <p className="mt-4 text-sm" style={{ color: "var(--muted)" }}>
        Your capital stays in a vault only you can withdraw from. Position caps and
        drawdown limits are enforced by the contract, and {agent.name} can place orders
        but can never move funds out.
      </p>

      <VaultPanel agent={agent} />
    </div>
  );
}
