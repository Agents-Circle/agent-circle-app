import assert from "node:assert/strict";
import { test } from "node:test";

import { feesExceedProfit, rollUpDay, turnoverRatio, type VaultDayInput } from "./metrics.ts";

/** USDC at 1e6, written in whole dollars for legibility. */
const usd = (whole: number) => BigInt(whole) * 1_000_000n;

function vault(overrides: Partial<VaultDayInput> = {}): VaultDayInput {
  return {
    vault: "0x3333333333333333333333333333333333333333",
    fills: [],
    events: [],
    equityOpen: usd(10_000),
    highWaterMarkOpen: usd(10_000),
    ...overrides,
  };
}

function reconciled(equity: bigint, highWaterMark: bigint, drawdownBps = 0) {
  return {
    name: "Reconciled",
    args: {
      equity: equity.toString(),
      highWaterMark: highWaterMark.toString(),
      drawdownBps: String(drawdownBps),
    },
  };
}

test("a day with nothing in it returns nothing and carries the equity", () => {
  const day = rollUpDay([vault()], []);
  assert.equal(day.net_return_bps, 0);
  assert.equal(day.gross_return_bps, 0);
  assert.equal(day.equity_close, usd(10_000).toString());
  assert.equal(day.fees_paid, "0");
  assert.equal(day.turnover_ratio, "0.0000");
});

test("a profitable day with no fees has net equal to gross", () => {
  const day = rollUpDay(
    [vault({ events: [reconciled(usd(11_000), usd(11_000))] })],
    []
  );
  assert.equal(day.net_return_bps, 1_000);
  assert.equal(day.gross_return_bps, 1_000);
  assert.equal(day.high_water_mark, usd(11_000).toString());
});

test("our fees come out of net and show up as the gap to gross", () => {
  // Equity is HyperCore's accountValue: our accrued fees are *not* deducted from it, so
  // net has to subtract them explicitly. The whole point of showing both numbers is that
  // this gap is the fee drag.
  const day = rollUpDay(
    [
      vault({
        events: [
          { name: "ExecutionFeeAccrued", args: { asset: "0", notional: "0", fee: usd(50).toString() } },
          { name: "FeesAssessed", args: { builderCut: usd(30).toString(), platformCut: usd(20).toString() } },
          reconciled(usd(11_000), usd(11_000)),
        ],
      }),
    ],
    []
  );

  assert.equal(day.fees_paid, usd(100).toString());
  assert.equal(day.net_return_bps, 900); // 900 USDC on 10,000
  assert.equal(day.gross_return_bps, 1_000);
});

test("venue fees are inside the equity delta and still counted as fees", () => {
  // Hyperliquid's fee has already left the account by the time equity is read, so it does
  // not come off net a second time — but it is part of the fee total a trader paid, and
  // part of gross.
  const day = rollUpDay(
    [
      vault({
        fills: [{ notional: usd(100_000), venueFee: usd(25) }],
        events: [reconciled(usd(9_975), usd(10_000), 25)],
      }),
    ],
    []
  );

  assert.equal(day.fees_paid, usd(25).toString());
  assert.equal(day.net_return_bps, -25);
  assert.equal(day.gross_return_bps, 0); // the only loss was the fee
  assert.equal(day.max_drawdown_bps, 25);
});

test("a deposit is not a return", () => {
  // The failure this prevents: a trader doubling a vault and the leaderboard reporting
  // +100% for an agent that did nothing.
  const day = rollUpDay(
    [
      vault({
        events: [
          { name: "DepositSettled", args: { amount: usd(10_000).toString() } },
          reconciled(usd(20_000), usd(20_000)),
        ],
      }),
    ],
    []
  );

  assert.equal(day.net_return_bps, 0);
  assert.equal(day.equity_close, usd(20_000).toString());
});

test("a withdrawal is not a loss", () => {
  const day = rollUpDay(
    [
      vault({
        events: [
          { name: "WithdrawRequested", args: { amount: usd(4_000).toString() } },
          reconciled(usd(6_000), usd(6_000)),
        ],
      }),
    ],
    []
  );

  assert.equal(day.net_return_bps, 0);
});

test("a day with flows but no reconcile carries the flows forward and reports zero", () => {
  const day = rollUpDay(
    [vault({ events: [{ name: "DepositSettled", args: { amount: usd(5_000).toString() } }] })],
    []
  );

  assert.equal(day.equity_close, usd(15_000).toString());
  assert.equal(day.net_return_bps, 0);
  assert.equal(day.high_water_mark, usd(10_000).toString());
});

