import type { FeedFailure } from "@/lib/agents";

/**
 * What a surface shows when the agent catalogue could not be read.
 *
 * The one thing this must never do is imply the marketplace is empty. "No agents yet" and
 * "we could not reach the index" look alike on screen and mean opposite things to someone
 * deciding whether to commit capital, so the empty states in `LeaderboardTable` and
 * `AgentsGrid` are reserved for a successful read that returned nothing, and every failure
 * lands here instead.
 */
const COPY: Record<FeedFailure, { title: string; body: string }> = {
  unconfigured: {
    title: "The agent index is not available here",
    body: "This deployment has no marketplace backend configured, so there is nothing to rank. It is not a sign that the marketplace is empty.",
  },
  unavailable: {
    title: "Could not load the agent index",
    body: "The marketplace backend did not answer. Agents and their track records are unaffected — this is a read failure on our side. Try again in a moment.",
  },
};

export function FeedNotice({ reason }: { reason: FeedFailure }) {
  const { title, body } = COPY[reason];

  return (
    <div
      className="rounded-2xl border px-6 py-10 text-center"
      style={{ borderColor: "var(--border)", background: "var(--card)" }}
      role="status"
    >
      <p className="text-sm font-semibold">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: "var(--muted)" }}>
        {body}
      </p>
    </div>
  );
}
