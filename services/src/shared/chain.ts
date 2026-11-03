import { createPublicClient, defineChain, http, type PublicClient } from "viem";

import type { CoreConfig } from "./env.ts";

/**
 * Chain definitions for the services.
 *
 * Deliberately not imported from the app's `lib/chains/hyperevm.ts`. That module reads
 * `NEXT_PUBLIC_*` variables and is compiled by Next's bundler; pulling it in here would
 * couple two processes with different configuration mechanisms and different lifetimes.
 * The ids are the part that must match, and a test pins them.
 */

export const hyperEvm = defineChain({
  id: 999,
  name: "HyperEVM",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.hyperliquid.xyz/evm"] } },
});

export const hyperEvmTestnet = defineChain({
  id: 998,
  name: "HyperEVM Testnet",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.hyperliquid-testnet.xyz/evm"] } },
  testnet: true,
});

export function chainFor(chainId: number) {
  if (chainId === 999) return hyperEvm;
  if (chainId === 998) return hyperEvmTestnet;
  throw new Error(`unsupported chain id ${chainId}`);
}

export function publicClientFor(config: CoreConfig): PublicClient {
  return createPublicClient({
    chain: chainFor(config.chainId),
    // `batch` because every poll reads the same fields from every vault. Thirteen reads
    // per vault over a dozen vaults is a hundred and fifty round trips otherwise, and
    // public RPCs rate-limit long before that becomes merely slow.
    transport: http(config.rpcUrl, { batch: true, retryCount: 3 }),
  });
}
