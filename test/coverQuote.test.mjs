import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { quoteSpend } from "../src/sniper/coverQuote.mjs";

describe("quoteSpend", () => {
  it("full cover from balance", () => {
    assert.deepEqual(quoteSpend(100n, 40n), { spend: 40n, short: 0n });
  });

  it("partial shortfall", () => {
    assert.deepEqual(quoteSpend(30n, 100n), { spend: 30n, short: 70n });
  });

  it("empty wallet", () => {
    assert.deepEqual(quoteSpend(0n, 50n), { spend: 0n, short: 50n });
  });
});
