import { randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { requireWrite } from "../shared/db.ts";
import { hashApiKey } from "./api.ts";
import { SEASON_0 } from "./rules.ts";
import { rulesHash } from "./season.ts";

/**
 * Running a season from the operator's side: create the row, move it through its
 * statuses, issue and revoke entry keys. `admin-cli.ts` is the command line over this.
 *
 * Every write goes through the service role, which only operators and the Arena process
 * hold. Season 0's closed beta (plans §8 week 3) is 5–10 builders, so issuing is an
 * operator action rather than a public form; self-serve registration is week 4.
 *
 * ## Keys
 *
 * A key is 32 random bytes, base64url, behind a fixed prefix so a leaked one is easy to
 * spot in a repo or a log. It is returned once, by `issueEntry` or `rotateKey`, and only
 * its SHA-256 is written. Losing it means rotating it, never recovering it.
 */

export const KEY_PREFIX = "acarena_";

export function newApiKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("base64url");
}

export const SEASON_STATUSES = ["draft", "open", "running", "scored", "closed"] as const;
export type SeasonStatus = (typeof SEASON_STATUSES)[number];

/** Forward only, one step at a time. A season that has run cannot be reopened. */
export function canMoveTo(from: SeasonStatus, to: SeasonStatus): boolean {
  return SEASON_STATUSES.indexOf(to) === SEASON_STATUSES.indexOf(from) + 1;
}

export type SeasonInput = {
  slug: string;
  name: string;
  number: number;
  startsAt: string;
  endsAt: string;
};

export type SeasonRecord = SeasonInput & { id: number; mode: string; status: SeasonStatus; rulesHash: string | null };

export type EntryRecord = {
  id: string;
  seasonId: number;
  builderWallet: string;
  displayName: string;
  status: "pending" | "active" | "disqualified" | "withdrawn";
  disqualifiedReason: string | null;
  keyIssuedAt: string | null;
};

/** The slice of the database this module writes. `SupabaseStore` in production. */
export type Store = {
  season(slug: string): Promise<SeasonRecord | null>;
  insertSeason(row: SeasonInput & { mode: "paper"; rulesHash: string; scoringNotes: string }): Promise<SeasonRecord>;
  setSeasonStatus(id: number, status: SeasonStatus): Promise<void>;
  entries(seasonId: number): Promise<EntryRecord[]>;
  insertEntry(row: { seasonId: number; builderWallet: string; displayName: string; apiKeyHash: string; keyIssuedAt: string }): Promise<EntryRecord>;
  updateEntry(id: string, patch: { apiKeyHash?: string; keyIssuedAt?: string; status?: EntryRecord["status"]; disqualifiedReason?: string }): Promise<void>;
};

export class AdminError extends Error {}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Wallets compare lowercase, so one builder is one wallet however they typed it. */
export function normaliseWallet(wallet: string): string {
  const trimmed = wallet.trim();
  if (!EVM_ADDRESS.test(trimmed)) throw new AdminError(`${wallet} is not a 0x address`);
  return trimmed.toLowerCase();
}

/** The text stored with the season, so its rules can be read without the code. */
export function scoringNotes(hash: string): string {
  const r = SEASON_0;
  return [
    `rules sha256 ${hash}`,
    `score S = R - lambda*MDD, lambda = ${Number(r.drawdownWeightBps) / 10_000}, net of fees, marked every minute`,
    `cap ${r.positionCapBps} bps of equity (${r.capMode}), auto-pause at ${r.maxDrawdownBps} bps drawdown`,
    `fees taker ${r.takerFeePpm} ppm, maker ${r.makerFeePpm} ppm, execution ${r.executionFeePpm} ppm, performance ${r.performanceFeeBps} bps`,
    `orders activate after ${r.activationDelayMs} ms, at most ${r.maxOpenOrders} open, each expiring after ${r.orderLifetimeMs} ms`,
    `prize eligibility: fills on ${r.minActiveDays} UTC days and presence in ${r.minPresenceBps} bps of minute marks`,
  ].join("\n");
}

