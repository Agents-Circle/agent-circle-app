"use client";

import { useState } from "react";
import Link from "next/link";
import { useSiws } from "@/hooks/useSiws";
import { submitAgentAuthed } from "@/lib/builderApi";
import { isSessionInvalidError } from "@/lib/auth";
import type { MarketCategory } from "@/lib/types";
import { WalletButton } from "./WalletButton";

const MARKETS: MarketCategory[] = ["Crypto", "Sports", "Politics", "Macro", "Event Markets"];

const inputStyle = {
  borderColor: "var(--border)",
  color: "var(--foreground)",
} as const;

export function SubmitAgentForm() {
  const { connected, wallet, session, verify, verifying, error: authError, signOut } = useSiws();
  const [builderName, setBuilderName] = useState("");
  const [agentName, setAgentName] = useState("");
  const [market, setMarket] = useState<MarketCategory>("Crypto");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [submittedSlug, setSubmittedSlug] = useState("");

  const shortAddress = wallet ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : null;
  const ready = Boolean(session);
  const canSubmit =
    ready && builderName.trim() && agentName.trim() && description.trim().length >= 20;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !session || status === "loading") return;

    setStatus("loading");
    setErrorMsg("");

    try {
      const slug = await submitAgentAuthed(session.token, {
        builderName,
        agentName,
        market,
        description,
      });
      setSubmittedSlug(slug);
      setStatus("done");
      window.dispatchEvent(new CustomEvent("ac:agents-updated"));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Submission failed";
      if (isSessionInvalidError(message)) signOut();
      setStatus("error");
      setErrorMsg(message);
    }
  };

  if (status === "done") {
    return (
      <div
        className="mt-8 rounded-2xl border p-8 text-center"
        style={{ borderColor: "var(--border)", background: "var(--card)" }}
      >
        <div
          className="mx-auto flex h-12 w-12 items-center justify-center rounded-full text-xl font-bold"
          style={{ background: "var(--grad-accent)", color: "var(--on-accent)" }}
        >
          ✓
        </div>
        <h2 className="mt-4 text-xl font-semibold">Agent submitted for vetting</h2>
        <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: "var(--muted)" }}>
          Your agent is now in the vetting queue. It appears in the catalogue
          as <span style={{ color: "var(--foreground)" }}>VETTING</span> and unlocks
          a public performance record once review completes.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Link href={`/agents/${submittedSlug}`} className="btn-accent">
            View your agent
          </Link>
          <button
            type="button"
            onClick={() => {
              setStatus("idle");
              setAgentName("");
              setDescription("");
            }}
            className="btn-ghost"
          >
            Submit another
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-8 rounded-2xl border p-6"
      style={{ borderColor: "var(--border)", background: "var(--card)" }}
    >
      {!connected && (
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Connect a wallet to submit your agent — it becomes your builder identity
          and, later, where revenue share streams.
        </p>
      )}

      {connected && !ready && (
        <div>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Connected as <span style={{ color: "var(--foreground)" }}>{shortAddress}</span>.
            One more step: sign a message to prove you own this wallet. It costs
            nothing and sends no transaction.
          </p>
          <button
            type="button"
            onClick={verify}
            disabled={verifying}
            className="btn-accent mt-4"
          >
            {verifying ? "Waiting for signature…" : "Verify wallet ownership"}
          </button>
          {authError && (
            <p className="mt-3 text-sm" role="alert" style={{ color: "var(--negative)" }}>
              {authError}
            </p>
          )}
        </div>
      )}

      {ready && (
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Verified as <span style={{ color: "var(--foreground)" }}>{shortAddress}</span>.
          Your wallet is your builder identity.
        </p>
      )}

      <div className="mt-6 space-y-5" style={{ opacity: ready ? 1 : 0.45 }}>
        <div>
          <label htmlFor="builder-name" className="text-xs font-semibold" style={{ color: "var(--muted)" }}>
            Builder / team name
          </label>
          <input
            id="builder-name"
            type="text"
            disabled={!ready}
            value={builderName}
            onChange={(e) => setBuilderName(e.target.value)}
            placeholder="e.g. 0xForge Labs"
            className="mt-2 w-full rounded-xl border bg-transparent px-4 py-3 text-sm outline-none"
            style={inputStyle}
          />
        </div>

        <div>
          <label htmlFor="agent-name" className="text-xs font-semibold" style={{ color: "var(--muted)" }}>
            Agent name
          </label>
          <input
            id="agent-name"
            type="text"
            disabled={!ready}
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            placeholder="e.g. Oracle Edge"
            className="mt-2 w-full rounded-xl border bg-transparent px-4 py-3 text-sm outline-none"
            style={inputStyle}
          />
        </div>

        <div>
          <label className="text-xs font-semibold" style={{ color: "var(--muted)" }}>
            Market focus
          </label>
          <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Market focus">
            {MARKETS.map((m) => (
              <button
                key={m}
                type="button"
                disabled={!ready}
                onClick={() => setMarket(m)}
                aria-pressed={market === m}
                className={`chip ${market === m ? "chip-selected" : ""}`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor="agent-description" className="text-xs font-semibold" style={{ color: "var(--muted)" }}>
            Strategy description{" "}
            <span className="font-normal">(min 20 characters — shown publicly on your agent&apos;s profile)</span>
          </label>
          <textarea
            id="agent-description"
            disabled={!ready}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            placeholder="What does your agent trade, and what's its edge?"
            className="mt-2 w-full resize-none rounded-xl border bg-transparent px-4 py-3 text-sm outline-none"
            style={inputStyle}
          />
        </div>
      </div>

      {status === "error" && (
        <p className="mt-4 text-sm" role="alert" style={{ color: "var(--negative)" }}>
          {errorMsg}
        </p>
      )}

      {ready ? (
        <button
          type="submit"
          disabled={!canSubmit || status === "loading"}
          className="btn-primary mt-6 w-full"
        >
          {status === "loading" ? "Submitting…" : "Submit for vetting"}
        </button>
      ) : !connected ? (
        <div className="mt-6 flex justify-center">
          <WalletButton />
        </div>
      ) : null}
    </form>
  );
}
