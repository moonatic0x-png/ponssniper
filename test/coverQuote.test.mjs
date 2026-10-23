import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  COVER_GAS,
  gasReserveFor,
  quoteSpend,
} from "../src/sniper/coverQuote.mjs";
import { slip } from "../src/chain/curveMath.mjs";
import { config } from "../src/config.mjs";

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

describe("cover fill vs slippage", () => {
  it("slipped minOut can be below need (legacy strand class)", () => {
    const need = 10_000n;
    const minOut = slip(need, 300);
    assert.ok(minOut < need);
    // A swap that fills exactly minOut would pass the router but fail after < need
    assert.equal(minOut >= need, false);
  });
});

describe("gasReserveFor", () => {
  const fee = 2_000_000_000n; // 2 gwei — warm fallback

  it("native ETH path reserves buy gas only", () => {
    const want = COVER_GAS.buy * fee;
    assert.equal(gasReserveFor("eth_native", fee), want > config.gasReserveWei ? want : config.gasReserveWei);
    assert.ok(gasReserveFor("eth_native", fee) >= COVER_GAS.buy * fee);
  });

  it("erc20 cover reserves swap + approve + buy at fee", () => {
    const units = COVER_GAS.swap + COVER_GAS.approve + COVER_GAS.buy;
    const want = units * fee;
    // At 2 gwei this is ~0.00176 ETH ≫ 0.0001 ETH floor
    assert.equal(gasReserveFor("erc20_cover", fee), want);
    assert.ok(want > config.gasReserveWei);
  });

  it("erc20 balance reserves approve + buy", () => {
    const want = (COVER_GAS.approve + COVER_GAS.buy) * fee;
    assert.equal(gasReserveFor("erc20_balance", fee), want);
  });

  it("uses 2 gwei when fee missing", () => {
    assert.equal(gasReserveFor("erc20_cover", null), gasReserveFor("erc20_cover", fee));
    assert.equal(gasReserveFor("erc20_cover", 0n), gasReserveFor("erc20_cover", fee));
  });

  it("honors GAS_RESERVE_WEI floor when fee×units is smaller", () => {
    const tiny = 1n;
    const got = gasReserveFor("eth_native", tiny);
    assert.equal(got, config.gasReserveWei);
  });
});
