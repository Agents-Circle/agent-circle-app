import type { Address } from "viem";

import { publicClientFor } from "../shared/chain.ts";
import { database } from "../shared/db.ts";
import { indexerConfig } from "../shared/env.ts";
import { InfoApi, assetIndexByCoin, sleep } from "../shared/hyperliquid.ts";
import { logger } from "../shared/log.ts";
import { blockRanges, readCursor, writeCursor } from "./cursor.ts";
import { syncVaultEvents } from "./events.ts";
import { syncFills } from "./fills.ts";
import { syncListings } from "./registry.ts";
import { dayOf, groupByListing, recomputeDays } from "./rollup.ts";
import { discoverVaults, knownVaults, syncVaults } from "./vaults.ts";

/**
 * The indexer.
 *
 * Reads the registry, the factory, the vaults and the Hyperliquid info API, and writes the
 * mirror every read surface of the product depends on. One pass does chain logs first, then
 * vault state, then fills, then the daily rollup — in that order, because each stage needs
 * the one before it: there is no vault to read fills for until the factory log is indexed.
 *
 * Run with `--once` to do a single pass and exit, which is what CI and a backfill want.
 *
 * ## Reorgs
 *
 * Every pass re-scans the last `INDEXER_CONFIRMATIONS` blocks. Re-indexing a log is free —
 * every table is keyed on the log's own identity — so the overlap costs nothing and covers
 * a shallow reorg that *adds* logs. What it cannot do is remove a log that was reorged out:
 * nothing here deletes. On a chain with HyperEVM's finality that is an acceptable gap and
 * not an invisible one, which is why it is written down here rather than assumed away.
 */

const CONFIRMATIONS = BigInt(process.env.INDEXER_CONFIRMATIONS ?? "2");

const log = logger("indexer");

async function pass(context: {
  config: ReturnType<typeof indexerConfig>;
  client: ReturnType<typeof publicClientFor>;
  db: ReturnType<typeof database>;
  info: InfoApi;
  assetIndex: Map<string, number>;
}): Promise<void> {
  const { config, client, db, info, assetIndex } = context;

  const cursor = await readCursor(db, "indexer", config.chainId, config.startBlock);
  const head = await client.getBlockNumber();

  const from = cursor.lastBlock > CONFIRMATIONS ? cursor.lastBlock - CONFIRMATIONS : 0n;
  let vaults = await knownVaults(db, config.chainId);
  const touched: { vault: string; day: string }[] = [];

  for (const range of blockRanges(from, head, config.blockRange)) {
    await syncListings(client, db, log, {
      registry: config.registry,
      chainId: config.chainId,
      ...range,
      fromBlock: range.from,
      toBlock: range.to,
    });

    const discovered = await discoverVaults(client, log, {
      factory: config.factory,
      fromBlock: range.from,
      toBlock: range.to,
    });

    if (discovered.length) {
      // State before events: `hl_vault_events` has a foreign key to `hl_vaults`, so a
      // vault's own `Initialized` log cannot be stored until its row exists.
      await syncVaults(client, db, log, { chainId: config.chainId, vaults: discovered });
      vaults = [...new Set([...vaults, ...discovered])];
    }

    await syncVaultEvents(client, db, log, {
      vaults,
      fromBlock: range.from,
      toBlock: range.to,
    });
  }

  // Refresh every vault's state once per pass. Separate from the range loop because this
  // reads current state, not history: doing it per range would be the same read repeated.
  await syncVaults(client, db, log, { chainId: config.chainId, vaults });

  // Fills, from the last timestamp seen. A cold cursor reads the last day rather than all
  // of history: a full backfill is `INDEXER_FILL_BACKFILL_MS`, set deliberately, because
  // walking a year of fills on every fresh deploy is how a rate limit is discovered.
  const backfillMs = Number(process.env.INDEXER_FILL_BACKFILL_MS ?? 86_400_000);
  const now = Date.now();
  const sinceMs = cursor.lastFillTimeMs > 0 ? cursor.lastFillTimeMs : now - backfillMs;

  const { inserted, cursorMs } = await syncFills(info, db, log, {
    vaults,
    assetIndexByCoin: assetIndex,
    sinceMs,
    untilMs: now,
  });

  // Which days changed. Derived from what was written rather than from a window, so a
  // backfill of old fills recomputes the days those fills belong to.
  const days = await touchedDays(db, vaults, sinceMs);
  touched.push(...days);

  const { listingByVault, vaultsByListing } = await vaultListings(db, config.chainId);
  await recomputeDays(db, log, groupByListing(touched, vaultsByListing, listingByVault));

  await writeCursor(db, "indexer", config.chainId, {
    lastBlock: head,
    lastFillTimeMs: cursorMs,
  });

  log.info("pass complete", { head, fills: inserted, days: touched.length });
}

