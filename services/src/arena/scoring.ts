import { BPS, drawdownBps, returnBps } from "../shared/units.ts";
import { DAY_MS, type SeasonRules } from "./rules.ts";

/**
 * The published scoring formula, and nothing else.
 *
 * ```
 * R   = E_T / E_0 − 1                          net of every fee, venue and ours
 * MDD = max over t of (peak_t − E_t) / peak_t  on one-minute marks
 * S   = R − λ · MDD
 * ```
 *
 * Calmar (R / MDD) was considered and rejected: dividing by a small drawdown rewards an
 * agent for doing nothing. The drawdown term exists so a lucky, oversized trade does not
 * win a season, and the activity minimums exist so a single trade does not either.
 *
 * Everything is integer bps. A score is stored in `scores.score` as `numeric(18,6)`, so
 * `scoreNumeric` renders bps as a six-place decimal without passing through a float.
 */

export type Mark = {
  timeMs: number;
  equity: bigint;
  /** A position or a resting order existed at this mark. Drives the presence minimum. */
  present: boolean;
};

export type ScoreInput = {
  startingEquity: bigint;
  marks: readonly Mark[];
  /** UTC days, `YYYY-MM-DD`, on which the entry had at least one fill. */
  fillDays: ReadonlySet<string>;
  notionalTraded: bigint;
  feesPaid: bigint;
  startMs: number;
};

export type Score = {
  netReturnBps: bigint;
  maxDrawdownBps: bigint;
  scoreBps: bigint;
  /** Annualised notional over average equity, at 1e4 (the column is `numeric(12,4)`). */
  turnover: bigint;
  feesPaid: bigint;
  activeDays: number;
  presenceBps: bigint;
  eligible: boolean;
};

const YEAR_MS = 365n * BigInt(DAY_MS);

export function utcDay(timeMs: number): string {
  return new Date(timeMs).toISOString().slice(0, 10);
}

export function maxDrawdown(startingEquity: bigint, marks: readonly Mark[]): bigint {
  let peak = startingEquity;
  let worst = 0n;
  for (const mark of marks) {
    if (mark.equity > peak) peak = mark.equity;
    const dd = drawdownBps(mark.equity, peak);
    if (dd > worst) worst = dd;
  }
  return worst;
}

/** The score as of the last mark in `input.marks`. */
export function score(input: ScoreInput, rules: SeasonRules): Score {
  const last = input.marks[input.marks.length - 1];
  const finalEquity = last?.equity ?? input.startingEquity;

  const netReturnBps = returnBps(input.startingEquity, finalEquity);
  const maxDrawdownBps = maxDrawdown(input.startingEquity, input.marks);
  const scoreBps = netReturnBps - (rules.drawdownWeightBps * maxDrawdownBps) / BPS;

  let equitySum = 0n;
  let present = 0n;
  for (const mark of input.marks) {
    equitySum += mark.equity;
    if (mark.present) present += 1n;
  }
  const count = BigInt(input.marks.length);
  const averageEquity = count === 0n ? input.startingEquity : equitySum / count;
  const elapsedMs = BigInt(Math.max(0, (last?.timeMs ?? input.startMs) - input.startMs));

  const turnover =
    averageEquity <= 0n || elapsedMs === 0n
      ? 0n
      : (input.notionalTraded * YEAR_MS * BPS) / (averageEquity * elapsedMs);

  const presenceBps = count === 0n ? 0n : (present * BPS) / count;
  const activeDays = input.fillDays.size;

  return {
    netReturnBps,
    maxDrawdownBps,
    scoreBps,
    turnover,
    feesPaid: input.feesPaid,
    activeDays,
    presenceBps,
    eligible: activeDays >= rules.minActiveDays && presenceBps >= rules.minPresenceBps,
  };
}

export type Ranked<T> = T & { score: Score; registeredAtMs: number };

/**
 * Highest score first. Ties go to the lower drawdown, then to whoever registered first —
 * both published, so a tie is never decided by whoever sorts the table.
 */
export function rank<T>(entries: readonly Ranked<T>[]): Ranked<T>[] {
  return [...entries].sort((a, b) => {
    if (a.score.scoreBps !== b.score.scoreBps) return a.score.scoreBps > b.score.scoreBps ? -1 : 1;
    if (a.score.maxDrawdownBps !== b.score.maxDrawdownBps) {
      return a.score.maxDrawdownBps < b.score.maxDrawdownBps ? -1 : 1;
    }
    return a.registeredAtMs - b.registeredAtMs;
  });
}

/** bps of 1 as a `numeric(18,6)` literal: 400 bps is `"0.040000"`. */
export function scoreNumeric(scoreBps: bigint): string {
  const negative = scoreBps < 0n;
  const micro = (negative ? -scoreBps : scoreBps) * 100n;
  const whole = micro / 1_000_000n;
  const fraction = (micro % 1_000_000n).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** `numeric(12,4)` literal from a value at 1e4. */
export function ratioNumeric(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  return `${negative ? "-" : ""}${magnitude / BPS}.${(magnitude % BPS).toString().padStart(4, "0")}`;
}
