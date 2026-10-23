import { decodeEventLog, getAddress } from "viem";
import {
  CurveAbi,
  DistributorAbi,
  Erc20Abi,
  TOPICS,
} from "../chain/abis.mjs";
import { lower } from "../chain/addresses.mjs";
import { sellOutFor } from "../chain/curveMath.mjs";
import { publicClient, wssClient } from "../chain/clients.mjs";
import { config, log } from "../config.mjs";
import {
  db,
  insertAction,
  insertClaim,
  setCursor,
  upsertEpoch,
  upsertPoolStats,
} from "../db/db.mjs";
import { holderStats } from "./holders.mjs";
import { snapshotNetWorth } from "./networth.mjs";
import { startObserve } from "./observe.mjs";
import { quoteToUsd } from "./price.mjs";

function heldRows() {
  return db()
    .prepare(
      `SELECT p.token, p.curve, p.distributor, p.pair, p.launch_block, p.symbol, p.decimals,
              pos.tokens, pos.entry_epoch
       FROM positions pos
       JOIN pools p ON p.token = pos.token
       WHERE pos.status IN ('open','dry') AND p.distributor IS NOT NULL`,
    )
    .all();
}

/**
 * @param {object} row
 * @param {{ holders?: boolean }} [opts] — holders=false skips Transfer walk (fast path)
 */
async function refreshPool(row, opts = {}) {
  const withHolders = opts.holders === true;
  const client = publicClient();
  const dist = getAddress(row.distributor);
  let unalloc = 0n;
  let epochCount = 0;
  let graduated = false;
  try {
    unalloc = await client.readContract({
      address: dist,
      abi: DistributorAbi,
      functionName: "unallocatedQuote",
    });
    epochCount = Number(
      await client.readContract({
        address: dist,
        abi: DistributorAbi,
        functionName: "epochCount",
      }),
    );
  } catch (e) {
    log("[watcher] dist read fail", row.token.slice(0, 10), e.message);
  }
  try {
    graduated = await client.readContract({
      address: getAddress(row.curve),
      abi: CurveAbi,
      functionName: "graduated",
    });
  } catch {
    /* */
  }

  let holderCount = undefined;
  let sharePct = undefined;
  let shareAfterCutoffPct = undefined;
  if (withHolders) {
    try {
      const stats = await holderStats(
        row.token,
        row.launch_block,
        row.curve,
        row._wallet || null,
      );
      holderCount = stats.holders;
      if (stats.sharePct != null) sharePct = stats.sharePct;
      if (stats.shareAfterCutoffPct != null) {
        shareAfterCutoffPct = stats.shareAfterCutoffPct;
      }
    } catch (e) {
      log("[watcher] holders fail", e.message);
    }
  }

  const potUsd = await quoteToUsd(row.pair, unalloc);

  // Fast bag mark (same math as networth) so Positions bag column moves with pot.
  let bag_mark_quote;
  let bag_mark_usd;
  if (row.curve && !graduated) {
    try {
      const me = row._wallet ? getAddress(row._wallet) : null;
      let bal = 0n;
      if (me) {
        bal = await client.readContract({
          address: getAddress(row.token),
          abi: Erc20Abi,
          functionName: "balanceOf",
          args: [me],
        });
      } else if (row.tokens != null) {
        bal = BigInt(row.tokens);
      }
      if (bal > 0n) {
        const [Q, T] = await client.readContract({
          address: getAddress(row.curve),
          abi: CurveAbi,
          functionName: "getReserves",
        });
        const feeBps = await client.readContract({
          address: getAddress(row.curve),
          abi: CurveAbi,
          functionName: "feeBps",
        });
        const taxBps = await client.readContract({
          address: getAddress(row.curve),
          abi: CurveAbi,
          functionName: "creatorTaxBps",
        });
        bag_mark_quote = sellOutFor(
          { Q, T, feeBps: Number(feeBps), taxBps: Number(taxBps) },
          bal,
        );
        bag_mark_usd = await quoteToUsd(row.pair, bag_mark_quote);
      }
    } catch {
      /* */
    }
  }

  upsertPoolStats({
    token: row.token,
    unallocated_quote: unalloc,
    epoch_count: epochCount,
    ...(holderCount !== undefined ? { holder_count: holderCount } : {}),
    pot_usd: potUsd,
    phase: graduated ? "graduated" : "curve",
    ...(bag_mark_quote != null
      ? { bag_mark_quote, bag_mark_usd: bag_mark_usd ?? null }
      : {}),
    ...(sharePct !== undefined ? { share_pct: sharePct } : {}),
    ...(shareAfterCutoffPct !== undefined
      ? { share_after_cutoff_pct: shareAfterCutoffPct }
      : {}),
  });
  setCursor("heartbeat", String(Date.now()));
}

