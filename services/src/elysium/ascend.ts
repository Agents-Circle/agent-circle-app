import { decodeEventLog, defineChain, parseAbi, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";

import { PRICE_DECIMALS } from "../shared/units.ts";

/**
 * Read-only access to Ascend's launch pools on Elysium, for the optional Elysium/Ascend
 * Arena bracket (`plans/arena-season0.md` §7, Option A in
 * `research/parked/elysium-fork-design.md`).
 *
 * **Foundation only.** Whether that bracket exists is Udoka's decision (handoff, "Blocked
 * on Udoka"), so nothing here is wired into the Season 0 engine. It holds no key, sends
 * no transaction, and reads nothing but public chain state.
 *
 * ## It is PancakeSwap Infinity, not Uniswap v4
 *
 * Our notes said "Uniswap v4 hook pools". The pool manager's events say otherwise:
 * `Initialize(id, currency0, currency1, hooks, fee, bytes32 parameters, sqrtPriceX96, tick)`
 * and a `Swap` carrying a `uint16 protocolFee` are PancakeSwap Infinity's `CLPoolManager`,
 * which sits behind a separate `Vault` (`poolManager.vault()`). Pool state is read with
 * `getSlot0(PoolId)` and `getLiquidity(PoolId)` — no `StateView`, no `extsload` slot
 * arithmetic. A fill model must quote through Infinity's CL quoter, not v4's.
 *
 * ## Testnet was redeployed
 *
 * As of 2026-11-04 the live Ascend hook and quote token are not the addresses recorded on
 * 2026-11-03: the earlier hook (`0xc051…01D9`) is idle, and every pool since block
 * ~21.6M uses the hook and the mock USDC in `ELYSIUM_TESTNET` below. Re-read
 * `listAscendPools` rather than trusting a remembered address, as with Hyperliquid's
 * asset indices.
 */

export const elysiumTestnet = defineChain({
  id: 99801,
  name: "Elysium Testnet",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.elysium.kinetiq.xyz"] } },
  testnet: true,
});

/** Verified on chain 2026-11-04. viem's own `elysiumTestnet` is a different chain (1338). */
export const ELYSIUM_TESTNET = {
  poolManager: "0x12e84206cb53ae0df055482ebc4658635096e1aa",
  ascendHook: "0x6d01f6644bbf1b5074472d3e85aa1465b4d2bf3d",
  /** "Mock USDC (testnet, no dollar backing)", 6 decimals. */
  quoteToken: "0x84cc00d13173f7016bbab22a736dbf75a154cfe2",
  /** First block with an Ascend pool on the current deployment. */
  fromBlock: 21_598_000n,
} as const satisfies Record<string, Address | bigint>;

/** Infinity's flag in `fee` meaning the LP fee is set by the hook, not fixed. */
export const DYNAMIC_FEE_FLAG = 0x800000;

const INITIALIZE = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, address hooks, uint24 fee, bytes32 parameters, uint160 sqrtPriceX96, int24 tick)"
);

const POOL_MANAGER = parseAbi([
  "function getSlot0(bytes32 id) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 id) view returns (uint128)",
]);

const ERC20 = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);

export type AscendPool = {
  id: Hex;
  /** The launched token: whichever currency is not the quote token. */
  token: Address;
  /** True when the token is `currency0`, which decides which way the price inverts. */
  tokenIsCurrency0: boolean;
  dynamicFee: boolean;
  initializedAtBlock: bigint;
};

export type PoolState = {
  sqrtPriceX96: bigint;
  tick: number;
  lpFeePpm: number;
  protocolFee: number;
  liquidity: bigint;
};

type InitializeLog = { topics: [Hex, ...Hex[]] | []; data: Hex; blockNumber: bigint | null };

/**
 * The Ascend pools among `Initialize` logs: those whose hook is Ascend's and which are
 * quoted in `quote`. Pools on other hooks or other quote tokens are someone else's.
 */
