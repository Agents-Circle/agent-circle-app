import { BPS, returnBps } from "../shared/units.ts";

/**
 * The daily rollup: one row per listing per day, computed from fills and vault events.
 *
 * ## What "net" means here, precisely
 *
 * `equity()` is HyperCore's `accountValue` and nothing else. Hyperliquid's own fees are
 * already inside it — they leave the account at the fill. Agent Circle's fees are **not**:
 * the execution fee and the performance fee accrue into `accruedBuilderFee` and
 * `accruedPlatformFee`, which are claims against equity that have not been swept. So the
 * equity delta over a day is net of the venue and gross of us, and the ranking number has
 * to subtract our fees explicitly or it flatters every agent by exactly our take.
 *
 * - `net_return_bps` — after every fee, venue and ours. **This is what ranking uses.**
 * - `gross_return_bps` — before every fee. Shown beside net so the fee drag is visible.
 * - `fees_paid` — venue fees + execution fees + performance fees, in USDC at 1e6.
 *
 * ## Flows have to come out, or the number is meaningless
 *
 * A trader depositing 10,000 USDC into a 10,000 USDC vault doubles its equity and has
 * returned nothing. Deposits are counted at `DepositSettled` (when Core shows the money,
 * not when the bridge was asked) and withdrawals at `WithdrawRequested` (when the money
 * leaves Core, not when the trader finally receives it on the EVM). Both are the moment
 * the flow hits the equity this measures.
 *
 * ## What this cannot see, stated rather than hidden
 *
 * Equity is sampled at `Reconciled` events. A vault that was reconciled twice in a day has
 * two samples, and a 40% dip between them is invisible here — exactly as it is invisible to
 * the on-chain auto-pause, which is also only evaluated at reconcile. `max_drawdown_bps` is
 * therefore a lower bound on the day's true drawdown, and a vault nobody reconciles has no
 * measured drawdown at all. That is the keeper's reason to exist.
 *
 * A day with no reconcile also has no equity sample, so its close is carried forward from
 * the previous day adjusted for flows, and its return is zero rather than a guess.
 */

export type VaultEvent = { name: string; args: Record<string, string> };

export type VaultDayInput = {
  vault: string;
  /** Fills in the day, money fields at 1e6. */
  fills: { notional: bigint; venueFee: bigint }[];
  /** Events in the day, in block and log order. */
  events: VaultEvent[];
  /** Equity at the start of the day: the previous day's close. */
  equityOpen: bigint;
  /** High-water mark at the start of the day. */
  highWaterMarkOpen: bigint;
};

export type DailyMetrics = {
  gross_return_bps: number;
  net_return_bps: number;
  max_drawdown_bps: number;
  notional: string;
  turnover_ratio: string;
  fees_paid: string;
  equity_close: string;
  high_water_mark: string;
  fees_exceed_profit: boolean;
};

/** A previously computed day, for the 30-day fee test. Ascending by day. */
export type TrailingDay = {
  net_return_bps: number;
  fees_paid: bigint;
  equity_close: bigint;
};

function sumArg(events: VaultEvent[], name: string, ...keys: string[]): bigint {
  let total = 0n;
  for (const event of events) {
    if (event.name !== name) continue;
    for (const key of keys) {
      const value = event.args[key];
      if (value !== undefined) total += BigInt(value);
    }
  }
  return total;
}

