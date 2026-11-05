import { fileURLToPath } from "node:url";

import type { Address } from "viem";

import { agentAccountFromEnv } from "../src/keys.ts";
import { InfoClient, type BookTop, type CoreOrderStatus, type Market, type Network } from "../src/markets.ts";
import type { OrderRequest } from "../src/orders.ts";
import { PaperClient, type PaperAccount, type PaperVerdict } from "../src/paper.ts";
import { newCloid, roundPrice, sizeForNotional, toE8 } from "../src/units.ts";
import { VaultClient, type PlacedOrder, type SentTx } from "../src/vault.ts";

/**
 * Example agent, perps: rest one passive bid, confirm it, cancel it.
 *
 * The smallest complete loop an agent runs: read the market, size an order, place it,
 * check that the venue has it, clean up. The same `OrderRequest` goes to the Arena (paper)
 * and to a vault (testnet), which is the point of the SDK.
 *
 *     # paper, against `npm run arena:local` or a real Arena
 *     ARENA_API_KEY=… npm run example:perp
 *
 *     # vault mode, HyperEVM testnet: needs a live listing whose agent authority is your
 *     # key, a deployed and funded vault, and an executable market. See README.md.
 *     MODE=vault VAULT=0x… AGENT_KEYSTORE=agent npm run example:perp
 *
 * Environment: `COIN` (BTC), `OFFSET_BPS` below the best bid (50), `NOTIONAL_USD` (11:
 * above Hyperliquid's $10 minimum, below a 12% cap on a 100 USDC vault).
 */

export type QuoteOptions = { offsetBps: number; notionalUsd: string };

/** A post-only bid `offsetBps` under the best bid, on Hyperliquid's tick, sized by dollars. */
export function buildQuote(market: Market, top: BookTop, options: QuoteOptions): OrderRequest {
  const bid = toE8(top.bid, "bid");
  const limitPx = roundPrice((bid * BigInt(10_000 - options.offsetBps)) / 10_000n, market.szDecimals, "down");
  return {
    asset: market.asset,
    isBuy: true,
    limitPx,
    sz: sizeForNotional(options.notionalUsd, limitPx, market.szDecimals),
    tif: "alo",
    cloid: newCloid(),
  };
}

type Log = (msg: string, fields?: Record<string, unknown>) => void;

export async function runPaper(client: PaperClient, order: OrderRequest, log: Log): Promise<{ placed: PaperVerdict; account: PaperAccount; cancelled: PaperVerdict }> {
  const placed = await client.placeOrder(order);
  log(placed.accepted ? "paper order accepted" : "paper order rejected", { cloid: placed.cloid, reason: placed.reason });
  if (!placed.accepted) throw new Error(`the Arena rejected the order: ${placed.reason}`);

  const account = await client.account();
  const mine = account.orders.find((o) => o.cloid === placed.cloid);
  log("paper account", { equity: account.equity, order: mine?.state ?? "missing" });
  if (!mine) throw new Error(`order ${placed.cloid} is not in the account`);

  const cancelled = await client.cancelOrder(placed.cloid);
  log(cancelled.accepted ? "paper order cancelled" : "cancel rejected", { reason: cancelled.reason });
  return { placed, account, cancelled };
}

async function waitForCore(info: InfoClient, vault: VaultClient, cloid: bigint, done: (s: CoreOrderStatus) => boolean, timeoutMs: number): Promise<CoreOrderStatus> {
  const deadline = Date.now() + timeoutMs;
  let status: CoreOrderStatus = { status: "unknownOid" };
  while (Date.now() < deadline) {
    status = await vault.coreOrderStatus(info, cloid);
    if (done(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return status;
}

export async function runVault(
  vault: VaultClient,
  info: InfoClient,
  agent: Address,
  market: Market,
  order: OrderRequest,
  log: Log
): Promise<{ placed: PlacedOrder; core: CoreOrderStatus; cancelled: SentTx; coreAfter: CoreOrderStatus }> {
  // Every reason `placeOrder` would revert that can be read first, said in words.
  const [state, listing, listed] = await Promise.all([vault.state(), vault.listing(), vault.isListed(market.asset)]);
  log("vault", { address: vault.address, status: state.status, equity: state.equity, openOrders: state.openOrders, listing: listing.status });
  if (state.status !== "Active") throw new Error(`vault is ${state.status}, not Active`);
  if (listing.status !== "Live") throw new Error(`listing is ${listing.status}, not Live`);
  if (listing.agentAuthority.toLowerCase() !== agent.toLowerCase()) {
    throw new Error(`this key (${agent}) is not the listing's agent authority (${listing.agentAuthority})`);
  }
  if (!listed) throw new Error(`${market.coin} (asset ${market.asset}) is not executable on the whitelist yet`);

  const placed = await vault.placeOrder(order, { szDecimals: market.szDecimals });
  log("placeOrder mined", { hash: placed.hash, cloid: placed.cloid, block: placed.receipt?.blockNumber });

  // CoreWriter delivers the action a few seconds after the block. Until Core answers,
  // the vault holds a reservation for an order that may never have reached the book.
  const core = await waitForCore(info, vault, placed.cloid, (s) => s.status !== "unknownOid", 60_000);
  log("HyperCore order status", { status: core.status });

  const cancelled = await vault.cancelOrder(placed.cloid);
  log("cancelOrder mined", { hash: cancelled.hash });
  const coreAfter = await waitForCore(info, vault, placed.cloid, (s) => s.status !== "open", 60_000);
  log("HyperCore order status after cancel", { status: coreAfter.status });
  return { placed, core, cancelled, coreAfter };
}

async function main(): Promise<void> {
  const env = process.env;
  const mode = env.MODE ?? "paper";
  const coin = env.COIN ?? "BTC";
  const options: QuoteOptions = { offsetBps: Number(env.OFFSET_BPS ?? 50), notionalUsd: env.NOTIONAL_USD ?? "11" };
  const log: Log = (msg, fields) =>
    process.stdout.write(`${JSON.stringify({ msg, ...fields }, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n`);

  if (mode === "paper") {
    // Read `meta` from the network the Arena trades: an index from the other network is
    // a different coin. Season 0 trades mainnet's feed.
    const network = (env.ARENA_NETWORK ?? "mainnet") as Network;
    const info = new InfoClient({ network });
    const market = await info.market(coin);
    const order = buildQuote(market, await info.bookTop(coin), options);
    log("Paper trading. Simulated fills on live Hyperliquid prices. No funds at risk. Not an on-chain track record.");
    log("quote", { coin, network, ...order });
    const client = new PaperClient({ baseUrl: env.ARENA_URL ?? "http://127.0.0.1:8787", apiKey: env.ARENA_API_KEY ?? "" });
    await runPaper(client, order, log);
    return;
  }

  if (mode === "vault") {
    if (!env.VAULT || !/^0x[0-9a-fA-F]{40}$/.test(env.VAULT)) throw new Error("VAULT must be the vault clone's address");
    const info = new InfoClient({ network: "testnet" });
    const market = await info.market(coin);
    const order = buildQuote(market, await info.bookTop(coin), options);
    log("quote", { coin, network: "testnet", ...order });
    const account = await agentAccountFromEnv(env);
    const vault = VaultClient.testnet({ vault: env.VAULT as Address, account, ...(env.HYPEREVM_RPC_URL ? { rpcUrl: env.HYPEREVM_RPC_URL } : {}) });
    await runVault(vault, info, account.address, market, order, log);
    return;
  }

  throw new Error("MODE must be paper or vault");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: Error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
