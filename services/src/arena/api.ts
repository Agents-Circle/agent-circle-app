import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { Logger } from "../shared/log.ts";
import { PRICE_DECIMALS, SIZE_DECIMALS, parseDecimal } from "../shared/units.ts";
import type { OutputEvent } from "./engine.ts";
import type { Order } from "./risk.ts";
import { TIF } from "./rules.ts";
import type { ArenaRuntime } from "./runtime.ts";

/**
 * The order API agents trade Season 0 through.
 *
 * Shaped like the vault, not like Hyperliquid's exchange endpoint: an order is the seven
 * fields `HLAgentVault.placeOrder` takes, a cancel is by cloid, and the answer is the
 * engine's verdict. An agent that trades here is rehearsing the call it will make on a
 * real vault.
 *
 *     POST   /v1/orders          { asset, isBuy, limitPx, sz, reduceOnly?, tif, cloid }
 *     DELETE /v1/orders/:cloid
 *     GET    /v1/account
 *     GET    /v1/health          (no key)
 *
 * Prices and sizes are decimal strings ("65000.5", "0.01"), never JSON numbers, because a
 * float cannot carry them exactly. `cloid` is `0x`-hex or decimal, non-zero, below 2^128.
 *
 * ## Keys
 *
 * `Authorization: Bearer <key>`. Only the SHA-256 of a key is ever stored
 * (`entries.api_key_hash`), so a leaked database is not a leaked set of keys. Lookups go
 * through `resolveEntry`, which the caller backs with the `entries` table.
 */

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export type EntryResolver = (apiKeyHash: string) => Promise<string | null> | string | null;

const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_BODY_BYTES = 4_096;

export class BadRequest extends Error {}

export function parseCloid(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0x[0-9a-fA-F]{1,32}|[0-9]{1,39})$/.test(value)) {
    throw new BadRequest("cloid must be a 0x-hex or decimal string");
  }
  const cloid = BigInt(value);
  if (cloid === 0n || cloid > MAX_UINT128) throw new BadRequest("cloid must be non-zero and below 2^128");
  return cloid;
}

function decimal(value: unknown, name: string, decimals: number): bigint {
  if (typeof value !== "string" || !/^[0-9]+(\.[0-9]+)?$/.test(value)) {
    throw new BadRequest(`${name} must be a positive decimal string`);
  }
  // `parseDecimal` truncates past its precision, which is right for the info API and
  // wrong for an agent's order: silently changing a price is worse than refusing it.
  if ((value.split(".")[1] ?? "").length > decimals) {
    throw new BadRequest(`${name} has more than ${decimals} decimal places`);
  }
  let parsed: bigint;
  try {
    parsed = parseDecimal(value, decimals);
  } catch (error) {
    throw new BadRequest(`${name}: ${(error as Error).message}`);
  }
  if (parsed <= 0n) throw new BadRequest(`${name} must be greater than zero`);
  return parsed;
}

export function parseOrder(body: unknown): Order {
  if (body === null || typeof body !== "object") throw new BadRequest("body must be a JSON object");
  const b = body as Record<string, unknown>;
  if (typeof b.asset !== "number" || !Number.isInteger(b.asset) || b.asset < 0) {
    throw new BadRequest("asset must be a non-negative integer");
  }
  if (typeof b.isBuy !== "boolean") throw new BadRequest("isBuy must be a boolean");
  if (b.reduceOnly !== undefined && typeof b.reduceOnly !== "boolean") {
    throw new BadRequest("reduceOnly must be a boolean");
  }
  if (typeof b.tif !== "string" || !(b.tif in TIF)) throw new BadRequest("tif must be one of alo, gtc, ioc");
  return {
    asset: b.asset,
    isBuy: b.isBuy,
    limitPx: decimal(b.limitPx, "limitPx", PRICE_DECIMALS),
    sz: decimal(b.sz, "sz", SIZE_DECIMALS),
    reduceOnly: b.reduceOnly ?? false,
    tif: TIF[b.tif as keyof typeof TIF],
    cloid: parseCloid(b.cloid),
  };
}

/** JSON with bigints as decimal strings. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
}

/** A fixed number of requests per window per entry. Refused requests never reach the log. */
export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #hits = new Map<string, number[]>();

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  allow(key: string): boolean {
    const now = this.#now();
    const recent = (this.#hits.get(key) ?? []).filter((t) => now - t < this.#windowMs);
    if (recent.length >= this.#limit) {
      this.#hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.#hits.set(key, recent);
    return true;
  }
}

export type ApiOptions = {
  runtime: ArenaRuntime;
  resolveEntry: EntryResolver;
  log: Logger;
  limiter?: RateLimiter;
};

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BadRequest("body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BadRequest("body is not valid JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(toJson(body));
}

/** The verdict for one cloid out of everything the event produced. */
function verdict(outputs: readonly OutputEvent[], cloid: bigint) {
  const mine = outputs.filter((e) => "cloid" in e && e.cloid === cloid);
  const rejected = mine.find((e) => e.kind === "rejected");
  return { status: rejected ? 422 : 200, events: mine };
}

export function arenaApi(options: ApiOptions): Server {
  const { runtime, resolveEntry, log } = options;
  const limiter = options.limiter ?? new RateLimiter(20, 10_000);

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://arena.local");

      if (req.method === "GET" && url.pathname === "/v1/health") {
        return send(res, 200, { ok: true, nowMs: runtime.engine.nowMs });
      }

      const header = req.headers.authorization ?? "";
      const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      const entryId = key === "" ? null : await resolveEntry(hashApiKey(key));
      if (entryId === null) return send(res, 401, { error: "missing or unknown API key" });
      if (!limiter.allow(entryId)) return send(res, 429, { error: "rate limited" });

      // An active entry the engine has not seen yet joins on its first authenticated call.
      await runtime.register(entryId);

      if (req.method === "POST" && url.pathname === "/v1/orders") {
        const order = parseOrder(await readBody(req));
        const { status, events } = verdict(await runtime.submit(entryId, order), order.cloid);
        return send(res, status, { events });
      }

      const cancel = /^\/v1\/orders\/([^/]+)$/.exec(url.pathname);
      if (req.method === "DELETE" && cancel) {
        const cloid = parseCloid(decodeURIComponent(cancel[1] ?? ""));
        const { status, events } = verdict(await runtime.cancel(entryId, cloid), cloid);
        return send(res, status, { events });
      }

      if (req.method === "GET" && url.pathname === "/v1/account") {
        return send(res, 200, runtime.engine.snapshot(entryId));
      }

      return send(res, 404, { error: "not found" });
    } catch (error) {
      if (error instanceof BadRequest) return send(res, 400, { error: error.message });
      log.error("arena api error", { error: (error as Error).message });
      return send(res, 500, { error: "internal error" });
    }
  });
}
