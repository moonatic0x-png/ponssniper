import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateGates } from "../src/sniper/gates.mjs";

const dist = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const other = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("evaluateGates", () => {
  it("passes holders-sharing + buyback off", () => {
    const g = evaluateGates({
      buybackEnabled: false,
      creatorFeeRecipient: dist,
      distributor: dist,
      pairToken: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
      pairSymbol: "USDG",
    });
    assert.equal(g.ok, true);
  });

  it("rejects buyback on", () => {
    const g = evaluateGates({
      buybackEnabled: true,
      creatorFeeRecipient: dist,
      distributor: dist,
    });
    assert.equal(g.ok, false);
    assert.equal(g.reason, "buyback_enabled");
  });

  it("rejects recipient ≠ distributor", () => {
    const g = evaluateGates({
      buybackEnabled: false,
      creatorFeeRecipient: other,
      distributor: dist,
    });
    assert.equal(g.ok, false);
    assert.equal(g.reason, "recipient_not_distributor");
  });

  it("skips ineligible WETH quote by default", () => {
    const g = evaluateGates({
      buybackEnabled: false,
      creatorFeeRecipient: dist,
      distributor: dist,
      pairSymbol: "WETH",
      skipIneligibleQuotes: true,
    });
    assert.equal(g.ok, false);
    assert.match(g.reason, /ineligible_quote/);
  });

  it("allows ineligible when toggle off", () => {
    const g = evaluateGates({
      buybackEnabled: false,
      creatorFeeRecipient: dist,
      distributor: dist,
      pairSymbol: "WETH",
      skipIneligibleQuotes: false,
    });
    assert.equal(g.ok, true);
  });

  it("case-insensitive recipient match", () => {
    const g = evaluateGates({
      buybackEnabled: false,
      creatorFeeRecipient: dist.toUpperCase(),
      distributor: dist,
    });
    assert.equal(g.ok, true);
  });
});