test("vaults of one listing are weighted by the capital they held", () => {
  // 50% on $100 and -1% on $1,000,000. An unweighted average says +24.5%; the capital
  // that was actually at risk says a loss, and the capital is what a trader cares about.
  const small = vault({
    vault: "0x1111111111111111111111111111111111111111",
    equityOpen: usd(100),
    highWaterMarkOpen: usd(100),
    events: [reconciled(usd(150), usd(150))],
  });
  const large = vault({
    vault: "0x2222222222222222222222222222222222222222",
    equityOpen: usd(1_000_000),
    highWaterMarkOpen: usd(1_000_000),
    events: [reconciled(usd(990_000), usd(1_000_000), 100)],
  });

  const day = rollUpDay([small, large], []);
  assert.ok(day.net_return_bps < 0, `expected a loss, got ${day.net_return_bps}`);
  assert.equal(day.net_return_bps, -99); // -9,950 on 1,000,100
});

test("max drawdown is the worst sample of the day", () => {
  const day = rollUpDay(
    [
      vault({
        events: [
          reconciled(usd(9_500), usd(10_000), 500),
          reconciled(usd(8_000), usd(10_000), 2_000),
          reconciled(usd(9_800), usd(10_000), 200),
        ],
      }),
    ],
    []
  );

  assert.equal(day.max_drawdown_bps, 2_000);
  // The close is the last sample, not the worst one.
  assert.equal(day.equity_close, usd(9_800).toString());
});

test("turnover is notional over opening equity, to four places", () => {
  assert.equal(turnoverRatio(usd(25_000), usd(10_000)), "2.5000");
  assert.equal(turnoverRatio(usd(1), usd(3)), "0.3333");
  assert.equal(turnoverRatio(usd(0), usd(10_000)), "0.0000");
  // No equity to turn over. Not infinity, not a crash.
  assert.equal(turnoverRatio(usd(100), 0n), "0");
});

test("fees exceeding gross profit over the window is flagged", () => {
  // A churning agent: it trades a lot, pays 40 USDC in fees, and ends the window down.
  // Gross profit is net plus fees, so "fees exceeded gross" is the same statement as
  // "the trader is down" — see the note on `feesExceedProfit`.
  const window = [
    { net_return_bps: 0, fees_paid: usd(10), equity_close: usd(10_000) },
    { net_return_bps: -20, fees_paid: usd(20), equity_close: usd(9_980) },
    { net_return_bps: -20, fees_paid: usd(20), equity_close: usd(9_960) },
  ];
  assert.equal(feesExceedProfit(window), true);
});

test("a profitable agent is not flagged", () => {
  const window = [
    { net_return_bps: 0, fees_paid: usd(10), equity_close: usd(10_000) },
    { net_return_bps: 500, fees_paid: usd(20), equity_close: usd(10_500) },
    { net_return_bps: 500, fees_paid: usd(20), equity_close: usd(11_025) },
  ];
  assert.equal(feesExceedProfit(window), false);
});

test("a single day cannot flag an agent on its own", () => {
  // The first row has no earlier close to open against, so it contributes neither profit
  // nor fees. A brand-new listing is therefore unflagged until there is a window to judge
  // it on, which is the point: the flag is a 30-day statement.
  assert.equal(
    feesExceedProfit([{ net_return_bps: -9_000, fees_paid: usd(100), equity_close: usd(1_000) }]),
    false
  );
});

test("a dormant vault paying nothing is not flagged", () => {
  const window = [
    { net_return_bps: 0, fees_paid: 0n, equity_close: usd(10_000) },
    { net_return_bps: 0, fees_paid: 0n, equity_close: usd(10_000) },
  ];
  assert.equal(feesExceedProfit(window), false);
});

test("a losing agent that charged no fees is not flagged either", () => {
  // It lost the trader money, which the return columns say plainly. This flag is about
  // fees eating a profit, and there were none to eat.
  const window = [
    { net_return_bps: 0, fees_paid: 0n, equity_close: usd(10_000) },
    { net_return_bps: -3_000, fees_paid: 0n, equity_close: usd(7_000) },
  ];
  assert.equal(feesExceedProfit(window), false);
});
