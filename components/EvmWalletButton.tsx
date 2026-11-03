"use client";

import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";

import { DEFAULT_CHAIN } from "@/lib/chains/hyperevm";
import { shortAddress } from "@/lib/format";

/**
 * Connect an EVM wallet, and say plainly when it is on the wrong chain.
 *
 * Separate from the Solana `WalletButton` rather than a combined "connect" control. A
 * trader can legitimately have both connected for different things, and a single button
 * would have to pick one to disconnect.
 */
export function EvmWalletButton() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();

  const injected = connectors[0];
  const wrongChain = isConnected && chainId !== DEFAULT_CHAIN.id;

  if (!isConnected) {
    return (
      <button
        type="button"
        className="btn-ghost px-4 py-2 text-xs"
        disabled={isPending || !injected}
        onClick={() => injected && connect({ connector: injected })}
      >
        {/* No browser wallet is a different problem from a failed connection, and a
            button that just does nothing is the worst way to say so. */}
        {!injected
          ? "No EVM wallet found"
          : isPending
            ? "Connecting…"
            : "Connect EVM wallet"}
      </button>
    );
  }

  if (wrongChain) {
    return (
      <button
        type="button"
        className="btn-primary px-4 py-2 text-xs"
        onClick={() => switchChain({ chainId: DEFAULT_CHAIN.id })}
      >
        Switch to {DEFAULT_CHAIN.name}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="chip" title={address}>
        {DEFAULT_CHAIN.testnet ? `${DEFAULT_CHAIN.name} · ` : ""}
        {address ? shortAddress(address) : ""}
      </span>
      <button type="button" className="btn-ghost px-3 py-2 text-xs" onClick={() => disconnect()}>
        Disconnect
      </button>
    </div>
  );
}
