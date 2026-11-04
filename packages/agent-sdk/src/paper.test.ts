import assert from "node:assert/strict";
import { test } from "node:test";

import { API_KEY, startArena } from "../test/arena.ts";
import { ArenaApiError, PaperClient } from "./paper.ts";

test("an IOC that crosses fills after the activation delay, and the account shows it", async () => {
  const arena = await startArena();
  try {
    const client = new PaperClient({ baseUrl: arena.baseUrl, apiKey: API_KEY });
    const placed = await client.placeOrder({ asset: 0, isBuy: true, limitPx: "100010", sz: "0.001", tif: "ioc" });
    assert.equal(placed.accepted, true);
    assert.equal((await client.account()).positions.length, 0, "nothing fills before activation");

    // Season 0 activates an order 2 s after it arrives, against the next book.
    await arena.tick(2_500);

    const account = await client.account();
    assert.deepEqual(account.positions.map((p) => [p.asset, p.size]), [[0, 100_000n]]);
    assert.ok(account.fees.venue > 0n && account.fees.execution > 0n, "taker and execution fees are charged");
    assert.ok(account.equity < 10_000_000_000n, "fees come out of equity");
    // A vault cannot see fills, so neither does the reservation: the IOC holds its slot
    // until it is cancelled or expires.
    const held = account.orders.find((o) => o.cloid === placed.cloid);
    assert.equal(held?.state, "done");
    assert.deepEqual(await client.cancelAll(), [placed.cloid]);
    assert.deepEqual((await client.account()).orders, []);
  } finally {
    await arena.close();
  }
});

test("a rejection comes back as a verdict with the vault's reason, not an exception", async () => {
  const arena = await startArena();
  try {
    const client = new PaperClient({ baseUrl: arena.baseUrl, apiKey: API_KEY });
    // 1 BTC is ~$100k against a $10k account and a 12% cap.
    const tooBig = await client.placeOrder({ asset: 0, isBuy: true, limitPx: "99000", sz: "1", tif: "gtc" });
    assert.equal(tooBig.accepted, false);
    assert.equal(tooBig.reason, "PositionCapExceeded");

    const offTick = await client.placeOrder({ asset: 0, isBuy: true, limitPx: "99000.5", sz: "0.001", tif: "gtc" });
    assert.equal(offTick.reason, "InvalidPrice");

    const unknown = await client.cancelOrder(12345n);
    assert.equal(unknown.accepted, false);
    assert.equal(unknown.reason, "OrderNotFound");

    // Refused before it leaves the process: the Arena would answer 400.
    await assert.rejects(client.placeOrder({ asset: 0, isBuy: true, limitPx: "1.123456789", sz: "1", tif: "gtc" }), RangeError);
  } finally {
    await arena.close();
  }
});

test("a wrong key is an ArenaApiError, and the health check needs no key", async () => {
  const arena = await startArena();
  try {
    const wrong = new PaperClient({ baseUrl: `${arena.baseUrl}/`, apiKey: "not-a-key" });
    assert.equal((await wrong.health()).ok, true);
    await assert.rejects(wrong.account(), (error: unknown) => error instanceof ArenaApiError && error.status === 401);
  } finally {
    await arena.close();
  }
});

test("429s are retried with backoff; refused requests never reached the log, so a retry cannot double an order", async () => {
  const statuses = [429, 429, 200];
  const sleeps: number[] = [];
  const calls: RequestInit[] = [];
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    const status = statuses.shift()!;
    const body = status === 200 ? { events: [{ kind: "accepted", atMs: 1, cloid: "9" }] } : { error: "rate limited" };
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  const client = new PaperClient({ baseUrl: "http://arena.test", apiKey: "k", fetch: fakeFetch, sleep: async (ms) => void sleeps.push(ms) });

  const verdict = await client.placeOrder({ asset: 0, isBuy: false, limitPx: "100", sz: "1", tif: "gtc", cloid: 9n });
  assert.equal(verdict.accepted, true);
  assert.deepEqual(sleeps, [2_500, 5_000]);
  assert.equal(calls.length, 3);
  // The same cloid every time.
  assert.ok(calls.every((c) => JSON.parse(String(c.body)).cloid === "9"));

  const exhausted = new PaperClient({
    baseUrl: "http://arena.test",
    apiKey: "k",
    retries: 0,
    fetch: (async () => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 })) as typeof fetch,
  });
  await assert.rejects(exhausted.account(), (error: unknown) => error instanceof ArenaApiError && error.status === 429);
});
