import { recoverMessageAddress } from "viem";

import {
  VETTING_CLOCK_SKEW_MS,
  VETTING_SIGNATURE_MAX_AGE_MS,
  vettingMessage,
  type VettingAction,
} from "@/lib/adminVetting";
import { adminConfig } from "@/lib/supabaseAdmin";

/**
 * Approve or reject an agent in the vetting queue.
 *
 * This replaced the browser calling `approve_agent` / `reject_agent` with the anon key
 * and an access code, which let anyone with the code (or the patience to guess it) set an
 * agent live. Those RPCs are now executable only by service_role, which only this route
 * holds, and it acts only on a fresh signature from a wallet in `ADMIN_WALLETS`.
 *
 * EOA signatures only: `recoverMessageAddress` cannot verify an ERC-1271 (Safe)
 * signature. An admin Safe needs an on-chain `isValidSignature` check added here.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNATURE = /^0x[0-9a-f]+$/i;

function fail(status: number, error: string) {
  return Response.json({ error }, { status });
}

export async function POST(request: Request) {
  const config = adminConfig();
  if (!config) return fail(503, "Admin vetting is not configured on this deployment.");

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return fail(400, "Expected a JSON body.");
  }

  const { action, agentId, issuedAt, signature } = body;
  if (action !== "approve" && action !== "reject") return fail(400, "Unknown action.");
  if (typeof agentId !== "string" || !UUID.test(agentId)) return fail(400, "Bad agent id.");
  if (typeof issuedAt !== "string") return fail(400, "Missing issuedAt.");
  if (typeof signature !== "string" || !SIGNATURE.test(signature)) {
    return fail(400, "Missing signature.");
  }

  const issued = Date.parse(issuedAt);
  const age = Date.now() - issued;
  if (Number.isNaN(issued) || age > VETTING_SIGNATURE_MAX_AGE_MS || age < -VETTING_CLOCK_SKEW_MS) {
    return fail(401, "Signature expired. Sign again.");
  }

  let signer: string;
  try {
    signer = await recoverMessageAddress({
      // Rebuilt from the validated fields, never taken from the client.
      message: vettingMessage(action as VettingAction, agentId, issuedAt),
      signature: signature as `0x${string}`,
    });
  } catch {
    return fail(401, "Signature could not be verified.");
  }
  if (!config.adminWallets.has(signer.toLowerCase())) {
    return fail(403, "This wallet is not an admin.");
  }

  const { data, error } = await config.supabase.rpc(
    action === "approve" ? "approve_agent" : "reject_agent",
    { p_agent_id: agentId, p_code: config.vettingCode }
  );

  if (error) {
    // The code is server configuration now, so a rejection is a deployment problem, not
    // something the admin can fix by typing again.
    if (error.message.includes("Invalid access code")) {
      console.error("admin vetting: ADMIN_VETTING_CODE rejected by the database");
      return fail(500, "Server's vetting code is misconfigured.");
    }
    return fail(502, error.message);
  }

  return Response.json({ handled: Boolean(data) });
}
