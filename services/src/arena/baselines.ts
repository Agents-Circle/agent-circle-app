import { createHash } from "node:crypto";

import { BPS, PRICE_DECIMALS, SIZE_DECIMALS, USDC_DECIMALS } from "../shared/units.ts";
import type { InputEvent } from "./engine.ts";
import { MAX_SIGNIFICANT_FIGURES, PERP_MAX_DECIMALS, priceIsValid, toLots, type Instrument } from "./market.ts";
import type { Order } from "./risk.ts";
import { HOUR_MS, MINUTE_MS, TIF, type SeasonRules } from "./rules.ts";

/**
 * The house baselines: entries the Arena runs itself, ranked beside everyone else's and
 * never eligible for a prize (`plans/arena-season0.md` §1, registration item 5).
 *
 * - `house:cash` registers and never trades. Anything ranked below it lost money.
 * - `house:btc-long` buys BTC once at the start, sized to the position cap, and holds.
 *   Anything ranked below it would have done better buying BTC and going to sleep.
 * - `house:random-N` opens a random coin, side and size (up to the cap) at random times,
 *   holds for a random while, then closes: first passively at the touch, then crossing
 *   whatever is left. It is what an agent with no edge looks like after fees.
 *
 * ## Inputs, not engine code
 *
 * The baselines are `register` / `submit` / `cancel` events merged into the season's input
 * log in time order, exactly as an entrant's orders arrive through the API. The engine has
 * no idea they are the house's, so they meet every rule an entrant meets, and a replay of
 * the log reproduces them without this file.
 *
 * ## Fire-and-forget, as a vault is
 *
 * The scripts read the market feed and nothing else: never a fill, never their own equity.
 * That is all a vault sees through CoreWriter, so it is all a baseline gets. Sizes are set
 * against the starting equity, closes are reduce-only so they can never overshoot what
 * actually filled, and every order is cancelled once it has had its chance, because a
 * filled order keeps its reservation until then.
 *
 * ## Deterministic
 *
 * Every choice comes from a seeded PRNG, drawn in a fixed order. Every action fires on the
 * first market event at or after its scheduled time, stamped with that event's time and
 * placed after it in the log, so an action only ever sees data at or before its own stamp.
 * The same market slice and seed therefore give the same log, line for line.
 */

export const HOUSE_PREFIX = "house:";

/** House entries are published, and never eligible for a prize. */
export function isHouseEntry(entryId: string): boolean {
  return entryId.startsWith(HOUSE_PREFIX);
}

export type RandomTiming = {
  /** Flat time before each new position, drawn uniformly from the range. */
  waitMs: readonly [number, number];
  /** Time between the open and the close, drawn uniformly. */
  holdMs: readonly [number, number];
  /** How long the passive close rests at the touch before the rest is crossed. */
  passiveMs: number;
  /** A taker order is cancelled this long after it is sent, to free its slot and reservation. */
  cancelAfterMs: number;
};

/** For a recorded day: a few positions an hour per entry. */
export const DAY_TIMING: RandomTiming = {
  waitMs: [MINUTE_MS, HOUR_MS],
  holdMs: [5 * MINUTE_MS, 2 * HOUR_MS],
  passiveMs: 5 * MINUTE_MS,
  cancelAfterMs: MINUTE_MS,
};

export type HouseOptions = {
  rules: SeasonRules;
  /** The season universe. `house:btc-long` needs BTC in it. */
  instruments: readonly Instrument[];
  startMs: number;
  endMs?: number;
  /** Published with the season, so anyone can regenerate the house's orders. */
  seed: string;
  /** How many `house:random-N` entries. Default 3. */
  randomEntries?: number;
  timing?: RandomTiming;
  /**
   * How far past the touch a crossing order is priced. 25 bps covers the touch's move
   * between the book an order is priced from and the one it activates against for every
   * BTC, ETH and SOL book recorded on 2026-11-04 (worst 20 bps); thinner coins miss now
   * and then, which is the fill model working, not the script failing.
   */
  slippageBps?: bigint;
};

/** A random open is sized at this share of the cap, drawn uniformly, in bps. */
const SHARE_OF_CAP_BPS = [1_000, 9_000] as const;

