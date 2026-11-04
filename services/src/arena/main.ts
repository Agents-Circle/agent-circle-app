import { database } from "../shared/db.ts";
import { InfoApi } from "../shared/hyperliquid.ts";
import { fatal, logger } from "../shared/log.ts";
import { arenaApi } from "./api.ts";
import { MarketFeed, WS_URL } from "./feed.ts";
import type { Instrument } from "./market.ts";
import { EntryDirectory, loadSeason, publishScores } from "./publish.ts";
import { SEASON_0 } from "./rules.ts";
import { ArenaRuntime } from "./runtime.ts";
import { freezeSeason, rulesHash, seasonFilePath } from "./season.ts";

/**
 * The Arena Season 0 process: feed in, orders in, scores out.
 *
 *     ARENA_SEASON_SLUG=season-0 ARENA_COINS=BTC,ETH,SOL npm run arena
 *
 * Paper only. It holds no key, signs nothing and moves no money; the only things it writes
 * are its input log and the `scores` table. Every input is logged before the engine sees
 * it, and every start replays the log first (see `runtime.ts`).
 */

const log = logger("arena");

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") throw new Error(`${name} is not set. See services/.env.example.`);
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const value = Number(env(name, String(fallback)));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

async function main(): Promise<void> {
  const network = env("NETWORK", "mainnet");
  if (network !== "mainnet" && network !== "testnet") throw new Error(`NETWORK must be mainnet or testnet`);
  const slug = env("ARENA_SEASON_SLUG");
  const coins = env("ARENA_COINS").split(",").map((c) => c.trim()).filter(Boolean);
  const logPath = env("ARENA_LOG_PATH", `./arena-data/${slug}.jsonl`);
  const port = positiveInt("ARENA_PORT", 8787);
  const publishMs = positiveInt("ARENA_PUBLISH_MS", 60_000);
  const infoUrl = env(
    "HYPERLIQUID_INFO_URL",
    network === "mainnet" ? "https://api.hyperliquid.xyz/info" : "https://api.hyperliquid-testnet.xyz/info"
  );

  const db = database({ supabaseUrl: env("SUPABASE_URL"), supabaseServiceKey: env("SUPABASE_SERVICE_ROLE_KEY") });
  const season = await loadSeason(db, slug);
  // The hash on the season page is the column; running anything else would score the
  // season under rules nobody published.
  if (season.rules_hash !== rulesHash(SEASON_0)) {
    throw new Error(`season ${slug} publishes rules ${season.rules_hash ?? "(none)"}, but this build runs ${rulesHash(SEASON_0)}`);
  }

  // Instruments come from the network once, at first start, and from the season file
  // after that. See `season.ts` for why the mapping must not be re-read.
  const meta = await new InfoApi(infoUrl, log).perpMeta();
  const instruments: Instrument[] = coins.map((coin) => {
    const asset = meta.universe.findIndex((u) => u.name === coin);
    if (asset < 0) throw new Error(`${coin} is not a perp on ${network}`);
    return { coin, asset, szDecimals: meta.universe[asset]!.szDecimals };
  });
  const frozen = await freezeSeason(seasonFilePath(logPath), {
    slug,
    startMs: Date.parse(season.starts_at),
    endMs: Date.parse(season.ends_at),
    instruments,
    rulesHash: rulesHash(SEASON_0),
  });

  const { runtime, replayed, repaired } = await ArenaRuntime.open({
    rules: SEASON_0,
    instruments: frozen.instruments,
    startMs: frozen.startMs,
    endMs: frozen.endMs,
    logPath,
  });
  log.info("season resumed from log", { slug, replayed, repaired, rulesHash: frozen.rulesHash });

  runtime.onOutput((event) => {
    if (event.kind === "auto_paused" || event.kind === "gap") log.warn(`engine: ${event.kind}`, { ...event });
  });

  const entries = new EntryDirectory(db, season.id);
  await entries.reload();
  log.info("entries loaded", { active: entries.size });

  const feed = new MarketFeed({
    url: WS_URL[network],
    coins: frozen.instruments.map((i) => i.coin),
    accept: (build) => runtime.market(build).catch((error: Error) => fatal(log, error)),
    log,
  });
  feed.start();

  const server = arenaApi({ runtime, resolveEntry: entries.resolve, log });
  server.listen(port, () => log.info("order API listening", { port }));

  // Timers fire on event time, so a quiet market still needs the clock to move.
  const clock = setInterval(() => void runtime.clock().catch((error: Error) => fatal(log, error)), 1_000);
  const reload = setInterval(() => void entries.reload().catch((e: Error) => log.warn("entry reload failed", { error: e.message })), 60_000);
  const publish = setInterval(
    () =>
      void publishScores(db, runtime.engine, SEASON_0)
        .then((n) => log.debug("scores published", { entries: n }))
        .catch((e: Error) => log.error("score publish failed", { error: e.message })),
    publishMs
  );

  const shutdown = () => {
    log.info("shutting down");
    clearInterval(clock);
    clearInterval(reload);
    clearInterval(publish);
    feed.stop();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => fatal(log, error));
