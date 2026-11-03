import { defineChain } from "viem";

/**
 * HyperEVM chain definitions.
 *
 * Hand-defined rather than imported from `viem/chains` so the RPC URLs are ours to
 * override per environment and so the two ids sit next to each other — `HLConstants` in
 * the contracts resolves USDC and the Core deposit wallet from `block.chainid`, and a
 * mismatch between what the app thinks it is connected to and what the contract thinks
 * sends deposits at a token the bridge path does not use.
 */

/** Mainnet. `HLConstants` treats anything that is not 998 as mainnet. */
export const hyperEvm = defineChain({
  id: 999,
  name: "HyperEVM",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.NEXT_PUBLIC_HYPEREVM_RPC ?? "https://rpc.hyperliquid.xyz/evm"],
    },
  },
  blockExplorers: {
    default: { name: "Hyperliquid", url: "https://app.hyperliquid.xyz/explorer" },
  },
});

/** Testnet. Chain id 998 is what `HLConstants` keys its testnet addresses off. */
export const hyperEvmTestnet = defineChain({
  id: 998,
  name: "HyperEVM Testnet",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        process.env.NEXT_PUBLIC_HYPEREVM_TESTNET_RPC ??
          "https://rpc.hyperliquid-testnet.xyz/evm",
      ],
    },
  },
  blockExplorers: {
    default: {
      name: "Hyperliquid Testnet",
      url: "https://app.hyperliquid-testnet.xyz/explorer",
    },
  },
  testnet: true,
});

/**
 * USDC on each chain, matching `HLConstants.usdc()` in the contracts.
 *
 * Duplicated from Solidity on purpose and checked by a test rather than imported: there
 * is no way to import a Solidity constant into TypeScript, and the alternative — reading
 * it from the vault at runtime — would make the UI unable to render a deposit form until
 * a network round trip completed.
 */
export const USDC_ADDRESS = {
  999: "0xb88339CB7199b77E23DB6E890353E22632Ba630f",
  998: "0x2B3370eE501B4a559b57D449569354196457D8Ab",
} as const;

/**
 * Core token index for USDC. Zero on both chains.
 *
 * A plain number, not a bigint literal: it is a uint64 that fits a JS number many times
 * over, and `0n` would require raising the tsconfig target for the whole project.
 */
export const USDC_CORE_INDEX = 0;

export type SupportedChainId = keyof typeof USDC_ADDRESS;

/**
 * Which chain the app targets.
 *
 * Testnet by default, deliberately. Phase 2's contracts have never been deployed to
 * mainnet and the open questions in ADR-0002 are unanswered, so a build that silently
 * pointed at mainnet would be inviting someone to send real money at untested code.
 */
export const DEFAULT_CHAIN =
  process.env.NEXT_PUBLIC_HYPEREVM_NETWORK === "mainnet" ? hyperEvm : hyperEvmTestnet;
