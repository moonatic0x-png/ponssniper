import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateFollowGates } from "../src/follow/gates.mjs";
import { planBuyFromQuote } from "../src/follow/plan.mjs";
import { buyTokensFor } from "../src/chain/curveMath.mjs";

const dist = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const other = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const usdg = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

const baseOk = {
  buybackEnabled: false,
  creatorFeeRecipient: dist,
  distributor: dist,
  pairToken: usdg,
  pairSymbol: "USDG",
  skipIneligibleQuotes: true,
  graduated: false,
  alreadyHeld: false,
  farmerHolds: true,
  openFollows: 0,
  maxOpen: 40,
  dailyUsdSpent: 0,
  dailyUsdCap: 40,
  buyUsd: 0.8,
};

describe("evaluateFollowGates", () => {
  it("farmer bag + sharing on → would-buy (ok)", () => {
    const g = evaluateFollowGates(baseOk);
    assert.equal(g.ok, true);
  });

  it("already held → skip", () => {
    const g = evaluateFollowGates({ ...baseOk, alreadyHeld: true });
    assert.equal(g.ok, false);
    assert.equal(g.reason, "already_held");
  });

  it("sharing off (recipient ≠ distributor) → skip", () => {
    const g = evaluateFollowGates({
      ...baseOk,
      creatorFeeRecipient: other,
    });
    assert.equal(g.ok, false);
    assert.equal(g.reason, "recipient_not_distributor");
  });

  it("no farmer bag → skip", () => {
    const g = evaluateFollowGates({ ...baseOk, farmerHolds: false });
    assert.equal(g.ok, false);
    assert.equal(g.reason, "farmer_no_bag");
  });

  it("buyback on → skip", () => {
    const g = evaluateFollowGates({ ...baseOk, buybackEnabled: true });
    assert.equal(g.ok, false);
    assert.equal(g.reason, "buyback_enabled");
  });

  it("graduated → skip", () => {
    const g = evaluateFollowGates({ ...baseOk, graduated: true });
    assert.equal(g.ok, false);
    assert.equal(g.reason, "graduated");
  });

  it("max open follows → skip", () => {
    const g = evaluateFollowGates({
      ...baseOk,
      openFollows: 40,
      maxOpen: 40,
    });
    assert.equal(g.ok, false);
    assert.equal(g.reason, "max_open");
  });

  it("daily USD cap → skip", () => {
    const g = evaluateFollowGates({
      ...baseOk,
      dailyUsdSpent: 39.5,
      dailyUsdCap: 40,
      buyUsd: 0.8,
    });
    assert.equal(g.ok, false);
    assert.equal(g.reason, "daily_usd_cap");
  });

  it("ineligible WETH quote → skip when toggle on", () => {
    const g = evaluateFollowGates({
      ...baseOk,
      pairSymbol: "WETH",
      skipIneligibleQuotes: true,
    });
    assert.equal(g.ok, false);
    assert.match(g.reason, /ineligible_quote/);
  });
});

describe("planBuyFromQuote (~$0.80 USDG)", () => {
  it("sizes tokens from 0.8 USDG quoteIn", () => {
    const quoteIn = 800_000n; // 0.8 USDG @ 6dp
    const curveState = {
      Q: 10_000_000_000n, // phantom+real
      T: 1_000_000n * 10n ** 18n,
      feeBps: 100,
      taxBps: 0,
    };
    const plan = planBuyFromQuote({
      curveState,
      pairToken: usdg,
      quoteIn,
      slippageBps: 300,
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.quoteIn, quoteIn);
    const sim = buyTokensFor(curveState, quoteIn);
    assert.equal(plan.target, sim.tokens);
    assert.ok(plan.target > 0n);
  });
});
