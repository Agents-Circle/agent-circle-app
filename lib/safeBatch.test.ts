import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, encodeFunctionData, keccak256, stringToHex, type Hex } from "viem";

import { AgentRegistryAbi } from "./contracts/abis/AgentRegistry.ts";
import {
  batchChecksum,
  registryTransaction,
  safeBatchFile,
  type BatchFile,
  type BatchTransaction,
  type ListingTerms,
} from "./safeBatch.ts";

/** HyperEVM testnet (chain 998), deployed 4 November 2026. */
const REGISTRY = "0x6757474DDC00CDa23F497faC09A2CD4B27117aCe";
const LISTING = keccak256(stringToHex("a listing id"));

/**
 * What the Transaction Builder does with a transaction that has no `data`: parse each
 * input value the way its form does (a tuple is `JSON.parse`d, an integer becomes a big
 * number) and encode the call from `contractMethod`. If this matches `data`, the method
 * and arguments a signer reads are the call that executes.
 */
function builderEncoding(tx: BatchTransaction): Hex {
  const { contractMethod, contractInputsValues } = tx;
  const args = contractMethod.inputs.map((input) => {
    const value = contractInputsValues[input.name]!;
    if (input.type !== "tuple") return value;
    return (JSON.parse(value) as string[]).map((field) => BigInt(field));
  });
  return encodeFunctionData({
    abi: [
      {
        type: "function",
        name: contractMethod.name,
        inputs: contractMethod.inputs,
        outputs: [],
        stateMutability: contractMethod.payable ? "payable" : "nonpayable",
      },
    ],
    args,
  });
}

test("approveListingAtLaunchTerms calldata decodes back to the method and listing id", () => {
  const tx = registryTransaction(REGISTRY, {
    method: "approveListingAtLaunchTerms",
    listingId: LISTING,
  });

  const decoded = decodeFunctionData({ abi: AgentRegistryAbi, data: tx.data });
  assert.equal(decoded.functionName, "approveListingAtLaunchTerms");
  assert.deepEqual(decoded.args, [LISTING]);

  assert.equal(tx.to, REGISTRY);
  assert.equal(tx.value, "0");
  assert.deepEqual(tx.contractMethod, {
    inputs: [{ internalType: "bytes32", name: "id", type: "bytes32" }],
    name: "approveListingAtLaunchTerms",
    payable: false,
  });
  assert.deepEqual(tx.contractInputsValues, { id: LISTING });
  assert.equal(builderEncoding(tx), tx.data);
});

test("rejectListing calldata decodes back to the method and listing id", () => {
  const tx = registryTransaction(REGISTRY, { method: "rejectListing", listingId: LISTING });

  const decoded = decodeFunctionData({ abi: AgentRegistryAbi, data: tx.data });
  assert.equal(decoded.functionName, "rejectListing");
  assert.deepEqual(decoded.args, [LISTING]);
  assert.deepEqual(tx.contractInputsValues, { id: LISTING });
  assert.equal(builderEncoding(tx), tx.data);
});

test("approveListing calldata decodes back to the listing id and every term", () => {
  const terms: ListingTerms = {
    performanceFeeBps: 2000,
    builderSplitBps: 5000,
    executionFeeBps: 10,
    executionBuilderSplitBps: 5000,
    positionCapBps: 1200,
    maxDrawdownBps: 3000,
  };
  const tx = registryTransaction(REGISTRY, { method: "approveListing", listingId: LISTING, terms });

  const decoded = decodeFunctionData({ abi: AgentRegistryAbi, data: tx.data });
  assert.equal(decoded.functionName, "approveListing");
  assert.deepEqual(decoded.args, [LISTING, terms]);

  // The tuple goes to the Builder in `IAgentRegistry.Terms` field order, as strings.
  assert.equal(tx.contractInputsValues.terms, '["2000","5000","10","5000","1200","3000"]');
  assert.deepEqual(
    tx.contractMethod.inputs[1]!.components!.map((c) => c.name),
    Object.keys(terms)
  );
  assert.equal(builderEncoding(tx), tx.data);
});

