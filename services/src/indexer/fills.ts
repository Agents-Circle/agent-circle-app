import type { SupabaseClient } from "@supabase/supabase-js";
import type { Address } from "viem";

import { requireWrite } from "../shared/db.ts";
import type { InfoApi, RawFill } from "../shared/hyperliquid.ts";
import type { Logger } from "../shared/log.ts";
import { PRICE_DECIMALS, SIZE_DECIMALS, USDC_DECIMALS, notionalUsdc, parseDecimal } from "../shared/units.ts";

/**
 * Fills, from the info API into `hl_fills`.
 *
 * This is the table every ranking claim rests on, so the transform below is the most
 * consequential twenty lines in the service and is the part with unit tests rather than
 * an integration test.
 */

export type FillRow = {
  vault_address: string;
  asset: number;
  coin: string;
  is_buy: boolean;
  size: string;
  price: string;
  notional: string;
  venue_fee: string;
  execution_fee: string;
  closed_pnl: string;
  order_id: number;
  cloid: string | null;
  filled_at: string;
};

/**
 * One raw fill to one row.
 *
 * Three decisions worth stating:
 *
 * **`side`.** Hyperliquid reports `"B"` for a buy and `"A"` for a sell — bid and ask, from
 * the resting order's point of view, which reads backwards until you know. Size is stored
 * signed so a close is distinguishable from an open without replaying position state.
 *
 * **`execution_fee` is always zero here.** Agent Circle's own fee does not exist per fill:
 * the vault charges it at `reconcile`, on `|szi_now - szi_last| * markPx` summed across
 * assets, and that quantity cannot be attributed to individual fills — a position opened
 * and closed between two reconciles is not billed at all. Writing an apportioned estimate
 * into a column named `execution_fee` would be inventing a number that does not reconcile
 * against the chain. The real figure is in `ExecutionFeeAccrued` and lands in
 * `agent_metrics_daily.fees_paid`.
 *
 * **An unknown coin throws.** A perp this map has never seen means the universe changed
 * under a running process; recording it against asset 0 would file BTC's fills under
 * whatever asset 0 happens to be.
 */
export function fillRow(
  raw: RawFill,
  vault: Address,
  assetIndexByCoin: Map<string, number>
): FillRow {
  const asset = assetIndexByCoin.get(raw.coin);
  if (asset === undefined) {
    throw new Error(`unknown coin ${raw.coin}; the perp universe changed, restart to reload it`);
  }

  const isBuy = raw.side === "B";
  const magnitude = parseDecimal(raw.sz, SIZE_DECIMALS);
  const price = parseDecimal(raw.px, PRICE_DECIMALS);

  return {
    vault_address: vault.toLowerCase(),
    asset,
    coin: raw.coin,
    is_buy: isBuy,
    size: (isBuy ? magnitude : -magnitude).toString(),
    price: price.toString(),
    notional: notionalUsdc(magnitude, price).toString(),
    venue_fee: parseDecimal(raw.fee, USDC_DECIMALS).toString(),
    execution_fee: "0",
    closed_pnl: parseDecimal(raw.closedPnl, USDC_DECIMALS).toString(),
    order_id: raw.oid,
    cloid: raw.cloid ?? null,
    filled_at: new Date(raw.time).toISOString(),
  };
}

/**
 * The timestamp to resume from, given a batch of fills.
 *
 * The **same** millisecond as the newest fill, not the next one: fills share timestamps,
 * and advancing past one would drop every other fill in that millisecond. The unique index
 * on `(vault_address, order_id)` makes re-reading them free, so the cursor errs toward
 * overlap deliberately.
 */
export function nextFillCursor(fills: RawFill[], previous: number): number {
  let newest = previous;
  for (const fill of fills) if (fill.time > newest) newest = fill.time;
  return newest;
}

export async function syncFills(
  info: InfoApi,
  db: SupabaseClient,
  log: Logger,
  args: {
    vaults: Address[];
    assetIndexByCoin: Map<string, number>;
    sinceMs: number;
    untilMs: number;
  }
): Promise<{ inserted: number; cursorMs: number }> {
  let inserted = 0;
  let cursorMs = args.sinceMs;

  for (const vault of args.vaults) {
    const raw = await info.userFills(vault, args.sinceMs, args.untilMs);
    if (raw.length === 0) continue;

    const rows = raw.map((fill) => fillRow(fill, vault, args.assetIndexByCoin));

    requireWrite(
      "upserting fills",
      await db
        .from("hl_fills")
        // The unique index is partial — `where order_id is not null` — so the conflict
        // target has to name the same columns and Postgres matches it to that index.
        .upsert(rows, { onConflict: "vault_address,order_id", ignoreDuplicates: true })
    );

    inserted += rows.length;
    cursorMs = Math.max(cursorMs, nextFillCursor(raw, args.sinceMs));
    log.debug("fills synced", { vault, count: rows.length });
  }

  return { inserted, cursorMs };
}
