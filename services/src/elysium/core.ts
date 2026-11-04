import type { Address, PublicClient } from "viem";

/**
 * Has HyperCore reached this chain yet?
 *
 * The vault's whole design needs two things HyperEVM has: CoreWriter at `0x3333…3333`
 * and the read precompiles at `0x800`–`0x813`. Kinetiq plans an `ElysiumCoreWriter` and a
 * HyperCore data precompile for Elysium about four weeks after mainnet, which is the
 * trigger for Option B in `research/parked/elysium-fork-design.md` (port `HLAgentVault`).
 *
 * Code size is no test: HyperEVM's precompiles have no code either. Calling one is. The
 * L1 block number precompile (`0x809`) takes no input and answers 32 bytes on HyperEVM
 * (verified on testnet 2026-11-04); on a chain without HyperCore the call returns empty.
 * CoreWriter is a real contract, so for it code size is the test.
 */

export const CORE_WRITER: Address = "0x3333333333333333333333333333333333333333";
export const L1_BLOCK_NUMBER_PRECOMPILE: Address = "0x0000000000000000000000000000000000000809";

export type CoreAvailability = { chainId: number; coreWriter: boolean; readPrecompiles: boolean; l1Block: bigint | null };

export async function hyperCoreAvailability(client: PublicClient): Promise<CoreAvailability> {
  const [chainId, code, call] = await Promise.all([
    client.getChainId(),
    client.getCode({ address: CORE_WRITER }),
    client.call({ to: L1_BLOCK_NUMBER_PRECOMPILE, data: "0x" }).catch(() => ({ data: undefined })),
  ]);
  const data = call.data;
  const answered = data !== undefined && data.length === 66;
  return {
    chainId,
    coreWriter: code !== undefined && code !== "0x",
    readPrecompiles: answered,
    l1Block: answered ? BigInt(data) : null,
  };
}
