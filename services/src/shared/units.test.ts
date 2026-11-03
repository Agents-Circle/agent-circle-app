import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BPS,
  drawdownBps,
  formatScaled,
  notionalUsdc,
  parseDecimal,
  returnBps,
} from "./units.ts";

test("parseDecimal scales whole numbers", () => {
  assert.equal(parseDecimal("1", 8), 100_000_000n);
  assert.equal(parseDecimal("0", 6), 0n);
  assert.equal(parseDecimal("109342", 8), 10_934_200_000_000n);
});

test("parseDecimal keeps every digit it is given room for", () => {
  assert.equal(parseDecimal("0.00000001", 8), 1n);
  assert.equal(parseDecimal("1.23456789", 8), 123_456_789n);
  assert.equal(parseDecimal("-1.5", 6), -1_500_000n);
});

test("parseDecimal does not lose precision the way a float would", () => {
  // 0.1 + 0.2 territory: this price times this size is exact in integers and is not
  // representable in binary floating point.
  const price = parseDecimal("109342.07", 8);
  const size = parseDecimal("0.03", 8);
  assert.equal(notionalUsdc(size, price), 3_280_262_100n); // 3280.262100 USDC, exactly

  // And where the product does not fit 1e6, it truncates rather than rounding up.
  assert.equal(notionalUsdc(parseDecimal("0.000003", 8), price), 328_026n); // 0.32802621
});

test("parseDecimal truncates toward zero, never away from it", () => {
  // More decimals than the scale holds. The lost magnitude is below 1e-6 USDC and the
  // error is always against us: a fee reads low, never high.
  assert.equal(parseDecimal("0.0000005", 6), 0n);
  assert.equal(parseDecimal("-0.0000005", 6), 0n);
  assert.equal(parseDecimal("1.9999999", 6), 1_999_999n);
  assert.equal(parseDecimal("-1.9999999", 6), -1_999_999n);
});

test("parseDecimal accepts the shapes the API actually sends", () => {
  assert.equal(parseDecimal("109342.0", 8), 10_934_200_000_000n);
  assert.equal(parseDecimal(".5", 8), 50_000_000n);
  assert.equal(parseDecimal("1.", 8), 100_000_000n);
  assert.equal(parseDecimal("  2.5  ", 8), 250_000_000n);
});

test("parseDecimal rejects anything it would have to guess at", () => {
  for (const bad of ["", "abc", "1e-8", "1,5", "0x10", "--1", "1.2.3", "Infinity", "NaN"]) {
    assert.throws(() => parseDecimal(bad, 8), /not a plain decimal/, `accepted ${bad}`);
  }
});

test("notionalUsdc converts 1e8 size and price to 1e6 USDC", () => {
  assert.equal(notionalUsdc(parseDecimal("2", 8), parseDecimal("3.5", 8)), 7_000_000n);
  // Sign of the size does not change the notional: a sell of 2 is the same money as a buy.
  assert.equal(notionalUsdc(parseDecimal("-2", 8), parseDecimal("3.5", 8)), 7_000_000n);
});

test("notionalUsdc uses the same divisor the vault reserves with", () => {
  // `SZ_PX_TO_USDC` is 1e10 in HLAgentVault. A reservation of 1 BTC at 100,000 is
  // 100,000 USDC on both sides, and the keeper compares the two.
  const size = parseDecimal("1", 8);
  const price = parseDecimal("100000", 8);
  assert.equal(notionalUsdc(size, price), 100_000_000_000n);
});

test("drawdownBps mirrors HighWaterMark.drawdownBps", () => {
  assert.equal(drawdownBps(100n, 100n), 0n);
  assert.equal(drawdownBps(110n, 100n), 0n); // above the mark is not a drawdown
  assert.equal(drawdownBps(90n, 100n), 1_000n);
  assert.equal(drawdownBps(0n, 100n), BPS); // total loss is 100%
  assert.equal(drawdownBps(50n, 0n), 0n); // no mark yet
});

test("drawdownBps truncates, like integer division on-chain", () => {
  // 1/3 of the mark lost is 3333.33 bps; Solidity reports 3333 and so must this, or the
  // keeper's "near the limit" test disagrees with the contract's "at the limit" test.
  assert.equal(drawdownBps(2n, 3n), 3_333n);
});

test("returnBps is zero when there was nothing to return on", () => {
  assert.equal(returnBps(0n, 1_000n), 0n);
  assert.equal(returnBps(1_000n, 1_100n), 1_000n);
  assert.equal(returnBps(1_000n, 900n), -1_000n);
});

test("formatScaled round-trips what parseDecimal reads", () => {
  for (const value of ["0.00000001", "1.23456789", "-1.5", "109342.07"]) {
    const scaled = parseDecimal(value, 8);
    assert.equal(parseDecimal(formatScaled(scaled, 8), 8), scaled);
  }
  assert.equal(formatScaled(1n, 6), "0.000001");
  assert.equal(formatScaled(-1_500_000n, 6), "-1.500000");
});
