"use client";

import { useMemo } from "react";
import type { Address, Hex } from "viem";
import { erc20Abi, maxUint256 } from "viem";
import {
  useAccount,
  useBytecode,
  useReadContract,
  useReadContracts,
  useWriteContract,
} from "wagmi";

import { AgentRegistryAbi } from "./abis";
import { deploymentFor } from "./addresses";
import { USDC_ADDRESS, type SupportedChainId } from "@/lib/chains/hyperevm";

/** Mirrors `IAgentRegistry.ListingStatus`. */
export const LISTING_STATUS = [
  "None",
  "Vetting",
  "Live",
  "Rejected",
  "Suspended",
  "Delisted",
] as const;
export type ListingStatus = (typeof LISTING_STATUS)[number];

export type BuilderState = {
  exists: boolean;
  /** USDC at 1e6. Bonds are USDC, never a token the platform issues. */
  bondAmount: bigint;
  /** Sum across every listing this builder owns, which is what the ceiling applies to. */
  totalAum: bigint;
  unbondAmount: bigint;
  unbondRequestedAt: bigint;
  slashCount: number;
  agentCount: number;
  /** 0–3. Tier 0 is registered but unbonded, and may hold no capital at all. */
  tier: number;
};

export type Tiers = {
  /** Bond required for tiers 1–3, USDC at 1e6. */
  bonds: readonly [bigint, bigint, bigint];
  /** AUM each tier unlocks, **per builder across every listing**, USDC at 1e6. */
  ceilings: readonly [bigint, bigint, bigint];
  /** Seconds between `requestUnbond` and `withdrawBond`. */
  unbondPeriod: bigint;
};

function registryFor(chainId: number): Address | null {
  return deploymentFor(chainId)?.registry ?? null;
}

/**
 * One builder's registry record.
 *
 * `null` when the chain has no deployment or no wallet is connected, so a caller that
 * renders from `state` cannot accidentally show a zeroed record as a real one.
 */
export function useBuilder(builder?: Address) {
  const { address: connected, chainId } = useAccount();
  const who = builder ?? connected;
  const registry = chainId ? registryFor(chainId) : null;

  const query = useReadContract({
    abi: AgentRegistryAbi,
    address: registry ?? undefined,
    functionName: "getBuilder",
    args: who ? [who] : undefined,
    query: { enabled: Boolean(registry && who) },
  });

  const state = useMemo<BuilderState | null>(() => {
    if (!query.data) return null;
    const b = query.data;
    return {
      exists: b.exists,
      bondAmount: b.bondAmount,
      totalAum: b.totalAum,
      unbondAmount: b.unbondAmount,
      unbondRequestedAt: BigInt(b.unbondRequestedAt),
      slashCount: Number(b.slashCount),
      agentCount: Number(b.agentCount),
      tier: Number(b.tier),
    };
  }, [query.data]);

  return { ...query, state };
}

/** The bond ladder, read from the chain rather than from `parameters.json`. */
export function useTiers() {
  const { chainId } = useAccount();
  const registry = chainId ? registryFor(chainId) : null;
  const contract = { abi: AgentRegistryAbi, address: registry ?? undefined } as const;

  const query = useReadContracts({
    contracts: [
      { ...contract, functionName: "tierBonds", args: [0n] },
      { ...contract, functionName: "tierBonds", args: [1n] },
      { ...contract, functionName: "tierBonds", args: [2n] },
      { ...contract, functionName: "tierCeilings", args: [0n] },
      { ...contract, functionName: "tierCeilings", args: [1n] },
      { ...contract, functionName: "tierCeilings", args: [2n] },
      { ...contract, functionName: "unbondPeriod" },
    ],
    allowFailure: false,
    query: { enabled: Boolean(registry) },
  });

  const tiers = useMemo<Tiers | null>(() => {
    if (!query.data) return null;
    const [b0, b1, b2, c0, c1, c2, unbondPeriod] = query.data;
    return {
      bonds: [b0, b1, b2],
      ceilings: [c0, c1, c2],
      unbondPeriod: BigInt(unbondPeriod),
    };
  }, [query.data]);

  return { ...query, tiers };
}

/**
 * What a tier costs *this* builder, which is not always `tierBonds`: governance can set an
 * agent bond discount, and `requiredBond` is the only place that applies it.
 */
export function useRequiredBond(tier: number) {
  const { chainId } = useAccount();
  const registry = chainId ? registryFor(chainId) : null;

  return useReadContract({
    abi: AgentRegistryAbi,
    address: registry ?? undefined,
    functionName: "requiredBond",
    args: [BigInt(tier)],
    query: { enabled: Boolean(registry) && tier > 0 },
  });
}

/** How much more AUM one listing can take before the builder's ceiling stops it. */
export function useAumHeadroom(listingId?: Hex) {
  const { chainId } = useAccount();
  const registry = chainId ? registryFor(chainId) : null;

  return useReadContract({
    abi: AgentRegistryAbi,
    address: registry ?? undefined,
    functionName: "availableAumHeadroom",
    args: listingId ? [listingId] : undefined,
    query: { enabled: Boolean(registry && listingId) },
  });
}

export type ListingState = {
  id: Hex;
  builder: Address;
  agentAuthority: Address;
  status: ListingStatus;
  performanceFeeBps: number;
  builderSplitBps: number;
  positionCapBps: number;
  maxDrawdownBps: number;
  executionFeeBps: number;
  executionBuilderSplitBps: number;
  submittedAt: bigint;
  metadataHash: Hex;
};

