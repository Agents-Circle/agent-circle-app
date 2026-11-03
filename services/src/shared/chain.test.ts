import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { chainFor, hyperEvm, hyperEvmTestnet } from "./chain.ts";

/**
 * The chain definitions are duplicated between the app and the services on purpose — one
 * is bundled by Next and reads `NEXT_PUBLIC_*`, the other is run by Node and does not.
 * What must never diverge is the ids, because `HLConstants` in the contracts resolves USDC
 * and the Core deposit wallet from `block.chainid`: a service pointed at the wrong id
 * writes a mirror of a chain nobody is trading on.
 */
test("chain ids match the app's definitions", async () => {
  const path = fileURLToPath(new URL("../../../lib/chains/hyperevm.ts", import.meta.url));
  const source = await readFile(path, "utf8");

  const ids = [...source.matchAll(/^\s*id:\s*(\d+),/gm)].map((match) => Number(match[1]));

  assert.deepEqual(ids, [hyperEvm.id, hyperEvmTestnet.id]);
  assert.deepEqual(ids, [999, 998]);
});

test("chainFor refuses an id it has no definition for", () => {
  assert.equal(chainFor(999).id, 999);
  assert.equal(chainFor(998).id, 998);
  assert.throws(() => chainFor(1), /unsupported chain id 1/);
});

test("testnet is marked as such", () => {
  // viem uses this to pick defaults, and more importantly the keeper's mainnet guard
  // keys off the configured network. Mislabelling testnet would make the guard a comment.
  assert.equal(hyperEvmTestnet.testnet, true);
  assert.notEqual(hyperEvm.testnet, true);
});
