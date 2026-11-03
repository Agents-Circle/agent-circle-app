import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ZERO_ADDRESS,
  capBreached,
  decide,
  isFastMode,
  prioritise,
  type OpenOrder,
  type VaultSnapshot,
} from "./policy.ts";

const usd = (whole: number) => BigInt(whole) * 1_000_000n;
const NOW = 1_762_000_000_000;

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
    lastReconciledAtMs: NOW - 60_000,
    ...overrides,
  };
}

const inputs = {
  nowMs: NOW,
  maxReconcileIntervalMs: 3_600_000,
  drawdownWarnMarginBps: 200n,
  fillsSinceReconcile: 0,
};

function order(overrides: Partial<OpenOrder> = {}): OpenOrder {
  return { cloid: "1", asset: 0, maxCost: usd(100), expiresAtMs: NOW + 60_000, ...overrides };
}

test("a quiet vault is left alone", () => {
  const decision = decide(snapshot(), [], inputs);
  assert.equal(decision.reconcile, false);
  assert.deepEqual(decision.reasons, []);
  assert.equal(decision.blind, false);
});

test("a vault that does not exist is not touched", () => {
  const decision = decide(snapshot({ status: "None" }), [order({ expiresAtMs: NOW - 1 })], inputs);
  assert.equal(decision.reconcile, false);
});

test("an expired reservation is released", () => {
  const decision = decide(snapshot(), [order({ cloid: "7", expiresAtMs: NOW - 1 })], inputs);
  assert.deepEqual(decision.reasons, ["stale_reservations"]);
  assert.deepEqual(decision.staleCloids, ["7"]);
});

test("a reservation that has not expired yet is not sent", () => {
  // `reconcile` skips anything where `block.timestamp <= r.expiry`, so sending it early
  // writes an audit row claiming a release that never happened.
  const decision = decide(snapshot(), [order({ cloid: "7", expiresAtMs: NOW })], inputs);
  assert.deepEqual(decision.staleCloids, []);
  assert.equal(decision.reconcile, false);
});

test("a settled bridge is a reason to reconcile", () => {
  const decision = decide(snapshot({ pendingBridge: usd(5_000) }), [], inputs);
  assert.deepEqual(decision.reasons, ["pending_bridge"]);
});

test("a bridge is not chased while Core still shows nothing", () => {
  // `reconcile` settles the bridge when equity covers it. With zero equity there is
  // nothing to settle and the call would burn gas to emit one event.
  const decision = decide(snapshot({ pendingBridge: usd(5_000), equity: 0n }), [], inputs);
  assert.equal(decision.reconcile, false);
});

test("a vault with capital in flight is not judged on drawdown", () => {
  // `deposit` raises the high-water mark at once and the money reaches Core a block or
  // two later. In between, equity against the mark reads as a total loss. A keeper that
  // reconciled here would pause a vault whose trader had just funded it.
  const decision = decide(
    snapshot({ pendingBridge: usd(10_000), equity: 0n, highWaterMark: usd(10_000) }),
    [],
    inputs
  );
  assert.equal(decision.reasons.includes("drawdown_breached"), false);
  assert.equal(decision.reconcile, false);
});

test("drawdown is judged again once the bridge has settled", () => {
  const decision = decide(
    snapshot({ pendingBridge: 0n, equity: usd(7_500), highWaterMark: usd(10_000) }),
    [],
    inputs
  );
  assert.ok(decision.reasons.includes("drawdown_breached"));
});

test("fills since the last reconcile are a reason, because that is when the fee accrues", () => {
  // The execution fee is charged on |szi_now - szi_last| at reconcile. A position opened
  // and closed between two reconciles is never billed, so an idle keeper is lost revenue.
  const decision = decide(snapshot(), [], { ...inputs, fillsSinceReconcile: 3 });
  assert.deepEqual(decision.reasons, ["fills_since_reconcile"]);
});

test("a breached drawdown is urgent", () => {
  // 25% down against a 20% limit. The contract pauses and sends reduce-only closes on the
  // next reconcile, and the keeper getting there first is the whole kill switch.
  const decision = decide(
    snapshot({ equity: usd(7_500), highWaterMark: usd(10_000) }),
    [],
    inputs
  );
  assert.ok(decision.reasons.includes("drawdown_breached"));
  assert.equal(decision.urgent, true);
});

test("approaching the limit is a reason but not an emergency", () => {
  // 19% down against a 20% limit, inside the 2% warning margin.
  const decision = decide(
    snapshot({ equity: usd(8_100), highWaterMark: usd(10_000) }),
    [],
    inputs
  );
  assert.deepEqual(decision.reasons, ["drawdown_near_limit"]);
  assert.equal(decision.urgent, false);
});

