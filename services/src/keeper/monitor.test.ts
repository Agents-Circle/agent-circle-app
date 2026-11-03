import assert from "node:assert/strict";
import { test } from "node:test";

import type { ClearinghouseState, InfoApi } from "../shared/hyperliquid.ts";
import { checkCap, readPositions } from "./monitor.ts";
import { ZERO_ADDRESS, type VaultSnapshot } from "./policy.ts";

const usd = (whole: number) => BigInt(whole) * 1_000_000n;

function snapshot(overrides: Partial<VaultSnapshot> = {}): VaultSnapshot {
  return {
    address: "0x3333333333333333333333333333333333333333",
    status: "Active",
    equity: usd(10_000),
    highWaterMark: usd(10_000),
    pendingBridge: 0n,
    pendingWithdrawal: 0n,
    reserved: 0n,
    openOrders: 0,
    maxDrawdownBps: 2_000n,
    positionCapBps: 5_000n,
    apiWallet: ZERO_ADDRESS,
    lastReconciledAtMs: null,
    ...overrides,
  };
}

function stubInfo(state: Partial<ClearinghouseState>): InfoApi {
  return {
    clearinghouseState: async () => ({
      assetPositions: [],
      marginSummary: {
        accountValue: "0",
        totalNtlPos: "0",
        totalRawUsd: "0",
        totalMarginUsed: "0",
      },
      withdrawable: "0",
      time: 0,
      ...state,
    }),
  } as unknown as InfoApi;
}

function position(coin: string, szi: string, positionValue: string) {
  return {
    type: "oneWay",
    position: { coin, szi, positionValue, unrealizedPnl: "0" },
  };
}

test("position value is summed across assets at 1e6", () => {
  const info = stubInfo({
    assetPositions: [position("BTC", "0.5", "50000.0"), position("ETH", "-10", "35000.5")],
    marginSummary: {
      accountValue: "10000.25",
      totalNtlPos: "85000.5",
      totalRawUsd: "0",
      totalMarginUsed: "0",
    },
  });

  return readPositions(info, "0x3").then((report) => {
    assert.equal(report.positionValue, usd(85_000) + 500_000n);
    assert.equal(report.accountValue, 10_000_250_000n);
    assert.deepEqual(
      report.assets.map((asset) => asset.coin),
      ["BTC", "ETH"]
    );
  });
});

test("a short counts toward the cap at its absolute value", () => {
  // `positionValue` from the API is already unsigned, and so is the contract's
  // `_positionValue`, which takes the magnitude of `szi`. A short at the cap is at the
  // cap.
  const info = stubInfo({ assetPositions: [position("ETH", "-10", "35000.0")] });
  return readPositions(info, "0x3").then((report) => {
    assert.equal(report.positionValue, usd(35_000));
  });
});

test("a position within the cap is not a breach", () => {
  const report = { positionValue: usd(5_000), accountValue: usd(10_000), assets: [] };
  assert.equal(checkCap(snapshot(), report, 5_000n), null);
});

test("a position over the cap is a breach, with the numbers that made it one", () => {
  const report = {
    positionValue: usd(9_000),
    accountValue: usd(10_000),
    assets: [{ coin: "BTC", value: usd(9_000) }],
  };
  const breach = checkCap(snapshot(), report, 5_000n);

  assert.ok(breach);
  assert.equal(breach.capBps, 5_000n);
  assert.equal(breach.positionValue, usd(9_000));
  assert.equal(breach.equity, usd(10_000));
});

test("reserved capital counts toward the cap, as it does on-chain", () => {
  // `_requireWithinPositionCap` adds `reserved` to the position value: an order in flight
  // is capital committed even though no position exists yet.
  const report = { positionValue: usd(5_000), accountValue: usd(10_000), assets: [] };
  assert.equal(checkCap(snapshot(), report, 5_000n), null);
  assert.ok(checkCap(snapshot({ reserved: usd(1) }), report, 5_000n));
});

test("an unreadable equity is not a breach and not a pass", () => {
  // Returning null means "no conclusion". Returning a breach would alert on an outage;
  // returning "within cap" would report green through one.
  const report = { positionValue: usd(9_000_000), accountValue: 0n, assets: [] };
  assert.equal(checkCap(snapshot({ equity: null }), report, 5_000n), null);
});

test("equity is the precompile's, not the info API's", () => {
  // The contract judges the cap against the precompile read, so the monitor must too.
  // `accountValue` from the API is carried for comparison and never substituted — the two
  // disagreeing is a signal, and silently preferring one would hide it.
  const report = { positionValue: usd(6_000), accountValue: usd(100_000), assets: [] };
  assert.ok(checkCap(snapshot({ equity: usd(10_000) }), report, 5_000n));
});
