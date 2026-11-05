import assert from "node:assert/strict";
import { test } from "node:test";

import { PaperClient } from "../src/paper.ts";
import { API_KEY, startArena, T0 } from "../test/arena.ts";
import { buildQuote, runPaper } from "./perp-quote.ts";

const BTC = { coin: "BTC", asset: 0, szDecimals: 5, maxLeverage: 40 };
const top = { coin: "BTC", timeMs: T0, bid: "99990", ask: "100010" };

test("the quote is a passive bid on Hyperliquid's tick, sized to clear the $10 minimum", () => {
  const order = buildQuote(BTC, top, { offsetBps: 50, notionalUsd: "11" });
  // 99,990 less 50 bps is 99,490.05; BTC (szDecimals 5) takes whole-dollar prices, rounded down.
  assert.equal(order.limitPx, "99490");
  // $11 at 99,490 is 0.000110563 BTC, rounded *up* to a 0.00001 lot so it stays above $10.
  assert.equal(order.sz, "0.00012");
  assert.equal(order.tif, "alo");
  assert.equal(order.isBuy, true);
  assert.ok(order.cloid !== undefined && order.cloid > 0n);
});

test("the example agent places, finds and cancels an order on an in-process Arena, over HTTP", async () => {
  const arena = await startArena();
  try {
    const client = new PaperClient({ baseUrl: arena.baseUrl, apiKey: API_KEY });
    const order = buildQuote(BTC, top, { offsetBps: 50, notionalUsd: "11" });
    const lines: string[] = [];

    const { placed, account, cancelled } = await runPaper(client, order, (msg) => lines.push(msg));

    assert.equal(placed.accepted, true);
    assert.equal(placed.cloid, order.cloid);
    assert.equal(placed.events[0]?.kind, "accepted");
    assert.equal(account.entryId, "builder");
    assert.equal(account.orders.find((o) => o.cloid === order.cloid)?.state, "pending");
    assert.equal(cancelled.accepted, true);
    assert.deepEqual(lines, ["paper order accepted", "paper account", "paper order cancelled"]);

    // Cancelled means released: the slot and the cap headroom are back.
    assert.deepEqual((await client.account()).orders, []);
    assert.ok(arena.runtime.engine.hasEntry("builder"));
  } finally {
    await arena.close();
  }
});