const SZ_PX_TO_USDC = 10n ** BigInt(SIZE_DECIMALS + PRICE_DECIMALS - USDC_DECIMALS);
const PRICE_SCALE = 10n ** BigInt(PRICE_DECIMALS);

// ───────────────────────────────────────────────────────── pure helpers

/**
 * mulberry32: a small 32-bit PRNG with integer-only steps, so the same seed draws the same
 * numbers on every machine and every Node version. Not for anything adversarial; the
 * house's orders are public anyway.
 */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** One PRNG per entry, so adding an entry never changes another entry's draws. */
export function entrySeed(seed: string, entryId: string): number {
  return createHash("sha256").update(`${seed}:${entryId}`).digest().readUInt32BE(0);
}

/** A uniform integer in `[lo, hi]`. The modulo bias is below 1e-5 for these ranges. */
function between(next: () => number, [lo, hi]: readonly [number, number]): number {
  return lo + (next() % (hi - lo + 1));
}

/**
 * The nearest valid Hyperliquid price at or beyond `px`: rounded up for a buy, down for
 * a sell, so a crossing order still crosses after rounding. The same rules as
 * `priceIsValid`: at most `6 − szDecimals` decimals and five significant figures, and an
 * integer is always valid.
 */
export function roundPrice(instrument: Instrument, px: bigint, up: boolean): bigint {
  const decimals = Math.max(0, PERP_MAX_DECIMALS - instrument.szDecimals);
  let step = 10n ** BigInt(PRICE_DECIMALS - decimals);
  const significant = 10n ** BigInt(Math.max(0, px.toString().length - MAX_SIGNIFICANT_FIGURES));
  if (significant > step) step = significant;
  if (step > PRICE_SCALE) step = PRICE_SCALE;
  const rounded = up ? ((px + step - 1n) / step) * step : (px / step) * step;
  if (!priceIsValid(instrument, rounded)) throw new Error(`no valid price near ${px} for ${instrument.coin}`);
  return rounded;
}

/**
 * The largest whole-lot size whose reservation, `sz × limitPx` truncated as the vault
 * truncates it, fits in `budget`. Sized on the limit, not the fill price, because the
 * limit is what the cap check reserves.
 */
export function capSize(instrument: Instrument, budget: bigint, limitPx: bigint): bigint {
  return toLots(instrument, (budget * SZ_PX_TO_USDC) / limitPx);
}

// ───────────────────────────────────────────────────────── the scripts

type Touch = { bid: bigint; ask: bigint };

type Plan = { instrument: Instrument; isBuy: boolean; shareBps: number; holdMs: number };

type RandomEntry = {
  id: string;
  next: () => number;
  position: { instrument: Instrument; isBuy: boolean; sz: bigint } | null;
  passiveCloid: bigint;
};

type Action = { atMs: number; seq: number; entryId: string } & (
  | { kind: "cap_long" }
  | { kind: "open"; plan: Plan }
  | { kind: "passive_close" }
  | { kind: "cross_close" }
  | { kind: "cancel"; cloid: bigint }
);

type Scheduled<A> = A extends unknown ? Omit<A, "atMs" | "seq" | "entryId"> : never;

export function houseEntryIds(randomEntries = 3): string[] {
  const ids = [`${HOUSE_PREFIX}cash`, `${HOUSE_PREFIX}btc-long`];
  for (let i = 1; i <= randomEntries; i++) ids.push(`${HOUSE_PREFIX}random-${i}`);
  return ids;
}

class HouseScript {
  readonly #options: HouseOptions;
  readonly #timing: RandomTiming;
  readonly #slippageBps: bigint;
  readonly #budget: bigint;
  readonly #btc: Instrument;
  readonly #touch = new Map<string, Touch>();
  readonly #random = new Map<string, RandomEntry>();
  readonly #cloids = new Map<string, bigint>();
  /** Sorted by (atMs, seq). Small: a few actions per entry at most. */
  readonly #queue: Action[] = [];
  #seq = 0;