export async function createSeason(store: Store, input: SeasonInput): Promise<SeasonRecord> {
  if (!/^[a-z0-9-]+$/.test(input.slug)) throw new AdminError("slug must be lowercase letters, digits and dashes");
  const starts = Date.parse(input.startsAt);
  const ends = Date.parse(input.endsAt);
  if (Number.isNaN(starts) || Number.isNaN(ends)) throw new AdminError("starts and ends must be ISO timestamps");
  if (ends <= starts) throw new AdminError("a season must end after it starts");
  if (await store.season(input.slug)) throw new AdminError(`season ${input.slug} already exists`);

  const hash = rulesHash(SEASON_0);
  return store.insertSeason({
    ...input,
    startsAt: new Date(starts).toISOString(),
    endsAt: new Date(ends).toISOString(),
    mode: "paper",
    rulesHash: hash,
    scoringNotes: scoringNotes(hash),
  });
}

async function requireSeason(store: Store, slug: string): Promise<SeasonRecord> {
  const season = await store.season(slug);
  if (!season) throw new AdminError(`season ${slug} does not exist`);
  return season;
}

export async function moveSeason(store: Store, slug: string, to: SeasonStatus): Promise<SeasonRecord> {
  const season = await requireSeason(store, slug);
  if (!canMoveTo(season.status, to)) throw new AdminError(`season ${slug} is ${season.status}; it can only move to the next status`);
  if (to === "open" && season.rulesHash !== rulesHash(SEASON_0)) {
    throw new AdminError(`season ${slug} was created under different rules; it cannot open under these`);
  }
  await store.setSeasonStatus(season.id, to);
  return { ...season, status: to };
}

/** Keys can be issued while a season is in draft (for house baselines) or open or running. */
function issuable(season: SeasonRecord): void {
  if (season.status === "scored" || season.status === "closed") throw new AdminError(`season ${season.slug} is ${season.status}`);
}

export async function issueEntry(
  store: Store,
  slug: string,
  wallet: string,
  displayName: string,
  now: () => Date = () => new Date()
): Promise<{ entry: EntryRecord; apiKey: string }> {
  const season = await requireSeason(store, slug);
  issuable(season);
  const name = displayName.trim();
  if (name.length < 2 || name.length > 40) throw new AdminError("display name must be 2 to 40 characters");
  const builderWallet = normaliseWallet(wallet);
  const existing = await store.entries(season.id);
  if (existing.some((e) => e.builderWallet === builderWallet && e.displayName === name)) {
    throw new AdminError(`${name} is already entered by ${builderWallet}; rotate its key instead`);
  }

  const apiKey = newApiKey();
  const entry = await store.insertEntry({
    seasonId: season.id,
    builderWallet,
    displayName: name,
    apiKeyHash: hashApiKey(apiKey),
    keyIssuedAt: now().toISOString(),
  });
  return { entry, apiKey };
}

async function requireEntry(store: Store, slug: string, entryId: string): Promise<{ season: SeasonRecord; entry: EntryRecord }> {
  const season = await requireSeason(store, slug);
  const entry = (await store.entries(season.id)).find((e) => e.id === entryId);
  if (!entry) throw new AdminError(`entry ${entryId} is not in season ${slug}`);
  return { season, entry };
}

/** A new key; the old one stops working at the Arena's next entry reload (one minute). */
export async function rotateKey(store: Store, slug: string, entryId: string, now: () => Date = () => new Date()): Promise<string> {
  const { season, entry } = await requireEntry(store, slug, entryId);
  issuable(season);
  if (entry.status !== "active") throw new AdminError(`entry ${entryId} is ${entry.status}`);
  const apiKey = newApiKey();
  await store.updateEntry(entryId, { apiKeyHash: hashApiKey(apiKey), keyIssuedAt: now().toISOString() });
  return apiKey;
}

/** Out of the season and the leaderboard. Its log history stays: the season is the log. */
export async function disqualify(store: Store, slug: string, entryId: string, reason: string): Promise<void> {
  const { entry } = await requireEntry(store, slug, entryId);
  if (reason.trim() === "") throw new AdminError("a disqualification needs a reason; it is published");
  if (entry.status === "disqualified") throw new AdminError(`entry ${entryId} is already disqualified`);
  await store.updateEntry(entryId, { status: "disqualified", disqualifiedReason: reason.trim() });
}

