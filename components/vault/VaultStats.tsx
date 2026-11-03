"use client";

import { drawdownBps, type VaultState } from "@/lib/contracts/useVault";
import { formatBps, formatUsdc } from "@/lib/format";

/**
 * The numbers a trader needs to decide whether to intervene.
 *
 * Ordered by how urgently each one might make someone act, not by how easy it is to
 * compute: drawdown against the limit first, because that is the one that triggers an
 * auto-pause, then equity, then the things that explain the gap between what was
 * deposited and what is tradeable.
 */
export function VaultStats({ state }: { state: VaultState }) {
  const dd = drawdownBps(state.equity, state.highWaterMark);
  const headroom = state.maxDrawdownBps - dd;

  // The contract auto-pauses at `dd >= maxDrawdownBps`, so "close" has to mean something
  // before that line rather than at it. A fifth of the allowance left is the point where
  // a trader can still do something about it.
  const nearLimit = headroom <= state.maxDrawdownBps / 5;

  return (
    <div className="mt-6 grid gap-3 sm:grid-cols-2">
      <Stat
        label="Drawdown from high-water mark"
        value={formatBps(dd)}
        sub={`limit ${formatBps(state.maxDrawdownBps)} · ${formatBps(Math.max(headroom, 0))} of allowance left`}
        tone={dd >= state.maxDrawdownBps || nearLimit ? "risk" : "neutral"}
      />
      <Stat
        label="Equity on HyperCore"
        value={`$${formatUsdc(state.equity)}`}
        sub={`high-water mark $${formatUsdc(state.highWaterMark)}`}
      />

      {/* Shown whenever non-zero rather than always. A zero pending bridge is the normal
          case and a permanent "$0.00 settling" row teaches people to ignore the row. */}
      {state.pendingBridge > 0n && (
        <Stat
          label="Settling onto HyperCore"
          value={`$${formatUsdc(state.pendingBridge)}`}
          sub="deposited, not yet usable as margin"
        />
      )}
      {state.reserved > 0n && (
        <Stat
          label="Reserved against open orders"
          value={`$${formatUsdc(state.reserved)}`}
          sub={`${state.openOrders} order${state.openOrders === 1 ? "" : "s"} · not withdrawable until cleared`}
        />
      )}
      {state.pendingWithdrawal > 0n && (
        <Stat
          label="Withdrawal in flight"
          value={`$${formatUsdc(state.pendingWithdrawal)}`}
          sub="requested from HyperCore, awaiting arrival"
        />
      )}

      <Stat
        label="Available to withdraw"
        value={`$${formatUsdc(state.availableToWithdraw)}`}
        sub="equity less anything reserved"
      />
      <Stat
        label="Fees accrued, unpaid"
        value={`$${formatUsdc(state.accruedBuilderFee + state.accruedPlatformFee)}`}
        sub={`builder $${formatUsdc(state.accruedBuilderFee)} · platform $${formatUsdc(state.accruedPlatformFee)}`}
      />
      <Stat
        label="Position cap"
        value={formatBps(state.positionCapBps)}
        sub="per position, against total vault value"
      />
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "neutral" | "risk";
}) {
  // Only two semantic colours exist, and DESIGN.md reserves them for "PnL / risk only"
  // while forbidding warm accents — so there is no warning tone to reach for and
  // inventing one would break the palette. Risk gets `--negative`; everything else is
  // plain, and the `sub` line carries the same information in words regardless, which
  // the accessibility rule requires anyway.
  const valueColor = tone === "risk" ? "var(--negative)" : undefined;

  return (
    <div className="card-surface p-4">
      <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--muted)" }}>
        {label}
      </p>
      <p className="mt-2 text-xl font-semibold tabular-nums" style={{ color: valueColor }}>
        {value}
      </p>
      {sub && (
        <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
          {sub}
        </p>
      )}
    </div>
  );
}
