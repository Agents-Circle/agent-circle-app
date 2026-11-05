import {
  encodeFunctionData,
  getAbiItem,
  keccak256,
  stringToHex,
  type AbiFunction,
  type AbiParameter,
  type Address,
  type Hex,
} from "viem";

// The generated file itself rather than the `./contracts/abis` barrel, and with its
// extension: `npm test` runs this module under plain Node, which resolves neither.
import { AgentRegistryAbi } from "./contracts/abis/AgentRegistry.ts";

/**
 * AgentRegistry governance calls, written as Safe Transaction Builder batch files.
 *
 * Listings are approved and rejected by the registry's governance account, which on
 * mainnet must be a Safe multisig and never a key the app holds. So the admin page
 * sends nothing: it writes the call in the file format the Safe's Transaction Builder app
 * imports, and the signers load it, check it and execute it from the Safe.
 *
 * The format is the Builder's own `BatchFile` (safe-global/safe-react-apps,
 * apps/tx-builder/src/typings/models.ts). Each transaction carries both
 * - `data`, the exact calldata. When it is present the Builder executes it as given,
 *   rather than re-encoding anything; and
 * - `contractMethod` and `contractInputsValues`, the method and arguments that calldata
 *   encodes, taken from the synced ABI, for a signer to read and check it against.
 */

export type ContractInput = {
  internalType: string;
  name: string;
  type: string;
  components?: ContractInput[];
};

export type ContractMethod = {
  inputs: ContractInput[];
  name: string;
  payable: boolean;
};

export type BatchTransaction = {
  to: Address;
  /** Wei, as a decimal string. The Builder refuses numbers here. */
  value: string;
  data: Hex;
  contractMethod: ContractMethod;
  /** Every value a string, as the Builder requires; a tuple is a JSON array. */
  contractInputsValues: Record<string, string>;
};

export type BatchFile = {
  version: "1.0";
  /** Decimal string, as the Builder writes it. */
  chainId: string;
  /** Milliseconds since the epoch. */
  createdAt: number;
  meta: {
    name: string;
    description: string;
    createdFromSafeAddress: string;
    createdFromOwnerAddress: string;
    checksum?: Hex;
  };
  transactions: BatchTransaction[];
};

/** Mirrors `IAgentRegistry.Terms`, in its field order. */
export type ListingTerms = {
  performanceFeeBps: number;
  builderSplitBps: number;
  executionFeeBps: number;
  executionBuilderSplitBps: number;
  positionCapBps: number;
  maxDrawdownBps: number;
};

/**
 * The governance calls the admin page can export. All three revert unless the listing
 * is in `Vetting`, so the page checks that on chain before offering them.
 */
export type RegistryCall =
  | { method: "approveListingAtLaunchTerms"; listingId: Hex }
  | { method: "approveListing"; listingId: Hex; terms: ListingTerms }
  | { method: "rejectListing"; listingId: Hex };

export function isListingId(value: string): value is Hex {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function encode(call: RegistryCall): { args: readonly unknown[]; data: Hex } {
  switch (call.method) {
    case "approveListingAtLaunchTerms": {
      const args = [call.listingId] as const;
      return { args, data: encodeFunctionData({ abi: AgentRegistryAbi, functionName: call.method, args }) };
    }
    case "rejectListing": {
      const args = [call.listingId] as const;
      return { args, data: encodeFunctionData({ abi: AgentRegistryAbi, functionName: call.method, args }) };
    }
    case "approveListing": {
      const args = [call.listingId, call.terms] as const;
      return { args, data: encodeFunctionData({ abi: AgentRegistryAbi, functionName: call.method, args }) };
    }
  }
}

function toContractInput(param: AbiParameter): ContractInput {
  const components = "components" in param ? param.components : undefined;
  return {
    internalType: param.internalType ?? param.type,
    name: param.name ?? "",
    type: param.type,
    ...(components ? { components: components.map(toContractInput) } : {}),
  };
}

/// How the Builder's input form writes a value: strings throughout, and a tuple as a
/// JSON array in component order, which is what it `JSON.parse`s back.
function inputValue(param: AbiParameter, arg: unknown): string {
  if (param.type === "tuple" && "components" in param) {
    const fields = arg as Record<string, unknown>;
    return JSON.stringify(param.components.map((c) => String(fields[c.name ?? ""])));
  }
  return String(arg);
}

export function registryTransaction(registry: Address, call: RegistryCall): BatchTransaction {
  if (!isListingId(call.listingId)) {
    throw new Error(`Not a listing id (expected 32 bytes of hex): ${call.listingId}`);
  }

  const { args, data } = encode(call);
  const method = getAbiItem({ abi: AgentRegistryAbi, name: call.method }) as AbiFunction;

  return {
    to: registry,
    value: "0",
    data,
    contractMethod: {
      inputs: method.inputs.map(toContractInput),
      name: method.name,
      payable: method.stateMutability === "payable",
    },
    contractInputsValues: Object.fromEntries(
      method.inputs.map((param, i) => [param.name ?? String(i), inputValue(param, args[i])])
    ),
  };
}

export function safeBatchFile({
  chainId,
  safe,
  name,
  description,
  transactions,
  createdAt = Date.now(),
}: {
  chainId: number;
  /** The account expected to execute the batch: the registry's governance. */
  safe?: Address;
  name: string;
  description: string;
  transactions: BatchTransaction[];
  createdAt?: number;
}): BatchFile {
  const file: BatchFile = {
    version: "1.0",
    chainId: String(chainId),
    createdAt,
    meta: {
      name,
      description,
      createdFromSafeAddress: safe ?? "",
      createdFromOwnerAddress: "",
    },
    transactions,
  };
  return { ...file, meta: { ...file.meta, checksum: batchChecksum(file) } };
}

/**
 * The Builder's checksum (apps/tx-builder/src/lib/checksum.ts), ported exactly.
 *
 * On import it deletes `meta.checksum`, recomputes this and shows a "this file was
 * modified" warning on a mismatch. Matching it means a signer who sees that warning on
 * one of our files knows the file really was changed after export.
 *
 * keccak256 of a key-sorted serialisation, with `meta.name` nulled so a batch can be
 * renamed. The format is the Builder's own, trailing commas included.
 */
export function batchChecksum(file: BatchFile): Hex {
  return keccak256(stringToHex(serialize({ ...file, meta: { ...file.meta, name: null } })));
}

const replacer = (_key: string, value: unknown) => (value === undefined ? null : value);

function serialize(json: unknown): string {
  if (Array.isArray(json)) {
    return `[${json.map(serialize).join(",")}]`;
  }
  if (typeof json === "object" && json !== null) {
    const record = json as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    let out = `{${JSON.stringify(keys, replacer)}`;
    for (const key of keys) out += `${serialize(record[key])},`;
    return `${out}}`;
  }
  return `${JSON.stringify(json, replacer)}`;
}