// ───────────────────────────────────────────────────────── Supabase

type SeasonRow = {
  id: number;
  slug: string;
  name: string;
  number: number;
  mode: string;
  starts_at: string;
  ends_at: string;
  status: SeasonStatus;
  rules_hash: string | null;
};

type EntryRow = {
  id: string;
  season_id: number;
  builder_wallet: string;
  display_name: string;
  status: EntryRecord["status"];
  disqualified_reason: string | null;
  key_issued_at: string | null;
};

const SEASON_COLUMNS = "id, slug, name, number, mode, starts_at, ends_at, status, rules_hash";
const ENTRY_COLUMNS = "id, season_id, builder_wallet, display_name, status, disqualified_reason, key_issued_at";

function season(row: SeasonRow): SeasonRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    number: row.number,
    mode: row.mode,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    rulesHash: row.rules_hash,
  };
}

function entry(row: EntryRow): EntryRecord {
  return {
    id: row.id,
    seasonId: row.season_id,
    builderWallet: row.builder_wallet,
    displayName: row.display_name,
    status: row.status,
    disqualifiedReason: row.disqualified_reason,
    keyIssuedAt: row.key_issued_at,
  };
}

export class SupabaseStore implements Store {
  readonly #db: SupabaseClient;

  constructor(db: SupabaseClient) {
    this.#db = db;
  }

  async season(slug: string): Promise<SeasonRecord | null> {
    const { data, error } = await this.#db.from("seasons").select(SEASON_COLUMNS).eq("slug", slug).maybeSingle();
    if (error) throw new Error(`loading season ${slug}: ${error.message}`);
    return data ? season(data as SeasonRow) : null;
  }

  async insertSeason(row: SeasonInput & { mode: "paper"; rulesHash: string; scoringNotes: string }): Promise<SeasonRecord> {
    const result = await this.#db
      .from("seasons")
      .insert(
        {
          slug: row.slug,
          name: row.name,
          number: row.number,
          mode: row.mode,
          starts_at: row.startsAt,
          ends_at: row.endsAt,
          rules_hash: row.rulesHash,
          scoring_notes: row.scoringNotes,
        },
        { count: "exact" }
      )
      .select(SEASON_COLUMNS)
      .single();
    requireWrite("season insert", result, 1);
    return season(result.data as SeasonRow);
  }

  async setSeasonStatus(id: number, status: SeasonStatus): Promise<void> {
    requireWrite("season status", await this.#db.from("seasons").update({ status }, { count: "exact" }).eq("id", id), 1);
  }

  async entries(seasonId: number): Promise<EntryRecord[]> {
    const { data, error } = await this.#db.from("entries").select(ENTRY_COLUMNS).eq("season_id", seasonId).order("created_at");
    if (error) throw new Error(`loading entries: ${error.message}`);
    return (data as EntryRow[]).map(entry);
  }

  async insertEntry(row: { seasonId: number; builderWallet: string; displayName: string; apiKeyHash: string; keyIssuedAt: string }): Promise<EntryRecord> {
    const result = await this.#db
      .from("entries")
      .insert(
        {
          season_id: row.seasonId,
          builder_wallet: row.builderWallet,
          display_name: row.displayName,
          api_key_hash: row.apiKeyHash,
          key_issued_at: row.keyIssuedAt,
          status: "active",
        },
        { count: "exact" }
      )
      .select(ENTRY_COLUMNS)
      .single();
    requireWrite("entry insert", result, 1);
    return entry(result.data as EntryRow);
  }

  async updateEntry(id: string, patch: { apiKeyHash?: string; keyIssuedAt?: string; status?: EntryRecord["status"]; disqualifiedReason?: string }): Promise<void> {
    const row: Record<string, string> = {};
    if (patch.apiKeyHash !== undefined) row.api_key_hash = patch.apiKeyHash;
    if (patch.keyIssuedAt !== undefined) row.key_issued_at = patch.keyIssuedAt;
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.disqualifiedReason !== undefined) row.disqualified_reason = patch.disqualifiedReason;
    requireWrite("entry update", await this.#db.from("entries").update(row, { count: "exact" }).eq("id", id), 1);
  }
}
