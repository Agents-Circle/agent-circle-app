import { supabase } from "./supabaseClient";
import { removeStorageItem, writeStorageItem } from "@/hooks/useStorageItem";

export const SIWS_STORAGE_KEY = "ac-siws-session";
const STORAGE_KEY = SIWS_STORAGE_KEY;

export type SiwsSession = { token: string; wallet: string };

export function getStoredSession(wallet?: string | null): SiwsSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as SiwsSession;
    if (wallet && session.wallet !== wallet) return null;
    return session;
  } catch {
    return null;
  }
}

export function clearSession() {
  // Through the helper, not `localStorage` directly: `useStorageItem` subscribers in
  // this tab only learn about a write if it is announced, and a sign-out that leaves the
  // UI looking signed in is the worst version of this bug.
  removeStorageItem(STORAGE_KEY);
}

export function isSessionInvalidError(message: string) {
  return /session expired or invalid/i.test(message);
}

/**
 * Sign-In-With-Solana: fetch a one-time message from the database, have the
 * wallet sign it, and let Postgres verify the ed25519 signature (pgsodium)
 * before minting a 7-day session token.
 */
export async function signInWithSolana(
  wallet: string,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>
): Promise<SiwsSession> {
  const { data: message, error: startError } = await supabase.rpc("siws_start", {
    p_wallet: wallet,
  });
  if (startError || typeof message !== "string") {
    throw new Error(startError?.message ?? "Could not start sign-in");
  }

  const signature = await signMessage(new TextEncoder().encode(message));
  const signatureHex = Array.from(signature)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const { data: token, error: verifyError } = await supabase.rpc("siws_verify", {
    p_wallet: wallet,
    p_signature_hex: signatureHex,
  });
  if (verifyError || typeof token !== "string") {
    throw new Error(verifyError?.message ?? "Signature verification failed");
  }

  const session: SiwsSession = { token, wallet };
  writeStorageItem(STORAGE_KEY, JSON.stringify(session));
  return session;
}
