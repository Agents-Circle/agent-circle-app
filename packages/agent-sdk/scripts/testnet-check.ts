import { createPublicClient, http, type Address } from "viem";

import { AgentRegistryAbi, HLAgentVaultFactoryAbi, HLMarketWhitelistAbi } from "../src/abis/index.ts";
import { hyperEvmTestnet, TESTNET } from "../src/deployments.ts";
import { InfoClient } from "../src/markets.ts";
import { findVault } from "../src/vault.ts";

/**
 * Is HyperEVM testnet ready for a vault-mode agent? Reads only; needs no key.
 *
 *     npm run testnet:check                  # BTC, ETH, SOL
 *     COINS=BTC npm run testnet:check
 *     TRADER=0x… LISTING_ID=0x… npm run testnet:check   # also: where is my vault?
 *
 * For each coin: its asset index from testnet `meta` (never a remembered one), whether
 * the whitelist lists it, and if not, when its queued addition becomes executable. Plus
 * the factory and registry wiring the SDK depends on. Exits non-zero if any coin is not
 * executable yet.
 */

const client = createPublicClient({ chain: hyperEvmTestnet, transport: http(process.env.HYPEREVM_RPC_URL ?? hyperEvmTestnet.rpcUrls.default.http[0]) });
const coins = (process.env.COINS ?? "BTC,ETH,SOL").split(",").map((c) => c.trim()).filter(Boolean);

const chainId = await client.getChainId();
if (chainId !== TESTNET.chainId) throw new Error(`RPC is chain ${chainId}, not HyperEVM testnet`);

const [implementation, vaultFactory] = await Promise.all([
  client.readContract({ address: TESTNET.factory, abi: HLAgentVaultFactoryAbi, functionName: "implementation" }),
  client.readContract({ address: TESTNET.registry, abi: AgentRegistryAbi, functionName: "vaultFactory" }),
]);
const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();
console.log(`factory.implementation  ${implementation}  ${same(implementation, TESTNET.vaultImplementation) ? "ok" : "MISMATCH"}`);
console.log(`registry.vaultFactory   ${vaultFactory}  ${same(vaultFactory, TESTNET.factory) ? "ok" : "MISMATCH"}`);

const markets = await new InfoClient({ network: "testnet" }).markets();
let ready = true;
for (const coin of coins) {
  const market = markets.find((m) => m.coin === coin);
  if (!market) throw new Error(`${coin} is not a perp on testnet`);
  const [listed, queued] = await Promise.all([
    client.readContract({ address: TESTNET.whitelist, abi: HLMarketWhitelistAbi, functionName: "isListed", args: [market.asset] }),
    client.readContract({ address: TESTNET.whitelist, abi: HLMarketWhitelistAbi, functionName: "queued", args: [market.asset] }),
  ]);
  const [eta, capBps, vetoed, exists] = queued;
  const state = listed
    ? "listed: orders allowed"
    : exists && !vetoed
      ? `queued at ${capBps} bps, executable from ${new Date(Number(eta) * 1_000).toISOString()} (governance must call executeAddition)`
      : "not listed and not queued";
  if (!listed) ready = false;
  console.log(`${coin.padEnd(5)} asset ${String(market.asset).padEnd(4)} szDecimals ${market.szDecimals}  ${state}`);
}

const { TRADER: trader, LISTING_ID: listingId } = process.env;
if (trader && listingId) {
  const vault = await findVault(client, { trader: trader as Address, listingId: listingId as `0x${string}` });
  console.log(`vault for ${trader}  ${vault.address}  ${vault.deployed ? "deployed" : "NOT DEPLOYED: the trader deploys it with factory.deployVault"}`);
  if (!vault.deployed) ready = false;
}
process.exitCode = ready ? 0 : 1;
