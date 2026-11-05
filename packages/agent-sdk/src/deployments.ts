import { defineChain, type Address } from "viem";

/**
 * Where the contracts are.
 *
 * **HyperEVM testnet (998) only.** Mainnet has no deployment, and the contracts have
 * never been audited, so this SDK has no mainnet entry and `VaultClient` refuses to sign
 * on any chain but 998. Adding mainnet here is a decision, not a config change.
 *
 * Addresses from the 4 November 2026 testnet deploy (`handbook/plans/handoff-2026-11-04.md`),
 * the same ones `.env.example` gives the app. Public chain addresses, not secrets.
 */

export const hyperEvmTestnet = defineChain({
  id: 998,
  name: "HyperEVM Testnet",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.hyperliquid-testnet.xyz/evm"] } },
  blockExplorers: { default: { name: "Hyperliquid Testnet", url: "https://app.hyperliquid-testnet.xyz/explorer" } },
  testnet: true,
});

export type Deployment = {
  chainId: number;
  network: "testnet";
  registry: Address;
  whitelist: Address;
  factory: Address;
  vaultImplementation: Address;
  usdc: Address;
};

export const TESTNET: Deployment = {
  chainId: 998,
  network: "testnet",
  registry: "0x6757474DDC00CDa23F497faC09A2CD4B27117aCe",
  whitelist: "0x1445B9E5080a9fB5dfdB97537935f8D4c40F3f4A",
  factory: "0x7c5F82a727ff7823E1EabC49119A6d6e823779b8",
  vaultImplementation: "0x3861eAbE8219E52a913B37fdB63bB0cF5BE0bCcb",
  usdc: "0x2B3370eE501B4a559b57D449569354196457D8Ab",
};

/** The only chains `VaultClient` will sign on. */
export const SIGNING_CHAIN_IDS: ReadonlySet<number> = new Set([TESTNET.chainId]);

/** `HLAgentVault.VaultStatus`. */
export const VAULT_STATUS = ["None", "Active", "Paused", "Closing"] as const;
export type VaultStatus = (typeof VAULT_STATUS)[number];

/** `IAgentRegistry.ListingStatus`. */
export const LISTING_STATUS = ["None", "Vetting", "Live", "Rejected", "Suspended", "Delisted"] as const;
export type ListingStatus = (typeof LISTING_STATUS)[number];

/** `Constants.MAX_OPEN_ORDERS`: open orders a vault allows at once. */
export const MAX_OPEN_ORDERS = 8;
