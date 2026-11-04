import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client and admin settings, for route handlers only.
 *
 * `server-only` makes importing this from a client component a build error, which is the
 * point: the service key bypasses RLS and is the only role that may call
 * `approve_agent` / `reject_agent` (migration 20261104000200).
 *
 * Read per call rather than at module scope, so `next build` without these variables
 * still succeeds and an unconfigured deployment answers 503 instead of crashing.
 */
export type AdminConfig = {
  supabase: SupabaseClient;
  adminWallets: Set<string>;
  /** Still required by the existing RPC bodies, which check `p_code`. Server-side only. */
  vettingCode: string;
};

export function adminConfig(): AdminConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const vettingCode = process.env.ADMIN_VETTING_CODE ?? "";
  const adminWallets = new Set(
    (process.env.ADMIN_WALLETS ?? "")
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter((a) => /^0x[0-9a-f]{40}$/.test(a))
  );

  if (!url || !serviceKey || !vettingCode || adminWallets.size === 0) return null;

  return {
    supabase: createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
    adminWallets,
    vettingCode,
  };
}
