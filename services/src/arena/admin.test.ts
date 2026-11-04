import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AdminError,
  canMoveTo,
  createSeason,
  disqualify,
  type EntryRecord,
  issueEntry,
  KEY_PREFIX,
  moveSeason,
  rotateKey,
  type SeasonRecord,
  type Store,
} from "./admin.ts";
import { hashApiKey } from "./api.ts";
import { SEASON_0 } from "./rules.ts";
import { rulesHash } from "./season.ts";

/** What the database would hold, including the hashes the real store never returns. */
class MemoryStore implements Store {
  seasons: (SeasonRecord & { scoringNotes: string })[] = [];
  rows: (EntryRecord & { apiKeyHash: string })[] = [];

  async season(slug: string) {
    return this.seasons.find((s) => s.slug === slug) ?? null;
  }
  async insertSeason(row: Parameters<Store["insertSeason"]>[0]) {
    const record = { ...row, id: this.seasons.length + 1, status: "draft" as const };
    this.seasons.push(record);
    return record;
  }
  async setSeasonStatus(id: number, status: SeasonRecord["status"]) {
    this.seasons.find((s) => s.id === id)!.status = status;
  }
  async entries(seasonId: number) {
    return this.rows.filter((e) => e.seasonId === seasonId);
  }
  async insertEntry(row: Parameters<Store["insertEntry"]>[0]) {
    const record = { ...row, id: `e${this.rows.length + 1}`, status: "active" as const, disqualifiedReason: null };
    this.rows.push(record);
    return record;
  }
  async updateEntry(id: string, patch: Parameters<Store["updateEntry"]>[1]) {
    Object.assign(this.rows.find((e) => e.id === id)!, patch);
  }
}

const SEASON = { slug: "season-0", name: "Season 0", number: 0, startsAt: "2026-11-11T00:00:00Z", endsAt: "2026-12-09T00:00:00Z" };
const WALLET = "0x00000000000000000000000000000000000000Ab";

test("a season is created as a paper draft carrying the hash of the rules the engine runs", async () => {
  const store = new MemoryStore();
  const season = await createSeason(store, SEASON);
  assert.equal(season.status, "draft");
  assert.equal(season.mode, "paper");
  assert.equal(season.rulesHash, rulesHash(SEASON_0));
  assert.match(store.seasons[0]!.scoringNotes, new RegExp(`rules sha256 ${rulesHash(SEASON_0)}`));
  await assert.rejects(createSeason(store, SEASON), /already exists/);
  await assert.rejects(createSeason(new MemoryStore(), { ...SEASON, endsAt: SEASON.startsAt }), /end after it starts/);
  await assert.rejects(createSeason(new MemoryStore(), { ...SEASON, slug: "Season 0" }), /slug/);
});

test("statuses move forward one step at a time, and a season under other rules cannot open", async () => {
  assert.equal(canMoveTo("draft", "open"), true);
  assert.equal(canMoveTo("draft", "running"), false);
  assert.equal(canMoveTo("running", "open"), false);

  const store = new MemoryStore();
  await createSeason(store, SEASON);
  await assert.rejects(moveSeason(store, "season-0", "running"), /only move to the next status/);
  store.seasons[0]!.rulesHash = "0".repeat(64);
  await assert.rejects(moveSeason(store, "season-0", "open"), /different rules/);
  store.seasons[0]!.rulesHash = rulesHash(SEASON_0);
  assert.equal((await moveSeason(store, "season-0", "open")).status, "open");
});

test("an issued key is returned once and only its hash is stored", async () => {
  const store = new MemoryStore();
  await createSeason(store, SEASON);
  const { entry, apiKey } = await issueEntry(store, "season-0", WALLET, "  Momentum bot ");

  assert.ok(apiKey.startsWith(KEY_PREFIX));
  assert.equal(apiKey.length, KEY_PREFIX.length + 43);
  assert.equal(entry.builderWallet, WALLET.toLowerCase());
  assert.equal(entry.displayName, "Momentum bot");
  assert.equal(store.rows[0]!.apiKeyHash, hashApiKey(apiKey));
  assert.equal(JSON.stringify(store.rows).includes(apiKey), false);
  assert.notEqual((await issueEntry(store, "season-0", WALLET, "Other bot")).apiKey, apiKey);
});

test("the same agent cannot be entered twice, however the wallet is cased", async () => {
  const store = new MemoryStore();
  await createSeason(store, SEASON);
  await issueEntry(store, "season-0", WALLET, "Bot");
  await assert.rejects(issueEntry(store, "season-0", WALLET.toUpperCase().replace("0X", "0x"), "Bot"), /already entered/);
  await assert.rejects(issueEntry(store, "season-0", "not-a-wallet", "Bot 2"), /not a 0x address/);
  await assert.rejects(issueEntry(store, "season-0", WALLET, "x"), /2 to 40/);
  await assert.rejects(issueEntry(store, "nope", WALLET, "Bot"), /does not exist/);
});

test("rotation replaces the hash; a disqualified entry cannot rotate and needs a reason", async () => {
  const store = new MemoryStore();
  await createSeason(store, SEASON);
  const { entry, apiKey } = await issueEntry(store, "season-0", WALLET, "Bot");

  const fresh = await rotateKey(store, "season-0", entry.id);
  assert.notEqual(fresh, apiKey);
  assert.equal(store.rows[0]!.apiKeyHash, hashApiKey(fresh));

  await assert.rejects(disqualify(store, "season-0", entry.id, "  "), /needs a reason/);
  await disqualify(store, "season-0", entry.id, "self-reported fills");
  assert.equal(store.rows[0]!.status, "disqualified");
  assert.equal(store.rows[0]!.disqualifiedReason, "self-reported fills");
  await assert.rejects(rotateKey(store, "season-0", entry.id), /is disqualified/);
  await assert.rejects(disqualify(store, "season-0", entry.id, "again"), /already disqualified/);
});

test("no keys are issued once a season has been scored", async () => {
  const store = new MemoryStore();
  await createSeason(store, SEASON);
  store.seasons[0]!.status = "scored";
  await assert.rejects(issueEntry(store, "season-0", WALLET, "Bot"), /is scored/);
  assert.ok(new AdminError("x") instanceof Error);
});
