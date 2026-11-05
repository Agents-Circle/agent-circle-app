import { drawdownBps } from "../shared/units.ts";
import {
  applyFill,
  applyFunding,
  assessPerformanceFee,
  equity,
  openAccount,
  totalFees,
  type Account,
  type Liquidity,
} from "./account.ts";
import { crosses, fillFromTrade, takeFromBook } from "./fills.ts";
import { midPx, type AssetContext, type Book, type Instrument, type Trade } from "./market.ts";
import { checkOrder, type Order, type Rejection, type Reservation } from "./risk.ts";
import { HOUR_MS, MINUTE_MS, TIF, type SeasonRules } from "./rules.ts";
import { utcDay, type Mark, type ScoreInput } from "./scoring.ts";

/**
 * The paper-trading engine for one season.
 *
 * ## Deterministic, and replayable from its inputs alone
 *
 * The engine has no clock and no I/O. Everything that can change its state arrives as an
 * `InputEvent` stamped with the time the process received it: market data, entry
 * registrations, order submissions, cancels. Timers (expiry, funding, minute marks,
 * fee assessments) fire as event time passes them. So the recorded input log *is* the
 * season, and replaying it reproduces every fill, mark and score to the last unit. That
 * is what lets a second, independent scorer check the ranks before a prize is paid, and
 * what makes a restart safe: replay the log, then carry on.
 *
 * One clock for everything: the receive time. Hyperliquid's own timestamps are kept in the
 * data and are not used to decide *when* anything happens, because comparing two machines'
 * clocks is how an order ends up filled against a book it could not have seen.
 *
 * The stale-book rule is the one place the two are subtracted, and it is safe there
 * because it only ever *refuses*. A book is stale when `receiveTime - book.timeMs`
 * exceeds `staleBookMs`, which is the book's whole age: the time Hyperliquid took to
 * send it plus the time we have held it. Skew makes that number larger, never smaller,
 * so a skewed clock can only make the engine more cautious than the rule requires. No
 * fill, activation or mark is ever granted on the strength of an exchange timestamp.
 *
 * ## Reservations, exactly as the vault keeps them
 *
 * A vault cannot see fills: CoreWriter is fire-and-forget. So a reservation is released
 * only when the order is cancelled or expires, never when it fills, and a filled order
 * keeps its open-order slot and its cap headroom until then. The engine does the same.
 * It is stricter than a venue would be, and it is the rule an agent will meet in a vault,
 * so it is the rule it should learn on paper: cancel what you are done with.
 */

export type InputEvent =
  | { kind: "book"; atMs: number; book: Book }
  | { kind: "trade"; atMs: number; trade: Trade }
  | { kind: "ctx"; atMs: number; ctx: AssetContext }
  | { kind: "register"; atMs: number; entryId: string }
  | { kind: "submit"; atMs: number; entryId: string; order: Order }
  | { kind: "cancel"; atMs: number; entryId: string; cloid: bigint }
  /** Advances timers when the market is quiet. Carries no data. */
  | { kind: "clock"; atMs: number };

export type EngineRejection = Rejection | "VaultNotFound" | "SeasonNotRunning" | "OrderNotFound";

export type DoneReason =
  | "filled"
  | "ioc_remainder"
  | "alo_would_cross"
  | "reduce_only_nothing_to_reduce"
  | "cancelled"
  | "expired"
  | "paused";

