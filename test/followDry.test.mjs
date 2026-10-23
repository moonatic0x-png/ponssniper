import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dist = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const farmer = "0xc736303d0b386675a53138959f981579607bb40f";
const token = "0xcccccccccccccccccccccccccccccccccccccccc";
const usdg = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

describe("follow DRY persist", () => {
  let tryFollow;
  let db;
  let getState;

  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "pons-follow-"));
    process.env.DB_PATH = join(dir, "test.db");
    process.env.FOLLOW_LIVE = "0";
    // Fresh module graph so openDb picks DB_PATH
    const dbMod = await import(`../src/db/db.mjs?t=${Date.now()}`);
    const runMod = await import(`../src/follow/runner.mjs?t=${Date.now()}`);
    dbMod.openDb();
    tryFollow = runMod.tryFollow;
    db = dbMod.db;
    getState = dbMod.getState;
  });

  it("farmer buy detected → would-buy DRY → positions.strategy=follow", async () => {
    const bought = new Set();
    const inflight = new Set();
    const resolve = async () => ({
      info: {
        exists: true,
        buybackEnabled: false,
        creatorFeeRecipient: dist,
        creatorTaxBps: 0,
        pairToken: usdg,
        curve: "0xdddddddddddddddddddddddddddddddddddddddd",
      },
      curve: "0xdddddddddddddddddddddddddddddddddddddddd",
      pair: usdg,
      decimals: 18,
      symbol: "TEST",
      distributor: dist,
      graduated: false,
      curveState: {
        Q: 10_000_000_000n,
        T: 1_000_000n * 10n ** 18n,
        feeBps: 100,
        taxBps: 0,
      },
      unallocated: 1_000_000n,
    });
    const buy = async ({ plan }) => ({
      ok: true,
      dry: true,
      quoteIn: plan.quoteIn,
      tokens: plan.target,
      tx: null,
      cover: { via: "balance", dry: true },
    });

    const result = await tryFollow(
      {
        token,
        to: farmer,
        from: "0x1111111111111111111111111111111111111111",
        value: 10n ** 18n,
        blockNumber: 123,
        txHash: "0xabc",
        detect_ts: Date.now(),
      },
      {
        warm: { state: { address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" } },
        bought,
        inflight,
        live: false,
        buyUsd: 0.8,
        dust: 1n,
        resolve,
        buy,
        farmerBalance: 10n ** 18n,
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.dry, true);
    const pos = db()
      .prepare(`SELECT strategy, status, cost_usd FROM positions WHERE token=?`)
      .get(token);
    assert.equal(pos.strategy, "follow");
    assert.equal(pos.status, "dry");
    assert.ok(pos.cost_usd != null && pos.cost_usd > 0);
    const act = db()
      .prepare(
        `SELECT kind FROM actions WHERE token=? AND kind='follow_buy_dry' LIMIT 1`,
      )
      .get(token);
    assert.ok(act);
    const state = getState();
    assert.ok(state.positions.some((p) => p.strategy === "follow"));
  });

  it("already held → skip without second buy", async () => {
    const bought = new Set([token]);
    const inflight = new Set();
    let buys = 0;
    const result = await tryFollow(
      {
        token,
        to: farmer,
        value: 10n ** 18n,
        detect_ts: Date.now(),
      },
      {
        warm: {},
        bought,
        inflight,
        resolve: async () => {
          throw new Error("should not resolve");
        },
        buy: async () => {
          buys++;
          return { ok: true, dry: true };
        },
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "already_held");
    assert.equal(buys, 0);
  });
});
