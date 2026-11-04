import { createPublicClient, http } from "viem";

import { formatScaled, PRICE_DECIMALS } from "../shared/units.ts";
import { ELYSIUM_TESTNET, elysiumTestnet, listAscendPools, readPool, spotPrice, tokenInfo } from "./ascend.ts";
import { hyperCoreAvailability } from "./core.ts";

/**
 * What an Elysium/Ascend bracket would trade, today.
 *
 *     npm run elysium:pools
 *
 * Read-only: lists Ascend's pools on Elysium testnet with spot price, LP fee and
 * liquidity, and says whether HyperCore has reached the chain. No key, no transaction.
 */

async function main(): Promise<void> {
  const rpc = process.env.ELYSIUM_RPC_URL ?? elysiumTestnet.rpcUrls.default.http[0];
  const client = createPublicClient({ chain: elysiumTestnet, transport: http(rpc) });

  const core = await hyperCoreAvailability(client);
  if (core.chainId !== elysiumTestnet.id) throw new Error(`${rpc} is chain ${core.chainId}, not Elysium testnet`);
  console.log(`Elysium testnet (${core.chainId}): CoreWriter ${core.coreWriter ? "present" : "absent"}, HyperCore read precompiles ${core.readPrecompiles ? `answering (L1 block ${core.l1Block})` : "absent"}`);

  const { poolManager, ascendHook, quoteToken, fromBlock } = ELYSIUM_TESTNET;
  const quote = await tokenInfo(client, quoteToken);
  const pools = await listAscendPools(client, { poolManager, hook: ascendHook, quote: quoteToken, fromBlock });
  console.log(`${pools.length} Ascend pools quoted in ${quote.symbol} (${quoteToken})`);

  for (const pool of pools) {
    const [state, token] = await Promise.all([readPool(client, poolManager, pool.id), tokenInfo(client, pool.token)]);
    const px = spotPrice(state.sqrtPriceX96, pool.tokenIsCurrency0, token.decimals, quote.decimals);
    console.log(
      [
        token.symbol.padEnd(8),
        pool.token,
        `spot ${formatScaled(px, PRICE_DECIMALS)} ${quote.symbol}`,
        `lp fee ${(state.lpFeePpm / 10_000).toFixed(2)}%${pool.dynamicFee ? " (dynamic)" : ""}`,
        `liquidity ${state.liquidity}`,
        `since block ${pool.initializedAtBlock}`,
      ].join("  ")
    );
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
