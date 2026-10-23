import { decodeEventLog, getAddress } from "viem";
import {
  CurveAbi,
  DistributorAbi,
  TOPICS,
} from "../chain/abis.mjs";
import { lower } from "../chain/addresses.mjs";
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
import { countHolders } from "./holders.mjs";
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

async function refreshPool(row) {
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

  let holderCount = null;
  try {
    holderCount = await countHolders(
      row.token,
      row.launch_block,
      row.curve,
    );
  } catch (e) {
    log("[watcher] holders fail", e.message);
  }

  const potUsd = await quoteToUsd(row.pair, unalloc);

  upsertPoolStats({
    token: row.token,
    unallocated_quote: unalloc,
    epoch_count: epochCount,
    holder_count: holderCount,
    pot_usd: potUsd,
    phase: graduated ? "graduated" : "curve",
  });
  setCursor("heartbeat", String(Date.now()));
}

async function pollHeldEvents(wallet) {
  const client = publicClient();
  const rows = heldRows();
  const me = lower(wallet);
  for (const row of rows) {
    if (!row.distributor) continue;
    try {
      const logs = await client.getLogs({
        address: getAddress(row.distributor),
        fromBlock: "latest",
        toBlock: "latest",
      });
      for (const lg of logs) {
        await handleDistLog(lg, row, me);
      }
    } catch {
      /* latest-only can be empty */
    }
  }
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
  if (doObserve) {
    observe = await startObserve(wallet);
  }
  let unwatch = null;
  let distSet = new Set();

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
            if (row) handleDistLog(lg, row, lower(wallet));
          }
        },
        onError: (err) => {
          log("[watcher] wss err", err?.message);
        },
      });
      log("[watcher] watching", addrs.length, "distributors");
    } catch (e) {
      log("[watcher] subscribe fail", e.message);
    }
  }

  async function tickPot() {
    for (const row of heldRows()) {
      await refreshPool(row).catch((e) =>
        log("[watcher] refresh", e.message),
      );
    }
    await resubscribe();
  }

  async function tickNet() {
    const s = await snapshotNetWorth(wallet);
    const fmt = (n) => (n == null ? "n/a" : Number(n).toFixed(2));
    log(
      `[networth] totalUsd=${fmt(s.totalUsd)} ethUsd=${fmt(s.ethUsd)} claimsUsd=${fmt(s.claimsUsd)}`,
    );
  }

  await tickPot();
  await tickNet();

  const potTimer = setInterval(tickPot, config.potRefreshMs);
  const netTimer = setInterval(tickNet, config.networthIntervalMs);
  const pollTimer = setInterval(
    () => pollHeldEvents(wallet).catch(() => {}),
    8_000,
  );

  log(
    `[watcher] started wallet=${wallet}` +
      (doObserve ? " mode=READ" : ""),
  );

  return {
    stop() {
      clearInterval(potTimer);
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