  constructor(options: HouseOptions) {
    this.#options = options;
    this.#timing = options.timing ?? DAY_TIMING;
    this.#slippageBps = options.slippageBps ?? 25n;
    this.#budget = (options.rules.startingEquity * options.rules.positionCapBps) / BPS;
    const btc = options.instruments.find((i) => i.coin === "BTC");
    if (!btc) throw new Error("house:btc-long needs BTC in the season's instruments");
    this.#btc = btc;

    for (const id of houseEntryIds(options.randomEntries)) this.#cloids.set(id, 0n);
    this.#schedule(`${HOUSE_PREFIX}btc-long`, options.startMs, { kind: "cap_long" });
    for (const id of houseEntryIds(options.randomEntries).slice(2)) {
      const entry: RandomEntry = { id, next: prng(entrySeed(options.seed, id)), position: null, passiveCloid: 0n };
      this.#random.set(id, entry);
      this.#scheduleOpen(entry, options.startMs);
    }
  }

  registrations(): InputEvent[] {
    return [...this.#cloids.keys()].map((entryId) => ({ kind: "register", atMs: this.#options.startMs, entryId }));
  }

  observe(event: InputEvent): void {
    if (event.kind !== "book") return;
    const bid = event.book.bids[0];
    const ask = event.book.asks[0];
    if (bid && ask) this.#touch.set(event.book.coin, { bid: bid.px, ask: ask.px });
  }

  /** Every action due by `nowMs` that can be priced, as events stamped `nowMs`. */
  due(nowMs: number): InputEvent[] {
    const out: InputEvent[] = [];
    let i = 0;
    while (i < this.#queue.length && this.#queue[i]!.atMs <= nowMs) {
      const events = this.#fire(this.#queue[i]!, nowMs);
      // No book for that coin yet: the action waits for one, and the rest go ahead.
      if (events === null) {
        i += 1;
        continue;
      }
      this.#queue.splice(i, 1);
      out.push(...events);
    }
    return out;
  }

  #schedule(entryId: string, atMs: number, action: Scheduled<Action>): void {
    if (this.#options.endMs !== undefined && atMs >= this.#options.endMs) return;
    const scheduled = { ...action, atMs, seq: this.#seq++, entryId } as Action;
    let at = this.#queue.length;
    while (at > 0 && this.#queue[at - 1]!.atMs > atMs) at -= 1;
    this.#queue.splice(at, 0, scheduled);
  }

  /** The draws happen here, in a fixed order, whether or not the open ever fires. */
  #scheduleOpen(entry: RandomEntry, fromMs: number): void {
    const { instruments } = this.#options;
    const waitMs = between(entry.next, this.#timing.waitMs);
    const instrument = instruments[between(entry.next, [0, instruments.length - 1])]!;
    const isBuy = between(entry.next, [0, 1]) === 0;
    const shareBps = between(entry.next, SHARE_OF_CAP_BPS);
    const holdMs = between(entry.next, this.#timing.holdMs);
    this.#schedule(entry.id, fromMs + waitMs, { kind: "open", plan: { instrument, isBuy, shareBps, holdMs } });
  }

  #cloid(entryId: string): bigint {
    const cloid = this.#cloids.get(entryId)! + 1n;
    this.#cloids.set(entryId, cloid);
    return cloid;
  }

  /** A limit `slippageBps` past the far touch, so the order crosses the next book too. */
  #crossingPx(instrument: Instrument, isBuy: boolean, touch: Touch): bigint {
    const px = isBuy ? (touch.ask * (BPS + this.#slippageBps)) / BPS : (touch.bid * (BPS - this.#slippageBps)) / BPS;
    return roundPrice(instrument, px, isBuy);
  }

  #submit(entryId: string, nowMs: number, order: Omit<Order, "cloid">): Extract<InputEvent, { kind: "submit" }> {
    return { kind: "submit", atMs: nowMs, entryId, order: { ...order, cloid: this.#cloid(entryId) } };
  }

  #fire(action: Action, nowMs: number): InputEvent[] | null {
    const { entryId } = action;

    if (action.kind === "cancel") return [{ kind: "cancel", atMs: nowMs, entryId, cloid: action.cloid }];

    if (action.kind === "cap_long") {
      const touch = this.#touch.get(this.#btc.coin);
      if (!touch) return null;
      const limitPx = this.#crossingPx(this.#btc, true, touch);
      const sz = capSize(this.#btc, this.#budget, limitPx);
      const submit = this.#submit(entryId, nowMs, { asset: this.#btc.asset, isBuy: true, limitPx, sz, reduceOnly: false, tif: TIF.ioc });
      this.#schedule(entryId, nowMs + this.#timing.cancelAfterMs, { kind: "cancel", cloid: submit.order.cloid });
      return [submit];
    }

    const entry = this.#random.get(entryId)!;

    if (action.kind === "open") {
      const { instrument, isBuy, shareBps, holdMs } = action.plan;
      const touch = this.#touch.get(instrument.coin);
      if (!touch) return null;
      const limitPx = this.#crossingPx(instrument, isBuy, touch);
      const sz = capSize(instrument, (this.#budget * BigInt(shareBps)) / BPS, limitPx);
      if (sz === 0n) {
        this.#scheduleOpen(entry, nowMs);
        return [];
      }
      const submit = this.#submit(entryId, nowMs, { asset: instrument.asset, isBuy, limitPx, sz, reduceOnly: false, tif: TIF.ioc });
      entry.position = { instrument, isBuy, sz };
      this.#schedule(entryId, nowMs + this.#timing.cancelAfterMs, { kind: "cancel", cloid: submit.order.cloid });
      this.#schedule(entryId, nowMs + holdMs, { kind: "passive_close" });
      return [submit];
    }

    const position = entry.position!;
    const touch = this.#touch.get(position.instrument.coin);
    if (!touch) return null;

    if (action.kind === "passive_close") {
      // Post-only at our own side's touch: the far side for the trade that closes us.
      const isBuy = !position.isBuy;
      const limitPx = roundPrice(position.instrument, isBuy ? touch.bid : touch.ask, !isBuy);
      const submit = this.#submit(entryId, nowMs, {
        asset: position.instrument.asset, isBuy, limitPx, sz: position.sz, reduceOnly: true, tif: TIF.alo,
      });
      entry.passiveCloid = submit.order.cloid;
      this.#schedule(entryId, nowMs + this.#timing.passiveMs, { kind: "cross_close" });
      return [submit];
    }

    // cross_close: withdraw the passive order, then cross whatever is left. Reduce-only
    // clamps to the position the engine actually holds, so a close that has already filled
    // in full ends as `reduce_only_nothing_to_reduce` and changes nothing.
    const isBuy = !position.isBuy;
    const cancel: InputEvent = { kind: "cancel", atMs: nowMs, entryId, cloid: entry.passiveCloid };
    const submit = this.#submit(entryId, nowMs, {
      asset: position.instrument.asset,
      isBuy,
      limitPx: this.#crossingPx(position.instrument, isBuy, touch),
      sz: position.sz,
      reduceOnly: true,
      tif: TIF.ioc,
    });
    entry.position = null;
    this.#schedule(entryId, nowMs + this.#timing.cancelAfterMs, { kind: "cancel", cloid: submit.order.cloid });
    this.#scheduleOpen(entry, nowMs);
    return [cancel, submit];
  }
}

/**
 * A recorded market slice with the house entries merged in: the season's input log.
 *
 * Streams, so a recorded day (a gigabyte of JSON) never has to be in memory. Market events
 * pass through unchanged and in order. The registrations are stamped `startMs`, before the
 * first market event at or after it; every other house event comes straight after the
 * market event that made it due, with the same stamp.
 */
export async function* withHouseEntries(
  market: AsyncIterable<InputEvent> | Iterable<InputEvent>,
  options: HouseOptions
): AsyncGenerator<InputEvent> {
  const script = new HouseScript(options);
  let registered = false;
  for await (const event of market) {
    if (!registered && event.atMs >= options.startMs) {
      yield* script.registrations();
      registered = true;
    }
    yield event;
    script.observe(event);
    if (registered) yield* script.due(event.atMs);
  }
  if (!registered) yield* script.registrations();
}
