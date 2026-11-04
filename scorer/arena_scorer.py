#!/usr/bin/env python3
"""Circle Arena: an independent scorer for a paper season.

Reads a season's input log and its `.season.json`, replays every event, and prints the
final ranking. Nothing else goes in: no network, no database, no keys.

    python3 scorer/arena_scorer.py <season.jsonl[.gz]> [--season FILE] [--json]

## Why a second implementation

The published claim is that the input log *is* the season, so anyone can recompute the
ranks before a prize is paid. That claim only means something if the recomputation does
not run the same code as the engine it is checking. So this file is Python, standard
library only, and shares nothing with `services/src/arena/`. It was written from, in this
order of authority:

  [rules]    the published page, mintlify-docs `builders/arena-rules-and-scoring.mdx`
  [SEASON_0] the numbers in `services/src/arena/rules.ts`
  [plan]     `handbook/plans/arena-season0.md` §1 (fill simulation and scoring)

and it read the TypeScript engine only for what those three leave unsaid: the log format,
the integer scales and the order in which timers fire. Every behaviour taken from the
engine rather than from a published source is tagged [engine] below, so a reader can see
which parts of a result rest on an unpublished convention. Where the sources disagree the
scorer reproduces the engine, so that it can check the engine's arithmetic, and the
disagreement is listed in `scorer/README.md` (D1, D2, ...) and counted in `--json` output.

## Units

Money is USDC at 1e6, sizes and prices at 1e8, funding rates at 1e12, all Python ints.
Every division truncates toward zero [rules]. Python's `//` floors, so it is never used
on a value that can be negative; `tdiv` is.
"""

from __future__ import annotations

import argparse
import datetime
import gzip
import hashlib
import heapq
import json
import sys
from collections import Counter
from dataclasses import dataclass, field

BPS = 10_000
PPM = 1_000_000
MINUTE_MS = 60_000
HOUR_MS = 3_600_000
DAY_MS = 86_400_000
YEAR_MS = 365 * DAY_MS

PRICE_DECIMALS = 8
SIZE_DECIMALS = 8
USDC_DECIMALS = 6
FUNDING_DECIMALS = 12
# 1e8 size x 1e8 price = 1e16; to USDC at 1e6 divide by 1e10 (the vault's SZ_PX_TO_USDC).
SZ_PX_TO_USDC = 10 ** (SIZE_DECIMALS + PRICE_DECIMALS - USDC_DECIMALS)
FUNDING_SCALE = SZ_PX_TO_USDC * 10 ** FUNDING_DECIMALS
UINT128_MAX = (1 << 128) - 1

# CoreWriter action 1 time-in-force codes.
TIF_ALO, TIF_GTC, TIF_IOC = 1, 2, 3

# Hyperliquid perp price rule [plan "tick size checked against meta"]: at most
# 6 - szDecimals decimals and 5 significant figures, an integer price always valid.
PERP_MAX_DECIMALS = 6
MAX_SIGNIFICANT_FIGURES = 5


# ─────────────────────────────────────────────────────────────── rules

SEASON_0 = {
    "startingEquity": 10_000_000_000,  # [rules] $10,000 paper USDC
    "activationDelayMs": 2_000,  # [rules] 2 seconds after the API receives it
    "depthShareBps": 2_500,  # [rules] 25% of each level, or of each print
    "takerFeePpm": 450,  # [rules] 4.5 bps taker
    "makerFeePpm": 150,  # [rules] 1.5 bps maker
    "executionFeePpm": 200,  # [rules] 2 bps of notional
    "performanceFeeBps": 1_000,  # [rules] 10% above the fee high-water mark
    "assessmentIntervalMs": 7 * DAY_MS,  # [rules] assessed weekly
    "positionCapBps": 1_200,  # [rules] 12% of equity
    "capMode": "aggregate",  # [rules] measured in aggregate at mark
    "maxDrawdownBps": 1_500,  # [rules] 15% from the high-water mark
    "maxOpenOrders": 8,  # [rules]
    "orderLifetimeMs": HOUR_MS,  # [rules] 1 hour
    "staleBookMs": 10_000,  # [rules] 10 seconds. Not applied: see D1.
    "drawdownWeightBps": BPS,  # [rules] lambda = 1
    "minActiveDays": 10,  # [rules] fills on 10 distinct UTC days
    "minPresenceBps": 2_000,  # [rules] 20% of minute marks
}

# The season file carries only a hash of the rules, so the rules themselves have to come
# from the published page, and the hash proves they are the ones the season ran under.
# [engine] The hash is SHA-256 over JSON with sorted keys and no whitespace, where the
# fields the TypeScript side holds as bigint are written as decimal strings and the rest
# as numbers. Which fields are which is not published anywhere (D12).
_HASHED_AS_STRING = frozenset(
    {
        "startingEquity",
        "depthShareBps",
        "takerFeePpm",
        "makerFeePpm",
        "executionFeePpm",
        "performanceFeeBps",
        "positionCapBps",
        "maxDrawdownBps",
        "drawdownWeightBps",
        "minPresenceBps",
    }
)