async function handleDistLog(lg, row, me) {
  const topic = lg.topics?.[0];
  try {
    if (topic === TOPICS.EpochPublished) {
      const { args } = decodeEventLog({
        abi: DistributorAbi,
        data: lg.data,
        topics: lg.topics,
      });
      upsertEpoch({
        token: row.token,
        epoch_id: Number(args.epochId),
        quote_total: args.quoteTotal,
        coin_total: args.coinTotal,
        published_at: Date.now(),
        tx: lg.transactionHash,
      });
      insertAction({
        kind: "epoch",
        token: row.token,
        detail: `epoch=${args.epochId}`,
      });
      await refreshPool(row, { holders: false }).catch(() => {});
    } else if (topic === TOPICS.Claimed) {
      const { args } = decodeEventLog({
        abi: DistributorAbi,
        data: lg.data,
        topics: lg.topics,
      });
      if (lower(args.account) !== me) return;
      const usd = await quoteToUsd(row.pair, args.quoteAmount);
      insertClaim({
        token: row.token,
        epoch_id: Number(args.epochId),
        quote_amount: args.quoteAmount,
        coin_amount: args.coinAmount,
        tx: lg.transactionHash,
        usd,
      });
      insertAction({
        kind: "claim",
        token: row.token,
        detail: `epoch=${args.epochId} quote=${args.quoteAmount}`,
      });
      await refreshPool(row, { holders: false }).catch(() => {});
    }
  } catch (e) {
    log("[watcher] log handle", e.message);
  }
}

/**
 * Watch epochs/claims via WSS on held distributors; refresh pot/holders; net worth.
 * No sell. Claims: watch Claimed for our wallet only (no claim executor).
 *
 * @param {{ observe?: boolean }} [opts] — when true (or address-only wallet),
 *   backfill/follow chain buys into local DB. Sniper machines leave this off;
 *   they journal positions themselves.
 */