export type OutputEvent =
  | { kind: "accepted"; atMs: number; entryId: string; cloid: bigint; maxCost: bigint; activatesAtMs: number }
  | { kind: "rejected"; atMs: number; entryId: string; cloid: bigint; reason: EngineRejection }
  | {
      kind: "fill";
      atMs: number;
      entryId: string;
      /** Zero for the exits the engine sends itself after an auto-pause. */
      cloid: bigint;
      asset: number;
      isBuy: boolean;
      px: bigint;
      sz: bigint;
      liquidity: Liquidity;
      notional: bigint;
      venueFee: bigint;
      executionFee: bigint;
    }
  /** The order stops trading. Its reservation may still be held; see `released`. */
  | { kind: "order_done"; atMs: number; entryId: string; cloid: bigint; why: DoneReason }
  /** The reservation and the open-order slot are free. */
  | { kind: "released"; atMs: number; entryId: string; cloid: bigint; why: "cancelled" | "expired" | "paused" }
  | { kind: "funding"; atMs: number; entryId: string; asset: number; payment: bigint }
  | { kind: "performance_fee"; atMs: number; entryId: string; fee: bigint }
  | { kind: "mark"; atMs: number; entryId: string; equity: bigint; drawdownBps: bigint; present: boolean }
  | { kind: "auto_paused"; atMs: number; entryId: string; drawdownBps: bigint }
  /** Something the engine needed and did not have. Published, not hidden. */
  | { kind: "gap"; atMs: number; asset: number; what: "no_mark" | "no_funding_context" | "stale_book" | "no_book" };

type Working = {
  order: Order;
  maxCost: bigint;
  activatesAtMs: number;
  expiresAtMs: number;
  remaining: bigint;
  state: "pending" | "resting" | "done";
};

type Exit = { isBuy: boolean; limitPx: bigint; activatesAtMs: number };

type Entry = {
  id: string;
  registeredAtMs: number;
  account: Account;
  /** Every order still holding a reservation, done or not. */
  orders: Map<bigint, Working>;
  /** Reduce-only IOC exits after an auto-pause, one per asset, as `_closeAllPositions`. */
  exits: Map<number, Exit>;
  marks: Mark[];
  fillDays: Set<string>;
};

export type EngineOptions = {
  rules: SeasonRules;
  instruments: readonly Instrument[];
  startMs: number;
  endMs?: number;
  emit?: (event: OutputEvent) => void;
};

export class ArenaEngine {
  readonly #rules: SeasonRules;
  readonly #instruments = new Map<number, Instrument>();
  readonly #byCoin = new Map<string, Instrument>();
  readonly #startMs: number;
  readonly #endMs: number | undefined;
  readonly #emit: (event: OutputEvent) => void;

  readonly #entries = new Map<string, Entry>();
  readonly #books = new Map<number, Book>();
  readonly #contexts = new Map<number, AssetContext>();

  #nowMs: number;
  #nextMinuteMs: number;

  constructor(options: EngineOptions) {
    this.#rules = options.rules;
    for (const instrument of options.instruments) {
      this.#instruments.set(instrument.asset, instrument);
      this.#byCoin.set(instrument.coin, instrument);
    }
    this.#startMs = options.startMs;
    this.#endMs = options.endMs;
    this.#emit = options.emit ?? (() => {});
    this.#nowMs = Number.NEGATIVE_INFINITY;
    this.#nextMinuteMs = Math.ceil(options.startMs / MINUTE_MS) * MINUTE_MS;
  }

  get nowMs(): number {
    return this.#nowMs;
  }

  handle(event: InputEvent): void {
    // Out-of-order input means the log is not the season any more. Failing here is the
    // only way to find out before a prize is paid against it.
    if (event.atMs < this.#nowMs) {
      throw new Error(`event at ${event.atMs} arrived after ${this.#nowMs}: the input log is out of order`);
    }
    this.#advanceTo(event.atMs);

    switch (event.kind) {
      case "book":
        return this.#onBook(event.atMs, event.book);
      case "trade":
        return this.#onTrade(event.atMs, event.trade);
      case "ctx":
        return this.#onContext(event.ctx);
      case "register":
        return this.#register(event.atMs, event.entryId);
      case "submit":
        return this.#submit(event.atMs, event.entryId, event.order);
      case "cancel":
        return this.#cancel(event.atMs, event.entryId, event.cloid);
      case "clock":
        return;
    }
  }

  // ─────────────────────────────────────────────────── reads