test("a vault above its high-water mark is not in drawdown", () => {
  const decision = decide(
    snapshot({ equity: usd(12_000), highWaterMark: usd(10_000) }),
    [],
    inputs
  );
  assert.deepEqual(decision.reasons, []);
});

test("an unreadable equity is recorded as blind, not as safe", () => {
  // The Core precompile can fail. Concluding "no drawdown" from a failed read is how a
  // monitor reports green through an outage.
  const decision = decide(snapshot({ equity: null }), [], inputs);
  assert.equal(decision.blind, true);
  assert.equal(decision.reasons.includes("drawdown_breached"), false);
  assert.equal(decision.reasons.includes("drawdown_near_limit"), false);
});

test("a blind vault is still reconciled for the reasons that do not need equity", () => {
  const decision = decide(
    snapshot({ equity: null }),
    [order({ cloid: "9", expiresAtMs: NOW - 1 })],
    inputs
  );
  assert.equal(decision.reconcile, true);
  assert.deepEqual(decision.staleCloids, ["9"]);
  assert.equal(decision.blind, true);
});

test("a vault with no drawdown limit is never flagged for drawdown", () => {
  const decision = decide(
    snapshot({ maxDrawdownBps: 0n, equity: usd(1), highWaterMark: usd(10_000) }),
    [],
    inputs
  );
  assert.deepEqual(decision.reasons, []);
});

test("the interval forces a reconcile even when nothing happened", () => {
  // Without this the execution fee never accrues on a quiet vault and reservations only
  // clear at expiry.
  const decision = decide(snapshot({ lastReconciledAtMs: NOW - 3_600_000 }), [], inputs);
  assert.deepEqual(decision.reasons, ["interval"]);
});

test("a vault that has never been reconciled is due immediately", () => {
  const decision = decide(snapshot({ lastReconciledAtMs: null }), [], inputs);
  assert.deepEqual(decision.reasons, ["interval"]);
});

test("a paused vault is still reconciled", () => {
  // Fees still accrue and reservations still need releasing. Skipping paused vaults would
  // strand a trader's reserved capital until expiry.
  const decision = decide(
    snapshot({ status: "Paused", lastReconciledAtMs: NOW - 3_600_000 }),
    [],
    inputs
  );
  assert.equal(decision.reconcile, true);
});

test("urgent work goes first, then the longest unreconciled", () => {
  const urgent = {
    decision: decide(snapshot({ equity: usd(1_000) }), [], inputs),
    lastReconciledAtMs: NOW,
  };
  const old = {
    decision: decide(snapshot({ lastReconciledAtMs: NOW - 7_200_000 }), [], inputs),
    lastReconciledAtMs: NOW - 7_200_000,
  };
  const recent = {
    decision: decide(snapshot({ lastReconciledAtMs: NOW - 3_600_000 }), [], inputs),
    lastReconciledAtMs: NOW - 3_600_000,
  };

  assert.equal(urgent.decision.urgent, true);
  assert.deepEqual(prioritise([recent, old, urgent]), [urgent, old, recent]);
});

test("capBreached is the contract's inequality, not an approximation", () => {
  // `(positionValue + reserved) * BPS > equity * capBps`. Exactly at the cap is allowed,
  // one unit over is not — the same boundary the vault enforces.
  const equity = usd(10_000);
  assert.equal(capBreached(equity, 0n, usd(5_000), 5_000n), false);
  assert.equal(capBreached(equity, 1n, usd(5_000), 5_000n), true);
  assert.equal(capBreached(equity, 0n, usd(5_001), 5_000n), true);
});

test("a zero cap means no position is allowed at all", () => {
  // `effectiveCapBps` returns 0 for an unlisted market, and the vault treats that as
  // "not whitelisted" rather than "unlimited".
  assert.equal(capBreached(usd(10_000), 0n, 1n, 0n), true);
  assert.equal(capBreached(usd(10_000), 0n, 0n, 0n), false);
});

test("fast mode is the presence of an api wallet", () => {
  assert.equal(isFastMode(snapshot()), false);
  assert.equal(isFastMode(snapshot({ apiWallet: "0x" + "ab".repeat(20) })), true);
  // Case must not decide it: addresses arrive checksummed from one source and lowercased
  // from another.
  assert.equal(isFastMode(snapshot({ apiWallet: ZERO_ADDRESS.toUpperCase() })), false);
});