/**
 * One listing. Reads the connected wallet's chain unless `onChain` names one, which is how
 * the admin page reads the deployment it exports for whatever chain the wallet is on.
 */
export function useListing(id?: Hex, onChain?: number) {
  const { chainId: walletChain } = useAccount();
  const chainId = onChain ?? walletChain;
  const registry = chainId ? registryFor(chainId) : null;

  const query = useReadContract({
    abi: AgentRegistryAbi,
    address: registry ?? undefined,
    functionName: "getListing",
    args: id ? [id] : undefined,
    chainId,
    query: { enabled: Boolean(registry && id) },
  });

  const state = useMemo<ListingState | null>(() => {
    if (!query.data || !id) return null;
    const l = query.data;
    // Status `None` is what the mapping returns for an id nobody submitted, so it is the
    // "does not exist" case rather than a listing in some initial state.
    if (Number(l.status) === 0) return null;
    return {
      id,
      builder: l.builder,
      agentAuthority: l.agentAuthority,
      status: LISTING_STATUS[Number(l.status)] ?? "None",
      performanceFeeBps: Number(l.performanceFeeBps),
      builderSplitBps: Number(l.builderSplitBps),
      positionCapBps: Number(l.positionCapBps),
      maxDrawdownBps: Number(l.maxDrawdownBps),
      executionFeeBps: Number(l.executionFeeBps),
      executionBuilderSplitBps: Number(l.executionBuilderSplitBps),
      submittedAt: BigInt(l.submittedAt),
      metadataHash: l.metadataHash,
    };
  }, [query.data, id]);

  return { ...query, state };
}

/**
 * The registry's governance account on `chainId`, and whether it is a contract.
 *
 * On mainnet it must be a Safe multisig. On testnet it is an EOA, which no Safe can act
 * for, so a page that exports governance calls has to say which of the two it is.
 */
export function useGovernance(chainId: number) {
  const registry = registryFor(chainId);

  const { data: address, ...query } = useReadContract({
    abi: AgentRegistryAbi,
    address: registry ?? undefined,
    functionName: "governance",
    chainId,
    query: { enabled: Boolean(registry) },
  });

  const { data: code } = useBytecode({
    address,
    chainId,
    query: { enabled: Boolean(address) },
  });

  return {
    ...query,
    address,
    /** `undefined` until the code has been read. */
    isContract: code === undefined ? undefined : code !== null && code !== "0x",
  };
}

/** The builder's USDC, and what the registry is allowed to take for a bond. */
export function useBondAllowance() {
  const { address, chainId } = useAccount();
  const registry = chainId ? registryFor(chainId) : null;
  const usdc = chainId ? USDC_ADDRESS[chainId as SupportedChainId] : undefined;

  return useReadContracts({
    contracts: [
      { abi: erc20Abi, address: usdc, functionName: "balanceOf", args: address ? [address] : undefined },
      {
        abi: erc20Abi,
        address: usdc,
        functionName: "allowance",
        args: address && registry ? [address, registry] : undefined,
      },
    ],
    allowFailure: false,
    query: { enabled: Boolean(usdc && address && registry) },
  });
}

/**
 * The write side.
 *
 * One `useWriteContract` for every action, as `useVaultActions` does, so a page can offer
 * the whole builder lifecycle without juggling six hooks and six pending flags.
 */
export function useRegistryActions() {
  const { chainId } = useAccount();
  const { writeContractAsync, data: hash, isPending, error, reset } = useWriteContract();
  const registry = chainId ? registryFor(chainId) : null;
  const usdc = chainId ? USDC_ADDRESS[chainId as SupportedChainId] : undefined;

  const registerBuilder = () =>
    writeContractAsync({
      abi: AgentRegistryAbi,
      address: registry!,
      functionName: "registerBuilder",
    });

  /** Bonds are pulled by the registry, so the allowance has to exist first. */
  const approveUsdc = () =>
    writeContractAsync({
      abi: erc20Abi,
      address: usdc!,
      functionName: "approve",
      args: [registry!, maxUint256],
    });

  const stakeBond = (amount: bigint) =>
    writeContractAsync({
      abi: AgentRegistryAbi,
      address: registry!,
      functionName: "stakeBond",
      args: [amount],
    });

  /**
   * Starts the unbonding clock. The bond stays slashable throughout, and `withdrawBond`
   * still refuses if what is left would not cover the builder's current AUM — traders
   * exit before a builder does.
   */
  const requestUnbond = (amount: bigint) =>
    writeContractAsync({
      abi: AgentRegistryAbi,
      address: registry!,
      functionName: "requestUnbond",
      args: [amount],
    });

  const withdrawBond = () =>
    writeContractAsync({
      abi: AgentRegistryAbi,
      address: registry!,
      functionName: "withdrawBond",
    });

  /**
   * `agentAuthority` is the only key that will ever place orders, and it can neither
   * deposit nor withdraw. It should be a hot key kept apart from the builder's own.
   */
  const submitListing = (agentAuthority: Address, metadataHash: Hex) =>
    writeContractAsync({
      abi: AgentRegistryAbi,
      address: registry!,
      functionName: "submitListing",
      args: [agentAuthority, metadataHash],
    });

  const setAgentAuthority = (id: Hex, next: Address) =>
    writeContractAsync({
      abi: AgentRegistryAbi,
      address: registry!,
      functionName: "setAgentAuthority",
      args: [id, next],
    });

  return {
    registerBuilder,
    approveUsdc,
    stakeBond,
    requestUnbond,
    withdrawBond,
    submitListing,
    setAgentAuthority,
    hash,
    isPending,
    error,
    reset,
    ready: Boolean(registry && usdc),
  };
}
