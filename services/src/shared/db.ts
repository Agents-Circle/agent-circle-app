import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { CoreConfig } from "./env.ts";

/**
 * The database handle, holding the service-role key.
 *
 * Every table these services write has RLS enabled and **no** insert or update policy, so
 * the anon key writes nothing and reports success while doing it — an `UPDATE` that
 * matches no rows is not an error in Postgres. That is RLS failing closed correctly, and
 * it is also why the wrong key here produces a service that looks healthy and stores
 * nothing. Hence `requireRowsAffected` below.
 */
export function database(config: CoreConfig): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Assert that a write actually landed.
 *
 * Supabase returns `{ error: null, count }` for a write that matched nothing. Treating
 * that as success is how a misconfigured key becomes a silently empty leaderboard, so
 * every write path in these services goes through this.
 */
export function requireWrite(
  what: string,
  result: { error: { message: string } | null; count?: number | null },
  expected?: number
): void {
  if (result.error) throw new Error(`${what} failed: ${result.error.message}`);
  if (expected !== undefined && (result.count ?? 0) < expected) {
    throw new Error(
      `${what} affected ${result.count ?? 0} rows, expected at least ${expected}. ` +
        "The usual cause is the anon key where the service-role key belongs."
    );
  }
}
