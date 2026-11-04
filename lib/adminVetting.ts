/**
 * The admin vetting request, shared by the admin page (which signs it) and the server
 * route (which verifies it).
 *
 * The server never trusts a message string from the client. It rebuilds the message from
 * the validated fields and recovers the signer from that, so a signature only ever
 * authorises the exact action, agent and time it names.
 */

export type VettingAction = "approve" | "reject";

export type VettingRequest = {
  action: VettingAction;
  agentId: string;
  /** ISO 8601, set by the signer. Bounds how long a captured signature stays usable. */
  issuedAt: string;
  signature: `0x${string}`;
};

/// How old a signature may be. A replay inside this window can only repeat the same
/// action on the same agent, which the RPCs treat as already handled.
export const VETTING_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

/// Allowance for the admin's clock running ahead of the server's.
export const VETTING_CLOCK_SKEW_MS = 60 * 1000;

export function vettingMessage(action: VettingAction, agentId: string, issuedAt: string): string {
  return [
    "Agent Circle admin",
    `Action: ${action}`,
    `Agent: ${agentId}`,
    `Issued: ${issuedAt}`,
  ].join("\n");
}
