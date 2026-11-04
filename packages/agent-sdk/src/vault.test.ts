import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  parseTransaction,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { AgentRegistryAbi, HLAgentVaultAbi, HLAgentVaultFactoryAbi } from "./abis/index.ts";
import { hyperEvmTestnet, TESTNET } from "./deployments.ts";
import { findVault, VaultClient, VaultRevert } from "./vault.ts";

const VAULT: Address = "0x00000000000000000000000000000000000000a1";
const LISTING_ID: Hex = `0x${"11".repeat(32)}`;
const TX_HASH: Hex = `0x${"ab".repeat(32)}`;
const BLOCK_HASH: Hex = `0x${"cd".repeat(32)}`;

/**
 * A HyperEVM node that knows one vault. Answers reads from `values`, decodes every call
 * against the real ABIs, and records what was sent, so a test can assert on the calldata
 * the vault would have received.
 */
function node(options: { chainId?: number; revert?: Hex } = {}) {
  const agent = privateKeyToAccount(generatePrivateKey()); // throwaway, never leaves the test
  const sent: Hex[] = [];
  const calls: string[] = [];
  let placed: { cloid: bigint; asset: number; isBuy: boolean; sz: bigint; maxCost: bigint } | null = null;

  const values: Record<string, unknown> = {
    status: 1,
    trader: "0x00000000000000000000000000000000000000b2",
    listingId: LISTING_ID,
    equity: 100_000_000n,
    highWaterMark: 100_000_000n,
    pendingBridge: 0n,
    reserved: 0n,
    availableToWithdraw: 100_000_000n,
    openOrders: 0,
    positionCapBps: 1_200,
    maxDrawdownBps: 1_500,
    apiWallet: "0x0000000000000000000000000000000000000000",
    trackedAssets: [3],
    registry: TESTNET.registry,
    whitelist: TESTNET.whitelist,
  };

  const request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    const p = (params ?? []) as [Record<string, Hex>, ...unknown[]];
    switch (method) {
      case "eth_chainId":
        return `0x${(options.chainId ?? 998).toString(16)}`;
      case "eth_blockNumber":
        return "0x10";
      case "eth_call": {
        const { to, data } = p[0];
        if (to?.toLowerCase() === TESTNET.registry.toLowerCase()) {
          calls.push("getListing");
          return encodeFunctionResult({
            abi: AgentRegistryAbi,
            functionName: "getListing",
            result: {
              builder: "0x00000000000000000000000000000000000000c3",
              agentAuthority: agent.address,
              status: 2,
              performanceFeeBps: 1_000,
              builderSplitBps: 8_000,
              positionCapBps: 1_200,
              maxDrawdownBps: 1_500,
              executionFeeBps: 2,
              executionBuilderSplitBps: 5_000,
              submittedAt: 0n,
              metadataHash: `0x${"00".repeat(32)}`,
            },
          });
        }
        const call = decodeFunctionData({ abi: HLAgentVaultAbi, data: data! });
        calls.push(call.functionName);
        if (["placeOrder", "cancelOrder", "cancelAll", "reconcile"].includes(call.functionName)) {
          if (options.revert) throw Object.assign(new Error("execution reverted"), { code: 3, data: options.revert });
          return "0x";
        }
        return encodeFunctionResult({ abi: HLAgentVaultAbi, functionName: call.functionName, result: values[call.functionName] } as never);
      }
      case "eth_getTransactionCount":
        return "0x0";
      case "eth_estimateGas":
        return "0x30000";
      case "eth_maxPriorityFeePerGas":
        return "0x1";
      case "eth_gasPrice":
        return "0x3b9aca00";
      case "eth_getBlockByNumber":
        return { number: "0x10", hash: BLOCK_HASH, baseFeePerGas: "0x3b9aca00", timestamp: "0x0", transactions: [] };
      case "eth_sendRawTransaction": {
        const raw = p[0] as unknown as Hex;
        sent.push(raw);
        const call = decodeFunctionData({ abi: HLAgentVaultAbi, data: parseTransaction(raw as `0x02${string}`).data! });
        if (call.functionName === "placeOrder") {
          const [asset, isBuy, limitPx, sz, , , cloid] = call.args as readonly [number, boolean, bigint, bigint, boolean, number, bigint];
          placed = { cloid, asset, isBuy, sz, maxCost: (sz * limitPx) / 10n ** 10n };
        }
        return TX_HASH;
      }
      case "eth_getTransactionReceipt": {
        const logs = placed
          ? [
              {
                address: VAULT,
                topics: encodeEventTopics({ abi: HLAgentVaultAbi, eventName: "OrderPlaced", args: { cloid: placed.cloid } }),
                data: encodeAbiParameters(
                  [{ type: "uint32" }, { type: "bool" }, { type: "uint64" }, { type: "uint64" }],
                  [placed.asset, placed.isBuy, placed.sz, placed.maxCost]
                ),
                blockNumber: "0x10",
                blockHash: BLOCK_HASH,
                transactionHash: TX_HASH,
                transactionIndex: "0x0",
                logIndex: "0x0",
                removed: false,
              },
            ]
          : [];
        return {
          transactionHash: TX_HASH,
          blockHash: BLOCK_HASH,
          blockNumber: "0x10",
          transactionIndex: "0x0",
          from: agent.address,
          to: VAULT,
          status: "0x1",
          type: "0x2",
          gasUsed: "0x20000",
          cumulativeGasUsed: "0x20000",
          effectiveGasPrice: "0x3b9aca00",
          contractAddress: null,
          logsBloom: `0x${"00".repeat(256)}`,
          logs,
        };
      }
      default:
        throw new Error(`unexpected RPC ${method}`);
    }
  };

  const transport = custom({ request });
  const chain = { ...hyperEvmTestnet, id: options.chainId ?? 998 };
  const client = new VaultClient({
    vault: VAULT,
    publicClient: createPublicClient({ chain, transport, pollingInterval: 5 }) as PublicClient,
    walletClient: createWalletClient({ chain, transport, account: agent }),
  });
  return { client, agent, sent, calls };
}

