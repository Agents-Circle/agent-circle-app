import type { AddressInfo } from "node:net";

import { arenaApi, hashApiKey, RateLimiter } from "../../../services/src/arena/api.ts";
import type { Book } from "../../../services/src/arena/market.ts";
import { SEASON_0 } from "../../../services/src/arena/rules.ts";
import { ArenaRuntime } from "../../../services/src/arena/runtime.ts";
import type { Logger } from "../../../services/src/shared/log.ts";

/**
 * The real Season 0 engine and order API, in-process, on a random port, with a clock the
 * test moves. Nothing is mocked between the SDK and the engine except the market feed,
 * which the test plays in by hand.
 */

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export const T0 = Date.UTC(2026, 10, 10);
export const API_KEY = "sdk-test-key";
export const BTC = { coin: "BTC", asset: 0, szDecimals: 5 } as const;

const PX = 100_000_000n;

/** A two-sided BTC book: 99,990 bid / 100,010 ask, 2 BTC each side. */
export function btcBook(timeMs: number): Book {
  return { coin: "BTC", timeMs, bids: [{ px: 99_990n * PX, sz: 2n * PX }], asks: [{ px: 100_010n * PX, sz: 2n * PX }] };
}

export async function startArena() {
  let now = T0 + 1_000;
  const runtime = new ArenaRuntime({ rules: SEASON_0, instruments: [BTC], startMs: T0, sink: async () => {}, now: () => now });
  await runtime.market((atMs) => ({
    kind: "ctx",
    atMs,
    ctx: { coin: "BTC", timeMs: atMs, markPx: 100_000n * PX, oraclePx: 100_000n * PX, fundingRate: 0n },
  }));
  await runtime.market((atMs) => ({ kind: "book", atMs, book: btcBook(atMs) }));

  const keyHash = hashApiKey(API_KEY);
  const server = arenaApi({
    runtime,
    resolveEntry: (hash) => (hash === keyHash ? "builder" : null),
    log: quiet,
    limiter: new RateLimiter(1_000, 10_000),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    runtime,
    /** Move the clock and play in a fresh book, which is what activates pending orders. */
    async tick(ms: number) {
      now += ms;
      await runtime.market((atMs) => ({ kind: "book", atMs, book: btcBook(atMs) }));
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
