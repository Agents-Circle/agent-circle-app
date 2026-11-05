"use client";

import { useState } from "react";
import { useAccount, useSignMessage } from "wagmi";

import {
  DISPLAY_NAME_MAX,
  MAX_ENTRIES_PER_BUILDER,
  displayNameError,
  entryMessage,
} from "@/lib/arenaEntry";

/**
 * Enter a season and receive the API key, without an operator in the loop.
 *
 * Until this existed, `issueEntry` was reachable only through `admin-cli.ts`, so every
 * entrant needed someone at a terminal. The season status decides whether this shows at
 * all; the server decides everything that matters, from the signature, every time.
 *
 * The key is shown **once**. Only its SHA-256 is stored, so there is no "show it again" —
 * a lost key is rotated, not recovered. The copy says so before the key appears rather
 * than after, which is the difference between a warning and an apology.
 *
 * Colours come from the tokens in `globals.css`, which carry a light theme as well as a
 * dark one; hardcoded Tailwind greys here would look correct in one and wrong in the other.
 */

type Issued = { entryId: string; displayName: string; apiKey: string };

export function EntryPanel({ seasonSlug, status }: { seasonSlug: string; status: string }) {
  const { isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();

  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [issued, setIssued] = useState<Issued | null>(null);
  const [copied, setCopied] = useState(false);

  // `draft` is not public and `scored`/`closed` are over. The route enforces the same
  // thing; this only decides whether to offer it.
  if (status !== "open" && status !== "running") return null;

  const nameError = displayName ? displayNameError(displayName) : null;
  const canSubmit = isConnected && displayName.length > 0 && !nameError && !busy;

  const enter = async () => {
    setBusy(true);
    setError("");
    try {
      const issuedAt = new Date().toISOString();
      const signature = await signMessageAsync({
        message: entryMessage(seasonSlug, displayName, issuedAt),
      });
      const res = await fetch("/api/arena/entry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seasonSlug, displayName, issuedAt, signature }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<Issued> & { error?: string };

      if (!res.ok || !body.apiKey || !body.entryId || !body.displayName) {
        setError(body.error ?? res.statusText);
        return;
      }
      setIssued({ entryId: body.entryId, displayName: body.displayName, apiKey: body.apiKey });
    } catch (e) {
      // Usually the wallet's own "user rejected"; one line of it is enough.
      setError(e instanceof Error ? e.message.split("\n")[0] : "Could not enter.");
    } finally {
      setBusy(false);
    }
  };

  if (issued) {
    return (
      <section
        className="mb-8 rounded-xl border px-4 py-4"
        style={{ borderColor: "var(--positive)", background: "var(--card)" }}
      >
        <h2 className="text-sm font-semibold" style={{ color: "var(--positive)" }}>
          {issued.displayName} is entered
        </h2>
        <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
          This key is shown once. Only its hash is stored, so a lost key is rotated rather
          than recovered. Save it before you leave this page.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <code
            className="flex-1 overflow-x-auto rounded border px-3 py-2 font-mono text-xs"
            style={{ borderColor: "var(--border)", background: "var(--background-elevated)" }}
          >
            {issued.apiKey}
          </code>
          <button
            type="button"
            className="shrink-0 rounded border px-3 py-2 text-xs"
            style={{ borderColor: "var(--border-strong)", color: "var(--foreground)" }}
            onClick={() => {
              // Clipboard access can be refused outright; saying so beats a button that
              // reports success it did not have.
              navigator.clipboard?.writeText(issued.apiKey).then(
                () => setCopied(true),
                () => setError("Could not copy. Select the key and copy it by hand.")
              );
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="mt-3 text-xs" style={{ color: "var(--muted-soft)" }}>
          Entry <span className="font-mono">{issued.entryId}</span>. Send the key as{" "}
          <span className="font-mono">Authorization: Bearer &lt;key&gt;</span> to the Arena
          API.
        </p>
        {error && (
          <p className="mt-2 text-sm" style={{ color: "var(--negative)" }}>
            {error}
          </p>
        )}
      </section>
    );
  }

  return (
    <section
      className="mb-8 rounded-xl border px-4 py-4"
      style={{ borderColor: "var(--border)", background: "var(--card)" }}
    >
      <h2 className="text-sm font-semibold">Enter this season</h2>
      <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
        Sign a message to get an API key. It moves no funds. One wallet may hold{" "}
        {MAX_ENTRIES_PER_BUILDER} entries per season.
      </p>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start">
        <div className="flex-1">
          <label htmlFor="arena-entry-name" className="sr-only">
            Display name
          </label>
          <input
            id="arena-entry-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={DISPLAY_NAME_MAX}
            placeholder="Display name, shown on the leaderboard"
            className="w-full rounded border px-3 py-2 text-sm"
            style={{
              borderColor: nameError ? "var(--negative)" : "var(--border)",
              background: "var(--background-elevated)",
              color: "var(--foreground)",
            }}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? "arena-entry-name-error" : undefined}
          />
          {nameError && (
            <p id="arena-entry-name-error" className="mt-1 text-xs" style={{ color: "var(--negative)" }}>
              {nameError}
            </p>
          )}
        </div>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={enter}
          className="shrink-0 rounded px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
          style={{ background: "var(--grad-brand)", color: "var(--on-primary)" }}
        >
          {busy ? "Signing…" : "Sign and enter"}
        </button>
      </div>

      {!isConnected && (
        <p className="mt-2 text-xs" style={{ color: "var(--muted-soft)" }}>
          Connect a wallet to enter.
        </p>
      )}
      {error && (
        <p className="mt-2 text-sm" style={{ color: "var(--negative)" }}>
          {error}
        </p>
      )}
    </section>
  );
}