test("state() reads every field at one block and decodes the enums", async () => {
  const { client } = node();
  const state = await client.state();
  assert.equal(state.blockNumber, 16n);
  assert.equal(state.status, "Active");
  assert.equal(state.equity, 100_000_000n);
  assert.equal(state.positionCapBps, 1_200);
  assert.deepEqual(state.trackedAssets, [3]);

  const listing = await client.listing();
  assert.equal(listing.status, "Live");
  assert.equal(listing.executionFeeBps, 2);
});

test("placeOrder simulates, sends the vault's exact arguments, and confirms OrderPlaced", async () => {
  const { client, agent, sent, calls } = node();
  assert.equal((await client.listing()).agentAuthority, agent.address);

  const placed = await client.placeOrder(
    { asset: 3, isBuy: true, limitPx: "99490", sz: "0.00012", tif: "alo", cloid: 0xbeefn },
    { szDecimals: 5 }
  );

  assert.equal(placed.hash, TX_HASH);
  assert.equal(placed.cloid, 0xbeefn);
  assert.ok(calls.indexOf("placeOrder") >= 0, "simulated first");
  assert.equal(sent.length, 1);
  const tx = parseTransaction(sent[0] as `0x02${string}`);
  assert.equal(tx.to?.toLowerCase(), VAULT);
  assert.equal(tx.chainId, 998);
  const { functionName, args } = decodeFunctionData({ abi: HLAgentVaultAbi, data: tx.data! });
  assert.equal(functionName, "placeOrder");
  // asset, isBuy, limitPx at 1e8, sz at 1e8, reduceOnly, tif (1 = Alo), cloid.
  assert.deepEqual(args, [3, true, 9_949_000_000_000n, 12_000n, false, 1, 0xbeefn]);
});

test("off-tick prices and sizes are refused before anything is sent", async () => {
  const { client, sent, calls } = node();
  await assert.rejects(client.placeOrder({ asset: 3, isBuy: true, limitPx: "99490.5", sz: "0.00012", tif: "gtc" }, { szDecimals: 5 }), /tick/);
  await assert.rejects(client.placeOrder({ asset: 3, isBuy: true, limitPx: "99490", sz: "0.000125", tif: "gtc" }, { szDecimals: 5 }), /lots/);
  assert.deepEqual([sent.length, calls.length], [0, 0]);
});

test("a revert in simulation surfaces as the contract's error name, and nothing is sent", async () => {
  const revert = encodeErrorResult({ abi: HLAgentVaultAbi, errorName: "PositionCapExceeded" });
  const { client, sent } = node({ revert });
  await assert.rejects(
    client.placeOrder({ asset: 3, isBuy: true, limitPx: "99490", sz: "1", tif: "gtc" }),
    (error: unknown) => error instanceof VaultRevert && error.reason === "PositionCapExceeded"
  );
  assert.equal(sent.length, 0);
});

test("cancels and reconcile send the right calls", async () => {
  const { client, sent } = node();
  await client.cancelOrder(7n);
  await client.cancelAll([7n, 8n]);
  await client.reconcile();
  const decoded = sent.map((raw) => decodeFunctionData({ abi: HLAgentVaultAbi, data: parseTransaction(raw as `0x02${string}`).data! }));
  assert.deepEqual(
    decoded.map((d) => [d.functionName, d.args]),
    [
      ["cancelOrder", [7n]],
      ["cancelAll", [[7n, 8n]]],
      ["reconcile", [[]]],
    ]
  );
});

test("writes refuse any chain but HyperEVM testnet", async () => {
  const { client, sent, calls } = node({ chainId: 999 });
  await assert.rejects(client.cancelOrder(7n), /refusing to sign on chain 999/);
  assert.deepEqual([sent.length, calls.length], [0, 0]);
  // Reads still work: looking is not signing.
  assert.equal((await client.state()).status, "Active");
});

test("findVault asks the factory for the clone address and whether it is deployed", async () => {
  const trader: Address = "0x00000000000000000000000000000000000000b2";
  const clone: Address = "0x00000000000000000000000000000000000000a1";
  const asked: string[] = [];
  const request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    if (method === "eth_chainId") return "0x3e6";
    if (method !== "eth_call") throw new Error(`unexpected RPC ${method}`);
    const { to, data } = (params as [{ to: Hex; data: Hex }])[0];
    assert.equal(to.toLowerCase(), TESTNET.factory.toLowerCase());
    const call = decodeFunctionData({ abi: HLAgentVaultFactoryAbi, data });
    asked.push(call.functionName);
    if (call.functionName === "predictVault") {
      assert.deepEqual(call.args, [trader, LISTING_ID]);
      return encodeFunctionResult({ abi: HLAgentVaultFactoryAbi, functionName: "predictVault", result: clone });
    }
    assert.equal((call.args[0] as Address).toLowerCase(), clone);
    return encodeFunctionResult({ abi: HLAgentVaultFactoryAbi, functionName: "isVault", result: false });
  };
  const client = createPublicClient({ chain: hyperEvmTestnet, transport: custom({ request }) }) as PublicClient;
  const found = await findVault(client, { trader, listingId: LISTING_ID });
  assert.equal(found.address.toLowerCase(), clone);
  assert.equal(found.deployed, false);
  assert.deepEqual(asked, ["predictVault", "isVault"]);
});
