import assert from "node:assert/strict";
import { test } from "node:test";

import { encodeAbiParameters, encodeEventTopics, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";

import { ascendPoolsFromLogs, DYNAMIC_FEE_FLAG, spotPrice } from "./ascend.ts";
import { hyperCoreAvailability } from "./core.ts";

const INITIALIZE = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, address hooks, uint24 fee, bytes32 parameters, uint160 sqrtPriceX96, int24 tick)"
);

const HOOK: Address = "0x6d01f6644bbf1b5074472d3e85aa1465b4d2bf3d";
const USDC: Address = "0x84cc00d13173f7016bbab22a736dbf75a154cfe2";
const LOW: Address = "0x0000000000000000000000000000000000000aaa"; // sorts before USDC
const HIGH: Address = "0xfffffffffffffffffffffffffffffffffffffaaa"; // sorts after it

function initLog(id: number, currency0: Address, currency1: Address, hooks: Address, fee: number) {
  const topics = encodeEventTopics({
    abi: [INITIALIZE],
    eventName: "Initialize",
    args: { id: `0x${id.toString(16).padStart(64, "0")}` as Hex, currency0, currency1 },
  }) as [Hex, ...Hex[]];
  const data = encodeAbiParameters(
    [{ type: "address" }, { type: "uint24" }, { type: "bytes32" }, { type: "uint160" }, { type: "int24" }],
    [hooks, fee, `0x${"0".repeat(64)}`, 1n << 96n, 0]
  );
  return { topics, data, blockNumber: BigInt(100 + id) };
}

test("only pools on Ascend's hook and quoted in the quote token are Ascend's", () => {
  const pools = ascendPoolsFromLogs(
    [
      initLog(1, LOW, USDC, HOOK, DYNAMIC_FEE_FLAG),
      initLog(2, USDC, HIGH, HOOK, 3000),
      initLog(3, LOW, USDC, "0x000000000000000000000000000000000000dead", DYNAMIC_FEE_FLAG), // another hook
      initLog(4, LOW, HIGH, HOOK, DYNAMIC_FEE_FLAG), // not quoted in USDC
    ],
    HOOK,
    USDC
  );
  assert.deepEqual(
    pools.map((p) => [Number(p.id), p.token, p.tokenIsCurrency0, p.dynamicFee, p.initializedAtBlock]),
    [
      [1, LOW, true, true, 101n],
      [2, HIGH, false, false, 102n],
    ]
  );
});

test("addresses compare case-insensitively", () => {
  const pools = ascendPoolsFromLogs([initLog(1, LOW, USDC, HOOK, 0)], HOOK.toUpperCase().replace("0X", "0x") as Address, USDC);
  assert.equal(pools.length, 1);
});

test("spot price is quote per whole token at 1e8, whichever side the token is on", () => {
  const Q96 = 1n << 96n;
  // Equal raw amounts: 1 raw c1 per raw c0.
  assert.equal(spotPrice(Q96, true, 6, 6), 100_000_000n); // 1.0
  // An 18-decimal token as c0 at raw ratio 1 is worth 1e12 whole USDC per token.
  assert.equal(spotPrice(Q96, true, 18, 6), 10n ** 20n);
  // Token as c1 at ratio 4 (sqrt 2): quote per token is 1/4 = 0.25.
  assert.equal(spotPrice(2n * Q96, false, 6, 6), 25_000_000n);
  assert.equal(spotPrice(0n, false, 18, 6), 0n);
});

test("spot price matches a pool read on Elysium testnet, 2026-11-04", () => {
  // W5T: token is currency0 (0x4f89… < 0x84cc…), 18 decimals, quoted in 6-decimal USDC.
  // getSlot0 gave sqrtPriceX96 224110913169361636207 → about 0.000008 USDC.
  const px = spotPrice(224110913169361636207n, true, 18, 6);
  assert.equal(px, 800n); // 0.00000800 at 1e8
});

test("HyperCore is reported absent when the precompile answers empty and CoreWriter has no code", async () => {
  const fake = (code: Hex | undefined, data: Hex | undefined) =>
    ({
      getChainId: async () => 99801,
      getCode: async () => code,
      call: async () => ({ data }),
    }) as unknown as PublicClient;

  assert.deepEqual(await hyperCoreAvailability(fake(undefined, undefined)), {
    chainId: 99801,
    coreWriter: false,
    readPrecompiles: false,
    l1Block: null,
  });
  const l1 = `0x${(0x2d580261).toString(16).padStart(64, "0")}` as Hex;
  assert.deepEqual(await hyperCoreAvailability(fake("0x6080", l1)), {
    chainId: 99801,
    coreWriter: true,
    readPrecompiles: true,
    l1Block: 0x2d580261n,
  });
});
