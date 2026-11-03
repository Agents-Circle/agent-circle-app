import assert from "node:assert/strict";
import { test } from "node:test";

import { serialiseArgs } from "./events.ts";

test("every value crosses into jsonb as a string", () => {
  // A uint64 of USDC passes 2^53 at about nine billion dollars. Storing it as a jsonb
  // number means `JSON.parse` rounds it on the way back out, and the rounding lands in
  // the fee accounting.
  const big = 9_007_199_254_740_993n; // 2^53 + 1, the first integer a double cannot hold
  const args = serialiseArgs({ equity: big, asset: 3, isBuy: true, reason: "expired" });

  assert.deepEqual(args, {
    equity: "9007199254740993",
    asset: "3",
    isBuy: "true",
    reason: "expired",
  });
  assert.equal(BigInt(args.equity!), big);
});

test("absent values are left out rather than stringified", () => {
  // `String(undefined)` is "undefined", which would be stored and then read back as a
  // seven-character number.
  assert.deepEqual(serialiseArgs({ cloid: undefined, reason: null, asset: 0 }), { asset: "0" });
});

test("a log with no decoded args is an empty object, not a crash", () => {
  assert.deepEqual(serialiseArgs(undefined), {});
  assert.deepEqual(serialiseArgs(null), {});
});