  entryIds(): string[] {
    return [...this.#entries.keys()];
  }

  hasEntry(entryId: string): boolean {
    return this.#entries.has(entryId);
  }

  snapshot(entryId: string) {
    const entry = this.#entries.get(entryId);
    if (!entry) return null;
    // A read, so it uses the engine's current event time rather than one of its own.
    const marks = this.#markPrices(this.#nowMs);
    const current = equity(entry.account, marks);
    return {
      entryId,
      active: entry.account.active,
      equity: current,
      cash: entry.account.cash,
      peak: entry.account.peak,
      drawdownBps: drawdownBps(current, entry.account.peak),
      positions: [...entry.account.positions].map(([asset, size]) => ({ asset, size, markPx: marks.get(asset) ?? null })),
      orders: [...entry.orders].map(([cloid, w]) => ({
        cloid,
        asset: w.order.asset,
        isBuy: w.order.isBuy,
        limitPx: w.order.limitPx,
        sz: w.order.sz,
        remaining: w.remaining,
        state: w.state,
        maxCost: w.maxCost,
        expiresAtMs: w.expiresAtMs,
      })),
      fees: {
        venue: entry.account.venueFees,
        execution: entry.account.executionFees,
        performance: entry.account.performanceFees,
      },
      fundingPaid: entry.account.fundingPaid,
    };
  }

  scoreInput(entryId: string): (ScoreInput & { registeredAtMs: number }) | null {
    const entry = this.#entries.get(entryId);
    if (!entry) return null;
    return {
      startingEquity: this.#rules.startingEquity,
      marks: entry.marks,
      fillDays: entry.fillDays,
      notionalTraded: entry.account.notionalTraded,
      feesPaid: totalFees(entry.account),
      startMs: Math.max(this.#startMs, entry.registeredAtMs),
      registeredAtMs: entry.registeredAtMs,
    };
  }

  // ─────────────────────────────────────────────────── time

  #inSeason(timeMs: number): boolean {
    return timeMs >= this.#startMs && (this.#endMs === undefined || timeMs <= this.#endMs);
  }

  #advanceTo(timeMs: number): void {
    while (this.#nextMinuteMs <= timeMs) {
      const minute = this.#nextMinuteMs;
      this.#expire(minute);
      if (this.#inSeason(minute)) {
        if (minute % HOUR_MS === 0) this.#fund(minute);
        this.#markAll(minute);
      }
      this.#nextMinuteMs += MINUTE_MS;
    }
    this.#expire(timeMs);
    this.#nowMs = timeMs;
  }