test("refuses anything that is not a 32-byte listing id", () => {
  for (const listingId of ["0x1234", `${LISTING}00`, LISTING.slice(2), `0x${"zz".repeat(32)}`]) {
    assert.throws(
      () => registryTransaction(REGISTRY, { method: "rejectListing", listingId: listingId as Hex }),
      /Not a listing id/
    );
  }
});

test("the batch file is a Transaction Builder batch for chain 998", () => {
  const governance = "0x000000000000000000000000000000000000dEaD";
  const file = safeBatchFile({
    chainId: 998,
    safe: governance,
    name: "Approve listing",
    description: "test",
    transactions: [registryTransaction(REGISTRY, { method: "approveListingAtLaunchTerms", listingId: LISTING })],
    createdAt: 1_793_786_000_000,
  });

  assert.equal(file.version, "1.0");
  assert.equal(file.chainId, "998");
  assert.equal(file.meta.createdFromSafeAddress, governance);
  assert.equal(file.transactions.length, 1);

  // The Builder rejects a batch that encodes any value or input as a JSON number.
  const parsed = JSON.parse(JSON.stringify(file)) as BatchFile;
  for (const tx of parsed.transactions) {
    assert.equal(typeof tx.value, "string");
    for (const value of Object.values(tx.contractInputsValues)) assert.equal(typeof value, "string");
  }
});

test("the checksum survives the file being written and read, as the Builder checks it", () => {
  const file = safeBatchFile({
    chainId: 998,
    name: "Reject listing",
    description: "test",
    transactions: [registryTransaction(REGISTRY, { method: "rejectListing", listingId: LISTING })],
  });

  // validateChecksum: delete meta.checksum from what was read, recompute, compare.
  const read = JSON.parse(JSON.stringify(file, null, 2)) as BatchFile;
  const { checksum, ...meta } = read.meta;
  assert.equal(batchChecksum({ ...read, meta }), checksum);

  // The name is excluded, so a renamed batch still validates; anything else is not.
  assert.equal(batchChecksum({ ...read, meta: { ...meta, name: "renamed" } }), checksum);
  assert.notEqual(batchChecksum({ ...read, chainId: "999", meta }), checksum);
});

test("the checksum matches the Transaction Builder's own test vector", () => {
  // Fixture and expected value from safe-global/safe-react-apps,
  // apps/tx-builder/src/lib/checksum.test.js (MIT). It includes a raw-data transaction
  // and a method-only one, which our files never contain, so it is typed loosely.
  const fixture = {
    version: "1.0",
    chainId: "4",
    createdAt: 1646321521061,
    meta: {
      name: "test batch file",
      txBuilderVersion: "1.4.0",
      checksum: "",
      createdFromSafeAddress: "0xDF8a1Ce35c9a6ACE153B4e0767942f1E2291a1Aa",
      createdFromOwnerAddress: "0x49d4450977E2c95362C13D3a31a09311E0Ea26A6",
    },
    transactions: [
      {
        to: "0x49d4450977E2c95362C13D3a31a09311E0Ea26A6",
        value: "0",
        contractMethod: {
          inputs: [{ internalType: "address", name: "paramAddress", type: "address" }],
          name: "testAddress",
          payable: false,
        },
        contractInputsValues: { paramAddress: "0x49d4450977E2c95362C13D3a31a09311E0Ea26A6" },
      },
      {
        to: "0x49d4450977E2c95362C13D3a31a09311E0Ea26A6",
        value: "0",
        contractMethod: {
          inputs: [{ internalType: "bool", name: "paramBool", type: "bool" }],
          name: "testBool",
          payable: false,
        },
        contractInputsValues: { paramAddress: "", paramBool: "false" },
      },
      {
        to: "0x49d4450977E2c95362C13D3a31a09311E0Ea26A6",
        value: "2000000000000000000",
        data: "0x42f4579000000000000000000000000049d4450977e2c95362c13d3a31a09311e0ea26a6",
      },
    ],
  } as unknown as BatchFile;

  assert.equal(
    batchChecksum(fixture),
    "0x4ecbfd364aa6759983915644e73f8bd411e85a2dc306f252a387c2728c4db64c"
  );
});
