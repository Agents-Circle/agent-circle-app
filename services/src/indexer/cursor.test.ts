import assert from "node:assert/strict";
import { test } from "node:test";

import { blockRanges } from "./cursor.ts";

test("blockRanges covers the span exactly once", () => {
  const ranges = blockRanges(0n, 9n, 4n);
  assert.deepEqual(ranges, [
    { from: 0n, to: 3n },
    { from: 4n, to: 7n },
    { from: 8n, to: 9n },
  ]);

  // No gaps and no overlaps: every block appears in exactly one range.
  const seen: bigint[] = [];
  for (const range of ranges) for (let b = range.from; b <= range.to; b += 1n) seen.push(b);
  assert.deepEqual(seen, [0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n]);
});

test("blockRanges handles a span smaller than one chunk", () => {
  assert.deepEqual(blockRanges(5n, 5n, 2000n), [{ from: 5n, to: 5n }]);
});

test("blockRanges returns nothing when the head is behind the cursor", () => {
  // Happens on a chain that was reset under a running indexer. Scanning backwards would
  // be worse than doing nothing.
  assert.deepEqual(blockRanges(10n, 9n, 100n), []);
});
