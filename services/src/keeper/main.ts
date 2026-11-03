import type { SupabaseClient } from "@supabase/supabase-js";
import { createWalletClient, formatEther, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { HLAgentVaultAbi } from "../abis/index.ts";
import { chainFor, publicClientFor } from "../shared/chain.ts";
import { database, requireWrite } from "../shared/db.ts";
import { keeperConfig } from "../shared/env.ts";
import { InfoApi, assetIndexByCoin, sleep } from "../shared/hyperliquid.ts";
import { logger } from "../shared/log.ts";
import { drawdownBps } from "../shared/units.ts";
import { readVaultState, VAULT_STATUS } from "../indexer/vaults.ts";
import { checkCap, effectiveCapBps, readPositions } from "./monitor.ts";
import { decide, isFastMode, prioritise, type Decision, type OpenOrder, type VaultSnapshot } from "./policy.ts";

/**
 * The keeper.
 *
 * Calls `reconcile` on the vaults that need it, and watches the ones running in fast mode.
 *
 * ## It reads the chain, not the mirror
 *
 * The indexer's tables say which vaults exist and which orders are outstanding — the second
 * of those is information the chain cannot provide, since `reservations` is a mapping and
 * mappings do not enumerate. Everything the *decision* turns on is read from the chain in
 * this pass: equity, the high-water mark, the limits, the status. A keeper that paused a
 * vault on the strength of a mirror row written four minutes ago would be acting on a
 * drawdown that may no longer exist.
 *
 * ## It sends nothing unless told to
 *
 * `KEEPER_SEND=true` is required before anything is signed, and mainnet needs a typed
 * acknowledgement on top of that. A dry run makes every decision, writes every audit row
 * with `sent = false`, and signs nothing — which makes "what would the keeper have done"
 * a question with an answer in the database.
 */

const log = logger("keeper");

const LOW_GAS_WEI = 10n ** 17n; // 0.1 HYPE

type Work = {
  vault: Address;
  snapshot: VaultSnapshot;
  decision: Decision;
  lastReconciledAtMs: number | null;
};

async function openOrders(db: SupabaseClient, vault: string): Promise<OpenOrder[]> {
  const { data, error } = await db
    .from("hl_orders")
    .select("cloid, asset, max_cost, expires_at")
    .eq("vault_address", vault)
    .is("released_at", null);

  if (error) throw new Error(`reading open orders failed: ${error.message}`);

  return (data ?? []).map((row) => ({
    cloid: String(row.cloid),
    asset: Number(row.asset),
    maxCost: BigInt(row.max_cost as string),
    expiresAtMs: new Date(row.expires_at as string).getTime(),
  }));
}

/**
 * When this vault was last reconciled, from whichever source is further ahead.
 *
 * The indexer's view can lag by a pass; the keeper's own audit trail cannot lag its own
 * sends. Taking the later of the two stops a keeper that is ahead of the indexer from
 * reconciling the same vault every poll because the event has not been indexed yet.
 */
async function lastReconciledAt(db: SupabaseClient, vault: string): Promise<number | null> {
  const [events, actions] = await Promise.all([
    db
      .from("hl_vault_events")
      .select("occurred_at")
      .eq("vault_address", vault)
      .eq("name", "Reconciled")
      .order("occurred_at", { ascending: false })
      .limit(1),
    db
      .from("keeper_actions")
      .select("created_at")
      .eq("vault_address", vault)
      .eq("action", "reconcile")
      .eq("sent", true)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  if (events.error) throw new Error(`reading reconciles failed: ${events.error.message}`);
  if (actions.error) throw new Error(`reading keeper actions failed: ${actions.error.message}`);

  const times = [
    events.data?.[0]?.occurred_at as string | undefined,
    actions.data?.[0]?.created_at as string | undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .map((value) => new Date(value).getTime());

  return times.length ? Math.max(...times) : null;
}

async function fillsSince(
  db: SupabaseClient,
  vault: string,
  sinceMs: number | null
): Promise<number> {
  if (sinceMs === null) return 0;

  const { count, error } = await db
    .from("hl_fills")
    .select("id", { count: "exact", head: true })
    .eq("vault_address", vault)
    .gt("filled_at", new Date(sinceMs).toISOString());

  if (error) throw new Error(`counting fills failed: ${error.message}`);
  return count ?? 0;
}

async function record(
  db: SupabaseClient,
  row: Record<string, unknown>
): Promise<void> {
  requireWrite("recording keeper action", await db.from("keeper_actions").insert(row));
}

async function pass(context: {
  config: ReturnType<typeof keeperConfig>;
  client: ReturnType<typeof publicClientFor>;
  wallet: ReturnType<typeof createWalletClient>;
  account: ReturnType<typeof privateKeyToAccount>;
  db: ReturnType<typeof database>;
  info: InfoApi;
  assetIndex: Map<string, number>;
}): Promise<void> {
  const { config, client, wallet, account, db, info, assetIndex } = context;

  const { data, error } = await db
    .from("hl_vaults")
    .select("address")
    .eq("chain_id", config.chainId);

  if (error) throw new Error(`reading vaults failed: ${error.message}`);
  const vaults = (data ?? []).map((row) => (row.address as string).toLowerCase() as Address);

  if (vaults.length === 0) {
    log.debug("no vaults to keep");
    return;
  }

  const work: Work[] = [];

  for (const vault of vaults) {
    const state = await readVaultState(client, vault);
    const status = VAULT_STATUS[state.status] ?? "None";
    const last = await lastReconciledAt(db, vault);

    const snapshot: VaultSnapshot = {
      address: vault,
      status,
      equity: state.equity,
      highWaterMark: state.highWaterMark,
      pendingBridge: state.pendingBridge,
      pendingWithdrawal: state.pendingWithdrawal,
      reserved: state.reserved,
      openOrders: state.openOrders,
      maxDrawdownBps: BigInt(state.maxDrawdownBps),
      positionCapBps: BigInt(state.positionCapBps),
      apiWallet: state.apiWallet,
      lastReconciledAtMs: last,
    };

    const decision = decide(snapshot, await openOrders(db, vault), {
      nowMs: Date.now(),
      maxReconcileIntervalMs: config.maxReconcileIntervalMs,
      drawdownWarnMarginBps: config.drawdownWarnMarginBps,
      fillsSinceReconcile: await fillsSince(db, vault, last),
    });

    work.push({ vault, snapshot, decision, lastReconciledAtMs: last });

    if (isFastMode(snapshot)) {
      await monitorFastMode(db, client, info, config, assetIndex, snapshot);
    }
  }

  for (const item of prioritise(work)) {
    const { vault, snapshot, decision } = item;

    const dd =
      snapshot.equity === null ? null : Number(drawdownBps(snapshot.equity, snapshot.highWaterMark));

    const audit = {
      chain_id: config.chainId,
      vault_address: vault,
      reasons: decision.reasons,
      equity: snapshot.equity?.toString() ?? null,
      high_water_mark: snapshot.highWaterMark.toString(),
      drawdown_bps: dd,
      stale_cloids: decision.staleCloids,
    };

    if (!decision.reconcile) {
      // Only recorded when something was observed but not acted on. A quiet vault writing
      // a row every poll would bury the rows that matter.
      if (decision.blind) {
        await record(db, { ...audit, action: "skipped", error: "equity unreadable" });
        log.warn("equity unreadable, no drawdown conclusion", { vault });
      }
      continue;
    }

    if (!config.send) {
      await record(db, { ...audit, action: "reconcile", sent: false });
      log.info("would reconcile", { vault, reasons: decision.reasons, dryRun: true });
      continue;
    }

    try {
      const hash = await wallet.writeContract({
        address: vault,
        abi: HLAgentVaultAbi,
        functionName: "reconcile",
        args: [decision.staleCloids.map((cloid) => BigInt(cloid))],
        account,
        chain: chainFor(config.chainId),
      });

      await client.waitForTransactionReceipt({ hash });
      await record(db, { ...audit, action: "reconcile", sent: true, tx_hash: hash });
      log.info("reconciled", { vault, reasons: decision.reasons, hash, urgent: decision.urgent });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await record(db, { ...audit, action: "failed", sent: false, error: message.slice(0, 500) });
      log.error("reconcile failed", { vault, error: message });
    }
  }
}

async function monitorFastMode(
  db: ReturnType<typeof database>,
  client: ReturnType<typeof publicClientFor>,
  info: InfoApi,
  config: ReturnType<typeof keeperConfig>,
  assetIndex: Map<string, number>,
  snapshot: VaultSnapshot
): Promise<void> {
  const report = await readPositions(info, snapshot.address);
  const capBps = await effectiveCapBps(client, config.whitelist, snapshot, assetIndex, report);
  const breach = checkCap(snapshot, report, capBps);

  if (breach === null) return;

  await record(db, {
    chain_id: config.chainId,
    vault_address: snapshot.address,
    action: "breach_detected",
    reasons: ["position_cap"],
    equity: breach.equity.toString(),
    high_water_mark: snapshot.highWaterMark.toString(),
    sent: false,
    error:
      `position value ${breach.positionValue} + reserved ${breach.reserved} exceeds ` +
      `${breach.capBps}bps of equity ${breach.equity}`,
  });

  // Error level because nothing downstream of this is automatic. The keeper has no call it
  // is authorised to make that reduces the position; the remedies belong to the trader and
  // to governance, and both of them are people who have to be told.
  log.error("position cap breached in fast mode", {
    vault: snapshot.address,
    capBps: breach.capBps,
    positionValue: breach.positionValue,
    equity: breach.equity,
    assets: breach.assets.map((asset) => asset.coin),
  });
}

async function main(): Promise<void> {
  const config = keeperConfig();
  const client = publicClientFor(config);
  const account = privateKeyToAccount(config.privateKey);
  const wallet = createWalletClient({
    account,
    chain: chainFor(config.chainId),
    transport: http(config.rpcUrl),
  });
  const db = database(config);
  const info = new InfoApi(config.infoUrl, log);
  const assetIndex = assetIndexByCoin(await info.perpMeta());

  const balance = await client.getBalance({ address: account.address });

  log.info("starting", {
    network: config.network,
    chainId: config.chainId,
    keeper: account.address,
    balanceHype: formatEther(balance),
    send: config.send,
  });

  if (!config.send) {
    log.warn("dry run: decisions will be recorded with sent = false and nothing signed");
  }

  if (balance < LOW_GAS_WEI) {
    // Not fatal. A keeper that cannot pay for gas still has a job: it records what it
    // would have done, and that record is what tells someone to fund it.
    log.warn("keeper balance is low", { balanceHype: formatEther(balance) });
  }

  const once = process.argv.includes("--once");
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      log.info("stopping after this pass", { signal });
      stopping = true;
    });
  }

  for (;;) {
    try {
      await pass({ config, client, wallet, account, db, info, assetIndex });
    } catch (error) {
      log.error("pass failed", { error: error instanceof Error ? error.message : String(error) });
    }

    if (once || stopping) return;
    await sleep(config.pollMs);
  }
}

await main();
