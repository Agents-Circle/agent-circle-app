import type { SupabaseClient } from "@supabase/supabase-js";
import type { Address, PublicClient } from "viem";

import { HLAgentVaultAbi } from "../abis/index.ts";
import { requireWrite } from "../shared/db.ts";
import type { Logger } from "../shared/log.ts";

/**
 * Vault logs, stored raw, and the order book projected out of them.
 *
 * ## Why the raw log is the stored thing
 *
 * `agent_metrics_daily` needs five different events to compute one day: the execution fees
 * accrued, the performance fees assessed, the deposits that settled, the withdrawals that
 * left Core, and the equity and high-water mark at the last reconcile. Accumulating those
 * into the daily row as each log arrives would double-count every time the indexer
 * re-scans a range — which it does on every restart. Stored against `(vault, block,
 * log_index)`, a day's metrics become a pure function of rows, and re-scanning is free.
 *
 * ## The order book is a projection, not a source
 *
 * `hl_orders` is derived from `OrderPlaced` / `OrderReleased` and exists because the chain
 * cannot answer "which orders are outstanding" — `reservations` is a Solidity mapping and
 * mappings do not enumerate. The keeper depends on it, which makes the projection
 * correctness-critical in a way the raw table is not.
 */

const EVENTS = HLAgentVaultAbi.filter((entry) => entry.type === "event");

/**
 * A decoded log, loosely typed.
 *
 * viem derives log types from the literal ABI value, so filtering the ABI at runtime
 * leaves it with an `AbiEvent[]` it cannot narrow and every field types as `never`. One
 * named shape at the boundary is honest about that; casting each field at its use site
 * would hide it in seven places.
 */
type DecodedLog = {
  address: string;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: string;
  eventName?: string;
  args?: unknown;
};

export type StoredEvent = {
  vault_address: string;
  block_number: string;
  log_index: number;
  name: string;
  args: Record<string, string>;
  occurred_at: string;
  tx_hash: string;
};

/**
 * Every value as a string, including the numbers.
 *
 * A uint64 of USDC passes 2^53 at about nine billion dollars, which is not a reassuring
 * margin for a product whose whole pitch is managed capital, and `JSON.parse` on the way
 * back out of jsonb would silently round it. Strings cross the boundary intact.
 */
export function serialiseArgs(args: unknown): Record<string, string> {
  if (args === null || typeof args !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    out[key] = typeof value === "string" ? value : String(value);
  }
  return out;
}

/** Block timestamps for the blocks a batch of logs touched, fetched once each. */
export async function blockTimestamps(
  client: PublicClient,
  blocks: bigint[]
): Promise<Map<bigint, number>> {
  const unique = [...new Set(blocks)];
  const fetched = await Promise.all(
    unique.map((blockNumber) => client.getBlock({ blockNumber, includeTransactions: false }))
  );

  const map = new Map<bigint, number>();
  unique.forEach((blockNumber, index) => {
    map.set(blockNumber, Number(fetched[index]!.timestamp) * 1000);
  });
  return map;
}

export async function syncVaultEvents(
  client: PublicClient,
  db: SupabaseClient,
  log: Logger,
  args: { vaults: Address[]; fromBlock: bigint; toBlock: bigint }
): Promise<number> {
  if (args.vaults.length === 0) return 0;

  const logs = (await client.getLogs({
    address: args.vaults,
    events: EVENTS as never,
    fromBlock: args.fromBlock,
    toBlock: args.toBlock,
  })) as unknown as DecodedLog[];

  if (logs.length === 0) return 0;

  const timestamps = await blockTimestamps(
    client,
    logs.map((entry) => entry.blockNumber)
  );

  const rows: StoredEvent[] = logs.map((entry) => {
    const occurredMs = timestamps.get(entry.blockNumber);
    if (occurredMs === undefined) throw new Error(`no timestamp for block ${entry.blockNumber}`);

    return {
      vault_address: entry.address.toLowerCase(),
      block_number: entry.blockNumber.toString(),
      log_index: entry.logIndex,
      name: entry.eventName ?? "unknown",
      args: serialiseArgs(entry.args),
      occurred_at: new Date(occurredMs).toISOString(),
      tx_hash: entry.transactionHash,
    };
  });

  requireWrite(
    "upserting vault events",
    await db
      .from("hl_vault_events")
      .upsert(rows, { onConflict: "vault_address,block_number,log_index", ignoreDuplicates: true })
  );

  await projectOrders(client, db, log, rows);

  log.info("vault events synced", { count: rows.length, toBlock: args.toBlock });
  return rows.length;
}

/**
 * Project `OrderPlaced` / `OrderReleased` into `hl_orders`.
 *
 * The expiry comes from a `reservations(cloid)` read rather than from `placed_at` plus a
 * duplicated `MAX_ORDER_LIFETIME`: the constant is internal to the contract, and the
 * keeper's whole job here is to pass cloids the contract will accept as expired. Reading
 * the number the contract itself stored removes the chance of being an hour out.
 */
export async function projectOrders(
  client: PublicClient,
  db: SupabaseClient,
  log: Logger,
  events: StoredEvent[]
): Promise<void> {
  const placed = events.filter((event) => event.name === "OrderPlaced");
  const released = events.filter((event) => event.name === "OrderReleased");

  if (placed.length) {
    const reservations = await Promise.all(
      placed.map((event) =>
        client.readContract({
          address: event.vault_address as Address,
          abi: HLAgentVaultAbi,
          functionName: "reservations",
          args: [BigInt(event.args.cloid!)],
        }) as Promise<readonly [number, bigint, bigint, boolean]>
      )
    );

    const rows = placed.map((event, index) => {
      const [, , expiry] = reservations[index]!;
      return {
        vault_address: event.vault_address,
        cloid: event.args.cloid!,
        asset: Number(event.args.asset!),
        is_buy: event.args.isBuy === "true",
        size: event.args.sz!,
        max_cost: event.args.maxCost!,
        // Zero expiry means the reservation has already been deleted, which the contract
        // does not do — `_release` only flips `released`. Treated as a bad read rather
        // than written as 1970, which would make the order instantly "stale" and have the
        // keeper send cloids the contract will skip.
        expires_at:
          expiry === 0n
            ? event.occurred_at
            : new Date(Number(expiry) * 1000).toISOString(),
        placed_at: event.occurred_at,
        placed_block: event.block_number,
      };
    });

    requireWrite(
      "upserting orders",
      await db.from("hl_orders").upsert(rows, { onConflict: "vault_address,cloid" })
    );
  }

  for (const event of released) {
    const { error, count } = await db
      .from("hl_orders")
      .update(
        {
          released_at: event.occurred_at,
          released_reason: event.args.reason ?? null,
        },
        { count: "exact" }
      )
      .eq("vault_address", event.vault_address)
      .eq("cloid", event.args.cloid!);

    if (error) throw new Error(`releasing order failed: ${error.message}`);

    if ((count ?? 0) === 0) {
      // The release was indexed without its placement, which means a block range was
      // never scanned. Loud, because the keeper's open-order set is now missing an order
      // it will never release and the only fix is a re-scan.
      log.warn("released an order that was never indexed", {
        vault: event.vault_address,
        cloid: event.args.cloid,
      });
    }
  }
}
