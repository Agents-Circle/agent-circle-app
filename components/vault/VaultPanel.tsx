"use client";

import { useState } from "react";
import type { Address } from "viem";
import { useAccount } from "wagmi";

import { EvmWalletButton } from "@/components/EvmWalletButton";
import { VaultStats } from "./VaultStats";
import { ExecutionModeCard } from "./ExecutionModeCard";
import { isDeployed } from "@/lib/contracts/addresses";
import {
  useUsdcPosition,
  useVaultActions,
  useVaultAddress,
  useVaultState,
} from "@/lib/contracts/useVault";
import { DEFAULT_CHAIN } from "@/lib/chains/hyperevm";
import { formatBps, formatUsdc, parseUsdc, shortAddress } from "@/lib/format";
import type { Agent } from "@/lib/types";

/**
 * The trader's vault surface for one listing.
 *
 * Written so that every state the contract can be in has a screen, including the ones
 * nobody wants: not deployed, wrong chain, paused, auto-paused into a drawdown, a
 * withdrawal stuck in flight. A UI that only renders the happy path is how a trader ends
 * up not knowing their vault stopped trading.
 */
export function VaultPanel({ agent, listingId }: { agent: Agent; listingId?: `0x${string}` }) {
  const { isConnected, chainId } = useAccount();
  const [amount, setAmount] = useState("");
  const [capBps, setCapBps] = useState("");
  const [ddBps, setDdBps] = useState("");

  const { data: predicted } = useVaultAddress(listingId);
  const vault = predicted as Address | undefined;
  const { state, refetch } = useVaultState(vault);
  const { data: usdc } = useUsdcPosition(vault);
  const actions = useVaultActions(vault);

  const [balance, allowance] = usdc ?? [0n, 0n];

  // The chain is the source of truth for whether anything here can work. Checked before
  // the wallet, because a connected wallet on a chain with no contracts is a more
  // confusing screen than no wallet at all.
  if (!chainId || !isDeployed(chainId)) {
    return (
      <Notice title="Not deployed yet">
        The HyperEVM vault contracts have passed their test suite and run against a local
        node, but they have not been deployed to {DEFAULT_CHAIN.name} or anywhere else. No
        vault can be opened until they are. The open questions that gate deployment are in{" "}
        <code>docs/adr/0002-hyperliquid-execution-modes.md</code>.
      </Notice>
    );
  }

  if (!isConnected) {
    return (
      <div className="card-surface mt-6 p-5">
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Connect an EVM wallet to open or manage a vault for {agent.name}.
        </p>
        <div className="mt-4">
          <EvmWalletButton />
        </div>
      </div>
    );
  }

  if (!listingId) {
    return (
      <Notice title="This agent has no on-chain listing">
        {agent.name} exists in the marketplace index but has no listing on the HyperEVM
        registry, so there is nothing to open a vault against. Listings are created by the
        builder and approved by governance.
      </Notice>
    );
  }

  const busy = actions.isPending;

  if (state && !state.exists) {
    return (
      <div className="card-surface mt-6 p-5">
        <p className="text-sm font-semibold">Open a vault for {agent.name}</p>
        <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
          A vault is yours alone. You are the only address that can withdraw from it, and
          its limits inherit {agent.name}&apos;s vetted defaults —{" "}
          {formatBps(agent.riskDefaults.positionCapPct * 100)} position cap and{" "}
          {formatBps(agent.riskDefaults.maxDrawdownPct * 100)} max drawdown. You can
          tighten them afterwards; you can never loosen them.
        </p>
        <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
          Its address is also its HyperCore account:{" "}
          <code>{vault ? shortAddress(vault) : "…"}</code>
        </p>
        <button
          type="button"
          className="btn-primary mt-4 px-5 py-2 text-xs"
          disabled={busy}
          onClick={() => actions.openVault(listingId).then(() => refetch())}
        >
          {busy ? "Opening…" : "Open vault"}
        </button>
        <ActionError error={actions.error} />
      </div>
    );
  }

  if (!state) {
    return (
      <div className="card-surface mt-6 p-5">
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Reading vault state…
        </p>
      </div>
    );
  }

  const parsed = parseUsdc(amount);
  const needsApproval = parsed !== null && allowance < parsed;

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--muted)" }}>
            Vault · {state.status}
          </p>
          <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
            <code>{shortAddress(state.address)}</code> — also its HyperCore account
          </p>
        </div>
        <EvmWalletButton />
      </div>

      {state.status === "Paused" && (
        <Notice title="This vault is paused" tone="warn">
          No new orders will be accepted. It may have paused itself: the contract pauses
          and sends reduce-only closes when drawdown reaches your limit. Withdrawing works
          normally while paused.
        </Notice>
      )}

      <VaultStats state={state} />

      <ExecutionModeCard
        state={state}
        busy={busy}
        onEnable={(w) => actions.enableFastMode(w).then(() => refetch())}
        onDisable={() => actions.disableFastMode().then(() => refetch())}
      />

      {/* ── deposit */}
      <div className="card-surface mt-6 p-5">
        <p className="text-sm font-semibold">Deposit USDC</p>
        <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
          Wallet balance ${formatUsdc(balance)}. A deposit crosses to HyperCore in two
          asynchronous steps, so it shows as settling before it is usable as margin.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            className="flex-1 rounded-xl border px-3 py-2 text-sm tabular-nums"
            style={{ borderColor: "var(--border-strong)", background: "var(--card-solid)" }}
            placeholder="0.00"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          {needsApproval ? (
            <button
              type="button"
              className="btn-primary px-5 py-2 text-xs"
              disabled={busy}
              onClick={() => actions.approveUsdc()}
            >
              {busy ? "Working…" : "Approve USDC"}
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary px-5 py-2 text-xs"
              disabled={busy || parsed === null || parsed === 0n || parsed > balance}
              onClick={() => actions.deposit(parsed!).then(() => refetch())}
            >
              {busy ? "Depositing…" : "Deposit"}
            </button>
          )}
        </div>
        {parsed !== null && parsed > balance && (
          <p className="mt-2 text-xs" style={{ color: "var(--negative)" }}>
            More than your wallet balance.
          </p>
        )}
      </div>

      {/* ── withdraw */}
      <div className="card-surface mt-4 p-5">
        <p className="text-sm font-semibold">Withdraw</p>
        <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
          Two steps, because HyperCore returns funds asynchronously. Requesting works in
          every state — paused, delisted, or with the market removed. ${formatUsdc(state.availableToWithdraw)} available.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-ghost px-5 py-2 text-xs"
            disabled={busy || state.availableToWithdraw === 0n}
            onClick={() =>
              actions.requestWithdraw(state.availableToWithdraw).then(() => refetch())
            }
          >
            Request everything available
          </button>
          <button
            type="button"
            className="btn-primary px-5 py-2 text-xs"
            disabled={busy || state.pendingWithdrawal === 0n}
            onClick={() => actions.finalizeWithdraw().then(() => refetch())}
          >
            {state.pendingWithdrawal > 0n
              ? `Finalise $${formatUsdc(state.pendingWithdrawal)}`
              : "Nothing in flight"}
          </button>
        </div>
      </div>

      {/* ── risk limits */}
      <div className="card-surface mt-4 p-5">
        <p className="text-sm font-semibold">Tighten limits</p>
        <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
          Currently {formatBps(state.positionCapBps)} position cap and{" "}
          {formatBps(state.maxDrawdownBps)} max drawdown. Tightening only — loosening past
          what this listing was vetted at would void the guarantee the leaderboard makes to
          everyone else.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            className="w-32 rounded-xl border px-3 py-2 text-sm tabular-nums"
            style={{ borderColor: "var(--border-strong)", background: "var(--card-solid)" }}
            placeholder="cap bps"
            inputMode="numeric"
            value={capBps}
            onChange={(e) => setCapBps(e.target.value)}
          />
          <input
            className="w-32 rounded-xl border px-3 py-2 text-sm tabular-nums"
            style={{ borderColor: "var(--border-strong)", background: "var(--card-solid)" }}
            placeholder="drawdown bps"
            inputMode="numeric"
            value={ddBps}
            onChange={(e) => setDdBps(e.target.value)}
          />
          <button
            type="button"
            className="btn-ghost px-5 py-2 text-xs"
            disabled={
              busy ||
              !/^\d+$/.test(capBps) ||
              !/^\d+$/.test(ddBps) ||
              Number(capBps) === 0 ||
              Number(ddBps) === 0 ||
              Number(capBps) > state.positionCapBps ||
              Number(ddBps) > state.maxDrawdownBps
            }
            onClick={() =>
              actions.tightenRiskLimits(Number(capBps), Number(ddBps)).then(() => refetch())
            }
          >
            Tighten
          </button>
        </div>
      </div>

      {/* ── control */}
      <div className="card-surface mt-4 p-5">
        <p className="text-sm font-semibold">Control</p>
        <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
          Pausing stops new orders and never blocks a withdrawal. Exiting sends a
          reduce-only close and needs no cooperation from the agent.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {state.status === "Active" ? (
            <button
              type="button"
              className="btn-ghost px-5 py-2 text-xs"
              disabled={busy}
              onClick={() => actions.pause().then(() => refetch())}
            >
              Pause
            </button>
          ) : (
            <button
              type="button"
              className="btn-ghost px-5 py-2 text-xs"
              disabled={busy}
              onClick={() => actions.resume().then(() => refetch())}
            >
              Resume
            </button>
          )}
        </div>
      </div>

      <ActionError error={actions.error} />

      {actions.hash && (
        <p className="mt-3 text-xs" style={{ color: "var(--muted)" }}>
          {actions.isSuccess ? "Confirmed" : "Submitted"} ·{" "}
          <a
            href={`${DEFAULT_CHAIN.blockExplorers?.default.url}/tx/${actions.hash}`}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            {shortAddress(actions.hash)}
          </a>
        </p>
      )}
    </div>
  );
}

function Notice({
  title,
  children,
  tone = "neutral",
}: {
  title: string;
  children: React.ReactNode;
  tone?: "neutral" | "warn";
}) {
  return (
    <div
      className="card-surface mt-6 p-5"
      style={tone === "warn" ? { borderColor: "var(--border-strong)" } : undefined}
    >
      <p
        className="text-xs font-semibold uppercase tracking-widest"
        style={{ color: tone === "warn" ? "var(--negative)" : "var(--muted)" }}
      >
        {title}
      </p>
      <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
        {children}
      </p>
    </div>
  );
}

/**
 * Surfaces the revert reason rather than swallowing it.
 *
 * The ABIs are generated with their error entries precisely so viem can decode a custom
 * error into a name — `PositionCapExceeded` instead of a hex blob. Showing the raw
 * message is less polished than mapping each error to prose, and more honest until that
 * mapping exists, because an invented explanation of someone else's revert is worse than
 * the revert.
 */
function ActionError({ error }: { error: Error | null }) {
  if (!error) return null;
  const short = error.message.split("\n")[0];
  return (
    <p className="mt-3 text-xs" style={{ color: "var(--negative)" }}>
      {short}
    </p>
  );
}
