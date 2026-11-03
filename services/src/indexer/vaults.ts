import type { SupabaseClient } from "@supabase/supabase-js";
import type { Address, PublicClient } from "viem";

import { HLAgentVaultAbi, HLAgentVaultFactoryAbi } from "../abis/index.ts";
import { requireWrite } from "../shared/db.ts";
import type { Logger } from "../shared/log.ts";

/**
 * Mirror of the vault clones.
 *
 * Discovery is from `VaultDeployed` on the factory, and **only** from there. The factory
 * is the contract whose `isVault` mapping the registry trusts, so a vault it did not
 * deploy is not a vault this product recognises however convincingly it implements the
 * interface. Indexing any address that emits the right events would mirror an imposter.
 */

export const VAULT_STATUS = ["None", "Active", "Paused", "Closing"] as const;

/**
 * The vault's callable function names, taken from the ABI.
 *
 * So a renamed getter is a typecheck failure here rather than a revert at runtime — which
 * is the entire reason the ABIs are generated instead of hand-written.
 */
type VaultView = Extract<
  (typeof HLAgentVaultAbi)[number],
  { type: "function"; stateMutability: "view" | "pure" }
>["name"];

export type VaultState = {
  trader: Address;
  listingId: `0x${string}`;
  status: number;
  positionCapBps: number;
  maxDrawdownBps: number;
  pendingBridge: bigint;
  reserved: bigint;
  openOrders: number;
  highWaterMark: bigint;
  pendingWithdrawal: bigint;
  accruedBuilderFee: bigint;
  accruedPlatformFee: bigint;
  apiWallet: Address;
  /** Null when the Core read failed — see `readVaultState`. */
  equity: bigint | null;
};

export async function discoverVaults(
  client: PublicClient,
  log: Logger,
  args: { factory: Address; fromBlock: bigint; toBlock: bigint }
): Promise<Address[]> {
  const logs = await client.getLogs({
    address: args.factory,
    event: HLAgentVaultFactoryAbi.find(
      (entry) => entry.type === "event" && entry.name === "VaultDeployed"
    ) as never,
    fromBlock: args.fromBlock,
    toBlock: args.toBlock,
  });

  const found = logs
    .map((entry) => (entry as { args?: { vault?: string } }).args?.vault)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase() as Address);

  if (found.length) log.info("vaults discovered", { count: found.length, vaults: found });
  return found;
}

/**
 * Read a vault's whole state in one batched JSON-RPC call.
 *
 * `equity()` is the one read that can fail for a reason that is not an error: it goes
 * through the HyperCore margin-summary precompile, and on a chain where that precompile is
 * absent — a bare anvil, a fork without the etched mocks — it reverts. The field is
 * nullable rather than defaulted to zero because zero is a real equity and "I could not
 * read it" must not be mirrored as "the vault is empty".
 */
export async function readVaultState(
  client: PublicClient,
  vault: Address
): Promise<VaultState> {
  const read = <T>(functionName: VaultView) =>
    client.readContract({
      address: vault,
      abi: HLAgentVaultAbi,
      functionName,
    }) as Promise<T>;

  const [
    trader,
    listingId,
    status,
    positionCapBps,
    maxDrawdownBps,
    pendingBridge,
    reserved,
    openOrders,
    highWaterMark,
    pendingWithdrawal,
    accruedBuilderFee,
    accruedPlatformFee,
    apiWallet,
  ] = await Promise.all([
    read<Address>("trader"),
    read<`0x${string}`>("listingId"),
    read<number>("status"),
    read<number>("positionCapBps"),
    read<number>("maxDrawdownBps"),
    read<bigint>("pendingBridge"),
    read<bigint>("reserved"),
    read<number>("openOrders"),
    read<bigint>("highWaterMark"),
    read<bigint>("pendingWithdrawal"),
    read<bigint>("accruedBuilderFee"),
    read<bigint>("accruedPlatformFee"),
    read<Address>("apiWallet"),
  ]);

  const equity = await read<bigint>("equity").catch(() => null);

  return {
    trader,
    listingId,
    status,
    positionCapBps,
    maxDrawdownBps,
    pendingBridge,
    reserved,
    openOrders,
    highWaterMark,
    pendingWithdrawal,
    accruedBuilderFee,
    accruedPlatformFee,
    apiWallet,
    equity,
  };
}

export function vaultRow(vault: Address, chainId: number, state: VaultState) {
  const status = VAULT_STATUS[state.status];
  if (status === undefined) throw new Error(`unknown vault status ${state.status} for ${vault}`);

  const row: Record<string, unknown> = {
    address: vault.toLowerCase(),
    chain_id: chainId,
    trader: state.trader.toLowerCase(),
    listing_id: state.listingId.toLowerCase(),
    status,
    high_water_mark: state.highWaterMark.toString(),
    reserved: state.reserved.toString(),
    pending_bridge: state.pendingBridge.toString(),
    pending_withdrawal: state.pendingWithdrawal.toString(),
    accrued_builder_fee: state.accruedBuilderFee.toString(),
    accrued_platform_fee: state.accruedPlatformFee.toString(),
    open_orders: state.openOrders,
    position_cap_bps: state.positionCapBps,
    max_drawdown_bps: state.maxDrawdownBps,
    api_wallet: state.apiWallet.toLowerCase(),
    updated_at: new Date().toISOString(),
  };

  // Left out of the upsert entirely when unreadable, so the previous value survives.
  if (state.equity !== null) row.equity = state.equity.toString();

  return row;
}

export async function syncVaults(
  client: PublicClient,
  db: SupabaseClient,
  log: Logger,
  args: { chainId: number; vaults: Address[] }
): Promise<number> {
  if (args.vaults.length === 0) return 0;

  const states = await Promise.all(args.vaults.map((vault) => readVaultState(client, vault)));
  const rows = args.vaults.map((vault, index) => vaultRow(vault, args.chainId, states[index]!));

  requireWrite(
    "upserting vaults",
    await db.from("hl_vaults").upsert(rows, { onConflict: "address" })
  );

  log.info("vaults synced", { count: rows.length });
  return rows.length;
}

/** Every vault the mirror knows, for the refresh pass and for the keeper. */
export async function knownVaults(db: SupabaseClient, chainId: number): Promise<Address[]> {
  const { data, error } = await db
    .from("hl_vaults")
    .select("address")
    .eq("chain_id", chainId);

  if (error) throw new Error(`listing vaults failed: ${error.message}`);
  return (data ?? []).map((row) => (row.address as string).toLowerCase() as Address);
}
