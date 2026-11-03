import type { SupabaseClient } from "@supabase/supabase-js";
import type { Address, PublicClient } from "viem";

import { AgentRegistryAbi } from "../abis/index.ts";
import { requireWrite } from "../shared/db.ts";
import type { Logger } from "../shared/log.ts";

/**
 * Mirror of `AgentRegistry` listings.
 *
 * ## Events say *which*, the view says *what*
 *
 * `ListingApproved(bytes32 indexed listingId)` carries no terms — the fees, the caps and
 * the agent authority are all set in the same call and none of them is in the log. So
 * reconstructing a listing from its events is impossible, and this does the only thing
 * that is correct: it uses the logs to learn which listings changed and then reads
 * `getListing` for the current truth.
 *
 * The cost is that a listing which changed twice inside one scanned range is recorded once,
 * at its final state. For a mirror whose purpose is "what are the terms now", that is the
 * right answer rather than a compromise; the intermediate states are in the logs for
 * anyone who needs them.
 */

/** Index is the on-chain enum value. Order must match `IAgentRegistry.ListingStatus`. */
export const LISTING_STATUS = [
  "None",
  "Vetting",
  "Live",
  "Rejected",
  "Suspended",
  "Delisted",
] as const;

const WATCHED = [
  "ListingSubmitted",
  "ListingApproved",
  "ListingRejected",
  "ListingSuspended",
  "AgentAuthorityChanged",
] as const;

const EVENTS = AgentRegistryAbi.filter(
  (entry) => entry.type === "event" && (WATCHED as readonly string[]).includes(entry.name)
);

export type ListingTuple = {
  builder: Address;
  agentAuthority: Address;
  status: number;
  performanceFeeBps: number;
  builderSplitBps: number;
  positionCapBps: number;
  maxDrawdownBps: number;
  executionFeeBps: number;
  executionBuilderSplitBps: number;
  submittedAt: bigint;
  metadataHash: `0x${string}`;
};

export function listingRow(
  listingId: string,
  chainId: number,
  listing: ListingTuple,
  lastBlock: bigint
) {
  const status = LISTING_STATUS[listing.status];
  if (status === undefined) {
    // A new enum member on-chain. The mirror's `status` column is text rather than an
    // enum precisely so this is a loud error here and not a failed insert later.
    throw new Error(`unknown listing status ${listing.status} for ${listingId}`);
  }

  return {
    listing_id: listingId.toLowerCase(),
    chain_id: chainId,
    builder: listing.builder.toLowerCase(),
    agent_authority: listing.agentAuthority.toLowerCase(),
    status,
    performance_fee_bps: listing.performanceFeeBps,
    builder_split_bps: listing.builderSplitBps,
    execution_fee_bps: listing.executionFeeBps,
    execution_builder_split_bps: listing.executionBuilderSplitBps,
    position_cap_bps: listing.positionCapBps,
    max_drawdown_bps: listing.maxDrawdownBps,
    metadata_hash: listing.metadataHash.toLowerCase(),
    last_block: lastBlock.toString(),
    updated_at: new Date().toISOString(),
  };
}

export async function syncListings(
  client: PublicClient,
  db: SupabaseClient,
  log: Logger,
  args: { registry: Address; chainId: number; fromBlock: bigint; toBlock: bigint }
): Promise<number> {
  const logs = await client.getLogs({
    address: args.registry,
    // Cast because the ABI is filtered at runtime: viem derives its log types from the
    // literal ABI value and cannot narrow a union it only sees as `AbiEvent[]`.
    events: EVENTS as never,
    fromBlock: args.fromBlock,
    toBlock: args.toBlock,
  });

  const touched = new Set<string>();
  for (const entry of logs) {
    const id = (entry as { args?: { listingId?: string } }).args?.listingId;
    if (id) touched.add(id.toLowerCase());
  }

  if (touched.size === 0) return 0;

  const ids = [...touched];
  const listings = await Promise.all(
    ids.map((id) =>
      client.readContract({
        address: args.registry,
        abi: AgentRegistryAbi,
        functionName: "getListing",
        args: [id as `0x${string}`],
      })
    )
  );

  const rows = ids.map((id, index) =>
    listingRow(id, args.chainId, listings[index] as unknown as ListingTuple, args.toBlock)
  );

  requireWrite(
    "upserting listings",
    await db.from("hl_listings").upsert(rows, { onConflict: "listing_id" })
  );

  log.info("listings synced", { count: rows.length, toBlock: args.toBlock });
  return rows.length;
}
