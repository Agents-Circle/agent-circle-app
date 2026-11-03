import { drawdownBps } from "../shared/units.ts";

/**
 * What the keeper should do about one vault, decided from state and nothing else.
 *
 * Pure, and separated from everything that sends a transaction, because this is the part
 * that decides whether somebody's live position gets closed. It is worth being able to
 * test exhaustively without a chain.
 *
 * ## What the keeper can actually do
 *
 * Exactly one thing: call `reconcile`. That is not a limitation of this file, it is the
 * contract's access control, and it is worth stating plainly because "the keeper enforces
 * the limits" would be a lie:
 *
 * - `reconcile` is **permissionless**. Anyone can call it, including us. It settles the
 *   bridge, accrues the execution fee, releases expired reservations, raises the
 *   high-water mark, and — if drawdown has breached the vault's limit — pauses the vault
 *   and sends reduce-only closes. That last clause is the kill switch, and the keeper's
 *   contribution to it is *calling the function sooner than anybody else would*.
 * - `pause` is `onlyTrader`. `cancelOrder` is `onlyTraderOrAgent`. The keeper is neither.
 *
 * So a **drawdown** breach has a remedy the keeper can trigger. A **position-cap** breach
 * in fast mode does not: in fast mode orders are not checked before they are sent, and
 * once a position exceeds the cap there is no call the keeper is authorised to make that
 * reduces it. All it can do is record the breach and alert. That is what "limits are
 * monitored, not enforced" means in practice, and the vault makes a trader type that
 * sentence before fast mode can be enabled.
 */

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type VaultSnapshot = {
  address: string;
  status: "None" | "Active" | "Paused" | "Closing";
  /** Null when the Core precompile read failed. The keeper must not infer safety from it. */
  equity: bigint | null;
  highWaterMark: bigint;
  pendingBridge: bigint;
  pendingWithdrawal: bigint;
  reserved: bigint;
  openOrders: number;
  maxDrawdownBps: bigint;
  positionCapBps: bigint;
  apiWallet: string;
  /** Milliseconds, or null if this vault has never been reconciled. */
  lastReconciledAtMs: number | null;
};

export type OpenOrder = {
  cloid: string;
  asset: number;
  maxCost: bigint;
  expiresAtMs: number;
};

export type Reason =
  | "pending_bridge"
  | "stale_reservations"
  | "fills_since_reconcile"
  | "drawdown_near_limit"
  | "drawdown_breached"
  | "interval";

export type Decision = {
  reconcile: boolean;
  reasons: Reason[];
  /** Cloids to pass to `reconcile`. Only ones the contract will accept as expired. */
  staleCloids: string[];
  /** A breach the contract will act on. Jump the queue for these. */
  urgent: boolean;
  /**
   * True when equity could not be read, so no drawdown conclusion was reached. A decision
   * not to act is only meaningful if the inputs were readable, and the audit trail has to
   * record which kind of "no" this was.
   */
  blind: boolean;
};

export type PolicyInputs = {
  nowMs: number;
  maxReconcileIntervalMs: number;
  drawdownWarnMarginBps: bigint;
  /** Fills recorded for this vault since its last reconcile. Drives fee accrual. */
  fillsSinceReconcile: number;
};

export function decide(
  snapshot: VaultSnapshot,
  orders: OpenOrder[],
  inputs: PolicyInputs
): Decision {
  const reasons: Reason[] = [];

  // Not a vault, or not one the factory deployed. Nothing to do and nothing to say.
  if (snapshot.status === "None") {
    return { reconcile: false, reasons, staleCloids: [], urgent: false, blind: false };
  }

  // Strictly past the expiry, because `reconcile` skips anything where
  // `block.timestamp <= r.expiry`. Sending a cloid a second early is not an error, it is
  // just a cloid the contract ignores — and an audit row claiming a release that never
  // happened.
  const staleCloids = orders
    .filter((order) => order.expiresAtMs < inputs.nowMs)
    .map((order) => order.cloid);

  if (staleCloids.length > 0) reasons.push("stale_reservations");

  // The bridge settles when Core shows the money. Without a reconcile the deposit sits in
  // `pendingBridge` and the trader's own vault page tells them their money has not arrived.
  if (snapshot.pendingBridge > 0n && (snapshot.equity ?? 0n) > 0n) {
    reasons.push("pending_bridge");
  }

  if (inputs.fillsSinceReconcile > 0) reasons.push("fills_since_reconcile");

  const blind = snapshot.equity === null;

  // Drawdown is not measurable while capital is in flight, and this is not a nicety.
  // `deposit` raises the high-water mark by the full amount immediately — it has to, or
  // fresh capital reads as profit — while the money does not appear in Core equity until
  // the bridge lands a block or two later. In that window `drawdownBps(equity, mark)` is
  // 10,000: a total loss, on a vault whose trader has just put money in.
  //
  // The keeper must not be the thing that calls `reconcile` into that window. (The window
  // is a contract-level problem too, and is recorded as one; this is the half of it the
  // keeper can refuse to participate in.)
  const bridging = snapshot.pendingBridge > 0n;

  if (!blind && !bridging && snapshot.maxDrawdownBps > 0n) {
    const dd = drawdownBps(snapshot.equity!, snapshot.highWaterMark);

    if (dd >= snapshot.maxDrawdownBps) {
      // The contract will pause and close on the next reconcile. Getting there first is
      // the entire value the keeper adds to a drawdown limit.
      reasons.push("drawdown_breached");
    } else if (dd + inputs.drawdownWarnMarginBps >= snapshot.maxDrawdownBps) {
      reasons.push("drawdown_near_limit");
    }
  }

  const since =
    snapshot.lastReconciledAtMs === null
      ? Number.POSITIVE_INFINITY
      : inputs.nowMs - snapshot.lastReconciledAtMs;

  if (since >= inputs.maxReconcileIntervalMs) reasons.push("interval");

  return {
    reconcile: reasons.length > 0,
    reasons,
    staleCloids,
    urgent: reasons.includes("drawdown_breached"),
    blind,
  };
}

/**
 * Order the work: breaches first, then everything else oldest-first.
 *
 * A keeper with thirty vaults and a rate-limited RPC will not get through all of them in
 * one pass on a bad day. Which vault it reaches first should be the one about to be
 * liquidated, not the one whose address sorts lowest.
 */
export function prioritise<T extends { decision: Decision; lastReconciledAtMs: number | null }>(
  work: T[]
): T[] {
  return [...work].sort((a, b) => {
    if (a.decision.urgent !== b.decision.urgent) return a.decision.urgent ? -1 : 1;
    const aAge = a.lastReconciledAtMs ?? 0;
    const bAge = b.lastReconciledAtMs ?? 0;
    return aAge - bAge;
  });
}

/**
 * Total position value against the position cap, mirroring `_requireWithinPositionCap`.
 *
 * The contract's check is `(positionValue + reserved) * BPS > equity * capBps`, evaluated
 * across *all* positions rather than per asset, and this has to be the same inequality or
 * the monitor reports breaches the contract would not and misses ones it would.
 *
 * Only meaningful in fast mode. In vault mode the contract already refused the order.
 */
export function capBreached(
  equity: bigint,
  reserved: bigint,
  positionValue: bigint,
  capBps: bigint
): boolean {
  if (capBps === 0n) return positionValue + reserved > 0n;
  return (positionValue + reserved) * 10_000n > equity * capBps;
}

export function isFastMode(snapshot: VaultSnapshot): boolean {
  return snapshot.apiWallet.toLowerCase() !== ZERO_ADDRESS;
}
