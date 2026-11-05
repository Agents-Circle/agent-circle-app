import assert from "node:assert/strict";
import { test } from "node:test";

import { priceIsValid as arenaPriceIsValid, sizeIsValid as arenaSizeIsValid } from "../../../services/src/arena/market.ts";
import { cloidHex, fromE8, newCloid, priceIsValid, roundPrice, roundSize, sizeForNotional, toE8 } from "./units.ts";

test("decimal strings convert to 1e8 exactly, or not at all", () => {
  assert.equal(toE8("100000.5"), 10_000_050_000_000n);
  assert.equal(toE8("0.00000001"), 1n);
  assert.equal(fromE8(10_000_050_000_000n), "100000.5");
  assert.equal(fromE8(100_000_000n), "1");
  assert.equal(fromE8(-150_000_000n), "-1.5");
  for (const bad of ["1.123456789", "-1", "0", "1e3", "", " 1", "1.", ".5", "0x10"]) {
    assert.throws(() => toE8(bad), RangeError, bad);
  }
});

test("rounded prices obey Hyperliquid's tick rules and never cross to the other side", () => {
  const cases: [string, number, "down" | "up", string][] = [
    ["99490.05", 5, "down", "99490"], // five integer digits: whole dollars
    ["99490.05", 5, "up", "99491"],
    ["123456.7", 5, "down", "123456"], // an integer price is always valid, even past five figures
    ["3456.789", 4, "down", "3456.7"], // four integer digits: one decimal by significance
    ["3456.789", 4, "up", "3456.8"],
    ["187.12345", 2, "down", "187.12"], // three integer digits: two decimals
    ["0.123456", 0, "down", "0.12345"], // below one: five significant figures...
    ["0.00012345", 0, "down", "0.000123"], // ...capped at 6 - szDecimals decimals
    ["99999.5", 5, "up", "100000"], // carrying into a sixth digit is fine
  ];
  for (const [px, szDecimals, mode, expected] of cases) {
    assert.equal(roundPrice(px, szDecimals, mode), expected, `${px} ${mode} at szDecimals ${szDecimals}`);
  }
});

test("every rounded price passes the Arena's own validator, which is what the engine enforces", () => {
  let seed = 7n;
  const next = () => (seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 63n));
  for (let i = 0; i < 5_000; i += 1) {
    const szDecimals = Number(next() % 6n);
    // Prices from 1e-6 to 1e7, at full 1e8 precision.
    const px = (next() % 1_000_000_000_000_000n) + 100n;
    for (const mode of ["down", "up"] as const) {
      const rounded = roundPrice(px, szDecimals, mode);
      const e8 = toE8(rounded);
      const instrument = { coin: "X", asset: 0, szDecimals };
      assert.ok(arenaPriceIsValid(instrument, e8), `${fromE8(px)} → ${rounded} (szDecimals ${szDecimals})`);
      assert.equal(priceIsValid(e8, szDecimals), true);
      assert.ok(mode === "down" ? e8 <= px : e8 >= px, `${fromE8(px)} rounded ${mode} to ${rounded}`);
    }
  }
});

test("sizes round down to lots, and dollar sizing rounds up so it stays above the minimum", () => {
  assert.equal(roundSize("0.123456", 5), "0.12345");
  assert.throws(() => roundSize("0.000001", 5), RangeError);
  const sz = sizeForNotional("11", "99490", 5);
  assert.equal(sz, "0.00012");
  assert.ok(arenaSizeIsValid({ coin: "BTC", asset: 0, szDecimals: 5 }, toE8(sz)));
  // ETH-like: szDecimals 4, $10 at 3,333.33 → 0.0030000003 → 0.0031.
  assert.equal(sizeForNotional("10", "3333.33", 4), "0.0031");
});

test("cloids are non-zero 128-bit values in Hyperliquid's 32-digit hex form", () => {
  const seen = new Set<bigint>();
  for (let i = 0; i < 100; i += 1) {
    const cloid = newCloid();
    assert.ok(cloid > 0n && cloid < 1n << 128n);
    seen.add(cloid);
  }
  assert.equal(seen.size, 100);
  assert.equal(cloidHex(255n), "0x000000000000000000000000000000ff");
  assert.throws(() => cloidHex(0n), RangeError);
  assert.throws(() => cloidHex(1n << 128n), RangeError);
});
