import assert from "node:assert/strict";
import { test } from "node:test";

import { SEASON_0 } from "./rules.ts";
import { maxDrawdown, rank, ratioNumeric, score, scoreNumeric, type Mark } from "./scoring.ts";

const usd = (whole: number) => BigInt(whole) * 1_000_000n;
const DAY = 86_400_000;

function marks(...equities: number[]): Mark[] {
  return equities.map((value, i) => ({ timeMs: (i + 1) * 60_000, equity: usd(value), present: true }));
}

test("drawdown is measured from the running peak, not from the start", () => {
  assert.equal(maxDrawdown(usd(10_000), marks(11_000, 9_900, 10_500)), 1_000n);
});

test("the published examples score as published", () => {
  // R = +12%, MDD = 8% scores 0.04. R = +30%, MDD = 14% scores 0.16.
  const a = score(
    { startingEquity: usd(10_000), marks: marks(10_000, 9_200, 11_200), fillDays: new Set(), notionalTraded: 0n, feesPaid: 0n, startMs: 0 },
    SEASON_0
  );
  assert.equal(a.netReturnBps, 1_200n);
  assert.equal(a.maxDrawdownBps, 800n);
  assert.equal(a.scoreBps, 400n);
  assert.equal(scoreNumeric(a.scoreBps), "0.040000");

  const b = score(
    { startingEquity: usd(10_000), marks: marks(10_000, 8_600, 13_000), fillDays: new Set(), notionalTraded: 0n, feesPaid: 0n, startMs: 0 },
    SEASON_0
  );
  assert.equal(b.scoreBps, 1_600n);
});

test("doing nothing scores zero, not infinity", () => {
  const idle = score(
    { startingEquity: usd(10_000), marks: marks(10_000, 10_000), fillDays: new Set(), notionalTraded: 0n, feesPaid: 0n, startMs: 0 },
    SEASON_0
  );
  assert.equal(idle.scoreBps, 0n);
  assert.equal(idle.eligible, false);
});

test("eligibility needs both the active days and the presence minimum", () => {
  const days = new Set(Array.from({ length: 10 }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`));
  const present = score(
    { startingEquity: usd(10_000), marks: marks(10_000), fillDays: days, notionalTraded: 0n, feesPaid: 0n, startMs: 0 },
    SEASON_0
  );
  assert.equal(present.eligible, true);

  const absent = score(
    {
      startingEquity: usd(10_000),
      marks: marks(10_000, 10_000, 10_000, 10_000, 10_000, 10_000).map((m, i) => ({ ...m, present: i === 0 })),
      fillDays: days,
      notionalTraded: 0n,
      feesPaid: 0n,
      startMs: 0,
    },
    SEASON_0
  );
  assert.equal(absent.presenceBps, 1_666n);
  assert.equal(absent.eligible, false);
});

test("turnover is annualised notional over average equity", () => {
  // $20,000 traded in one day on $10,000 is 2x a day, 730x a year.
  const result = score(
    {
      startingEquity: usd(10_000),
      marks: [{ timeMs: DAY, equity: usd(10_000), present: true }],
      fillDays: new Set(),
      notionalTraded: usd(20_000),
      feesPaid: 0n,
      startMs: 0,
    },
    SEASON_0
  );
  assert.equal(ratioNumeric(result.turnover), "730.0000");
});

test("ties go to the lower drawdown, then to the earlier registration", () => {
  const base = { netReturnBps: 0n, turnover: 0n, feesPaid: 0n, activeDays: 0, presenceBps: 0n, eligible: true };
  const ranked = rank([
    { id: "late", registeredAtMs: 2, score: { ...base, scoreBps: 100n, maxDrawdownBps: 50n } },
    { id: "early", registeredAtMs: 1, score: { ...base, scoreBps: 100n, maxDrawdownBps: 50n } },
    { id: "calm", registeredAtMs: 3, score: { ...base, scoreBps: 100n, maxDrawdownBps: 10n } },
    { id: "best", registeredAtMs: 4, score: { ...base, scoreBps: 200n, maxDrawdownBps: 90n } },
  ]);
  assert.deepEqual(
    ranked.map((r) => r.id),
    ["best", "calm", "early", "late"]
  );
});

test("negative scores render as negative decimals", () => {
  assert.equal(scoreNumeric(-125n), "-0.012500");
});
