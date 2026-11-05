import "server-only";

import { createHash, randomBytes } from "node:crypto";

/**
 * Arena API key generation and hashing.
 *
 * **This is a second copy.** `services/src/arena/admin.ts` (`KEY_PREFIX`, `newApiKey`)
 * and `services/src/arena/api.ts` (`hashApiKey`) hold the originals, and the Arena API
 * authenticates by looking up `sha256(key)` in `entries.api_key_hash`. If the two copies
 * ever disagree, keys issued by this route silently fail to authenticate — the worst
 * shape of bug, because it looks like the entrant's fault.
 *
 * They are copied rather than imported because `services/` is a separate package with its
 * own TypeScript settings (native type stripping, `.ts` import specifiers), and pulling it
 * into the Next build is a bigger risk than duplicating eight lines.
 *
 * `KEY_VECTOR` in `arenaEntry.test.ts` and in `services/src/arena/admin.test.ts` pins the
 * same key to the same hash on both sides, so drift fails a test instead of a season.
 */

export const KEY_PREFIX = "acarena_";

export function newApiKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("base64url");
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}
