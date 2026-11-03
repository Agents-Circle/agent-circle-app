import type { SupabaseClient } from "@supabase/supabase-js";

import { requireWrite } from "../shared/db.ts";
import type { Logger } from "../shared/log.ts";
import { rollUpDay, type TrailingDay, type VaultDayInput } from "./metrics.ts";

/**
 * Fetch what a day needs and write the rolled-up row.
 *
 * Recomputed from stored rows every time rather than updated in place, which is what makes
 * a re-scanned block range harmless. The cost is a handful of small queries per touched
 * day; the alternative is an accumulator that is wrong after the first restart.
 */

/** `YYYY-MM-DD` in UTC. Days are UTC everywhere — a leaderboard needs one clock. */
export function dayOf(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function dayBounds(day: string): { start: string; end: string } {
  const start = new Date(`${day}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 86_400_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Equity and high-water mark at the last reconcile strictly before `day`. */
async function openingState(
  db: SupabaseClient,
  vault: string,
  day: string
): Promise<{ equityOpen: bigint; highWaterMarkOpen: bigint }> {
  const { start } = dayBounds(day);

  const { data, error } = await db
    .from("hl_vault_events")
    .select("args")
    .eq("vault_address", vault)
    .eq("name", "Reconciled")
    .lt("occurred_at", start)
    .order("occurred_at", { ascending: false })
    .limit(1);

  if (error) throw new Error(`reading opening state failed: ${error.message}`);

  const args = (data?.[0]?.args ?? null) as Record<string, string> | null;
  if (!args) return { equityOpen: 0n, highWaterMarkOpen: 0n };

  return {
    equityOpen: BigInt(args.equity ?? "0"),
    highWaterMarkOpen: BigInt(args.highWaterMark ?? "0"),
  };
}

async function vaultDay(
  db: SupabaseClient,
  vault: string,
  day: string
): Promise<VaultDayInput> {
  const { start, end } = dayBounds(day);

  const [fills, events, opening] = await Promise.all([
    db
      .from("hl_fills")
      .select("notional, venue_fee")
      .eq("vault_address", vault)
      .gte("filled_at", start)
      .lt("filled_at", end),
    db
      .from("hl_vault_events")
      .select("name, args, block_number, log_index")
      .eq("vault_address", vault)
      .gte("occurred_at", start)
      .lt("occurred_at", end)
      .order("block_number", { ascending: true })
      .order("log_index", { ascending: true }),
    openingState(db, vault, day),
  ]);

  if (fills.error) throw new Error(`reading fills failed: ${fills.error.message}`);
  if (events.error) throw new Error(`reading events failed: ${events.error.message}`);

  return {
    vault,
    fills: (fills.data ?? []).map((row) => ({
      notional: BigInt(row.notional as string),
      venueFee: BigInt(row.venue_fee as string),
    })),
    events: (events.data ?? []).map((row) => ({
      name: row.name as string,
      args: (row.args ?? {}) as Record<string, string>,
    })),
    ...opening,
  };
}

/**
 * The thirty days before `day`, for the fee-versus-profit test.
 *
 * Thirty-one rows are needed to produce thirty days of profit — the first contributes its
 * fees but has no earlier close to open against — so this asks for thirty and `rollUpDay`
 * appends the day being computed.
 */
async function trailing(
  db: SupabaseClient,
  listingId: string,
  day: string
): Promise<TrailingDay[]> {
  const { data, error } = await db
    .from("agent_metrics_daily")
    .select("day, net_return_bps, fees_paid, equity_close")
    .eq("listing_id", listingId)
    .lt("day", day)
    .order("day", { ascending: false })
    .limit(30);

  if (error) throw new Error(`reading trailing days failed: ${error.message}`);

  return (data ?? [])
    .slice()
    .reverse()
    .map((row) => ({
      net_return_bps: Number(row.net_return_bps),
      fees_paid: BigInt(row.fees_paid as string),
      equity_close: BigInt(row.equity_close as string),
    }));
}

/**
 * Recompute `(listing, day)` pairs.
 *
 * Keyed by listing rather than by vault because that is what a leaderboard ranks: an agent
 * running in nine vaults has one track record, and the honest way to combine them is by the
 * capital each actually held. Summing the money quantities and dividing by summed opening
 * equity does exactly that — a 50% gain on $100 and a 1% loss on $1,000,000 is a loss, as
 * it should be, and not the +24.5% an unweighted average would report.
 */
export async function recomputeDays(
  db: SupabaseClient,
  log: Logger,
  touched: { listingId: string; day: string; vaults: string[] }[]
): Promise<number> {
  for (const entry of touched) {
    const inputs = await Promise.all(
      entry.vaults.map((vault) => vaultDay(db, vault, entry.day))
    );

    const metrics = rollUpDay(inputs, await trailing(db, entry.listingId, entry.day));

    requireWrite(
      "upserting daily metrics",
      await db.from("agent_metrics_daily").upsert(
        {
          listing_id: entry.listingId,
          day: entry.day,
          ...metrics,
          computed_at: new Date().toISOString(),
        },
        { onConflict: "listing_id,day" }
      )
    );

    log.info("day rolled up", {
      listing: entry.listingId,
      day: entry.day,
      net_return_bps: metrics.net_return_bps,
      fees_paid: metrics.fees_paid,
      fees_exceed_profit: metrics.fees_exceed_profit,
    });
  }

  return touched.length;
}

/**
 * Group touched `(vault, day)` pairs by listing.
 *
 * Every vault of a listing goes into the group, not only the touched ones: the day's
 * numbers are capital-weighted across the listing, so a vault that did nothing still
 * contributes its equity to the denominator.
 */
export function groupByListing(
  touched: { vault: string; day: string }[],
  vaultsByListing: Map<string, string[]>,
  listingByVault: Map<string, string>
): { listingId: string; day: string; vaults: string[] }[] {
  const seen = new Set<string>();
  const out: { listingId: string; day: string; vaults: string[] }[] = [];

  for (const entry of touched) {
    const listingId = listingByVault.get(entry.vault);
    if (listingId === undefined) continue;

    const key = `${listingId}|${entry.day}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ listingId, day: entry.day, vaults: vaultsByListing.get(listingId) ?? [entry.vault] });
  }

  return out;
}
