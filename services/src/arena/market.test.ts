import assert from "node:assert/strict";
import { test } from "node:test";

import { lotSize, parseBook, priceIsValid, sizeIsValid, toLots, type Instrument } from "./market.ts";

const px = (value: number) => BigInt(Math.round(value * 1e8));
const BTC: Instrument = { coin: "BTC", asset: 0, szDecimals: 5 };
const MEME: Instrument = { coin: "MEME", asset: 9, szDecimals: 0 };

test("an integer price is always valid, however many figures it has", () => {
  assert.equal(priceIsValid(BTC, px(109_342)), true);
});

test("more than five significant figures is invalid unless the price is an integer", () => {
  assert.equal(priceIsValid(BTC, px(109_342.5)), false);
  assert.equal(priceIsValid(MEME, 1_234_500n), true); // 0.012345: five figures
  assert.equal(priceIsValid(MEME, 1_234_560n), false); // 0.0123456: six
});

test("decimal places are capped at 6 − szDecimals", () => {
  // BTC allows one decimal place; 9.25 has two.
  assert.equal(priceIsValid(BTC, px(9.2)), true);
  assert.equal(priceIsValid(BTC, px(9.25)), false);
  // szDecimals 0 allows six; 0.0012345 needs seven.
  assert.equal(priceIsValid(MEME, 123_450n), false);
});

test("size must be whole lots", () => {
  assert.equal(lotSize(BTC), 1_000n);
  assert.equal(sizeIsValid(BTC, 1_000n), true);
  assert.equal(sizeIsValid(BTC, 1_500n), false);
  assert.equal(sizeIsValid(BTC, 0n), false);
  assert.equal(toLots(BTC, 2_999n), 2_000n);
});

test("a book parses to integers without touching a float", () => {
  const book = parseBook({
    coin: "BTC",
    time: 1,
    levels: [
      [{ px: "109342.0", sz: "0.03451", n: 2 }],
      [{ px: "109343.0", sz: "1.2", n: 1 }],
    ],
  });
  assert.equal(book.bids[0]!.px, 10_934_200_000_000n);
  assert.equal(book.bids[0]!.sz, 3_451_000n);
  assert.equal(book.asks[0]!.sz, 120_000_000n);
});