/** The `(vault, day)` pairs with a fill or an event at or after `sinceMs`. */
async function touchedDays(
  db: ReturnType<typeof database>,
  vaults: Address[],
  sinceMs: number
): Promise<{ vault: string; day: string }[]> {
  if (vaults.length === 0) return [];
  const since = new Date(sinceMs).toISOString();

  const [fills, events] = await Promise.all([
    db.from("hl_fills").select("vault_address, filled_at").in("vault_address", vaults).gte("filled_at", since),
    db
      .from("hl_vault_events")
      .select("vault_address, occurred_at")
      .in("vault_address", vaults)
      .gte("occurred_at", since),
  ]);

  if (fills.error) throw new Error(`reading touched fills failed: ${fills.error.message}`);
  if (events.error) throw new Error(`reading touched events failed: ${events.error.message}`);

  const seen = new Set<string>();
  const out: { vault: string; day: string }[] = [];

  const add = (vault: string, iso: string) => {
    const day = dayOf(iso);
    const key = `${vault}|${day}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ vault, day });
  };

  for (const row of fills.data ?? []) add(row.vault_address as string, row.filled_at as string);
  for (const row of events.data ?? []) add(row.vault_address as string, row.occurred_at as string);

  return out;
}

async function vaultListings(
  db: ReturnType<typeof database>,
  chainId: number
): Promise<{ listingByVault: Map<string, string>; vaultsByListing: Map<string, string[]> }> {
  const { data, error } = await db
    .from("hl_vaults")
    .select("address, listing_id")
    .eq("chain_id", chainId);

  if (error) throw new Error(`reading vault listings failed: ${error.message}`);

  const listingByVault = new Map<string, string>();
  const vaultsByListing = new Map<string, string[]>();

  for (const row of data ?? []) {
    const vault = row.address as string;
    const listing = row.listing_id as string;
    listingByVault.set(vault, listing);
    vaultsByListing.set(listing, [...(vaultsByListing.get(listing) ?? []), vault]);
  }

  return { listingByVault, vaultsByListing };
}

async function main(): Promise<void> {
  const config = indexerConfig();
  const client = publicClientFor(config);
  const db = database(config);
  const info = new InfoApi(config.infoUrl, log);

  const assetIndex = assetIndexByCoin(await info.perpMeta());

  log.info("starting", {
    network: config.network,
    chainId: config.chainId,
    registry: config.registry,
    factory: config.factory,
    assets: assetIndex.size,
    startBlock: config.startBlock,
  });

  const once = process.argv.includes("--once");
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      // Finish the pass rather than dying inside it. A pass is interrupted safely at any
      // point — the cursor only advances at the end — but finishing one keeps the logs
      // readable and the next start cheap.
      log.info("stopping after this pass", { signal });
      stopping = true;
    });
  }

  for (;;) {
    try {
      await pass({ config, client, db, info, assetIndex });
    } catch (error) {
      // Keep going. A pass that throws has written whatever it got to and left the cursor
      // where it was, so the next one redoes the range. Exiting would turn a rate limit
      // into an outage.
      log.error("pass failed", { error: error instanceof Error ? error.message : String(error) });
    }

    if (once || stopping) return;
    await sleep(config.pollMs);
  }
}

await main();
