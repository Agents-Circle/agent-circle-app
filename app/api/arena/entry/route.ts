import { recoverMessageAddress } from "viem";

import {
  ENTRY_CLOCK_SKEW_MS,
  ENTRY_SIGNATURE_MAX_AGE_MS,
  MAX_ENTRIES_PER_BUILDER,
  SEASON_SLUG,
  displayNameError,
  entryMessage,
  normaliseWallet,
} from "@/lib/arenaEntry";
import { hashApiKey, newApiKey } from "@/lib/arenaKey";
import { adminConfig } from "@/lib/supabaseAdmin";

/**
 * Issue an Arena entry and its API key to the wallet that signed for it.
 *
 * This is the one surface that made the Arena unusable without an operator: `issueEntry`
 * has existed since the engine landed, but only `admin-cli.ts` called it, so every
 * entrant needed someone at a terminal. A season with real entrants cannot work that way.
 *
 * The key is returned **once** and only its SHA-256 is stored, so a lost key is rotated,
 * never recovered. That is `admin.ts`'s rule and this route keeps it.
 *
 * EOA signatures only: `recoverMessageAddress` cannot verify an ERC-1271 (Safe)
 * signature, the same limitation the admin vetting route carries. A builder entering from
 * a Safe needs an on-chain `isValidSignature` check added here.
 */

const SIGNATURE = /^0x[0-9a-f]+$/i;

function fail(status: number, error: string) {
  return Response.json({ error }, { status });
}

export async function POST(request: Request) {
  const config = adminConfig();
  // Entry writes `entries.api_key_hash`, which only service_role may do. An unconfigured
  // deployment says so rather than failing in a way that looks like a bad signature.
  if (!config) return fail(503, "Arena entry is not configured on this deployment.");

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return fail(400, "Expected a JSON body.");
  }

  const { seasonSlug, displayName, issuedAt, signature } = body;
  if (typeof seasonSlug !== "string" || !SEASON_SLUG.test(seasonSlug)) return fail(400, "Bad season.");
  if (typeof displayName !== "string") return fail(400, "Missing display name.");
  const nameError = displayNameError(displayName);
  if (nameError) return fail(400, nameError);
  if (typeof issuedAt !== "string") return fail(400, "Missing issuedAt.");
  if (typeof signature !== "string" || !SIGNATURE.test(signature)) return fail(400, "Missing signature.");

  const issued = Date.parse(issuedAt);
  const age = Date.now() - issued;
  if (Number.isNaN(issued) || age > ENTRY_SIGNATURE_MAX_AGE_MS || age < -ENTRY_CLOCK_SKEW_MS) {
    return fail(401, "Signature expired. Sign again.");
  }

  let signer: string;
  try {
    signer = await recoverMessageAddress({
      // Rebuilt from the validated fields, never taken from the client.
      message: entryMessage(seasonSlug, displayName, issuedAt),
      signature: signature as `0x${string}`,
    });
  } catch {
    return fail(401, "Signature could not be verified.");
  }
  const wallet = normaliseWallet(signer);

  const season = await config.supabase
    .from("seasons")
    .select("id, slug, status")
    .eq("slug", seasonSlug)
    .maybeSingle();
  if (season.error) return fail(502, season.error.message);
  if (!season.data) return fail(404, "No such season.");

  // Stricter than `admin.ts`, which also allows `draft`. A draft season is not public, so
  // a self-serve entry into one would be an entry nobody announced.
  if (season.data.status !== "open" && season.data.status !== "running") {
    return fail(409, `Season ${seasonSlug} is ${season.data.status}, so it is not taking entries.`);
  }

  const mine = await config.supabase
    .from("entries")
    .select("id, display_name")
    .eq("season_id", season.data.id)
    .eq("builder_wallet", wallet);
  if (mine.error) return fail(502, mine.error.message);

  if (mine.data.some((e) => e.display_name === displayName)) {
    return fail(409, `You already entered "${displayName}" in this season. Rotate its key instead.`);
  }
  if (mine.data.length >= MAX_ENTRIES_PER_BUILDER) {
    return fail(409, `One wallet may hold ${MAX_ENTRIES_PER_BUILDER} entries per season.`);
  }

  const apiKey = newApiKey();
  const inserted = await config.supabase
    .from("entries")
    .insert({
      season_id: season.data.id,
      builder_wallet: wallet,
      display_name: displayName,
      api_key_hash: hashApiKey(apiKey),
      key_issued_at: new Date().toISOString(),
      status: "active",
    })
    .select("id")
    .single();

  if (inserted.error) {
    // The unique (season, wallet, name) constraint is the backstop for two requests
    // racing past the check above. 23505 is unique_violation.
    if (inserted.error.code === "23505") {
      return fail(409, `You already entered "${displayName}" in this season.`);
    }
    return fail(502, inserted.error.message);
  }

  return Response.json({
    entryId: inserted.data.id,
    displayName,
    wallet,
    // Shown once. Only the hash is stored, so this response is the only copy.
    apiKey,
  });
}
