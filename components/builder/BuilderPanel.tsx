"use client";

import { useState } from "react";
import { useAccount } from "wagmi";

import { EvmWalletButton } from "@/components/EvmWalletButton";
import { isDeployed } from "@/lib/contracts/addresses";
import {
  useBondAllowance,
  useBuilder,
  useRegistryActions,
  useTiers,
} from "@/lib/contracts/useRegistry";
import { DEFAULT_CHAIN } from "@/lib/chains/hyperevm";
import { formatUsdc, parseUsdc } from "@/lib/format";

/**
 * The builder's on-chain surface: register, bond, and see what the bond actually buys.
 *
 * This is deliberately separate from `SubmitAgentForm`, which writes the off-chain
 * catalogue. The two are different systems — an agent can sit in the catalogue with no
 * on-chain listing, and a listing can exist with no catalogue entry — and merging them in
 * the UI would imply a link that does not exist in the data.
 */
export function BuilderPanel() {
  const { isConnected, chainId } = useAccount();
  const [amount, setAmount] = useState("");

  const { state: builder, refetch } = useBuilder();
  const { tiers } = useTiers();
  const { data: usdc } = useBondAllowance();
  const actions = useRegistryActions();

  const [balance, allowance] = usdc ?? [0n, 0n];

  if (!chainId || !isDeployed(chainId)) {
    return (
      <Notice title="No registry on this chain">
        The registry is deployed on {DEFAULT_CHAIN.name}, not on the chain your wallet is
        connected to. Switch networks to register as a builder.
      </Notice>
    );
  }

  if (!isConnected) {
    return (
      <div className="card-surface mt-6 flex flex-wrap items-center justify-between gap-4 p-5">
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Your wallet is your builder identity. Connect it to register and post a bond.
        </p>
        <EvmWalletButton />
      </div>
    );
  }

  const staged = parseUsdc(amount);
  const needsApproval = staged !== null && staged > allowance;

  // Tier 0 is registered-but-unbonded. It may submit listings and hold no capital at all,
  // which is the single most surprising thing about the bond ladder — so it is said
  // plainly rather than left for a trader to discover at deposit time.
  const ceiling =
    builder && tiers && builder.tier > 0 ? tiers.ceilings[builder.tier - 1] ?? 0n : 0n;

  return (
    <div className="mt-6 space-y-4">
      {!builder?.exists ? (
        <div className="card-surface p-5">
          <p className="text-sm font-semibold">Not registered</p>
          <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
            Registering is free, permissionless and one transaction. It records your wallet
            as a builder; it does not post a bond and does not list anything.
          </p>
          <button
            type="button"
            className="btn-accent mt-4 px-5 py-2.5 text-xs"
            disabled={actions.isPending}
            onClick={() => actions.registerBuilder().then(() => refetch())}
          >
            {actions.isPending ? "Confirming…" : "Register as a builder"}
          </button>
        </div>
      ) : (
        <>
          <div className="card-surface p-5">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Tier" value={String(builder.tier)} />
              <Stat label="Bond" value={`$${formatUsdc(builder.bondAmount)}`} />
              <Stat label="AUM" value={`$${formatUsdc(builder.totalAum)}`} />
              <Stat
                label="Ceiling"
                value={builder.tier === 0 ? "none" : `$${formatUsdc(ceiling)}`}
              />
            </div>

            {builder.tier === 0 && (
              <p className="mt-4 text-sm" style={{ color: "var(--negative)" }}>
                Tier 0 holds no capital. You can submit listings and they can be approved,
                but every deposit into them will revert until you post a bond.
              </p>
            )}

            <p className="mt-4 text-sm" style={{ color: "var(--muted)" }}>
              The ceiling is per builder across every listing you own, not per listing.
              {builder.agentCount > 0 && ` You have ${builder.agentCount} listing${
                builder.agentCount === 1 ? "" : "s"
              } sharing it.`}
            </p>
          </div>

          <div className="card-surface p-5">
            <p className="text-sm font-semibold">Post a bond</p>
            <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
              In USDC, never in a token we issue — a bond whose value we control is worth
              least exactly when harmed traders need it. It stays slashable the whole time
              it is posted.
            </p>

            {tiers && (
              <div className="mt-4 grid gap-2 sm:grid-cols-3">
                {tiers.bonds.map((bond, i) => (
                  <button
                    key={i}
                    type="button"
                    className="card-surface p-3 text-left"
                    onClick={() => setAmount(formatUsdc(bond, 0))}
                  >
                    <div className="text-xs" style={{ color: "var(--muted)" }}>
                      Tier {i + 1}
                    </div>
                    <div className="tabular mt-1 text-sm font-semibold">
                      ${formatUsdc(bond, 0)}
                    </div>
                    <div className="text-[11px]" style={{ color: "var(--muted)" }}>
                      up to ${formatUsdc(tiers.ceilings[i] ?? 0n, 0)} AUM
                    </div>
                  </button>
                ))}
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                placeholder="Amount in USDC"
                className="w-44 rounded-lg border bg-transparent px-3 py-2 text-sm"
                style={{ borderColor: "var(--border)" }}
              />
              {needsApproval ? (
                <button
                  type="button"
                  className="btn-accent px-5 py-2.5 text-xs"
                  disabled={actions.isPending}
                  onClick={() => actions.approveUsdc()}
                >
                  {actions.isPending ? "Confirming…" : "Approve USDC"}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-accent px-5 py-2.5 text-xs"
                  disabled={actions.isPending || staged === null || staged === 0n}
                  onClick={() => actions.stakeBond(staged!).then(() => refetch())}
                >
                  {actions.isPending ? "Confirming…" : "Post bond"}
                </button>
              )}
              <span className="text-xs" style={{ color: "var(--muted)" }}>
                Balance ${formatUsdc(balance)}
              </span>
            </div>
          </div>

          {builder.bondAmount > 0n && (
            <div className="card-surface p-5">
              <p className="text-sm font-semibold">Withdraw a bond</p>
              <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
                Unbonding takes {tiers ? Number(tiers.unbondPeriod) / 86_400 : 14} days, and
                the bond is slashable throughout. A withdrawal is refused outright if what
                is left would not cover the AUM you currently hold: traders get out before
                you do.
              </p>
              {builder.unbondAmount > 0n && (
                <p className="mt-3 text-sm">
                  ${formatUsdc(builder.unbondAmount)} unbonding.
                </p>
              )}
            </div>
          )}
        </>
      )}

      {actions.error && (
        <Notice title="The transaction failed" tone="warn">
          {actions.error.message}
        </Notice>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px]" style={{ color: "var(--muted)" }}>
        {label}
      </div>
      <div className="tabular mt-1 text-sm font-semibold">{value}</div>
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
