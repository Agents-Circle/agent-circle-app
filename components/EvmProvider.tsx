"use client";

import { useState } from "react";
import { WagmiProvider, createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { hyperEvm, hyperEvmTestnet, DEFAULT_CHAIN } from "@/lib/chains/hyperevm";

/**
 * EVM wallet and query context, alongside the existing Solana adapter.
 *
 * One profile can hold both: the Solana side signs SIWS for the existing registry, the
 * EVM side signs SIWE and talks to the HyperEVM vault. They are deliberately separate
 * providers rather than one abstraction over "a wallet" — the two chains' signing,
 * address formats and session semantics have nothing in common, and pretending otherwise
 * produces a lowest-common-denominator interface that is wrong for both.
 *
 * `injected()` only, for now. WalletConnect needs a project id and a relay, which is
 * configuration the deployment does not have yet; adding it as a dead connector would
 * show users a button that cannot work.
 */
const config = createConfig({
  chains: [DEFAULT_CHAIN, DEFAULT_CHAIN.id === hyperEvm.id ? hyperEvmTestnet : hyperEvm],
  connectors: [injected()],
  transports: {
    [hyperEvm.id]: http(),
    [hyperEvmTestnet.id]: http(),
  },
  ssr: true,
});

export function EvmProvider({ children }: { children: React.ReactNode }) {
  // Created in state rather than at module scope. A module-level client is shared across
  // requests on the server, which leaks one user's cached data into another's render.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Chain reads are cheap and change on their own schedule; refetching on every
            // window focus makes a dashboard flicker without telling anyone anything new.
            refetchOnWindowFocus: false,
            staleTime: 10_000,
            retry: 1,
          },
        },
      })
  );

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
