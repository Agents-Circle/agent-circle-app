"use client";

import { useCallback, useSyncExternalStore } from "react";

export type StorageArea = "local" | "session";

/** Same-tab notification. The `storage` event only fires in *other* tabs. */
const STORAGE_EVENT = "ac-storage";

function area(which: StorageArea): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return which === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    // Private windows and blocked site data throw on access rather than returning null.
    return null;
  }
}

/**
 * Tell subscribers a key changed in this tab.
 *
 * Anything writing a key read through `useStorageItem` must call this, or the UI keeps
 * showing the old value until something else re-renders it. `lib/auth.ts` does.
 */
export function notifyStorageChanged(key: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(STORAGE_EVENT, { detail: key }));
}

export function writeStorageItem(key: string, value: string, which: StorageArea = "local") {
  const store = area(which);
  if (!store) return;
  try {
    store.setItem(key, value);
  } catch {
    // Out of quota, or blocked. The caller's state is still correct for this session.
  }
  notifyStorageChanged(key);
}

export function removeStorageItem(key: string, which: StorageArea = "local") {
  const store = area(which);
  if (!store) return;
  try {
    store.removeItem(key);
  } catch {
    // As above.
  }
  notifyStorageChanged(key);
}

/**
 * Read a browser-storage key as React state, without setting state from an effect.
 *
 * ## Why this exists rather than the obvious effect
 *
 * The obvious version is `useState(null)` plus an effect that reads storage and calls
 * `setState`. React 19 flags that as a cascading render, and it is right to: the
 * component renders once with the wrong value, then again with the right one, and on an
 * auth check that means a signed-in user sees a signed-out UI for a frame.
 *
 * `useSyncExternalStore` is the sanctioned answer. It takes a server snapshot and a
 * client snapshot, so there is no mismatch to correct and no second pass.
 *
 * ## The subtlety that makes it work
 *
 * `getSnapshot` must return a **referentially stable** value when nothing has changed,
 * or React re-renders forever. So this returns the raw `string | null` — a primitive,
 * compared by value — and leaves parsing to the caller, which can memoise on it. An
 * earlier shape that parsed JSON here returned a fresh object every call and looped.
 */
export function useStorageItem(key: string, which: StorageArea = "local"): string | null {
  const subscribe = useCallback((onChange: () => void) => {
    if (typeof window === "undefined") return () => {};

    const onCustom = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (detail === undefined || detail === key) onChange();
    };
    // `storage` for other tabs, the custom event for this one.
    const onNative = (event: StorageEvent) => {
      if (event.key === null || event.key === key) onChange();
    };

    window.addEventListener(STORAGE_EVENT, onCustom);
    window.addEventListener("storage", onNative);
    return () => {
      window.removeEventListener(STORAGE_EVENT, onCustom);
      window.removeEventListener("storage", onNative);
    };
  }, [key]);

  const getSnapshot = useCallback(() => {
    const store = area(which);
    if (!store) return null;
    try {
      return store.getItem(key);
    } catch {
      return null;
    }
  }, [key, which]);

  // Null on the server: storage does not exist there, and claiming otherwise is what
  // produces a hydration mismatch.
  const getServerSnapshot = useCallback(() => null, []);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
