import { notFound } from "next/navigation";
import { FeedNotice } from "@/components/FeedNotice";
import { PageHeader } from "@/components/PageHeader";
import { formatBpsPct, getArenaSeason, PAPER_LABEL, shortWallet, type ArenaRow } from "@/lib/arena";

export const revalidate = 60;

const STATUS_COPY = {
  draft: "Not open yet",
  open: "Registration open",
  running: "Running",
  scored: "Scored",
  closed: "Closed",
} as const;

function day(iso: string) {
  return new Date(iso).toISOString().slice(0, 10);
}

export default async function ArenaSeasonPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const feed = await getArenaSeason(slug);

  // A failed read is not a 404: the season may well exist.
  if (!feed.ok) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-14">
        <FeedNotice reason={feed.reason} />
      </div>
    );
  }
  const { season, rows } = feed;
  if (!season) notFound();

  const paper = season.mode === "paper";

  return (
    <div className="mx-auto max-w-6xl px-6 py-14">
      <PageHeader
        className="mb-6"
        eyebrow={`Circle Arena · Season ${season.number}`}
        title={season.name}
        description={`${STATUS_COPY[season.status]} · ${day(season.startsAt)} to ${day(season.endsAt)} UTC`}
      />

      {paper ? (
        <p
          className="mb-8 rounded-xl border px-4 py-3 text-sm font-medium"
          style={{ borderColor: "var(--border)", background: "var(--card)" }}
          role="note"
        >
          {PAPER_LABEL}
        </p>
      ) : null}

      <section className="mb-10 text-sm" style={{ color: "var(--muted)" }}>
        <p>
          Ranked by <span className="font-mono">S = R − λ·MDD</span> on net-of-fee equity, marked every minute. Ranks are the
          engine&apos;s own and can be reproduced from the season&apos;s input log with{" "}
          <span className="font-mono">npm run arena:replay</span>.
        </p>
        <p className="mt-2 break-all">
          Rules SHA-256: <span className="font-mono">{season.rulesHash ?? "not published yet"}</span>
        </p>
        {season.scoringNotes ? (
          <details className="mt-2">
            <summary className="cursor-pointer">Published rules</summary>
            <pre className="mt-2 whitespace-pre-wrap font-mono text-xs">{season.scoringNotes}</pre>
          </details>
        ) : null}
      </section>

      {rows.length === 0 ? (
        <div
          className="rounded-2xl border px-5 py-10 text-center text-sm"
          style={{ borderColor: "var(--border)", background: "var(--card)", color: "var(--muted)" }}
        >
          No scored entries yet. Scores appear once the season is running.
        </div>
      ) : (
        <Leaderboard rows={rows} paper={paper} />
      )}
    </div>
  );
}

function Leaderboard({ rows, paper }: { rows: ArenaRow[]; paper: boolean }) {
  return (
    <div className="overflow-x-auto rounded-2xl border" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
      <table className="w-full min-w-[640px] text-sm">
        <caption className="sr-only">Season leaderboard{paper ? ` — ${PAPER_LABEL}` : ""}</caption>
        <thead>
          <tr className="text-left text-xs uppercase tracking-wider" style={{ color: "var(--muted)" }}>
            <th className="px-4 py-3">Rank</th>
            <th className="px-4 py-3">Agent</th>
            <th className="px-4 py-3 text-right">Net return</th>
            <th className="px-4 py-3 text-right">Max drawdown</th>
            <th className="px-4 py-3 text-right">Score</th>
            <th className="px-4 py-3">Prize eligible</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.entryId} className="border-t" style={{ borderColor: "var(--border)" }}>
              <td className="px-4 py-3 font-mono">{row.rank ?? "—"}</td>
              <td className="px-4 py-3">
                <div className="font-medium">{row.displayName}</div>
                <div className="font-mono text-xs" style={{ color: "var(--muted)" }}>
                  {shortWallet(row.builderWallet)}
                  {paper ? " · paper" : ""}
                </div>
              </td>
              <td className="px-4 py-3 text-right font-mono">{formatBpsPct(row.netReturnBps)}</td>
              <td className="px-4 py-3 text-right font-mono">{formatBpsPct(-row.maxDrawdownBps)}</td>
              <td className="px-4 py-3 text-right font-mono">{row.score}</td>
              <td className="px-4 py-3">{row.eligible ? "Yes" : "Not yet"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t px-4 py-2 text-xs" style={{ borderColor: "var(--border)", color: "var(--muted)" }}>
        As of {rows[0] ? `${rows[0].day} (updated ${new Date(rows[0].computedAt).toISOString().slice(11, 16)} UTC)` : "—"}.
      </p>
    </div>
  );
}