export async function startWatcher(wallets, opts = {}) {
  const wallet = wallets.sniper.address;
  const doObserve = opts.observe === true || wallets.sniper.readOnly === true;
  let observe = null;
  let unwatch = null;
  let distSet = new Set();
  let eventCursor = null;
  let potBusy = false;
  let holdersBusy = false;
  let pollBusy = false;

  const observeReady =
    doObserve
      ? startObserve(wallet)
          .then((o) => {
            observe = o;
          })
          .catch((e) => log("[observe] start err", e.message))
      : Promise.resolve();

  async function resubscribe() {
    const rows = heldRows();
    const addrs = [
      ...new Set(rows.map((r) => r.distributor).filter(Boolean)),
    ].map((a) => getAddress(a));
    const key = addrs.map(lower).sort().join(",");
    if (key === [...distSet].sort().join(",") && unwatch) return;
    distSet = new Set(addrs.map(lower));
    try {
      unwatch?.();
    } catch {
      /* */
    }
    unwatch = null;
    if (!addrs.length) return;

    const byDist = new Map(rows.map((r) => [lower(r.distributor), r]));
    try {
      const client = wssClient();
      unwatch = client.watchEvent({
        address: addrs,
        onLogs: (logs) => {
          for (const lg of logs) {
            const row = byDist.get(lower(lg.address));
            if (row) void handleDistLog(lg, row, lower(wallet));
          }
        },
        onError: (err) => {
          log("[watcher] wss err", err?.message);
          try {
            unwatch?.();
          } catch {
            /* */
          }
          unwatch = null;
          distSet = new Set();
          setTimeout(() => resubscribe().catch(() => {}), 1_500);
        },
      });
      log("[watcher] watching", addrs.length, "distributors");
    } catch (e) {
      log("[watcher] subscribe fail", e.message);
      unwatch = null;
      distSet = new Set();
    }
  }

  /** Fast path: pot USD + epoch count only (no holder Transfer walk). */
  async function tickPot() {
    if (potBusy) return;
    potBusy = true;
    try {
      const rows = heldRows().map((r) => ({ ...r, _wallet: wallet }));
      await Promise.all(
        rows.map((row) =>
          refreshPool(row, { holders: false }).catch((e) =>
            log("[watcher] refresh", e.message),
          ),
        ),
      );
      await resubscribe();
    } finally {
      potBusy = false;
    }
  }

  /** Holder count + payout share (Transfer walk). Sequential to spare RPC. */
  async function tickHolders() {
    if (holdersBusy) return;
    holdersBusy = true;
    try {
      for (const row of heldRows()) {
        await refreshPool(
          { ...row, _wallet: wallet },
          { holders: true },
        ).catch((e) => log("[watcher] holders", e.message));
      }
    } finally {
      holdersBusy = false;
    }
  }

  async function tickNet() {
    const s = await snapshotNetWorth(wallet);
    const fmt = (n) => (n == null ? "n/a" : Number(n).toFixed(2));
    log(
      `[networth] totalUsd=${fmt(s.totalUsd)} ethUsd=${fmt(s.ethUsd)} claimsUsd=${fmt(s.claimsUsd)}`,
    );
  }

  /** Block-range poll so we do not miss events between WSS drops. */
  async function pollHeldEvents() {
    if (pollBusy) return;
    pollBusy = true;
    try {
      const client = publicClient();
      const tip = await client.getBlockNumber();
      if (eventCursor == null) {
        eventCursor = tip > 8n ? tip - 8n : 0n;
      }
      if (eventCursor >= tip) return;
      const from = eventCursor + 1n;
      const to = tip - from > 300n ? from + 300n : tip;
      const rows = heldRows();
      const byDist = new Map(
        rows.filter((r) => r.distributor).map((r) => [lower(r.distributor), r]),
      );
      const addrs = [...byDist.keys()].map((a) => getAddress(a));
      if (addrs.length) {
        const logs = await client.getLogs({
          address: addrs,
          fromBlock: from,
          toBlock: to,
        });
        const me = lower(wallet);
        for (const lg of logs) {
          const row = byDist.get(lower(lg.address));
          if (row) await handleDistLog(lg, row, me);
        }
      }
      eventCursor = to;
    } catch {
      /* */
    } finally {
      pollBusy = false;
    }
  }

  await tickPot();
  await tickNet();

  const potTimer = setInterval(tickPot, config.potRefreshMs);
  // Prefer HOLDER_REFRESH_MS; else SHARE_REFRESH_MS (default 2m) so Positions
  // share fills without requiring the old holders toggle.
  const holdersEveryMs =
    config.holderRefreshMs > 0
      ? config.holderRefreshMs
      : config.shareRefreshMs > 0
        ? config.shareRefreshMs
        : 0;
  const holderTimer =
    holdersEveryMs > 0 ? setInterval(tickHolders, holdersEveryMs) : null;
  if (holderTimer) void tickHolders();
  const netTimer = setInterval(tickNet, config.networthIntervalMs);
  const pollTimer = setInterval(
    () => pollHeldEvents().catch(() => {}),
    config.eventPollMs,
  );

  log(
    `[watcher] started wallet=${wallet}` +
      (doObserve ? " mode=READ" : "") +
      ` pot=${config.potRefreshMs}ms events=${config.eventPollMs}ms` +
      (holderTimer
        ? ` holders+share=${holdersEveryMs}ms`
        : " holders+share=off"),
  );
  void observeReady;

  return {
    stop() {
      clearInterval(potTimer);
      if (holderTimer) clearInterval(holderTimer);
      clearInterval(netTimer);
      clearInterval(pollTimer);
      observe?.stop();
      try {
        unwatch?.();
      } catch {
        /* */
      }
    },
  };
}
