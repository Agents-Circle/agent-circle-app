/**
 * Self-serve Arena entry: the request a builder signs, shared by the page that signs it
 * and the route that verifies it.
 *
 * Until now the only way to get an entry key was for an admin to run
 * `services/src/arena/admin-cli.ts`, so every entrant needed a human at a terminal. That
 * is fine for a closed test and impossible for a season with real entrants.
 *
 * The server never trusts a message string from the client. It rebuilds the message from
 * the validated fields and recovers the signer from that, so a signature authorises
 * exactly the season, name and time it names — the same rule as `lib/adminVetting.ts`.
 */

export type EntryRequest = {
  seasonSlug: string;
  displayName: string;
  /** ISO 8601, set by the signer. Bounds how long a captured signature stays usable. */
  issuedAt: string;
  signature: `0x${string}`;
};

/// How old a signature may be. A replay inside this window is harmless: it either hits the
/// per-builder cap or the unique (season, wallet, name) constraint, both of which refuse.
export const ENTRY_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

/// Allowance for the entrant's clock running ahead of the server's.
export const ENTRY_CLOCK_SKEW_MS = 60 * 1000;

/**
 * Entries one wallet may hold in one season.
 *
 * `plans/arena-season0.md` §1 says two, one designated for prizes. Nothing enforced it:
 * `admin.ts` only refuses a duplicate display name for the same wallet, so a builder
 * could hold as many entries as they could think of names for. Two lets someone run a
 * strategy and a variant; more turns the leaderboard into a search over seeds.
 */
export const MAX_ENTRIES_PER_BUILDER = 2;

export const DISPLAY_NAME_MIN = 2;
export const DISPLAY_NAME_MAX = 40;

/// Lowercase hex, as `entries.builder_wallet` stores it and `admin.ts` normalises it.
export function normaliseWallet(wallet: string): string {
  return wallet.trim().toLowerCase();
}

/**
 * A display name is shown on a public leaderboard, so it is deliberately narrow: letters,
 * digits, and single internal spaces, hyphens or underscores. No leading or trailing
 * separators, which is what stops two entries looking identical to a reader.
 */
export function displayNameError(name: string): string | null {
  if (name !== name.trim()) return "No leading or trailing spaces.";
  if (name.length < DISPLAY_NAME_MIN || name.length > DISPLAY_NAME_MAX) {
    return `Between ${DISPLAY_NAME_MIN} and ${DISPLAY_NAME_MAX} characters.`;
  }
  if (!/^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/.test(name)) {
    return "Letters, digits, and single spaces, hyphens or underscores between them.";
  }
  return null;
}

export const SEASON_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function entryMessage(seasonSlug: string, displayName: string, issuedAt: string): string {
  return [
    "Agent Circle Arena entry",
    `Season: ${seasonSlug}`,
    `Name: ${displayName}`,
    `Issued: ${issuedAt}`,
    "",
    "Signing this requests an API key for this season. It moves no funds.",
  ].join("\n");
}
