import type { SupabaseClient } from "@supabase/supabase-js";

import { requireWrite } from "../shared/db.ts";

/**
 * Durable progress markers.
 *
 * The cursor is advanced **after** the work for a range is written, never before. A crash
 * in between therefore re-does a range, which is free: every derived table is keyed on the
 * natural identity of the thing it stores, so a second write of the same log is a no-op.
 * The opposite order would skip, and a skipped fill is a number that is wrong forever.
 */

export type Cursor = {
  lastBlock: bigint;
  lastFillTimeMs: number;
};

export async function readCursor(
  db: SupabaseClient,
  service: "indexer" | "keeper",
  chainId: number,
  startBlock: bigint
): Promise<Cursor> {
  const { data, error } = await db
    .from("indexer_cursors")
    .select("last_block, last_fill_time_ms")
    .eq("service", service)
    .eq("chain_id", chainId)
    .maybeSingle();

  if (error) throw new Error(`reading cursor failed: ${error.message}`);

  if (!data) {
    return { lastBlock: startBlock, lastFillTimeMs: 0 };
  }

  // `startBlock` wins if it is ahead: moving the configured start forward is how an
  // operator skips a range they do not want (a chain reset, a redeploy of the registry),
  // and the stored cursor should not quietly undo that.
  const stored = BigInt(data.last_block as string | number);
  return {
    lastBlock: stored > startBlock ? stored : startBlock,
    lastFillTimeMs: Number(data.last_fill_time_ms ?? 0),
  };
}

export async function writeCursor(
  db: SupabaseClient,
  service: "indexer" | "keeper",
  chainId: number,
  cursor: Cursor
): Promise<void> {
  requireWrite(
    "writing cursor",
    await db.from("indexer_cursors").upsert(
      {
        service,
        chain_id: chainId,
        last_block: cursor.lastBlock.toString(),
        last_fill_time_ms: cursor.lastFillTimeMs,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "service,chain_id" }
    )
  );
}

/**
 * Split `(from, to]` into chunks no larger than `range`.
 *
 * Public RPCs cap `eth_getLogs` by block span, by result count, or by both, and the error
 * they return when you exceed it is not standardised. Chunking unconditionally is cheaper
 * than parsing a dozen providers' complaints.
 */
export function blockRanges(
  from: bigint,
  to: bigint,
  range: bigint
): { from: bigint; to: bigint }[] {
  if (to < from) return [];
  const out: { from: bigint; to: bigint }[] = [];
  let start = from;
  while (start <= to) {
    const end = start + range - 1n > to ? to : start + range - 1n;
    out.push({ from: start, to: end });
    start = end + 1n;
  }
  return out;
}
