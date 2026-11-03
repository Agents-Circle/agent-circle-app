"use client";

import { useState } from "react";
import type { Address } from "viem";
import { isAddress } from "viem";

import type { VaultState } from "@/lib/contracts/useVault";

/**
 * The execution-mode choice.
 *
 * This component carries the single most important piece of copy in the product, and the
 * wording is not negotiable at the UI layer: in vault mode the contract checks limits
 * before every order; in fast mode a keeper **monitors** them and trips a kill switch
 * after the fact. ADR-0002 states both claims, and the difference is the difference
 * between something we can defend in a technical conversation and something we cannot.
 *
 * So the warning is in the flow, not a footnote, and the opt-in requires typing the
 * confirmation. A checkbox is dismissed without reading; a phrase has to be understood
 * well enough to copy.
 */
export function ExecutionModeCard({
  state,
  onEnable,
  onDisable,
  busy,
}: {
  state: VaultState;
  onEnable: (apiWallet: Address) => void;
  onDisable: () => void;
  busy: boolean;
}) {
  const fastModeOn = state.apiWallet !== "0x0000000000000000000000000000000000000000";
  const [opening, setOpening] = useState(false);
  const [apiWallet, setApiWallet] = useState("");
  const [confirmation, setConfirmation] = useState("");

  const CONFIRM_PHRASE = "monitored, not enforced";
  const walletValid = isAddress(apiWallet);
  const confirmed = confirmation.trim().toLowerCase() === CONFIRM_PHRASE;

  if (fastModeOn) {
    return (
      <div className="card-surface mt-6 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--negative)" }}>
              Fast mode active — limits monitored, not enforced
            </p>
            <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
              Your agent signs orders directly with a registered API wallet. This vault&apos;s
              position cap and drawdown limit are watched by a keeper and enforced by an
              automatic kill switch <em>after</em> a breach, not refused before one.
            </p>
            <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
              Your custody is unchanged: an API wallet can trade but cannot withdraw. You
              remain the only address that can move funds out.
            </p>
          </div>
        </div>
        <button
          type="button"
          className="btn-primary mt-4 px-5 py-2 text-xs"
          disabled={busy}
          onClick={onDisable}
        >
          {busy ? "Working…" : "Return to vault mode"}
        </button>
        <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
          Pauses the vault and sends reduce-only closes for every position.
        </p>
      </div>
    );
  }

  return (
    <div className="card-surface mt-6 p-5">
      <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--muted)" }}>
        Execution mode
      </p>
      <p className="mt-2 text-sm font-semibold">Vault mode — limits checked before every order</p>
      <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
        Every order passes through this contract, which refuses it if it would breach your
        position cap or drawdown limit. Orders carry a few seconds of delay.
      </p>

      {!opening ? (
        <button
          type="button"
          className="btn-ghost mt-4 px-5 py-2 text-xs"
          onClick={() => setOpening(true)}
        >
          Consider fast mode
        </button>
      ) : (
        <div
          className="mt-4 rounded-xl border p-4"
          style={{ borderColor: "var(--border-strong)" }}
        >
          <p className="text-sm font-semibold" style={{ color: "var(--negative)" }}>
            Fast mode weakens the guarantee you are relying on
          </p>
          <ul className="mt-2 space-y-1 text-sm" style={{ color: "var(--muted)" }}>
            <li>
              • Your limits become <strong>monitored, not enforced</strong>. A keeper
              watches them and trips a kill switch after a breach.
            </li>
            <li>• The bound on a loss is the keeper&apos;s reaction time, not a block.</li>
            <li>• In exchange: no order delay, and the agent earns builder-code revenue.</li>
            <li>• Unchanged: an API wallet cannot withdraw. You keep custody.</li>
          </ul>

          <label className="mt-4 block text-xs font-semibold" style={{ color: "var(--muted)" }}>
            Agent API wallet address
          </label>
          <input
            className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
            style={{ borderColor: "var(--border-strong)", background: "var(--card-solid)" }}
            placeholder="0x…"
            value={apiWallet}
            onChange={(e) => setApiWallet(e.target.value)}
          />
          {apiWallet.length > 0 && !walletValid && (
            <p className="mt-1 text-xs" style={{ color: "var(--negative)" }}>
              Not a valid address.
            </p>
          )}

          <label className="mt-3 block text-xs font-semibold" style={{ color: "var(--muted)" }}>
            Type <strong>{CONFIRM_PHRASE}</strong> to confirm you understand
          </label>
          <input
            className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
            style={{ borderColor: "var(--border-strong)", background: "var(--card-solid)" }}
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
          />

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              className="btn-primary px-5 py-2 text-xs"
              disabled={!walletValid || !confirmed || busy}
              onClick={() => onEnable(apiWallet as Address)}
            >
              {busy ? "Working…" : "Enable fast mode"}
            </button>
            <button
              type="button"
              className="btn-ghost px-5 py-2 text-xs"
              onClick={() => {
                setOpening(false);
                setConfirmation("");
              }}
            >
              Stay in vault mode
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
