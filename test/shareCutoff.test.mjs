import assert from "node:assert/strict";
import test from "node:test";
import { PAYOUT_CUTOFF_PCT } from "../src/watcher/holders.mjs";

/** Mirror of holderStats cutoff math for unit coverage (no RPC). */
function shareAfterCutoff(balances, me, cutoffPct = PAYOUT_CUTOFF_PCT) {
  const total = balances.reduce((s, b) => s + b.bal, 0n);
  if (total <= 0n) return { sharePct: 0, shareAfterCutoffPct: 0 };
  const pctOf = (part, whole) => Number((part * 1_000_000n) / whole) / 10_000;
  const meL = me.toLowerCase();
  const our = balances.find((b) => b.addr === meL)?.bal ?? 0n;
  const sharePct = pctOf(our, total);
  const kept = balances.filter((b) => pctOf(b.bal, total) >= cutoffPct);
  const keptTotal = kept.reduce((s, b) => s + b.bal, 0n);
  const ourKept = kept.find((b) => b.addr === meL);
  const shareAfterCutoffPct =
    ourKept && keptTotal > 0n ? pctOf(ourKept.bal, keptTotal) : 0;
  return { sharePct, shareAfterCutoffPct };
}

test("payout cutoff drops sub-1.5% bags to zero share", () => {
  const me = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const r = shareAfterCutoff(
    [
      { addr: me, bal: 1_000n }, // 1%
      { addr: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", bal: 99_000n },
    ],
    me,
  );
  assert.ok(r.sharePct > 0 && r.sharePct < 1.5);
  assert.equal(r.shareAfterCutoffPct, 0);
});

test("majority bag keeps renormalised share after cutoff", () => {
  const me = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const r = shareAfterCutoff(
    [
      { addr: me, bal: 50_000n },
      { addr: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", bal: 50_000n },
      { addr: "0xcccccccccccccccccccccccccccccccccccccccc", bal: 100n }, // dust under cutoff
    ],
    me,
  );
  assert.ok(r.sharePct > 49 && r.sharePct < 51);
  assert.ok(r.shareAfterCutoffPct > 49 && r.shareAfterCutoffPct < 51);
});
