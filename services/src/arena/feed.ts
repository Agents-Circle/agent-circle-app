import type { Logger } from "../shared/log.ts";
import type { InputEvent } from "./engine.ts";
import { parseAssetContext, parseBook, parseTrade } from "./market.ts";

/**
 * Hyperliquid's public WebSocket, turned into engine input.
 *
 * Three subscriptions per coin — `l2Book`, `trades`, `activeAssetCtx` — none of which
 * need a key or count against the per-IP limit on user subscriptions. The feed never
 * touches the engine directly: every message goes through the caller's `accept`, which in
 * production is the `Sequencer`, so it is stamped and written to the input log first.
 *
 * ## Disconnects are visible, not papered over
 *
 * While the socket is down the engine simply stops receiving books, and its stale-book
 * rule (`staleBookMs`) stops trading against them. The feed does not invent a book to
 * bridge the gap. It logs the outage with its duration, because a season with a long
 * outage is a season whose results need a note on them.
 */

export const WS_URL = {
  mainnet: "wss://api.hyperliquid.xyz/ws",
  testnet: "wss://api.hyperliquid-testnet.xyz/ws",
} as const;

type MarketEvent = Extract<InputEvent, { kind: "book" | "trade" | "ctx" }>;
type Builder = (atMs: number) => MarketEvent;

/**
 * One raw message to the events it carries, as builders awaiting a receive time.
 *
 * Builders rather than events because the time is stamped by the sequencer, not here:
 * the feed must not hold a clock of its own. Messages for coins outside the season, and
 * channels the engine does not use, produce nothing.
 */
export function parseFeedMessage(raw: unknown, coins: ReadonlySet<string>): Builder[] {
  if (raw === null || typeof raw !== "object") return [];
  const { channel, data } = raw as { channel?: unknown; data?: unknown };

  switch (channel) {
    case "l2Book": {
      const book = data as { coin: string; time: number; levels: [never[], never[]] };
      if (!coins.has(book.coin)) return [];
      const parsed = parseBook(book);
      return [(atMs) => ({ kind: "book", atMs, book: parsed })];
    }
    case "trades": {
      const trades = (data as { coin: string; side: string; px: string; sz: string; time: number; tid: number }[]) ?? [];
      return trades
        .filter((t) => coins.has(t.coin))
        .map((t) => {
          const trade = parseTrade(t);
          return (atMs: number) => ({ kind: "trade", atMs, trade }) as const;
        });
    }
    case "activeAssetCtx": {
      const ctx = data as { coin: string; ctx: { markPx: string; oraclePx: string; funding: string } };
      if (!coins.has(ctx.coin)) return [];
      // `activeAssetCtx` has no timestamp; the receive time is the one the engine acts on.
      return [(atMs) => ({ kind: "ctx", atMs, ctx: parseAssetContext(ctx, atMs) })];
    }
    default:
      return [];
  }
}

export function subscriptions(coins: Iterable<string>): string[] {
  const out: string[] = [];
  for (const coin of coins) {
    for (const type of ["l2Book", "trades", "activeAssetCtx"]) {
      out.push(JSON.stringify({ method: "subscribe", subscription: { type, coin } }));
    }
  }
  return out;
}

/** The slice of the WebSocket API the feed uses, so tests can hand it a fake. */
export type SocketLike = {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "close" | "error" | "message", listener: (event: { data?: unknown }) => void): void;
};

export type FeedOptions = {
  url: string;
  coins: readonly string[];
  accept: (build: Builder) => unknown;
  log: Logger;
  connect?: (url: string) => SocketLike;
  /** Hyperliquid drops a connection idle for 60s. */
  pingMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
};

export class MarketFeed {
  readonly #options: Required<Omit<FeedOptions, "connect">> & { connect: (url: string) => SocketLike };
  readonly #coins: ReadonlySet<string>;
  #socket: SocketLike | null = null;
  #ping: ReturnType<typeof setInterval> | null = null;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #attempt = 0;
  #downSinceMs: number | null = null;
  #stopped = false;

  constructor(options: FeedOptions) {
    this.#options = {
      pingMs: 30_000,
      maxBackoffMs: 30_000,
      now: Date.now,
      connect: (url) => new WebSocket(url) as unknown as SocketLike,
      ...options,
    };
    this.#coins = new Set(options.coins);
  }

  start(): void {
    this.#stopped = false;
    this.#open();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#ping) clearInterval(this.#ping);
    if (this.#retry) clearTimeout(this.#retry);
    this.#socket?.close();
    this.#socket = null;
  }

  #open(): void {
    const { url, log } = this.#options;
    const socket = this.#options.connect(url);
    this.#socket = socket;

    socket.addEventListener("open", () => {
      this.#attempt = 0;
      if (this.#downSinceMs !== null) {
        log.warn("feed reconnected", { downMs: this.#options.now() - this.#downSinceMs });
        this.#downSinceMs = null;
      } else {
        log.info("feed connected", { url, coins: [...this.#coins] });
      }
      for (const message of subscriptions(this.#coins)) socket.send(message);
      this.#ping = setInterval(() => socket.send(JSON.stringify({ method: "ping" })), this.#options.pingMs);
    });

    socket.addEventListener("message", (event) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(event.data));
      } catch {
        log.warn("feed sent a non-JSON message", {});
        return;
      }
      for (const build of parseFeedMessage(raw, this.#coins)) this.#options.accept(build);
    });

    socket.addEventListener("error", () => {
      log.warn("feed socket error", {});
    });

    socket.addEventListener("close", () => {
      if (this.#ping) clearInterval(this.#ping);
      this.#ping = null;
      if (this.#stopped) return;
      this.#downSinceMs ??= this.#options.now();
      const delay = Math.min(this.#options.maxBackoffMs, 500 * 2 ** this.#attempt);
      this.#attempt += 1;
      log.warn("feed disconnected; reconnecting", { inMs: delay, attempt: this.#attempt });
      this.#retry = setTimeout(() => this.#open(), delay);
    });
  }
}