  #expire(timeMs: number): void {
    for (const entry of this.#entries.values()) {
      for (const [cloid, working] of entry.orders) {
        // Strictly after, as `reconcile` skips anything where `block.timestamp <= expiry`.
        if (working.expiresAtMs < timeMs) {
          this.#finish(entry, cloid, working, "expired", timeMs);
          this.#release(entry, cloid, "expired", timeMs);
        }
      }
    }
  }

  #fund(timeMs: number): void {
    for (const entry of this.#entries.values()) {
      for (const asset of entry.account.positions.keys()) {
        const context = this.#contexts.get(asset);
        if (!context) {
          this.#emit({ kind: "gap", atMs: timeMs, asset, what: "no_funding_context" });
          continue;
        }
        const payment = applyFunding(entry.account, asset, context.oraclePx, context.fundingRate);
        if (payment !== 0n) this.#emit({ kind: "funding", atMs: timeMs, entryId: entry.id, asset, payment });
      }
    }
  }

  #markAll(timeMs: number): void {
    const marks = this.#markPrices(timeMs);

    for (const entry of this.#entries.values()) {
      if (timeMs < entry.registeredAtMs) continue;
      const account = entry.account;

      for (const asset of account.positions.keys()) {
        if (!marks.has(asset)) this.#emit({ kind: "gap", atMs: timeMs, asset, what: "no_mark" });
      }

      let current = equity(account, marks);
      if (timeMs - account.lastAssessmentMs >= this.#rules.assessmentIntervalMs) {
        const fee = assessPerformanceFee(account, current, this.#rules, timeMs);
        if (fee > 0n) {
          current -= fee;
          this.#emit({ kind: "performance_fee", atMs: timeMs, entryId: entry.id, fee });
        }
      }

      if (current > account.peak) account.peak = current;
      const dd = drawdownBps(current, account.peak);
      let present = account.positions.size > 0;
      for (const working of entry.orders.values()) if (working.state !== "done") present = true;

      entry.marks.push({ timeMs, equity: current, present });
      this.#emit({ kind: "mark", atMs: timeMs, entryId: entry.id, equity: current, drawdownBps: dd, present });

      if (account.active && dd >= this.#rules.maxDrawdownBps) this.#autoPause(entry, timeMs, dd);
      // Retried every minute until flat: an exit capped by displayed depth may need
      // several books to complete.
      if (!account.active) this.#scheduleExits(entry, timeMs);
    }
  }

  #markPrices(timeMs: number): Map<number, bigint> {
    const marks = new Map<number, bigint>();
    for (const asset of this.#instruments.keys()) {
      const context = this.#contexts.get(asset);
      if (context) {
        marks.set(asset, context.markPx);
        continue;
      }
      // Deliberately not filtered by `staleBookMs`. The published rule is about what is
      // traded against, and `#submit` values exposure through this map: refusing a mark
      // here would reject orders outright during a feed gap, when the rule says they
      // wait. Whether a *recorded* minute mark should accept an old mid is a separate
      // question, and a live one - the independent scorer counts it as part of D1.
      const book = this.#books.get(asset);
      const mid = book ? midPx(book) : null;
      if (mid !== null) marks.set(asset, mid);
    }
    return marks;
  }

  // ─────────────────────────────────────────────────── entries and orders

  #register(timeMs: number, entryId: string): void {
    if (this.#entries.has(entryId)) return;
    this.#entries.set(entryId, {
      id: entryId,
      registeredAtMs: timeMs,
      account: openAccount(this.#rules, Math.max(this.#startMs, timeMs)),
      orders: new Map(),
      exits: new Map(),
      marks: [],
      fillDays: new Set(),
    });
  }

  #submit(timeMs: number, entryId: string, order: Order): void {
    const reject = (reason: EngineRejection) =>
      this.#emit({ kind: "rejected", atMs: timeMs, entryId, cloid: order.cloid, reason });

    if (timeMs < this.#startMs || (this.#endMs !== undefined && timeMs >= this.#endMs)) {
      return reject("SeasonNotRunning");
    }
    const entry = this.#entries.get(entryId);
    if (!entry) return reject("VaultNotFound");

    const marks = this.#markPrices(timeMs);
    const reservations = new Map<bigint, Reservation>();
    for (const [cloid, working] of entry.orders) {
      reservations.set(cloid, { asset: working.order.asset, maxCost: working.maxCost });
    }

    const verdict = checkOrder(
      order,
      {
        active: entry.account.active,
        equity: equity(entry.account, marks),
        peak: entry.account.peak,
        positions: entry.account.positions,
        marks,
        reservations,
      },
      this.#instruments,
      this.#rules
    );
    if (!verdict.ok) return reject(verdict.reason);

    const activatesAtMs = timeMs + this.#rules.activationDelayMs;
    entry.orders.set(order.cloid, {
      order,
      maxCost: verdict.maxCost,
      activatesAtMs,
      expiresAtMs: timeMs + this.#rules.orderLifetimeMs,
      remaining: order.sz,
      state: "pending",
    });
    this.#emit({ kind: "accepted", atMs: timeMs, entryId, cloid: order.cloid, maxCost: verdict.maxCost, activatesAtMs });
  }

  #cancel(timeMs: number, entryId: string, cloid: bigint): void {
    const entry = this.#entries.get(entryId);
    const working = entry?.orders.get(cloid);
    if (!entry || !working) {
      this.#emit({ kind: "rejected", atMs: timeMs, entryId, cloid, reason: "OrderNotFound" });
      return;
    }
    this.#finish(entry, cloid, working, "cancelled", timeMs);
    this.#release(entry, cloid, "cancelled", timeMs);
  }

  #finish(entry: Entry, cloid: bigint, working: Working, why: DoneReason, timeMs: number): void {
    if (working.state === "done") return;
    working.state = "done";
    this.#emit({ kind: "order_done", atMs: timeMs, entryId: entry.id, cloid, why });
  }

  #release(entry: Entry, cloid: bigint, why: "cancelled" | "expired" | "paused", timeMs: number): void {
    if (!entry.orders.delete(cloid)) return;
    this.#emit({ kind: "released", atMs: timeMs, entryId: entry.id, cloid, why });
  }

  #autoPause(entry: Entry, timeMs: number, dd: bigint): void {
    entry.account.active = false;
    this.#emit({ kind: "auto_paused", atMs: timeMs, entryId: entry.id, drawdownBps: dd });
    for (const [cloid, working] of entry.orders) {
      this.#finish(entry, cloid, working, "paused", timeMs);
      this.#release(entry, cloid, "paused", timeMs);
    }
  }

  /** `_sendReduceOnlyClose`: IOC at mark ± 50%, so the exit is limited by depth, not price. */
  #scheduleExits(entry: Entry, timeMs: number): void {
    const marks = this.#markPrices(timeMs);
    for (const [asset, size] of entry.account.positions) {
      if (entry.exits.has(asset)) continue;
      const mark = marks.get(asset);
      if (mark === undefined) continue;
      const isBuy = size < 0n;
      entry.exits.set(asset, {
        isBuy,
        limitPx: isBuy ? mark + mark / 2n : mark / 2n,
        activatesAtMs: timeMs + this.#rules.activationDelayMs,
      });
    }
  }

  // ─────────────────────────────────────────────────── market data

  #onContext(context: AssetContext): void {
    const instrument = this.#byCoin.get(context.coin);
    if (instrument) this.#contexts.set(instrument.asset, context);
  }

  /** How much of this order may fill now. Reduce-only is clamped to the open position. */
  #fillable(entry: Entry, asset: number, isBuy: boolean, remaining: bigint, reduceOnly: boolean): bigint {
    if (!reduceOnly) return remaining;
    const size = entry.account.positions.get(asset) ?? 0n;
    const reducible = isBuy ? (size < 0n ? -size : 0n) : size > 0n ? size : 0n;
    return reducible < remaining ? reducible : remaining;
  }

  /**
   * `staleBookMs`, in one place.
   *
   * The age of the data, not the age of our copy: a book that reaches us 15 seconds after
   * Hyperliquid stamped it is 15 seconds old on arrival, and the published rule says it is
   * not traded against. Stored books age the same way as event time advances, so the same
   * test serves the arrival path, the print path and the mark.
   */
  #stale(book: Book, timeMs: number): boolean {
    return timeMs - book.timeMs > this.#rules.staleBookMs;
  }

  #onBook(timeMs: number, book: Book): void {
    const instrument = this.#byCoin.get(book.coin);
    if (!instrument) return;
    const asset = instrument.asset;

    // Stored even when stale: it is still the best view of the asset there is, and the
    // next test is made against the time of use, not of arrival.
    this.#books.set(asset, book);

    if (this.#stale(book, timeMs)) {
      // Orders on this asset wait. Nothing is cancelled and no order loses its place;
      // they activate and fill on the first book that arrives inside the limit.
      this.#emit({ kind: "gap", atMs: timeMs, asset, what: "stale_book" });
      return;
    }

    for (const entry of this.#entries.values()) {
      const exit = entry.exits.get(asset);
      if (exit && exit.activatesAtMs <= timeMs) {
        entry.exits.delete(asset);
        const want = this.#fillable(entry, asset, exit.isBuy, 1n << 127n, true);
        const slices = takeFromBook(exit.isBuy, exit.limitPx, want, book, instrument, this.#rules.depthShareBps);
        for (const slice of slices) this.#fill(entry, 0n, null, asset, exit.isBuy, slice.px, slice.sz, "taker", timeMs);
      }

      for (const [cloid, working] of entry.orders) {
        if (working.order.asset !== asset || working.state !== "pending") continue;
        if (working.activatesAtMs > timeMs) continue;
        this.#activate(entry, cloid, working, book, instrument, timeMs);
      }
    }
  }

  #activate(entry: Entry, cloid: bigint, working: Working, book: Book, instrument: Instrument, timeMs: number): void {
    const { order } = working;

    if (order.tif === TIF.alo) {
      // Post-only: Hyperliquid rejects an ALO that would take liquidity.
      if (crosses(order.isBuy, order.limitPx, book)) this.#finish(entry, cloid, working, "alo_would_cross", timeMs);
      else working.state = "resting";
      return;
    }

    const want = this.#fillable(entry, order.asset, order.isBuy, working.remaining, order.reduceOnly);
    if (order.reduceOnly && want === 0n) {
      this.#finish(entry, cloid, working, "reduce_only_nothing_to_reduce", timeMs);
      return;
    }

    const slices = takeFromBook(order.isBuy, order.limitPx, want, book, instrument, this.#rules.depthShareBps);
    for (const slice of slices) {
      this.#fill(entry, cloid, working, order.asset, order.isBuy, slice.px, slice.sz, "taker", timeMs);
    }

    if (working.remaining === 0n) this.#finish(entry, cloid, working, "filled", timeMs);
    else if (order.tif === TIF.ioc) this.#finish(entry, cloid, working, "ioc_remainder", timeMs);
    else working.state = "resting";
  }

  #onTrade(timeMs: number, trade: Trade): void {
    const instrument = this.#byCoin.get(trade.coin);
    if (!instrument) return;

    // A print is not a book. Granting a maker fill while the asset's book is stale is
    // trading on an asset the engine cannot currently see, which is what the rule forbids
    // - and `l2Book` stalling while `trades` keep arriving is the ordinary shape of a
    // partial feed outage, not a rare one.
    //
    // Reported as two reasons, not one. Having no book yet is not a stale book: every
    // season opens with a short burst of it, because trades arrive before the first
    // `l2Book` snapshot does. Counting those as stale-book refusals makes a season log
    // read as though the rule bound when nothing was wrong.
    const book = this.#books.get(instrument.asset);
    if (book === undefined) {
      this.#emit({ kind: "gap", atMs: timeMs, asset: instrument.asset, what: "no_book" });
      return;
    }
    if (this.#stale(book, timeMs)) {
      this.#emit({ kind: "gap", atMs: timeMs, asset: instrument.asset, what: "stale_book" });
      return;
    }

    for (const entry of this.#entries.values()) {
      for (const [cloid, working] of entry.orders) {
        const { order } = working;
        if (order.asset !== instrument.asset || working.state !== "resting") continue;

        const want = this.#fillable(entry, order.asset, order.isBuy, working.remaining, order.reduceOnly);
        if (order.reduceOnly && want === 0n) {
          this.#finish(entry, cloid, working, "reduce_only_nothing_to_reduce", timeMs);
          continue;
        }

        const size = fillFromTrade(order.isBuy, order.limitPx, want, trade, instrument, this.#rules.depthShareBps);
        if (size === 0n) continue;

        this.#fill(entry, cloid, working, order.asset, order.isBuy, order.limitPx, size, "maker", timeMs);
        if (working.remaining === 0n) this.#finish(entry, cloid, working, "filled", timeMs);
      }
    }
  }

  #fill(
    entry: Entry,
    cloid: bigint,
    working: Working | null,
    asset: number,
    isBuy: boolean,
    px: bigint,
    sz: bigint,
    liquidity: Liquidity,
    timeMs: number
  ): void {
    const charges = applyFill(entry.account, { asset, isBuy, px, sz, liquidity }, this.#rules);
    if (working) working.remaining -= sz;
    entry.fillDays.add(utcDay(timeMs));
    this.#emit({ kind: "fill", atMs: timeMs, entryId: entry.id, cloid, asset, isBuy, px, sz, liquidity, ...charges });
  }
}
