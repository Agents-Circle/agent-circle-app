import { fatal, logger } from "../shared/log.ts";
import { MarketFeed, WS_URL } from "./feed.ts";
import { Sequencer } from "./inputlog.ts";
import {
  chooseInstruments,
  compressDay,
  daySink,
  freezeManifest,
  type MetaAndAssetCtxs,
  RecorderStats,
  resumePoint,
  writeDayMeta,
} from "./recording.ts";

/**
 * The market-data recorder. See `recording.ts`.
 *
 *     NETWORK=mainnet npm run arena:record
 *
 * Public data only: no key, no database, nothing signed. It writes to
 * `ARENA_RECORD_DIR` (default `./arena-data/recorder/<network>`) and nothing else.
 */

const log = logger("arena-recorder");

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") throw new Error(`${name} is not set. See services/.env.example.`);
  return value;
}

async function snapshot(infoUrl: string): Promise<MetaAndAssetCtxs> {
  const response = await fetch(infoUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
  });
  if (!response.ok) throw new Error(`metaAndAssetCtxs ${response.status}`);
  return (await response.json()) as MetaAndAssetCtxs;
}

async function main(): Promise<void> {
  const network = env("NETWORK", "mainnet");
  if (network !== "mainnet" && network !== "testnet") throw new Error("NETWORK must be mainnet or testnet");
  const dir = env("ARENA_RECORD_DIR", `./arena-data/recorder/${network}`);
  const top = Number(env("ARENA_RECORD_TOP", "15"));
  if (!Number.isInteger(top) || top <= 0) throw new Error("ARENA_RECORD_TOP must be a positive integer");
  const explicit = (process.env.ARENA_RECORD_COINS ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  const infoUrl = env(
    "HYPERLIQUID_INFO_URL",
    network === "mainnet" ? "https://api.hyperliquid.xyz/info" : "https://api.hyperliquid-testnet.xyz/info"
  );

  const { manifest, created } = await freezeManifest(dir, async () => ({
    network,
    instruments: chooseInstruments(await snapshot(infoUrl), top, explicit),
    chosenAtMs: Date.now(),
    rankedBy: explicit.length > 0 ? "ARENA_RECORD_COINS" : `open interest notional, top ${top}`,
  }));
  if (manifest.network !== network) throw new Error(`${dir} was recorded on ${manifest.network}, not ${network}`);
  const coins = manifest.instruments.map((i) => i.coin);
  log.info(created ? "coins chosen and frozen" : "coins read from manifest", { dir, coins });

  const { resumeAfterMs, stale } = await resumePoint(dir);
  for (const path of stale) {
    log.warn("compressing a day a previous run left plain", { path });
    await compressDay(path);
  }

  const daySnapshot = (day: string) =>
    snapshot(infoUrl)
      .then((s) => writeDayMeta(dir, day, s, log))
      .catch((error: Error) => log.warn("day meta snapshot failed", { day, error: error.message }));

  const stats = new RecorderStats();
  const sequencer = new Sequencer({
    sink: daySink(dir, (day, closed) => {
      log.info("day opened", { day });
      void daySnapshot(day);
      if (closed) {
        compressDay(closed)
          .then((archive) => log.info("day archived", { archive }))
          .catch((error: Error) => log.error("day archive failed; plain file kept", { path: closed, error: error.message }));
      }
    }),
    apply: (event) => stats.count(event),
    ...(resumeAfterMs === null ? {} : { resumeAfterMs }),
  });
  log.info("resuming", { resumeAfterMs });

  const feed = new MarketFeed({
    url: WS_URL[network],
    coins,
    accept: (build) => sequencer.accept(build).catch((error: Error) => fatal(log, error)),
    log,
  });
  feed.start();

  // A silent feed is the failure this exists to catch, so it says so loudly. systemd
  // restarts the process if it ever exits; it does not notice a socket that went quiet.
  const SILENCE_MS = 120_000;
  const heartbeat = setInterval(() => {
    const { counts, silentMs } = stats.drain(Date.now());
    if (silentMs !== null && silentMs > SILENCE_MS) {
      log.error("no market data; restarting the feed", { silentMs });
      feed.stop();
      feed.start();
    } else {
      log.info("recording", { counts, silentMs });
    }
  }, 60_000);

  const shutdown = () => {
    log.info("shutting down");
    clearInterval(heartbeat);
    feed.stop();
    // Let queued appends land; the sequencer serialises them.
    void sequencer.accept((atMs) => ({ kind: "clock", atMs })).finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => fatal(log, error));
