import assert from "node:assert/strict";
import { test } from "node:test";

import type { Logger } from "../shared/log.ts";
import { MarketFeed, parseFeedMessage, subscriptions, type SocketLike } from "./feed.ts";

const COINS = new Set(["BTC"]);
const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };

test("an l2Book message becomes a book event at the receive time, not Hyperliquid's", () => {
  const [build] = parseFeedMessage(
    {
      channel: "l2Book",
      data: { coin: "BTC", time: 111, levels: [[{ px: "100000.5", sz: "0.5", n: 1 }], [{ px: "100001", sz: "1", n: 2 }]] },
    },
    COINS
  );
  const event = build!(999);
  assert.equal(event.kind, "book");
  assert.equal(event.atMs, 999);
  if (event.kind !== "book") return;
  assert.equal(event.book.timeMs, 111);
  assert.equal(event.book.bids[0]!.px, 10_000_050_000_000n);
  assert.equal(event.book.asks[0]!.sz, 100_000_000n);
});

test("trades fan out one event each, and other coins are dropped", () => {
  const builds = parseFeedMessage(
    {
      channel: "trades",
      data: [
        { coin: "BTC", side: "B", px: "100000", sz: "0.1", time: 1, tid: 1, hash: "0x" },
        { coin: "ETH", side: "A", px: "4000", sz: "1", time: 1, tid: 2, hash: "0x" },
        { coin: "BTC", side: "A", px: "99999", sz: "0.2", time: 2, tid: 3, hash: "0x" },
      ],
    },
    COINS
  );
  assert.deepEqual(
    builds.map((b) => b(5)).map((e) => (e.kind === "trade" ? e.trade.tid : null)),
    [1, 3]
  );
});

test("activeAssetCtx takes its time from the receive stamp", () => {
  const [build] = parseFeedMessage(
    { channel: "activeAssetCtx", data: { coin: "BTC", ctx: { markPx: "100000", oraclePx: "99990", funding: "0.0000125" } } },
    COINS
  );
  const event = build!(42);
  assert.ok(event.kind === "ctx");
  if (event.kind !== "ctx") return;
  assert.equal(event.ctx.timeMs, 42);
  assert.equal(event.ctx.fundingRate, 12_500_000n);
});

test("pongs, subscription acks and junk produce nothing", () => {
  assert.deepEqual(parseFeedMessage({ channel: "pong" }, COINS), []);
  assert.deepEqual(parseFeedMessage({ channel: "subscriptionResponse", data: {} }, COINS), []);
  assert.deepEqual(parseFeedMessage("nope", COINS), []);
});

test("three subscriptions per coin", () => {
  assert.equal(subscriptions(["BTC", "ETH"]).length, 6);
});

class FakeSocket implements SocketLike {
  sent: string[] = [];
  listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.fire("close");
  }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: string, data?: unknown) {
    for (const l of this.listeners.get(type) ?? []) l({ data });
  }
}

test("the feed subscribes on open, forwards messages, and reconnects after a drop", async () => {
  const sockets: FakeSocket[] = [];
  const accepted: number[] = [];
  const feed = new MarketFeed({
    url: "wss://example",
    coins: ["BTC"],
    accept: (build) => accepted.push(build(7).atMs),
    log: quiet,
    connect: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    maxBackoffMs: 1,
    pingMs: 60_000,
  });
  feed.start();
  sockets[0]!.fire("open");
  assert.equal(sockets[0]!.sent.length, 3);

  sockets[0]!.fire("message", JSON.stringify({ channel: "trades", data: [{ coin: "BTC", side: "B", px: "1", sz: "1", time: 1, tid: 1 }] }));
  assert.deepEqual(accepted, [7]);

  sockets[0]!.fire("close");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sockets.length, 2, "reconnected");
  sockets[1]!.fire("open");
  assert.equal(sockets[1]!.sent.length, 3, "resubscribed");

  feed.stop();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sockets.length, 2, "no reconnect after stop");
});
