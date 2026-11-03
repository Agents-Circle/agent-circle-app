"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import type { Agent } from "@/lib/types";
import { WalletButton } from "./WalletButton";

export function ListForm({ agent }: { agent: Agent }) {
  const { connected, publicKey } = useWallet();
  const [capital, setCapital] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const shortAddress = publicKey
    ? `${publicKey.toBase58().slice(0, 4)}…${publicKey.toBase58().slice(-4)}`
    : null;

  return (
    <div
      className="mt-8 rounded-2xl border p-6"
      style={{ borderColor: "var(--border)", background: "var(--card)" }}
    >
      {connected ? (
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Connected as <span style={{ color: "var(--foreground)" }}>{shortAddress}</span>.
          Set your allocation and risk limits below.
        </p>
      ) : (
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Connect a wallet to configure and list this agent.
        </p>
      )}

      <div className="mt-6 space-y-4" style={{ opacity: connected ? 1 : 0.45 }}>
        <div>
          <label className="text-xs font-semibold" style={{ color: "var(--muted)" }}>
            Capital to allocate (USDC)
          </label>
          <input
            type="number"
            min={0}
            disabled={!connected}
            value={capital}
            onChange={(e) => setCapital(e.target.value)}
            placeholder="0.00"
            className="mt-2 w-full rounded-xl border bg-transparent px-4 py-3 text-sm outline-none"
            style={{ borderColor: "var(--border)", color: "var(--foreground)" }}
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-semibold" style={{ color: "var(--muted)" }}>
              Position cap
            </label>
            <div
              className="mt-2 rounded-xl border px-4 py-3 text-sm"
              style={{ borderColor: "var(--border)" }}
            >
              {agent.riskDefaults.positionCapPct}%
            </div>
          </div>
          <div>
            <label className="text-xs font-semibold" style={{ color: "var(--muted)" }}>
              Max drawdown
            </label>
            <div
              className="mt-2 rounded-xl border px-4 py-3 text-sm"
              style={{ borderColor: "var(--border)" }}
            >
              {agent.riskDefaults.maxDrawdownPct}%
            </div>
          </div>
        </div>
      </div>

      {connected ? (
        submitted ? (
          <div
            className="mt-6 rounded-xl border p-4 text-sm"
            style={{ borderColor: "var(--border-strong)", color: "var(--muted)" }}
          >
            Listing execution isn&apos;t live yet — Phase 1 opens once the
            vetted agent cohort and on-chain programs are ready. Your inputs
            aren&apos;t saved or submitted anywhere.
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setSubmitted(true)}
            disabled={!capital}
            className="btn-primary mt-6 w-full"
          >
            Review &amp; List
          </button>
        )
      ) : (
        <div className="mt-6 flex justify-center">
          <WalletButton />
        </div>
      )}
    </div>
  );
}