export function ascendPoolsFromLogs(logs: readonly InitializeLog[], hook: Address, quote: Address): AscendPool[] {
  const pools: AscendPool[] = [];
  for (const log of logs) {
    const { args } = decodeEventLog({ abi: [INITIALIZE], topics: log.topics, data: log.data });
    if (args.hooks.toLowerCase() !== hook.toLowerCase()) continue;
    const c0 = args.currency0.toLowerCase() as Address;
    const c1 = args.currency1.toLowerCase() as Address;
    const q = quote.toLowerCase();
    if (c0 !== q && c1 !== q) continue;
    pools.push({
      id: args.id,
      token: c0 === q ? c1 : c0,
      tokenIsCurrency0: c0 !== q,
      dynamicFee: (args.fee & DYNAMIC_FEE_FLAG) !== 0,
      initializedAtBlock: log.blockNumber ?? 0n,
    });
  }
  return pools;
}

/** Every Ascend pool since `fromBlock`, read in windows the public RPC accepts. */
export async function listAscendPools(
  client: PublicClient,
  options: { poolManager: Address; hook: Address; quote: Address; fromBlock: bigint; window?: bigint }
): Promise<AscendPool[]> {
  const head = await client.getBlockNumber();
  const window = options.window ?? 500_000n;
  const logs: InitializeLog[] = [];
  for (let from = options.fromBlock; from <= head; from += window) {
    const to = from + window - 1n > head ? head : from + window - 1n;
    logs.push(...(await client.getLogs({ address: options.poolManager, event: INITIALIZE, fromBlock: from, toBlock: to })));
  }
  return ascendPoolsFromLogs(logs, options.hook, options.quote);
}

export async function readPool(client: PublicClient, poolManager: Address, id: Hex): Promise<PoolState> {
  const [[sqrtPriceX96, tick, protocolFee, lpFee], liquidity] = await Promise.all([
    client.readContract({ address: poolManager, abi: POOL_MANAGER, functionName: "getSlot0", args: [id] }),
    client.readContract({ address: poolManager, abi: POOL_MANAGER, functionName: "getLiquidity", args: [id] }),
  ]);
  return { sqrtPriceX96, tick, lpFeePpm: lpFee, protocolFee, liquidity };
}

export async function tokenInfo(client: PublicClient, token: Address): Promise<{ symbol: string; decimals: number }> {
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: token, abi: ERC20, functionName: "symbol" }),
    client.readContract({ address: token, abi: ERC20, functionName: "decimals" }),
  ]);
  return { symbol, decimals };
}

const Q192 = 1n << 192n;

/**
 * Spot price in quote units per whole token, at `PRICE_DECIMALS` (1e8), from
 * `sqrtPriceX96`. Integer math throughout: these are launch tokens priced in millionths of
 * a dollar, where a float would lose the digits that matter. Truncates.
 *
 * `sqrtPriceX96² / 2¹⁹²` is raw `currency1` per raw `currency0`. Scaling by the two
 * tokens' decimals gives whole units, and the inversion depends on which side the token is.
 *
 * **Spot, not a fill price.** §7 marks positions at liquidation value — the quote to sell
 * — because a thin launch pool's spot can be pushed within a block. Use this for display
 * and sanity checks, and the CL quoter for fills and marks.
 */
export function spotPrice(sqrtPriceX96: bigint, tokenIsCurrency0: boolean, tokenDecimals: number, quoteDecimals: number): bigint {
  const ratio = sqrtPriceX96 * sqrtPriceX96; // raw c1 per raw c0, × 2^192
  const scale = 10n ** BigInt(PRICE_DECIMALS);
  if (tokenIsCurrency0) {
    // quote (c1) per token (c0): ratio × 10^(tokenDec − quoteDec)
    return (ratio * scale * 10n ** BigInt(tokenDecimals)) / (Q192 * 10n ** BigInt(quoteDecimals));
  }
  // token is c1, so quote (c0) per token is the inverse
  if (ratio === 0n) return 0n;
  return (Q192 * scale * 10n ** BigInt(tokenDecimals)) / (ratio * 10n ** BigInt(quoteDecimals));
}
