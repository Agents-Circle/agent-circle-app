import type { Address, PublicClient } from "viem";

import { HLMarketWhitelistAbi } from "../abis/index.ts";
import type { InfoApi } from "../shared/hyperliquid.ts";
import { USDC_DECIMALS, parseDecimal } from "../shared/units.ts";
import { capBreached, type VaultSnapshot } from "./policy.ts";

/**
 * Fast-mode position monitoring.
 *
 * In vault mode every order passes the position cap before CoreWriter sees it, so there is
 * nothing to monitor — the contract already said no. Fast mode exists because builder
 * codes require an off-chain signature, which means orders reach HyperCore without passing
 * through the vault at all, which means the cap is a thing we observe rather than enforce.
 *
 * **And observing it is all that can be done.** There is no call the keeper is authorised
 * to make that reduces an oversized position: `pause` is `onlyTrader` and `cancelOrder` is
 * `onlyTraderOrAgent`. A detected cap breach produces a record and an alert, and the
 * remedies are the trader's (pause, withdraw) and governance's (suspend the listing). This
 * is precisely the asymmetry a trader accepts by typing "monitored, not enforced", and
 * pretending otherwise in the code would make that consent meaningless.
 */

export type PositionReport = {
  /** Total mark-to-market value of every open position, USDC at 1e6. */
  positionValue: bigint;
  /** Core's own account value, USDC at 1e6. For cross-checking the precompile read. */
  accountValue: bigint;
  assets: { coin: string; value: bigint }[];
};

export async function readPositions(
  info: InfoApi,
  vault: string
): Promise<PositionReport> {
  const state = await info.clearinghouseState(vault);

  const assets = state.assetPositions.map((entry) => ({
    coin: entry.position.coin,
    value: parseDecimal(entry.position.positionValue, USDC_DECIMALS),
  }));

  return {
    positionValue: assets.reduce((total, asset) => total + asset.value, 0n),
    accountValue: parseDecimal(state.marginSummary.accountValue, USDC_DECIMALS),
    assets,
  };
}

/**
 * The cap that actually applies, which is the strictest of the vault's own and the
 * whitelist's per-asset ones.
 *
 * The contract evaluates `effectiveCapBps(asset, vaultCapBps)` for the asset being traded
 * and compares it against the vault's *total* position value. A vault holding two assets
 * is therefore subject to whichever of their caps is tighter, and taking the minimum is
 * what mirrors that. Without a whitelist address configured, the vault's own cap is used
 * and the monitor is permissive by exactly the amount governance has tightened — which is
 * why the address belongs in the environment even though only this path reads it.
 */
export async function effectiveCapBps(
  client: PublicClient,
  whitelist: Address | null,
  snapshot: VaultSnapshot,
  assetIndexByCoin: Map<string, number>,
  report: PositionReport
): Promise<bigint> {
  if (whitelist === null || report.assets.length === 0) return snapshot.positionCapBps;

  const caps = await Promise.all(
    report.assets.map(async (asset) => {
      const index = assetIndexByCoin.get(asset.coin);
      if (index === undefined) return snapshot.positionCapBps;

      return (await client.readContract({
        address: whitelist,
        abi: HLMarketWhitelistAbi,
        functionName: "effectiveCapBps",
        args: [index, Number(snapshot.positionCapBps)],
      })) as bigint | number;
    })
  );

  return caps.reduce<bigint>(
    (strictest, cap) => (BigInt(cap) < strictest ? BigInt(cap) : strictest),
    snapshot.positionCapBps
  );
}

export type Breach = {
  capBps: bigint;
  positionValue: bigint;
  equity: bigint;
  reserved: bigint;
  assets: { coin: string; value: bigint }[];
};

export function checkCap(
  snapshot: VaultSnapshot,
  report: PositionReport,
  capBps: bigint
): Breach | null {
  // The precompile read is the one the contract itself uses, so it is the one the cap is
  // judged against. `accountValue` from the info API is kept in the report for comparison
  // and deliberately not substituted here.
  const equity = snapshot.equity;
  if (equity === null) return null;

  if (!capBreached(equity, snapshot.reserved, report.positionValue, capBps)) return null;

  return {
    capBps,
    positionValue: report.positionValue,
    equity,
    reserved: snapshot.reserved,
    assets: report.assets,
  };
}
