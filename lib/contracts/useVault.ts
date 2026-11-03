"use client";

import { useMemo } from "react";
import type { Address } from "viem";
import { erc20Abi, maxUint256 } from "viem";
import {
  useAccount,
  useReadContract,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

import { HLAgentVaultAbi, HLAgentVaultFactoryAbi } from "./abis";
import { deploymentFor } from "./addresses";
import { USDC_ADDRESS, type SupportedChainId } from "@/lib/chains/hyperevm";

/** Vault lifecycle, mirroring `HLAgentVault.VaultStatus`. */
export const VAULT_STATUS = ["None", "Active", "Paused", "Closing"] as const;
export type VaultStatus = (typeof VAULT_STATUS)[number];

export type VaultState = {
  address: Address;
  exists: boolean;
  status: VaultStatus;
  /** USDC, 1e6, as HyperCore reports it. */
  equity: bigint;
  highWaterMark: bigint;
  /** Deposited and asked of Core, not yet visible in the Core margin summary. */
  pendingBridge: bigint;
  /** Worst-case cost of orders the vault believes are outstanding. */
  reserved: bigint;
  availableToWithdraw: bigint;
  pendingWithdrawal: bigint;
  openOrders: number;
  positionCapBps: number;
  maxDrawdownBps: number;
  /** Zero when fast mode is off. */
  apiWallet: Address;
  accruedBuilderFee: bigint;
  accruedPlatformFee: bigint;
};

/**
 * Drawdown from the high-water mark, in basis points.
 *
 * Computed here rather than read from the chain because the contract does not expose it
 * — `HighWaterMark.drawdownBps` is an internal pure function. Keeping the arithmetic
 * identical to Solidity matters: a dashboard that disagrees with the contract about how
 * far down a vault is would have traders arguing with an auto-pause they can see coming
 * and the UI cannot.
 */
export function drawdownBps(equity: bigint, highWaterMark: bigint): number {
  if (highWaterMark === 0n || equity >= highWaterMark) return 0;
  return Number(((highWaterMark - equity) * 10_000n) / highWaterMark);
}

/** Where this trader's vault for `listingId` lives, deployed or not. */
export function useVaultAddress(listingId: `0x${string}` | undefined) {
  const { address: trader, chainId } = useAccount();
  const deployment = chainId ? deploymentFor(chainId) : null;

  return useReadContract({
    abi: HLAgentVaultFactoryAbi,
    address: deployment?.factory,
    functionName: "predictVault",
    args: trader && listingId ? [trader, listingId] : undefined,
    query: { enabled: Boolean(deployment && trader && listingId) },
  });
}

/**
 * Everything the dashboard needs about one vault, in a single multicall.
 *
 * Thirteen separate `useReadContract` calls would be thirteen round trips and thirteen
 * independently-stale values, which on a risk dashboard is worse than it sounds: a
 * trader could see an equity from one block beside a high-water mark from another and a
 * drawdown computed across the two. Batched, they are at least consistent with each
 * other.
 */
export function useVaultState(vault: Address | undefined) {
  const base = { abi: HLAgentVaultAbi, address: vault } as const;

  const query = useReadContracts({
    allowFailure: false,
    contracts: [
      { ...base, functionName: "status" },
      { ...base, functionName: "equity" },
      { ...base, functionName: "highWaterMark" },
      { ...base, functionName: "pendingBridge" },
      { ...base, functionName: "reserved" },
      { ...base, functionName: "availableToWithdraw" },
      { ...base, functionName: "pendingWithdrawal" },
      { ...base, functionName: "openOrders" },
      { ...base, functionName: "positionCapBps" },
      { ...base, functionName: "maxDrawdownBps" },
      { ...base, functionName: "apiWallet" },
      { ...base, functionName: "accruedBuilderFee" },
      { ...base, functionName: "accruedPlatformFee" },
    ],
    query: { enabled: Boolean(vault) },
  });

  const state = useMemo<VaultState | null>(() => {
    if (!vault || !query.data) return null;
    const [
      status,
      equity,
      highWaterMark,
      pendingBridge,
      reserved,
      availableToWithdraw,
      pendingWithdrawal,
      openOrders,
      positionCapBps,
      maxDrawdownBps,
      apiWallet,
      accruedBuilderFee,
      accruedPlatformFee,
    ] = query.data;

    return {
      address: vault,
      // `status` is `None` for an address that has never been initialised, which is also
      // what `predictVault` returns for a vault nobody has opened. One check, both cases.
      exists: Number(status) !== 0,
      status: VAULT_STATUS[Number(status)] ?? "None",
      equity,
      highWaterMark,
      pendingBridge,
      reserved,
      availableToWithdraw,
      pendingWithdrawal,
      openOrders: Number(openOrders),
      positionCapBps: Number(positionCapBps),
      maxDrawdownBps: Number(maxDrawdownBps),
      apiWallet,
      accruedBuilderFee,
      accruedPlatformFee,
    };
  }, [vault, query.data]);

  return { ...query, state };
}

/**
 * The write side.
 *
 * One hook returning named actions rather than one hook per action, so a surface can
 * offer deposit, withdraw, pause and exit without six `useWriteContract` instances whose
 * pending states have to be reconciled by hand.
 */
export function useVaultActions(vault: Address | undefined) {
  const { chainId } = useAccount();
  const deployment = chainId ? deploymentFor(chainId) : null;
  const usdc = chainId ? USDC_ADDRESS[chainId as SupportedChainId] : undefined;

  const { writeContractAsync, data: hash, isPending, error, reset } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash });

  const openVault = (listingId: `0x${string}`, capBps = 0, maxDdBps = 0) =>
    writeContractAsync({
      abi: HLAgentVaultFactoryAbi,
      address: deployment!.factory,
      functionName: "deployVault",
      args: [listingId, capBps, maxDdBps],
    });

  /**
   * Approve USDC to the vault.
   *
   * `maxUint256` rather than the exact amount, and it is a real trade-off: an unlimited
   * approval to a vault means a compromised vault implementation could pull the trader's
   * whole USDC balance, not just what they meant to deposit. It is used here because the
   * vault is a clone of an implementation that cannot be upgraded and whose only
   * `transferFrom` is in `deposit`, which is gated on `onlyTrader`. If the implementation
   * ever becomes upgradeable, this must become an exact-amount approval.
   */
  const approveUsdc = () =>
    writeContractAsync({
      abi: erc20Abi,
      address: usdc!,
      functionName: "approve",
      args: [vault!, maxUint256],
    });

  const deposit = (amount: bigint) =>
    writeContractAsync({
      abi: HLAgentVaultAbi,
      address: vault!,
      functionName: "deposit",
      args: [amount],
    });

  const requestWithdraw = (amount: bigint) =>
    writeContractAsync({
      abi: HLAgentVaultAbi,
      address: vault!,
      functionName: "requestWithdraw",
      args: [amount],
    });

  const finalizeWithdraw = () =>
    writeContractAsync({
      abi: HLAgentVaultAbi,
      address: vault!,
      functionName: "finalizeWithdraw",
    });

  const pause = () =>
    writeContractAsync({
      abi: HLAgentVaultAbi,
      address: vault!,
      functionName: "pause",
    });

  const resume = () =>
    writeContractAsync({
      abi: HLAgentVaultAbi,
      address: vault!,
      functionName: "resume",
    });

  const tightenRiskLimits = (capBps: number, maxDdBps: number) =>
    writeContractAsync({
      abi: HLAgentVaultAbi,
      address: vault!,
      functionName: "tightenRiskLimits",
      args: [capBps, maxDdBps],
    });

  const exitPosition = (asset: number) =>
    writeContractAsync({
      abi: HLAgentVaultAbi,
      address: vault!,
      functionName: "exitPosition",
      args: [asset],
    });

  const enableFastMode = (apiWallet: Address) =>
    writeContractAsync({
      abi: HLAgentVaultAbi,
      address: vault!,
      functionName: "enableFastMode",
      args: [apiWallet],
    });

  const disableFastMode = () =>
    writeContractAsync({
      abi: HLAgentVaultAbi,
      address: vault!,
      functionName: "disableFastMode",
    });

  return {
    openVault,
    approveUsdc,
    deposit,
    requestWithdraw,
    finalizeWithdraw,
    pause,
    resume,
    tightenRiskLimits,
    exitPosition,
    enableFastMode,
    disableFastMode,
    hash,
    isPending: isPending || receipt.isLoading,
    isSuccess: receipt.isSuccess,
    error: error ?? receipt.error,
    reset,
  };
}

/** The trader's USDC balance and what they have approved to the vault. */
export function useUsdcPosition(vault: Address | undefined) {
  const { address: owner, chainId } = useAccount();
  const usdc = chainId ? USDC_ADDRESS[chainId as SupportedChainId] : undefined;

  return useReadContracts({
    allowFailure: false,
    contracts: [
      {
        abi: erc20Abi,
        address: usdc,
        functionName: "balanceOf",
        args: owner ? [owner] : undefined,
      },
      {
        abi: erc20Abi,
        address: usdc,
        functionName: "allowance",
        args: owner && vault ? [owner, vault] : undefined,
      },
    ],
    query: { enabled: Boolean(usdc && owner && vault) },
  });
}
