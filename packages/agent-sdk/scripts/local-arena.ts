import { randomBytes } from "node:crypto";

import { arenaApi, hashApiKey } from "../../../services/src/arena/api.ts";
import { MarketFeed, WS_URL } from "../../../services/src/arena/feed.ts";
import { SEASON_0 } from "../../../services/src/arena/rules.ts";
import { ArenaRuntime } from "../../../services/src/arena/runtime.ts";
import { fatal, logger } from "../../../services/src/shared/log.ts";
import { InfoClient, type Network } from "../src/markets.ts";

/**
 * A Circle Arena on your own machine, for building an agent before you have an entry.
 *
 *     npm run arena:local                        # BTC, ETH, SOL on mainnet's public feed
 *     ARENA_COINS=BTC NETWORK=testnet npm run arena:local
 *
 * The Season 0 engine and order API from `services/src/arena`, unchanged, fed by
 * Hyperliquid's live public WebSocket. What it leaves out is everything that needs an
 * operator: no database, no season row, no published scores. One API key, printed at
 * start (or `ARENA_API_KEY`), resolves to one entry called `local`.
 *
 * **Paper trading. Simulated fills on live Hyperliquid prices. No funds at risk. Not an
 * on-chain track record.** It holds no key and signs nothing.
 *
 * Asset indices come from the chosen network's `meta`, as the real Arena's do. Season 0
 * reads mainnet's feed, so mainnet is the default here too, and an agent trading this
 * Arena must read `meta` from the same network (`ARENA_NETWORK` in the example).
 */

const log = logger("arena-local");

async function main(): Promise<void> {
  const network = (process.env.NETWORK ?? "mainnet") as Network;
  if (network !== "mainnet" && network !== "testnet") throw new Error("NETWORK must be mainnet or testnet");
  const coins = (process.env.ARENA_COINS ?? "BTC,ETH,SOL").split(",").map((c) => c.trim()).filter(Boolean);
  const port = Number(process.env.ARENA_PORT ?? 8787);
  const key = process.env.ARENA_API_KEY ?? randomBytes(24).toString("base64url");

  const markets = await new InfoClient({ network }).markets();
  const instruments = coins.map((coin) => {
    const market = markets.find((m) => m.coin === coin);
    if (!market) throw new Error(`${coin} is not a perp on ${network}`);
    return { coin, asset: market.asset, szDecimals: market.szDecimals };
  });

  const runtime = new ArenaRuntime({ rules: SEASON_0, instruments, startMs: Date.now(), sink: async () => {} });
  runtime.onOutput((event) => {
    if (event.kind !== "mark" && event.kind !== "gap") log.info(`engine: ${event.kind}`, { ...event });
  });

  const feed = new MarketFeed({
    url: WS_URL[network],
    coins,
    accept: (build) => runtime.market(build).catch((error: Error) => fatal(log, error)),
    log,
  });
  feed.start();

  const keyHash = hashApiKey(key);
  const server = arenaApi({ runtime, resolveEntry: (hash) => (hash === keyHash ? "local" : null), log });
  server.listen(port, "127.0.0.1", () => {
    log.info("local arena listening (paper trading: simulated fills, no funds at risk)", {
      url: `http://127.0.0.1:${port}`,
      network,
      instruments,
    });
    if (process.env.ARENA_API_KEY === undefined) process.stdout.write(`\nARENA_API_KEY=${key}\n\n`);
  });

  const clock = setInterval(() => void runtime.clock().catch((error: Error) => fatal(log, error)), 1_000);
  const shutdown = () => {
    clearInterval(clock);
    feed.stop();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => fatal(log, error));
