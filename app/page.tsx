import { getLeaderboardAgents } from "@/lib/agents";
import { LeaderboardTable } from "@/components/LeaderboardTable";
import { FeedNotice } from "@/components/FeedNotice";
import { PageHeader } from "@/components/PageHeader";

export const revalidate = 60;

export default async function LeaderboardPage() {
  const feed = await getLeaderboardAgents();

  return (
    <div className="mx-auto max-w-6xl px-6 py-14">
      <PageHeader
        className="mb-10"
        eyebrow="Agent Leaderboard"
        title={
          <>
            Vetted agents, ranked by <span className="accent-text">verified performance.</span>
          </>
        }
        description="Live rankings surface agents that earn trust through results. Filter by market and compare before you commit capital."
      />

      {feed.ok ? (
        <LeaderboardTable agents={feed.agents} />
      ) : (
        <FeedNotice reason={feed.reason} />
      )}
    </div>
  );
}
