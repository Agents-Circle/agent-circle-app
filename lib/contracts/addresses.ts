import type { Address } from "viem";

import { hyperEvm, hyperEvmTestnet, type SupportedChainId } from "@/lib/chains/hyperevm";

/**
 * Deployed contract addresses, per chain.
 *
 * From the environment rather than committed, so that a chain with no deployment reads as
 * `null` rather than as a working form pointed at nothing.
 *
 * HyperEVM **testnet** is live as of 4 November 2026 and its addresses are in
 * `.env.example`; they are public chain addresses, not secrets. **Mainnet is not
 * deployed**, so those three stay empty and every mainnet surface reads `isDeployed` as
 * false.
 *
 * `isDeployed` is how every surface decides whether to offer an action or explain why it
 * cannot. Callers must branch on it rather than assume — see `useVaultDeployment`.
 */
export type Deployment = {
  registry: Address;
  factory: Address;
  whitelist: Address;
};

/**
 * Next inlines `process.env.NEXT_PUBLIC_*` at build time only for *statically
 * analysable* member expressions, so the lookups have to be written out literally. A
 * computed `process.env[name]` returns undefined in the browser however correct it looks
 * in Node — which is exactly the sort of thing that works in dev and fails in a
 * production build.
 */
const DEPLOYMENTS: Record<SupportedChainId, Deployment | null> = {
  [hyperEvm.id]: (() => {
    const registry = process.env.NEXT_PUBLIC_HL_MAINNET_REGISTRY;
    const factory = process.env.NEXT_PUBLIC_HL_MAINNET_FACTORY;
    const whitelist = process.env.NEXT_PUBLIC_HL_MAINNET_WHITELIST;
    if (!registry || !factory || !whitelist) return null;
    return {
      registry: registry as Address,
      factory: factory as Address,
      whitelist: whitelist as Address,
    };
  })(),
  [hyperEvmTestnet.id]: (() => {
    const registry = process.env.NEXT_PUBLIC_HL_TESTNET_REGISTRY;
    const factory = process.env.NEXT_PUBLIC_HL_TESTNET_FACTORY;
    const whitelist = process.env.NEXT_PUBLIC_HL_TESTNET_WHITELIST;
    if (!registry || !factory || !whitelist) return null;
    return {
      registry: registry as Address,
      factory: factory as Address,
      whitelist: whitelist as Address,
    };
  })(),
};

export function deploymentFor(chainId: number): Deployment | null {
  return DEPLOYMENTS[chainId as SupportedChainId] ?? null;
}

export function isDeployed(chainId: number): boolean {
  return deploymentFor(chainId) !== null;
}
