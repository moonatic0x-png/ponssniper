import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  entryQuoteFor,
  buyTokensFor,
  sellOutFor,
  slip,
} from "../src/chain/curveMath.mjs";

const curve = {
  Q: 1_680_000_000_000_000_000n, // 1.68 ETH phantom-ish
  T: 1_000_000_000n * 10n ** 18n,
  feeBps: 100,
  taxBps: 100,
};

describe("curveMath", () => {
  it("entryQuoteFor then buyTokensFor ≈ target", () => {
    const target = 100_000n * 10n ** 18n;
    const quote = entryQuoteFor(curve, target);
    assert.ok(quote > 0n);
    const { tokens } = buyTokensFor(curve, quote);
    // rounding: tokens should be >= target - small epsilon
    assert.ok(tokens >= target - target / 1000n);
  });

  it("rejects tokens >= reserve", () => {
    assert.equal(entryQuoteFor(curve, curve.T), null);
  });

  it("slip applies bps", () => {
    assert.equal(slip(10_000n, 300), 9700n);
  });

  it("sellOutFor is positive for small bag", () => {
    const out = sellOutFor(curve, 1000n * 10n ** 18n);
    assert.ok(out > 0n);
  });
});
