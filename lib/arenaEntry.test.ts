import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress } from "viem";

import {
  DISPLAY_NAME_MAX,
  ENTRY_CLOCK_SKEW_MS,
  ENTRY_SIGNATURE_MAX_AGE_MS,
  MAX_ENTRIES_PER_BUILDER,
  SEASON_SLUG,
  displayNameError,
  entryMessage,
  normaliseWallet,
} from "./arenaEntry.ts";

/**
 * The same key must hash the same on both sides of the package boundary.
 *
 * `lib/arenaKey.ts` and `services/src/arena/api.ts` each hash API keys, and the Arena API
 * authenticates by finding `sha256(key)` in `entries.api_key_hash`. If the two drift, a
 * key issued by the route fails to authenticate and it looks like the entrant's mistake.
 * `services/src/arena/admin.test.ts` asserts the same pair, so either side drifting fails
 * a test. Computed here with `node:crypto` directly rather than imported, because
 * `arenaKey.ts` is `server-only` and importing it would couple this test to the Next
 * runtime.
 */
const KEY_VECTOR = {
  key: "acarena_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  sha256: "2be3145f45b9e1f61d99da43c7d84a6e1e67c0aab3fb1444545cdeb459c49ef0",
} as const;

test("the API key hash is the same on both sides of the package boundary", () => {
  const computed = createHash("sha256").update(KEY_VECTOR.key, "utf8").digest("hex");
  assert.equal(
    computed.length,
    64,
    "a sha256 hex digest is 64 characters; entries.api_key_hash expects exactly that"
  );
  // Pins the algorithm and encoding. If `services/` ever changes either, its copy of this
  // vector fails and the mismatch is found before a key is issued against it.
  assert.equal(computed, KEY_VECTOR.sha256);
});

test("the message names the season, the name and the time, and nothing else", () => {
  const message = entryMessage("season-0", "Oracle Edge", "2026-11-05T12:00:00.000Z");
  assert.match(message, /^Agent Circle Arena entry\n/);
  assert.match(message, /\nSeason: season-0\n/);
  assert.match(message, /\nName: Oracle Edge\n/);
  assert.match(message, /\nIssued: 2026-11-05T12:00:00\.000Z\n/);
  // A signer should be able to read what they are agreeing to.
  assert.match(message, /moves no funds/);
});

test("a signature over one season does not authorise another", async () => {
  // A throwaway key, for a signature that authorises nothing on any chain.
  const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const issuedAt = "2026-11-05T12:00:00.000Z";
  const signature = await account.signMessage({
    message: entryMessage("season-0", "Oracle Edge", issuedAt),
  });

  // The route rebuilds the message from its own validated fields, so verifying against a
  // different season recovers a different address — not the signer.
  const asSigned = await recoverMessageAddress({
    message: entryMessage("season-0", "Oracle Edge", issuedAt),
    signature,
  });
  assert.equal(normaliseWallet(asSigned), normaliseWallet(account.address));

  const asOtherSeason = await recoverMessageAddress({
    message: entryMessage("season-1", "Oracle Edge", issuedAt),
    signature,
  });
  assert.notEqual(normaliseWallet(asOtherSeason), normaliseWallet(account.address));

  const asOtherName = await recoverMessageAddress({
    message: entryMessage("season-0", "Oracle Edgf", issuedAt),
    signature,
  });
  assert.notEqual(normaliseWallet(asOtherName), normaliseWallet(account.address));
});

test("display names are narrow enough to be readable on a leaderboard", () => {
  assert.equal(displayNameError("Oracle Edge"), null);
  assert.equal(displayNameError("mean-revert_v2"), null);
  assert.equal(displayNameError("a".repeat(DISPLAY_NAME_MAX)), null);

  for (const bad of [
    "x", // too short
    "a".repeat(DISPLAY_NAME_MAX + 1),
    " Oracle", // leading space
    "Oracle ", // trailing space
    "Oracle  Edge", // a double space reads as one on a page
    "-Oracle", // leading separator
    "Oracle-", // trailing separator
    "Oracle--Edge",
    "Oracle​Edge", // zero-width, which would let two entries look identical
    "Oracle\nEdge", // a newline would forge extra lines in the signed message
  ]) {
    assert.notEqual(displayNameError(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test("a newline in a name cannot forge a line of the signed message", () => {
  // Without the name rule, "x\nSeason: other" would make the message read as though it
  // named a different season. The validator refuses it before it is ever signed.
  assert.notEqual(displayNameError("x\nSeason: other-season"), null);
});

test("wallets are compared lowercased, as the column stores them", () => {
  assert.equal(normaliseWallet("0xAbCdEf0123456789012345678901234567890123"), "0xabcdef0123456789012345678901234567890123");
  assert.equal(normaliseWallet("  0xABC  "), "0xabc");
});

test("season slugs are restricted, so a slug cannot smuggle a newline either", () => {
  assert.ok(SEASON_SLUG.test("season-0"));
  assert.ok(SEASON_SLUG.test("s0"));
  for (const bad of ["Season-0", "season_0", "-season", "season-", "season--0", "season 0", "season\n0", ""]) {
    assert.ok(!SEASON_SLUG.test(bad), `should reject ${JSON.stringify(bad)}`);
  }
});

test("the replay window is short and the cap is the published one", () => {
  assert.equal(ENTRY_SIGNATURE_MAX_AGE_MS, 5 * 60 * 1000);
  assert.equal(ENTRY_CLOCK_SKEW_MS, 60 * 1000);
  // plans/arena-season0.md §1: two entries per builder, one designated for prizes.
  assert.equal(MAX_ENTRIES_PER_BUILDER, 2);
});
