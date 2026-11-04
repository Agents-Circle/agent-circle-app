"use client";

import { useState } from "react";
import type { Hex } from "viem";

import { DEFAULT_CHAIN } from "@/lib/chains/hyperevm";
import { deploymentFor } from "@/lib/contracts/addresses";
import { useGovernance, useListing } from "@/lib/contracts/useRegistry";
import { shortAddress } from "@/lib/format";
import {
  isListingId,
  registryTransaction,
  safeBatchFile,
  type BatchFile,
  type RegistryCall,
} from "@/lib/safeBatch";

/**
 * Approve or reject an on-chain listing, by exporting the call for the governance Safe.
 *
 * Nothing here signs or sends a transaction, and nothing could: `approveListing*` and
 * `rejectListing` are `onlyGovernance`, governance on mainnet must be a Safe multisig, and
 * the app never holds its key. The page writes a Safe Transaction Builder file instead, and
 * the signers load it into the Safe, check it and execute it.
 *
 * The listing is read from the chain first, because all three calls revert unless it is
 * in `Vetting`, and a file that can only revert costs the signers a round for nothing.
 */
export function ListingSafeExport() {
  const chain = DEFAULT_CHAIN;
  const registry = deploymentFor(chain.id)?.registry ?? null;
  const governance = useGovernance(chain.id);

  const [input, setInput] = useState("");
  const [saved, setSaved] = useState("");
  const trimmed = input.trim();
  const listingId = isListingId(trimmed) ? (trimmed.toLowerCase() as Hex) : undefined;
  const listing = useListing(listingId, chain.id);

  if (!registry) {
    return (
      <Section chainName={chain.name}>
        <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
          No AgentRegistry is configured for {chain.name}, so there is nothing to export a
          call against. Set <code>NEXT_PUBLIC_HL_{chain.testnet ? "TESTNET" : "MAINNET"}_REGISTRY</code>.
        </p>
      </Section>
    );
  }

  const exportCall = (call: RegistryCall, verb: "approve" | "reject", summary: string) => {
    const file = safeBatchFile({
      chainId: chain.id,
      safe: governance.address,
      name: `Agent Circle: ${verb} listing ${call.listingId.slice(0, 10)}`,
      description:
        `${summary} on AgentRegistry ${registry} (${chain.name}, chain ${chain.id}). ` +
        "Exported by the Agent Circle admin page, which holds no governance key. " +
        "Execute from the registry's governance account.",
      transactions: [registryTransaction(registry, call)],
    });
    const filename = `agent-registry-${verb}-${call.listingId.slice(0, 10)}-${chain.id}.json`;
    download(file, filename);
    setSaved(filename);
  };

  const vetting = listing.state?.status === "Vetting";

  return (
    <Section chainName={chain.name}>
      <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--muted)" }}>
        Listings are approved on chain by the registry&apos;s governance account, which on
        mainnet must be a Safe multisig. This page holds no governance key and sends nothing: it
        exports a Safe Transaction Builder file for the signers to load, check and execute.
      </p>

      <p className="mt-3 text-xs" style={{ color: "var(--muted)" }}>
        Governance:{" "}
        {governance.address ? (
          <>
            <span className="tabular">{governance.address}</span>
            {governance.isContract === true && " (a contract, expected to be the Safe)"}
            {governance.isContract === false &&
              " is a plain account (EOA) on this chain, so a Safe cannot load the file here. Its data field is the exact calldata that account would send."}
          </>
        ) : governance.isError ? (
          "could not be read."
        ) : (
          "reading…"
        )}
      </p>

      <label className="mt-5 block text-xs font-semibold" htmlFor="listing-id">
        Listing id
      </label>
      <input
        id="listing-id"
        className="mt-2 w-full rounded-xl border px-3 py-2 font-mono text-xs"
        style={{ borderColor: "var(--border-strong)", background: "var(--card-solid)" }}
        placeholder="0x… (32 bytes, from the builder's ListingSubmitted event)"
        spellCheck={false}
        autoComplete="off"
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
          setSaved("");
        }}
      />

      <div className="mt-3 text-sm" style={{ color: "var(--muted)" }} role="status">
        {trimmed && !listingId && "A listing id is 0x followed by 64 hex characters."}
        {listingId && listing.isLoading && `Reading the listing on ${chain.name}…`}
        {listingId && listing.isError && `Could not read the listing: ${errorLine(listing.error)}`}
        {listingId && listing.isSuccess && !listing.state && `No listing with this id on ${chain.name}.`}
        {listing.state && !vetting && (
          <>
            This listing is <strong>{listing.state.status}</strong>. Approve and reject apply only
            to a listing in Vetting; the registry would revert.
          </>
        )}
      </div>

      {listingId && listing.state && vetting && (
        <>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <dt style={{ color: "var(--muted)" }}>Status</dt>
            <dd>{listing.state.status}</dd>
            <dt style={{ color: "var(--muted)" }}>Builder</dt>
            <dd className="tabular">{listing.state.builder}</dd>
            <dt style={{ color: "var(--muted)" }}>Agent authority</dt>
            <dd className="tabular">{shortAddress(listing.state.agentAuthority)}</dd>
            <dt style={{ color: "var(--muted)" }}>Submitted</dt>
            <dd>{new Date(Number(listing.state.submittedAt) * 1000).toLocaleString()}</dd>
          </dl>

          <div className="mt-5 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() =>
                exportCall(
                  { method: "approveListingAtLaunchTerms", listingId },
                  "approve",
                  `Approve listing ${listingId} at the registry's launch terms`
                )
              }
              className="rounded-full px-5 py-2.5 text-xs font-semibold"
              style={{ background: "var(--positive)", color: "#04140c" }}
            >
              Export approval for the Safe
            </button>
            <button
              type="button"
              onClick={() =>
                exportCall({ method: "rejectListing", listingId }, "reject", `Reject listing ${listingId}`)
              }
              className="rounded-full border px-5 py-2.5 text-xs font-semibold"
              style={{ borderColor: "var(--negative)", color: "var(--negative)" }}
            >
              Export rejection for the Safe
            </button>
          </div>
          <p className="mt-3 text-xs" style={{ color: "var(--muted)" }}>
            Approval uses the registry&apos;s locked launch terms (
            <code>approveListingAtLaunchTerms</code>). Custom terms are not offered here.
          </p>
        </>
      )}

      {saved && (
        <p className="mt-4 text-sm" role="status">
          Saved <code>{saved}</code>. In the governance Safe, open the Transaction Builder app,
          drop the file in, check the method and listing id against this page, then create the
          batch and collect signatures.
        </p>
      )}
    </Section>
  );
}

function Section({ chainName, children }: { chainName: string; children: React.ReactNode }) {
  return (
    <section className="card-surface mt-8 p-6">
      <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--muted)" }}>
        On-chain listing · AgentRegistry on {chainName}
      </p>
      {children}
    </section>
  );
}

function errorLine(error: Error | null): string {
  if (!error) return "unknown error.";
  const short = (error as { shortMessage?: string }).shortMessage;
  return short ?? error.message.split("\n")[0];
}

function download(file: BatchFile, filename: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(file, null, 2)], { type: "application/json" })
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // Revoked after the click has had a chance to start the download, not during it.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
