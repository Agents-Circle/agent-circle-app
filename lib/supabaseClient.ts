import { createClient } from "@supabase/supabase-js";

/**
 * Supabase client, and deliberately not a module-level throw.
 *
 * This used to `throw` on import when the env vars were missing, which made
 * `next build` fail outright: every page that reaches `lib/agents.ts` imports this, and
 * Next evaluates those modules while collecting page data. The result was a build that
 * could not run in CI, or anywhere else without production credentials — a runtime
 * concern deciding whether the app compiles.
 *
 * `isSupabaseConfigured` is the single place that question is answered. Callers branch on
 * it rather than string-matching the URL themselves, which is how `lib/agents.ts` used to
 * decide and is the kind of check that drifts the moment a second caller appears.
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

/** The sentinel `.env.example` and CI use to mean "no backend here". */
const PLACEHOLDER_HOST = "placeholder.supabase.co";

export const isSupabaseConfigured =
  url.length > 0 && anonKey.length > 0 && !url.includes(PLACEHOLDER_HOST);

/**
 * Always a real client object, so callers never have to null-check it.
 *
 * When nothing is configured it points at the placeholder host and every request fails.
 * That is intentional: a client that silently resolves to empty data would make a
 * misconfigured deployment look like an empty marketplace, and the leaderboard is
 * exactly where that would be most misleading.
 */
export const supabase = createClient(
  isSupabaseConfigured ? url : `https://${PLACEHOLDER_HOST}`,
  isSupabaseConfigured ? anonKey : "placeholder"
);
