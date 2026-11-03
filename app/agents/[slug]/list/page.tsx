import Link from "next/link";
import { notFound } from "next/navigation";
import { getAgentBySlug } from "@/lib/agents";
import { FeedNotice } from "@/components/FeedNotice";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ListForm } from "@/components/ListForm";

export const revalidate = 60;

export default async function ListAgentPage({
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
      <div className="mx-auto max-w-2xl px-6 py-14">
        <FeedNotice reason={lookup.reason} />
      </div>
    );
  }

  const agent = lookup.agent;

  if (!agent) notFound();

  return (
    <div className="mx-auto max-w-2xl px-6 py-14">
      <Link href={`/agents/${slug}`} className="text-xs font-semibold" style={{ color: "var(--muted)" }}>
        ← Back to {agent.name}
      </Link>

      <div className="mt-6 flex items-center gap-3">
        <AgentAvatar name={agent.name} size={44} />
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--muted)" }}>
            List
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">{agent.name}</h1>
        </div>
      </div>

      <ListForm agent={agent} />
    </div>
  );
}