export function rollUpDay(
  vaults: VaultDayInput[],
  trailing: TrailingDay[]
): DailyMetrics {
  let equityOpen = 0n;
  let equityClose = 0n;
  let highWaterMark = 0n;
  let notional = 0n;
  let venueFees = 0n;
  let ourFees = 0n;
  let flows = 0n;
  let maxDrawdownBps = 0n;

  for (const vault of vaults) {
    const reconciles = vault.events.filter((event) => event.name === "Reconciled");
    const last = reconciles.at(-1);

    const deposits = sumArg(vault.events, "DepositSettled", "amount");
    const withdrawals = sumArg(vault.events, "WithdrawRequested", "amount");
    const execution = sumArg(vault.events, "ExecutionFeeAccrued", "fee");
    const performance = sumArg(vault.events, "FeesAssessed", "builderCut", "platformCut");

    for (const fill of vault.fills) {
      notional += fill.notional;
      venueFees += fill.venueFee;
    }

    for (const reconcile of reconciles) {
      const dd = BigInt(reconcile.args.drawdownBps ?? "0");
      if (dd > maxDrawdownBps) maxDrawdownBps = dd;
    }

    equityOpen += vault.equityOpen;
    // No reconcile means no equity sample. Carrying the open forward with the day's flows
    // keeps the next day's open honest and leaves this day's return at zero, which is the
    // truth: nothing was measured.
    equityClose +=
      last !== undefined
        ? BigInt(last.args.equity ?? "0")
        : vault.equityOpen + deposits - withdrawals;
    highWaterMark +=
      last !== undefined
        ? BigInt(last.args.highWaterMark ?? "0")
        : vault.highWaterMarkOpen;

    ourFees += execution + performance;
    flows += deposits - withdrawals;
  }

  const feesPaid = venueFees + ourFees;
  const netProfit = equityClose - equityOpen - flows - ourFees;
  const grossProfit = netProfit + feesPaid;

  const netReturnBps = equityOpen === 0n ? 0n : returnBps(equityOpen, equityOpen + netProfit);
  const grossReturnBps = equityOpen === 0n ? 0n : returnBps(equityOpen, equityOpen + grossProfit);

  const window = [...trailing, { net_return_bps: Number(netReturnBps), fees_paid: feesPaid, equity_close: equityClose }];

  return {
    gross_return_bps: Number(grossReturnBps),
    net_return_bps: Number(netReturnBps),
    max_drawdown_bps: Number(maxDrawdownBps),
    notional: notional.toString(),
    turnover_ratio: turnoverRatio(notional, equityOpen),
    fees_paid: feesPaid.toString(),
    equity_close: equityClose.toString(),
    high_water_mark: highWaterMark.toString(),
    fees_exceed_profit: feesExceedProfit(window),
  };
}

/**
 * Notional traded as a multiple of opening equity, to four decimal places.
 *
 * Four because that is the column's scale. Computed in integers and formatted as a string
 * rather than via a float: `numeric(12,4)` accepts a string and Postgres parses it exactly,
 * whereas a JS number would round the fourth decimal on the way through.
 */
export function turnoverRatio(notional: bigint, equityOpen: bigint): string {
  if (equityOpen === 0n) return "0";
  const scaled = (notional * 10_000n) / equityOpen;
  const whole = scaled / 10_000n;
  const fraction = (scaled % 10_000n).toString().padStart(4, "0");
  return `${whole}.${fraction}`;
}

/**
 * The 30-day "fees exceeded gross profit" condition.
 *
 * This is the guardrail with teeth: the locked parameters cap the execution fee at 10 bps
 * and require that a fee which eats the profit it was charged on gets flagged. Evaluated
 * over a trailing window rather than per day, because one bad Tuesday would otherwise flag
 * every agent and a flag that fires constantly is not a flag.
 *
 * Gross profit per day is reconstructed from the stored columns: the day's net profit is
 * `net_return_bps` applied to its opening equity, which is the previous day's close. So the
 * window must be in ascending order, and the **first row contributes neither profit nor
 * fees** — there is no earlier close to open it against, and counting its fees without its
 * profit would flag an agent for the cost of a day this window cannot measure.
 *
 * Worth being explicit about what this reduces to. Gross profit is net profit plus fees, so
 * `fees > gross` is the same statement as `net profit < 0`: an agent whose fees exceeded the
 * profit they were charged on is exactly an agent whose trader is down over the window. That
 * is not a weakness of the test, it is why the test is trustworthy — there is no way to pay
 * out a flag-free fee on a losing month. The `fees > 0` guard keeps a dormant vault, which
 * is flat and pays nothing, from being flagged for a rounding error.
 */
export function feesExceedProfit(window: TrailingDay[]): boolean {
  let fees = 0n;
  let gross = 0n;

  window.forEach((day, index) => {
    const previous = window[index - 1];
    if (previous === undefined) return;

    const netProfit = (previous.equity_close * BigInt(day.net_return_bps)) / BPS;
    fees += day.fees_paid;
    gross += netProfit + day.fees_paid;
  });

  return fees > 0n && fees > gross;
}
