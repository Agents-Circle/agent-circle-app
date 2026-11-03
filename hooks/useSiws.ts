"use client";

import { useCallback, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  clearSession,
  signInWithSolana,
  SIWS_STORAGE_KEY,
  type SiwsSession,
} from "@/lib/auth";
import { useStorageItem } from "./useStorageItem";

export function useSiws() {
  const { publicKey, signMessage, connected } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState("");

  // Derived from storage rather than copied into state by an effect. The effect version
  // rendered once as signed-out before correcting itself, which on an auth check means a
  // signed-in user sees the signed-out UI for a frame. It is also what React 19 flags as
  // a cascading render.
  //
  // Memoised on the raw string so the parse happens only when the stored value actually
  // changes, and so the returned object is referentially stable between renders.
  const raw = useStorageItem(SIWS_STORAGE_KEY);
  const session = useMemo<SiwsSession | null>(() => {
    if (!raw || !wallet) return null;
    try {
      const parsed = JSON.parse(raw) as SiwsSession;
      // A session belongs to one wallet. Switching wallets must not inherit it.
      return parsed.wallet === wallet ? parsed : null;
    } catch {
      return null;
    }
  }, [raw, wallet]);

  const verify = useCallback(async () => {
    if (!wallet || !signMessage) {
      setError("This wallet does not support message signing.");
      return;
    }
    setVerifying(true);
    setError("");
    try {
      // The write notifies `useStorageItem`, so `session` updates without being set here.
      await signInWithSolana(wallet, signMessage);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed");
    } finally {
      setVerifying(false);
    }
  }, [wallet, signMessage]);

  const signOut = useCallback(() => {
    clearSession();
  }, []);

  return { connected, wallet, session, verify, verifying, error, signOut };
}
