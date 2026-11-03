"use client";

import { useMemo } from "react";
import { Buffer } from "buffer";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
// The two adapters directly, not the `@solana/wallet-adapter-wallets` meta-package.
//
// That package depends on *every* adapter — Keystone, Gemini, Fractal, a dozen more —
// and only Phantom and Solflare are used here. Dropping it took production
// vulnerabilities from 133 to 62 and criticals from 3 to 2: 71 of them were arriving
// for wallets the app never offers. The remainder come from @solana/web3.js and the
// adapter UI and are not removable this way.
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { clusterApiUrl } from "@solana/web3.js";

import "@solana/wallet-adapter-react-ui/styles.css";

if (typeof window !== "undefined") {
  window.Buffer = window.Buffer || Buffer;
}

export function WalletContextProvider({ children }: { children: React.ReactNode }) {
  const endpoint = useMemo(
    () => process.env.NEXT_PUBLIC_SOLANA_RPC_ENDPOINT || clusterApiUrl("devnet"),
    []
  );

  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    []
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
