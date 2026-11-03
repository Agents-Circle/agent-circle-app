import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import type { Logger } from "../shared/log.ts";
import { arenaApi, BadRequest, hashApiKey, parseCloid, parseOrder, RateLimiter } from "./api.ts";
import type { Book, Instrument } from "./market.ts";
import { SEASON_0, TIF } from "./rules.ts";
import { ArenaRuntime } from "./runtime.ts";

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const T0 = Date.UTC(2026, 10, 10);
const BTC: Instrument = { coin: "BTC", asset: 0, szDecimals: 5 };

test("orders parse from decimal strings into the engine's integers", () => {
  const order = parseOrder({ asset: 0, isBuy: true, limitPx: "100000.5", sz: "0.01", tif: "ioc", cloid: "0xff" });
  assert.deepEqual(order, {
    asset: 0,
    isBuy: true,
    limitPx: 10_000_050_000_000n,
    sz: 1_000_000n,
    reduceOnly: false,
    tif: TIF.ioc,
    cloid: 255n,
  });
});

test("malformed orders are refused, never coerced", () => {
  const base = { asset: 0, isBuy: true, limitPx: "1", sz: "1", tif: "gtc", cloid: "1" };
  for (const bad of [
    { ...base, limitPx: 1 }, // a JSON number, not a string
    { ...base, limitPx: "1.123456789" }, // past 1e8: would be silently truncated
    { ...base, sz: "-1" },
    { ...base, sz: "0" },
    { ...base, tif: "fok" },
    { ...base, asset: 1.5 },
    { ...base, cloid: "0" },
  ]) {
    assert.throws(() => parseOrder(bad), BadRequest, JSON.stringify(bad));
  }
  assert.throws(() => parseCloid("0x" + "f".repeat(33)), BadRequest);
  assert.equal(parseCloid("0x" + "f".repeat(32)), (1n << 128n) - 1n);
});

test("the rate limiter is per key and per window", () => {
  let now = 0;
  const limiter = new RateLimiter(2, 1_000, () => now);
  assert.ok(limiter.allow("a"));
  assert.ok(limiter.allow("a"));
  assert.ok(!limiter.allow("a"));
  assert.ok(limiter.allow("b"));
  now = 1_000;
  assert.ok(limiter.allow("a"));
});

async function serve() {
  const runtime = new ArenaRuntime({ rules: SEASON_0, instruments: [BTC], startMs: T0, sink: async () => {}, now: () => T0 + 1_000 });
  const book: Book = { coin: "BTC", timeMs: T0, bids: [{ px: 9_999_000_000_000n, sz: 200_000_000n }], asks: [{ px: 10_001_000_000_000n, sz: 200_000_000n }] };
  await runtime.market((atMs) => ({ kind: "ctx", atMs, ctx: { coin: "BTC", timeMs: atMs, markPx: 10_000_000_000_000n, oraclePx: 10_000_000_000_000n, fundingRate: 0n } }));
  await runtime.market((atMs) => ({ kind: "book", atMs, book }));

  const keys = new Map([[hashApiKey("alice-key"), "alice"]]);
  const server = arenaApi({ runtime, resolveEntry: (h) => keys.get(h) ?? null, log: quiet, limiter: new RateLimiter(5, 60_000) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, init: RequestInit = {}, key: string | null = "alice-key") =>
    fetch(base + path, { ...init, headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) } });
  return { server, runtime, call };
}

test("the HTTP API authenticates, trades, cancels and reports", async () => {
  const { server, runtime, call } = await serve();
  try {
    assert.equal((await call("/v1/health", {}, null)).status, 200);
    assert.equal((await call("/v1/account", {}, null)).status, 401);
    assert.equal((await call("/v1/account", {}, "wrong")).status, 401);

    const order = { asset: 0, isBuy: true, limitPx: "100010", sz: "0.01", tif: "gtc", cloid: "7" };
    const placed = await call("/v1/orders", { method: "POST", body: JSON.stringify(order) });
    assert.equal(placed.status, 200);
    const body = (await placed.json()) as { events: { kind: string; cloid: string }[] };
    assert.equal(body.events[0]!.kind, "accepted");
    assert.equal(body.events[0]!.cloid, "7");
    assert.ok(runtime.engine.hasEntry("alice"), "first authenticated call registers the entry");

    const tooBig = await call("/v1/orders", { method: "POST", body: JSON.stringify({ ...order, sz: "50", cloid: "8" }) });
    assert.equal(tooBig.status, 422);

    assert.equal((await call("/v1/orders", { method: "POST", body: "{" })).status, 400);

    const cancelled = await call("/v1/orders/7", { method: "DELETE" });
    assert.equal(cancelled.status, 200);

    // Five authenticated requests per minute in this test's limiter: the four above,
    // then this one. The sixth is refused, and 401s never counted.
    const account = await call("/v1/account");
    assert.equal(account.status, 200);
    assert.equal(((await account.json()) as { entryId: string }).entryId, "alice");
    assert.equal((await call("/v1/account")).status, 429);
  } finally {
    server.close();
  }
});