def canonical_rules(rules: dict) -> str:
    ordered = {key: (str(rules[key]) if key in _HASHED_AS_STRING else rules[key]) for key in sorted(rules)}
    return json.dumps(ordered, separators=(",", ":"), ensure_ascii=False)


def rules_hash(rules: dict) -> str:
    return hashlib.sha256(canonical_rules(rules).encode("utf-8")).hexdigest()


# ─────────────────────────────────────────────────────────────── integer arithmetic


def tdiv(a: int, b: int) -> int:
    """Integer division truncating toward zero [rules "every division truncates toward zero"]."""
    q = abs(a) // abs(b)
    return q if (a < 0) == (b < 0) else -q


def notional_usdc(size: int, px: int) -> int:
    return tdiv(abs(size) * px, SZ_PX_TO_USDC)


def signed_value(size: int, px: int) -> int:
    """Mark-to-market value of a signed position: negative for a short."""
    return tdiv(size * px, SZ_PX_TO_USDC)


def drawdown_bps(equity: int, peak: int) -> int:
    if peak == 0 or equity >= peak:
        return 0
    return tdiv((peak - equity) * BPS, peak)


def return_bps(start: int, end: int) -> int:
    if start == 0:
        return 0
    return tdiv((end - start) * BPS, start)


def utc_day(time_ms: int) -> str:
    return (datetime.date(1970, 1, 1) + datetime.timedelta(days=time_ms // DAY_MS)).isoformat()


def score_numeric(bps: int) -> str:
    """bps of 1 as a six-place decimal: 400 bps is "0.040000"."""
    micro = abs(bps) * 100
    return f"{'-' if bps < 0 else ''}{micro // 1_000_000}.{micro % 1_000_000:06d}"


def format_scaled(value: int, decimals: int) -> str:
    digits = str(abs(value)).rjust(decimals + 1, "0")
    whole, fraction = digits[: len(digits) - decimals], digits[len(digits) - decimals :]
    return f"{'-' if value < 0 else ''}{whole}{'.' + fraction if decimals else ''}"


# ─────────────────────────────────────────────────────────────── instruments


@dataclass(frozen=True)
class Instrument:
    coin: str
    asset: int
    sz_decimals: int

    @property
    def lot(self) -> int:
        return 10 ** (SIZE_DECIMALS - self.sz_decimals)

    def to_lots(self, size: int) -> int:
        """Truncate to whole lots [rules "never rounded up"]."""
        return tdiv(size, self.lot) * self.lot

    def size_is_valid(self, size: int) -> bool:
        return size > 0 and size % self.lot == 0

    def price_is_valid(self, px: int) -> bool:
        if px <= 0:
            return False
        if px % 10**PRICE_DECIMALS == 0:
            return True
        allowed = max(0, PERP_MAX_DECIMALS - self.sz_decimals)
        if px % 10 ** (PRICE_DECIMALS - allowed) != 0:
            return False
        return len(str(px).rstrip("0")) <= MAX_SIGNIFICANT_FIGURES


# ─────────────────────────────────────────────────────────────── the log


class LogError(Exception):
    """The log cannot be scored. A prize must not be paid against it."""


def _reject_constant(name: str):
    raise ValueError(f"{name} is not JSON")


_DECODER = json.JSONDecoder(parse_constant=_reject_constant)


def read_log(path: str):
    """Every event in a log, in order, as plain dicts.

    [engine] Blank lines are skipped. A *final* line that does not parse is what a crash
    mid-append leaves, and the engine never applied it, so it is skipped with a warning; an
    unreadable line with anything after it is a corrupted season and stops the replay.
    Bigints stay as `{"$n": "..."}` here and are decoded field by field, which keeps the C
    JSON parser on its fast path for the bulk of a recorded day.
    """
    opener = gzip.open if path.endswith(".gz") else open
    torn: LogError | None = None
    with opener(path, "rt", encoding="utf-8", errors="replace", newline="") as lines:
        for number, line in enumerate(lines, start=1):
            if line.strip() == "":
                continue
            if torn:
                raise torn
            try:
                event = _DECODER.decode(line)
            except ValueError as error:
                torn = LogError(f"{path}:{number}: unreadable input log line ({error})")
                continue
            yield event
    if torn:
        print(f"warning: skipped a torn final line: {torn}", file=sys.stderr)


def _where(event: dict) -> str:
    return f"{event.get('kind')} event at {event.get('atMs')}"


def _big(obj: dict, key: str, event: dict) -> int:
    value = obj.get(key) if isinstance(obj, dict) else None
    if isinstance(value, dict) and len(value) == 1 and isinstance(value.get("$n"), str):
        text = value["$n"]
        digits = text[1:] if text.startswith("-") else text
        if digits.isascii() and digits.isdigit():
            return int(text)
    raise LogError(f"{_where(event)}: {key} is not a {{\"$n\": \"<integer>\"}} bigint: {value!r}")


def _int(obj: dict, key: str, event: dict) -> int:
    value = obj.get(key) if isinstance(obj, dict) else None
    if type(value) is not int:
        raise LogError(f"{_where(event)}: {key} is not an integer: {value!r}")
    return value


def _bool(obj: dict, key: str, event: dict) -> bool:
    value = obj.get(key) if isinstance(obj, dict) else None
    if type(value) is not bool:
        raise LogError(f"{_where(event)}: {key} is not a boolean: {value!r}")
    return value


def _str(obj: dict, key: str, event: dict) -> str:
    value = obj.get(key) if isinstance(obj, dict) else None
    if type(value) is not str:
        raise LogError(f"{_where(event)}: {key} is not a string: {value!r}")
    return value


def _obj(obj: dict, key: str, event: dict) -> dict:
    value = obj.get(key) if isinstance(obj, dict) else None
    if not isinstance(value, dict):
        raise LogError(f"{_where(event)}: {key} is not an object")
    return value


def _levels(book: dict, key: str, event: dict) -> list[tuple[int, int]]:
    raw = book.get(key)
    if not isinstance(raw, list):
        raise LogError(f"{_where(event)}: book.{key} is not a list")
    return [(_big(level, "px", event), _big(level, "sz", event)) for level in raw]


def read_season(path: str) -> dict:
    with open(path, encoding="utf-8") as handle:
        season = json.load(handle)
    instruments = []
    for raw in season.get("instruments", []):
        instruments.append(Instrument(coin=raw["coin"], asset=raw["asset"], sz_decimals=raw["szDecimals"]))
    if type(season.get("startMs")) is not int:
        raise LogError(f"{path}: startMs is not an integer")
    end = season.get("endMs")
    if end is not None and type(end) is not int:
        raise LogError(f"{path}: endMs is not an integer")
    return {
        "slug": season.get("slug"),
        "startMs": season["startMs"],
        "endMs": end,
        "instruments": instruments,
        "rulesHash": season.get("rulesHash"),
    }


# ─────────────────────────────────────────────────────────────── state


@dataclass
class Order:
    asset: int
    is_buy: bool
    limit_px: int
    sz: int
    reduce_only: bool
    tif: int
    cloid: int


@dataclass
class Working:
    order: Order
    max_cost: int
    activates_at: int
    expires_at: int
    remaining: int
    serial: int
    state: str = "pending"  # pending -> resting -> done; or pending -> done


@dataclass
class Exit:
    """[engine] The reduce-only IOC close an auto-paused entry sends per asset."""

    is_buy: bool
    limit_px: int
    activates_at: int


@dataclass
class Entry:
    id: str
    registered_at: int
    cash: int
    fee_mark: int
    peak: int
    last_assessment: int
    active: bool = True
    positions: dict[int, int] = field(default_factory=dict)  # asset -> signed size, never 0
    # Every order still holding a reservation, done or not [rules "until cancelled or
    # expires, never when it fills"]. Insertion-ordered, as the engine walks them.
    orders: dict[int, Working] = field(default_factory=dict)
    exits: dict[int, Exit] = field(default_factory=dict)
    # Orders not yet done, by asset: lets a print skip entries with nothing on that coin.
    live: Counter = field(default_factory=Counter)
    marks: list[tuple[int, int, bool]] = field(default_factory=list)  # (time, equity, present)
    fill_days: set[str] = field(default_factory=set)
    venue_fees: int = 0
    execution_fees: int = 0
    performance_fees: int = 0
    funding_paid: int = 0
    notional_traded: int = 0
    fills: int = 0
    rejections: Counter = field(default_factory=Counter)
    auto_paused_at: int | None = None


class Engine:
    """A replay of one season. Fed events in log order by `handle`."""

    def __init__(self, rules: dict, instruments: list[Instrument], start_ms: int, end_ms: int | None):
        self.rules = rules
        self.instruments: dict[int, Instrument] = {}
        self.by_coin: dict[str, Instrument] = {}
        for instrument in instruments:
            self.instruments[instrument.asset] = instrument
            self.by_coin[instrument.coin] = instrument
        self.start_ms = start_ms
        self.end_ms = end_ms
        self.entries: dict[str, Entry] = {}
        self.books: dict[int, tuple[int, int, list, list]] = {}  # asset -> (received, hl time, bids, asks)
        self.contexts: dict[int, tuple[int, int, int, int]] = {}  # asset -> (received, mark, oracle, rate)
        self.now: int | None = None
        # [engine] Minute marks fall on whole UTC minutes, the first at or after the start.
        self.next_minute = -(-start_ms // MINUTE_MS) * MINUTE_MS
        self._expiries: list[tuple[int, int, str, int]] = []  # (expires_at, serial, entry, cloid)
        self._serial = 0
        self.events = 0
        # Counts for the divergences in README.md, so a dispute can see whether one mattered.
        self.audit: Counter = Counter()

    # ───────────────────────────────────────────── input

    def handle(self, event: dict) -> None:
        if not isinstance(event, dict):
            raise LogError(f"event {self.events + 1} is not an object")
        at = _int(event, "atMs", event)
        # [rules] The log is the season. Out of order means it is not, any more.
        if self.now is not None and at < self.now:
            raise LogError(f"event at {at} arrived after {self.now}: the input log is out of order")
        self.events += 1
        self._advance_to(at)

        kind = event.get("kind")
        if kind == "book":
            self._on_book(at, _obj(event, "book", event), event)
        elif kind == "trade":
            self._on_trade(at, _obj(event, "trade", event), event)
        elif kind == "ctx":
            self._on_context(at, _obj(event, "ctx", event), event)
        elif kind == "register":
            self._register(at, _str(event, "entryId", event))
        elif kind == "submit":
            self._submit(at, _str(event, "entryId", event), self._order(event))
        elif kind == "cancel":
            self._cancel(at, _str(event, "entryId", event), _big(event, "cloid", event))
        elif kind == "clock":
            pass
        else:
            # [engine] An unknown kind still advances the clock and changes nothing else.
            self.audit["unknown_event_kind"] += 1

    def _order(self, event: dict) -> Order:
        raw = _obj(event, "order", event)
        return Order(
            asset=_int(raw, "asset", event),
            is_buy=_bool(raw, "isBuy", event),
            limit_px=_big(raw, "limitPx", event),
            sz=_big(raw, "sz", event),
            reduce_only=_bool(raw, "reduceOnly", event),
            tif=_int(raw, "tif", event),
            cloid=_big(raw, "cloid", event),
        )

    # ───────────────────────────────────────────── time

    def _in_season(self, t: int) -> bool:
        return t >= self.start_ms and (self.end_ms is None or t <= self.end_ms)

    def _advance_to(self, t: int) -> None:
        # [engine] Timers fire as event time passes them, before the event itself: at each
        # whole minute, expiry, then (on the hour) funding, then the mark.
        while self.next_minute <= t:
            minute = self.next_minute
            self._expire(minute)
            if self._in_season(minute):
                if minute % HOUR_MS == 0:
                    self._fund(minute)
                self._mark_all(minute)
            self.next_minute += MINUTE_MS
        self._expire(t)
        self.now = t

    def _expire(self, t: int) -> None:
        # [rules] Orders last an hour. [engine] Strictly after: an order is still live at
        # exactly submit + 1 h, as the vault's `reconcile` skips `block.timestamp <= expiry`.
        heap = self._expiries
        while heap and heap[0][0] < t:
            _, serial, entry_id, cloid = heapq.heappop(heap)
            entry = self.entries[entry_id]
            working = entry.orders.get(cloid)
            if working is None or working.serial != serial:
                continue  # already released
            self._finish(entry, working)
            self._release(entry, cloid)

    def _fund(self, t: int) -> None:
        # [rules] Hourly, on the oracle price, longs paying shorts when the rate is positive.
        # [engine] Uses the latest asset context however old, on the position held at the
        # hour, for paused entries too.
        for entry in self.entries.values():
            for asset, size in entry.positions.items():
                context = self.contexts.get(asset)
                if context is None:
                    self.audit["gap_no_funding_context"] += 1
                    continue
                _, _, oracle_px, rate = context
                payment = tdiv(size * oracle_px * rate, FUNDING_SCALE)
                entry.cash -= payment
                entry.funding_paid += payment
                if payment < 0 and (size * oracle_px * rate) % FUNDING_SCALE:
                    self.audit["funding_receipts_truncated_against_entrant"] += 1

    def _mark_prices(self, t: int, at_minute: bool = False) -> dict[int, int]:
        # [engine] The mark is the latest asset context's markPx, whatever its age; only an
        # asset that has never had a context falls back to the latest book's mid (D3).
        marks: dict[int, int] = {}
        for asset in self.instruments:
            context = self.contexts.get(asset)
            if context is not None:
                marks[asset] = context[1]
                continue
            book = self.books.get(asset)
            if book is not None and book[2] and book[3]:
                marks[asset] = (book[2][0][0] + book[3][0][0]) // 2
                if at_minute and t - book[0] > self.rules["staleBookMs"]:
                    self.audit["d1_mark_from_book_older_than_staleBookMs"] += 1
        return marks

    def _equity(self, entry: Entry, marks: dict[int, int]) -> int:
        # [engine] A position with no mark at all is valued at zero.
        return entry.cash + sum(signed_value(size, marks.get(asset, 0)) for asset, size in entry.positions.items())

    def _mark_all(self, t: int) -> None:
        marks = self._mark_prices(t, at_minute=True)
        rules = self.rules
        for entry in self.entries.values():
            if t < entry.registered_at:
                continue
            for asset in entry.positions:
                if asset not in marks:
                    self.audit["gap_no_mark"] += 1

            current = self._equity(entry, marks)
            # [rules] Performance fee: 10% above the fee high-water mark, weekly. [engine] The
            # week runs from max(season start, registration), at the first minute mark at
            # least 7 days on, and the mark moves to post-fee equity. No final assessment at
            # the season end, which the plan asks for (D5).
            if t - entry.last_assessment >= rules["assessmentIntervalMs"]:
                entry.last_assessment = t
                gain = current - entry.fee_mark
                if gain > 0:
                    fee = tdiv(gain * rules["performanceFeeBps"], BPS)
                    entry.cash -= fee
                    entry.performance_fees += fee
                    entry.fee_mark = current - fee
                    current -= fee

            if current > entry.peak:
                entry.peak = current
            dd = drawdown_bps(current, entry.peak)
            # [rules] "a position or resting order". [engine] An order still waiting out its
            # activation delay counts as resting (D9).
            present = bool(entry.positions) or any(w.state != "done" for w in entry.orders.values())
            entry.marks.append((t, current, present))

            # [rules] 15% from the high-water mark, then auto-pause. [engine] Measured only at
            # minute marks, against the highest marked equity; at or above the limit pauses.
            if entry.active and dd >= rules["maxDrawdownBps"]:
                self._auto_pause(entry, t)
            if not entry.active:
                self._schedule_exits(entry, t, marks)

    # ───────────────────────────────────────────── entries and orders

    def _register(self, t: int, entry_id: str) -> None:
        if entry_id in self.entries:
            return  # [engine] registering twice is a no-op; the first time stands
        start = self.rules["startingEquity"]
        self.entries[entry_id] = Entry(
            id=entry_id,
            registered_at=t,
            cash=start,
            fee_mark=start,
            peak=start,
            last_assessment=max(self.start_ms, t),
        )

    def _check_order(self, entry: Entry, order: Order, marks: dict[int, int]) -> tuple[str | None, int]:
        """The vault's checks, in the vault's order [plan "the same check as placeOrder"].

        Returns (rejection reason or None, reservation).
        """
        rules = self.rules
        if not entry.active:
            return "VaultNotActive", 0
        if order.sz == 0 or order.limit_px == 0:
            return "ZeroAmount", 0
        if order.cloid <= 0 or order.cloid > UINT128_MAX:
            return "ZeroAmount", 0
        if order.cloid in entry.orders:
            return "OrderAlreadyExists", 0
        instrument = self.instruments.get(order.asset)
        if instrument is None:
            return "VenueNotWhitelisted", 0
        # [rules] 8 open orders, where an order is open until cancelled or expired.
        if len(entry.orders) >= rules["maxOpenOrders"]:
            return "TooManyOpenOrders", 0
        # [engine] Drawdown at current marks against the peak as of the last minute mark.
        if drawdown_bps(self._equity(entry, marks), entry.peak) >= rules["maxDrawdownBps"]:
            return "DrawdownLimitBreached", 0
        if order.tif not in (TIF_ALO, TIF_GTC, TIF_IOC):
            return "InvalidTif", 0
        if not instrument.price_is_valid(order.limit_px):
            return "InvalidPrice", 0
        if not instrument.size_is_valid(order.sz):
            return "InvalidSize", 0

        max_cost = notional_usdc(order.sz, order.limit_px)
        # [plan] Reduce-only skips the cap and reserves nothing.
        if order.reduce_only:
            return None, 0
        if max_cost == 0:
            return "ZeroAmount", 0
        if any(asset not in marks for asset in entry.positions) or order.asset not in marks:
            return "NoMarkPrice", 0

        # [rules] 12% of equity, in aggregate at mark: every position at mark, plus every
        # held reservation at its limit price, plus this order.
        if rules["capMode"] == "aggregate":
            exposure = sum(notional_usdc(size, marks[asset]) for asset, size in entry.positions.items())
            exposure += sum(w.max_cost for w in entry.orders.values())
        else:
            exposure = notional_usdc(entry.positions.get(order.asset, 0), marks[order.asset])
            exposure += sum(w.max_cost for w in entry.orders.values() if w.order.asset == order.asset)
        exposure += max_cost
        if exposure * BPS > self._equity(entry, marks) * rules["positionCapBps"]:
            return "PositionCapExceeded", 0
        return None, max_cost

    def _submit(self, t: int, entry_id: str, order: Order) -> None:
        # [engine] Orders are accepted from the start up to, not including, the end.
        if t < self.start_ms or (self.end_ms is not None and t >= self.end_ms):
            self.audit["rejected_SeasonNotRunning"] += 1
            if entry_id in self.entries:
                self.entries[entry_id].rejections["SeasonNotRunning"] += 1
            return
        entry = self.entries.get(entry_id)
        if entry is None:
            self.audit["rejected_VaultNotFound"] += 1
            return
        reason, max_cost = self._check_order(entry, order, self._mark_prices(t))
        if reason is not None:
            entry.rejections[reason] += 1
            return

        self._serial += 1
        working = Working(
            order=order,
            max_cost=max_cost,
            activates_at=t + self.rules["activationDelayMs"],
            expires_at=t + self.rules["orderLifetimeMs"],
            remaining=order.sz,
            serial=self._serial,
        )
        entry.orders[order.cloid] = working
        entry.live[order.asset] += 1
        heapq.heappush(self._expiries, (working.expires_at, working.serial, entry_id, order.cloid))

    def _cancel(self, t: int, entry_id: str, cloid: int) -> None:
        entry = self.entries.get(entry_id)
        working = entry.orders.get(cloid) if entry else None
        if working is None:
            self.audit["rejected_OrderNotFound"] += 1
            if entry is not None:
                entry.rejections["OrderNotFound"] += 1
            return
        self._finish(entry, working)
        self._release(entry, cloid)

    def _finish(self, entry: Entry, working: Working) -> None:
        """The order stops trading. Its reservation stays until `_release`."""
        if working.state == "done":
            return
        working.state = "done"
        entry.live[working.order.asset] -= 1

    def _release(self, entry: Entry, cloid: int) -> None:
        entry.orders.pop(cloid, None)

    def _auto_pause(self, entry: Entry, t: int) -> None:
        entry.active = False
        entry.auto_paused_at = t
        for cloid, working in list(entry.orders.items()):
            self._finish(entry, working)
            self._release(entry, cloid)

    def _schedule_exits(self, entry: Entry, t: int, marks: dict[int, int]) -> None:
        # [engine] As the vault's `_sendReduceOnlyClose`: an IOC at mark +/- 50%, so depth
        # rather than price limits the exit, retried at every minute mark until flat.
        for asset, size in entry.positions.items():
            if asset in entry.exits or asset not in marks:
                continue
            mark = marks[asset]
            is_buy = size < 0
            entry.exits[asset] = Exit(
                is_buy=is_buy,
                limit_px=mark + mark // 2 if is_buy else mark // 2,
                activates_at=t + self.rules["activationDelayMs"],
            )

    # ───────────────────────────────────────────── market data

    def _on_context(self, t: int, ctx: dict, event: dict) -> None:
        instrument = self.by_coin.get(_str(ctx, "coin", event))
        if instrument is None:
            return
        self.contexts[instrument.asset] = (
            t,
            _big(ctx, "markPx", event),
            _big(ctx, "oraclePx", event),
            _big(ctx, "fundingRate", event),
        )

    def _reducible(self, entry: Entry, asset: int, is_buy: bool, remaining: int) -> int:
        size = entry.positions.get(asset, 0)
        reducible = (-size if size < 0 else 0) if is_buy else (size if size > 0 else 0)
        return min(reducible, remaining)

    def _take(self, is_buy: bool, limit_px: int, remaining: int, levels: list, instrument: Instrument) -> list:
        """[rules] Walk the book to the limit, at most 25% of displayed size per level.

        [engine] The share is truncated to whole lots per level, and a level whose share
        rounds to nothing is skipped rather than ending the walk.
        """
        share = self.rules["depthShareBps"]
        slices = []
        for px, sz in levels:
            if remaining == 0:
                break
            if (px > limit_px) if is_buy else (px < limit_px):
                break
            take = min(instrument.to_lots(tdiv(sz * share, BPS)), remaining)
            if take == 0:
                continue
            slices.append((px, take))
            remaining -= take
        return slices

    def _on_book(self, t: int, book: dict, event: dict) -> None:
        instrument = self.by_coin.get(_str(book, "coin", event))
        if instrument is None:
            return
        asset = instrument.asset
        exchange_time = _int(book, "timeMs", event)
        bids, asks = _levels(book, "bids", event), _levels(book, "asks", event)
        self.books[asset] = (t, exchange_time, bids, asks)
        stale = t - exchange_time > self.rules["staleBookMs"]

        for entry in self.entries.values():
            exit_ = entry.exits.get(asset) if entry.exits else None
            if exit_ is not None and exit_.activates_at <= t:
                del entry.exits[asset]
                want = self._reducible(entry, asset, exit_.is_buy, 1 << 127)
                for px, sz in self._take(exit_.is_buy, exit_.limit_px, want, asks if exit_.is_buy else bids, instrument):
                    self._fill(entry, None, asset, exit_.is_buy, px, sz, "taker", t)
                    if stale:
                        self.audit["d1_taker_fill_on_book_older_than_staleBookMs"] += 1

            if not entry.live[asset]:
                continue
            for working in list(entry.orders.values()):
                if working.order.asset != asset or working.state != "pending" or working.activates_at > t:
                    continue
                if exchange_time < working.activates_at:
                    # [plan] says the first book "with timestamp >= t_recv + D". The engine
                    # compares receive times only, so this book qualifies there (D2).
                    self.audit["d2_activated_on_book_stamped_before_activation"] += 1
                fills_before = entry.fills
                self._activate(entry, working, bids, asks, instrument, t)
                if stale and entry.fills > fills_before:
                    self.audit["d1_taker_fill_on_book_older_than_staleBookMs"] += entry.fills - fills_before

    def _activate(self, entry: Entry, working: Working, bids: list, asks: list, instrument: Instrument, t: int) -> None:
        order = working.order
        if order.tif == TIF_ALO:
            # [plan] Post-only: an ALO that would take liquidity is rejected at activation.
            # [engine] It then keeps its reservation and slot until cancel or expiry (D8).
            side = asks if order.is_buy else bids
            crosses = bool(side) and (side[0][0] <= order.limit_px if order.is_buy else side[0][0] >= order.limit_px)
            if crosses:
                self._finish(entry, working)
                self.audit["alo_would_cross"] += 1
            else:
                working.state = "resting"
            return

        want = working.remaining
        if order.reduce_only:
            want = self._reducible(entry, order.asset, order.is_buy, want)
            if want == 0:
                self._finish(entry, working)
                return

        levels = asks if order.is_buy else bids
        for px, sz in self._take(order.is_buy, order.limit_px, want, levels, instrument):
            self._fill(entry, working, order.asset, order.is_buy, px, sz, "taker", t)

        if working.remaining == 0:
            self._finish(entry, working)
        elif order.tif == TIF_IOC:
            # [plan] IOC remainders cancel; GTC remainders rest.
            self._finish(entry, working)
            self.audit["ioc_remainder"] += 1
        else:
            working.state = "resting"

    def _on_trade(self, t: int, trade: dict, event: dict) -> None:
        instrument = self.by_coin.get(_str(trade, "coin", event))
        if instrument is None:
            return
        asset = instrument.asset
        trade_px, trade_sz = _big(trade, "px", event), _big(trade, "sz", event)
        share = self.rules["depthShareBps"]
        book = self.books.get(asset)
        stale = book is None or t - book[0] > self.rules["staleBookMs"]

        for entry in self.entries.values():
            if not entry.live[asset]:
                continue
            for working in list(entry.orders.values()):
                order = working.order
                if order.asset != asset or working.state != "resting":
                    continue
                want = working.remaining
                if order.reduce_only:
                    want = self._reducible(entry, asset, order.is_buy, want)
                    if want == 0:
                        self._finish(entry, working)
                        continue
                # [rules] Only a print strictly through the price fills, for at most 25% of
                # the print, at the order's own price. [engine] The print's aggressor side
                # is not consulted (D7).
                through = trade_px < order.limit_px if order.is_buy else trade_px > order.limit_px
                if not through:
                    continue
                size = min(instrument.to_lots(tdiv(trade_sz * share, BPS)), want)
                if size == 0:
                    continue
                self._fill(entry, working, asset, order.is_buy, order.limit_px, size, "maker", t)
                if stale:
                    self.audit["d1_maker_fill_while_book_older_than_staleBookMs"] += 1
                if working.remaining == 0:
                    self._finish(entry, working)

    def _fill(self, entry: Entry, working: Working | None, asset: int, is_buy: bool, px: int, sz: int, liquidity: str, t: int) -> None:
        rules = self.rules
        signed = sz if is_buy else -sz
        notional = notional_usdc(sz, px)
        # [rules] Venue fee and execution fee on every fill, each truncated.
        venue_fee = tdiv(notional * (rules["takerFeePpm"] if liquidity == "taker" else rules["makerFeePpm"]), PPM)
        execution_fee = tdiv(notional * rules["executionFeePpm"], PPM)
        # [engine] Cash accounting: buying spends notional, selling raises it.
        entry.cash -= signed_value(signed, px) + venue_fee + execution_fee
        entry.venue_fees += venue_fee
        entry.execution_fees += execution_fee
        entry.notional_traded += notional
        if not is_buy and (sz * px) % SZ_PX_TO_USDC:
            self.audit["sale_proceeds_truncated_against_entrant"] += 1

        position = entry.positions.get(asset, 0) + signed
        if position == 0:
            entry.positions.pop(asset, None)
        else:
            entry.positions[asset] = position

        if working is not None:
            working.remaining -= sz
        entry.fills += 1
        day = utc_day(t)
        entry.fill_days.add(day)
        if self.end_ms is not None and t > self.end_ms:
            self.audit["d10_fills_after_season_end"] += 1


# ─────────────────────────────────────────────────────────────── scoring


@dataclass
class Score:
    entry: Entry
    net_return_bps: int
    max_drawdown_bps: int
    score_bps: int
    turnover: int  # annualised notional over average equity, at 1e4
    fees_paid: int
    active_days: int
    presence_bps: int
    eligible: bool


def score_entry(entry: Entry, rules: dict, season_start: int) -> Score:
    """[rules] R = E_T / E_0 - 1;  MDD = max (peak_t - E_t) / peak_t on minute marks;  S = R - lambda MDD.

    [engine] All three in whole bps, each truncated toward zero, so two entries tie when
    their scores agree to the basis point (D11). E_T is the last minute mark's equity.
    """
    start = rules["startingEquity"]
    marks = entry.marks
    final = marks[-1][1] if marks else start

    net = return_bps(start, final)
    peak, worst = start, 0
    for _, equity, _ in marks:
        if equity > peak:
            peak = equity
        worst = max(worst, drawdown_bps(equity, peak))
    score = net - tdiv(rules["drawdownWeightBps"] * worst, BPS)

    count = len(marks)
    equity_sum = sum(equity for _, equity, _ in marks)
    present = sum(1 for _, _, is_present in marks if is_present)
    average = start if count == 0 else tdiv(equity_sum, count)
    elapsed = max(0, (marks[-1][0] if marks else season_start) - max(season_start, entry.registered_at))
    turnover = 0 if average <= 0 or elapsed == 0 else tdiv(entry.notional_traded * YEAR_MS * BPS, average * elapsed)
    presence = 0 if count == 0 else tdiv(present * BPS, count)
    active_days = len(entry.fill_days)

    return Score(
        entry=entry,
        net_return_bps=net,
        max_drawdown_bps=worst,
        score_bps=score,
        turnover=turnover,
        fees_paid=entry.venue_fees + entry.execution_fees + entry.performance_fees,
        active_days=active_days,
        presence_bps=presence,
        # [rules] Fills on 10 distinct UTC days, and present in 20% of minute marks.
        eligible=active_days >= rules["minActiveDays"] and presence >= rules["minPresenceBps"],
    )


def rank(engine: Engine) -> list[Score]:
    """[rules] Highest score first; ties to the lower drawdown, then to who registered first.

    [engine] Registration at the same millisecond falls back to log order (the sort is
    stable over registration order). Every entry is ranked, eligible or not (D4).
    """
    scores = [score_entry(entry, engine.rules, engine.start_ms) for entry in engine.entries.values()]
    return sorted(scores, key=lambda s: (-s.score_bps, s.max_drawdown_bps, s.entry.registered_at))


def replay(log_path: str, season_path: str | None = None, rules: dict = SEASON_0) -> tuple[dict, Engine, list[Score]]:
    season_path = season_path or f"{log_path}.season.json"
    try:
        season = read_season(season_path)
    except FileNotFoundError:
        raise LogError(f"{season_path} not found; it is written at the season's first start") from None
    if season["rulesHash"] != rules_hash(rules):
        raise LogError("these rules are not the ones the season was recorded under (rules hash differs)")
    engine = Engine(rules, season["instruments"], season["startMs"], season["endMs"])
    try:
        for event in read_log(log_path):
            engine.handle(event)
    except FileNotFoundError:
        raise LogError(f"{log_path} not found") from None
    return season, engine, rank(engine)


# ─────────────────────────────────────────────────────────────── output


def ranking_lines(season: dict, engine: Engine, ranked: list[Score]) -> list[str]:
    """The ranking in exactly the layout `npm run arena:replay` prints, so the two diff."""
    lines = [f"season {season['slug']}: {engine.events} events replayed, rules {season['rulesHash'][:16]}…"]
    for position, s in enumerate(ranked, start=1):
        lines.append(
            "  ".join(
                [
                    str(position).rjust(3),
                    s.entry.id,
                    f"score {score_numeric(s.score_bps)}",
                    f"return {s.net_return_bps}bps",
                    f"mdd {s.max_drawdown_bps}bps",
                    f"fees {format_scaled(s.fees_paid, 6)}",
                    "eligible" if s.eligible else "not eligible",
                ]
            )
        )
    return lines


def ranking_json(season: dict, engine: Engine, ranked: list[Score]) -> dict:
    entries = []
    prize_rank = 0
    for position, s in enumerate(ranked, start=1):
        e = s.entry
        if s.eligible:
            prize_rank += 1
        final_equity = e.marks[-1][1] if e.marks else engine.rules["startingEquity"]
        entries.append(
            {
                "rank": position,
                # [rules] "An entry is ranked only if it meets both minimums" (D4).
                "prizeRank": prize_rank if s.eligible else None,
                "entryId": e.id,
                "score": score_numeric(s.score_bps),
                "scoreBps": s.score_bps,
                "netReturnBps": s.net_return_bps,
                "maxDrawdownBps": s.max_drawdown_bps,
                "feesPaid": format_scaled(s.fees_paid, 6),
                "fees": {
                    "venue": format_scaled(e.venue_fees, 6),
                    "execution": format_scaled(e.execution_fees, 6),
                    "performance": format_scaled(e.performance_fees, 6),
                },
                "fundingPaid": format_scaled(e.funding_paid, 6),
                "finalEquity": format_scaled(final_equity, 6),
                "cash": format_scaled(e.cash, 6),
                "positions": {str(asset): format_scaled(size, 8) for asset, size in e.positions.items()},
                "eligible": s.eligible,
                "activeDays": s.active_days,
                "presenceBps": s.presence_bps,
                "turnover": format_scaled(s.turnover, 4),
                "marks": len(e.marks),
                "fills": e.fills,
                "notionalTraded": format_scaled(e.notional_traded, 6),
                "registeredAtMs": e.registered_at,
                "autoPausedAtMs": e.auto_paused_at,
                "rejections": dict(sorted(e.rejections.items())),
            }
        )
    return {
        "season": season["slug"],
        "events": engine.events,
        "rulesHash": season["rulesHash"],
        "startMs": season["startMs"],
        "endMs": season["endMs"],
        "lastEventMs": engine.now,
        "entries": entries,
        "audit": dict(sorted(engine.audit.items())),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Replay a Circle Arena season log and print the final ranking.")
    parser.add_argument("log", help="the season input log, .jsonl or .jsonl.gz")
    parser.add_argument("--season", help="the season file (default: <log>.season.json)")
    parser.add_argument("--json", action="store_true", help="full detail as JSON, with prize ranks and divergence counts")
    args = parser.parse_args(argv)
    try:
        season, engine, ranked = replay(args.log, args.season)
    except LogError as error:
        print(error, file=sys.stderr)
        return 1
    if args.json:
        json.dump(ranking_json(season, engine, ranked), sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        print("\n".join(ranking_lines(season, engine, ranked)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
