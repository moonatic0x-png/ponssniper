import { decodeEventLog, getAddress } from "viem";
import {
  CurveAbi,
  DistributorFactoryAbi,
  Erc20Abi,
  FactoryAbi,
  TOPICS,
} from "../chain/abis.mjs";
import {
  DIST_FACTORY,
  KNOWN_QUOTES,
  LAUNCH,
  ZERO,
  lower,
} from "../chain/addresses.mjs";
import { publicClient, wssClient } from "../chain/clients.mjs";
import { ethUsdMark } from "../chain/price.mjs";
import { config, log } from "../config.mjs";
import {
  db,
  insertAction,
  setCursor,
  upsertPool,
  upsertPosition,
} from "../db/db.mjs";

/** Factory log chunks — keep under free-RPC range caps. */
const CHUNK = 2_000n;
const CURSOR = "observe_head";
const curveBuyEvent = CurveAbi.find((x) => x.name === "CurveBuy");

function costUsdFor(pair, quoteIn, ethPx) {
  const p = lower(pair) || ZERO;
  const meta = KNOWN_QUOTES[p];
  if (meta?.symbol === "ETH" || p === ZERO) {
    if (ethPx == null) return null;
    return (Number(quoteIn) / 1e18) * ethPx;
  }
  if (meta?.symbol === "USDG") return Number(quoteIn) / 1e6;
  return null;
}

/**
 * List ERC-20s the wallet holds via Blockscout (when reachable).
 * @returns {Promise<string[]>} lowercase token addresses with bal > 0
 */
async function fetchHeldTokenAddresses(wallet) {
  const base = String(config.blockscoutApi || "").replace(/\/$/, "");
  if (!base) return [];
  const url = `${base}/api/v2/addresses/${getAddress(wallet)}/tokens?type=ERC-20`;
  const headers = { Accept: "application/json" };
  if (config.blockscoutApiKey) {
    headers.Authorization = config.blockscoutApiKey.startsWith("Bearer ")
      ? config.blockscoutApiKey
      : `Bearer ${config.blockscoutApiKey}`;
  }
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    log(`[observe] explorer tokens HTTP ${res.status}`);
    return [];
  }
  const body = await res.json();
  const items = body?.items || body?.result || [];
  const out = [];
  for (const it of items) {
    const addr = it?.token?.address_hash || it?.token?.address || it?.contractAddress;
    const raw = it?.value ?? it?.balance ?? "0";
    try {
      if (addr && BigInt(raw) > 0n) out.push(lower(addr));
    } catch {
      /* */
    }
  }
  if (out.length) log(`[observe] explorer held tokens=${out.length}`);
  return out;
}

async function fetchMeta(token, curveHint) {
  const client = publicClient();
  const tokenA = getAddress(token);
  let info = null;
  let symbol = null;
  let decimals = 18;
  try {
    info = await client.readContract({
      address: getAddress(LAUNCH),
      abi: FactoryAbi,
      functionName: "getLaunchedToken",
      args: [tokenA],
    });
  } catch {
    /* */
  }
  try {
    symbol = await client.readContract({
      address: tokenA,
      abi: Erc20Abi,
      functionName: "symbol",
    });
  } catch {
    /* */
  }
  try {
    decimals = Number(
      await client.readContract({
        address: tokenA,
        abi: Erc20Abi,
        functionName: "decimals",
      }),
    );
  } catch {
    /* */
  }
  return {
    curve: curveHint || (info?.curve ? lower(info.curve) : null),
    pair: info?.pairToken != null ? lower(info.pairToken) : null,
    symbol,
    decimals,
    buyback: !!info?.buybackEnabled,
    tax_bps: Number(info?.creatorTaxBps ?? 0),
    creatorFeeRecipient: info?.creatorFeeRecipient
      ? lower(info.creatorFeeRecipient)
      : null,
  };
}

/**
 * Sum CurveBuy for wallet on a single curve (address-scoped — RPC requires this).
 */
async function buysOnCurve(curve, wallet, fromBlock, toBlock) {
  const client = publicClient();
  const curveA = getAddress(curve);
  const me = getAddress(wallet);
  const seen = new Set();
  let quoteIn = 0n;
  let tokens = 0n;
  let buyTx = null;
  let entryBlock = null;

  let from = BigInt(fromBlock);
  const end = BigInt(toBlock);
  while (from <= end) {
    const to = from + CHUNK - 1n > end ? end : from + CHUNK - 1n;
    const [asBuyer, asRecipient] = await Promise.all([
      client
        .getLogs({
          address: curveA,
          event: curveBuyEvent,
          args: { buyer: me },
          fromBlock: from,
          toBlock: to,
        })
        .catch(() => []),
      client
        .getLogs({
          address: curveA,
          event: curveBuyEvent,
          args: { recipient: me },
          fromBlock: from,
          toBlock: to,
        })
        .catch(() => []),
    ]);
    for (const lg of [...asBuyer, ...asRecipient]) {
      const key = `${lg.transactionHash}:${lg.logIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let decoded;
      try {
        decoded = decodeEventLog({
          abi: CurveAbi,
          data: lg.data,
          topics: lg.topics,
        });
      } catch {
        continue;
      }
      quoteIn += decoded.args.quoteIn;
      tokens += decoded.args.tokensOut;
      if (!buyTx) {
        buyTx = lg.transactionHash;
        entryBlock =
          lg.blockNumber != null ? Number(lg.blockNumber) : null;
      }
    }
    from = to + 1n;
  }
  return { quoteIn, tokens, buyTx, entryBlock, n: seen.size };
}

/**
 * Max launches to balance-check from a scan window (most recent first).
 * Wide windows used to skip ALL launch candidates and only re-check DB rows,
 * so new bags (e.g. buy 30k blocks ago) never appeared when Blockscout 403'd.
 */
const MAX_LAUNCH_BALANCE_CHECKS = 400;

/**
 * Find held Pons bags in [from,to] and upsert positions.
 *
 * Wide lookbacks only index factory launches for metadata and balance-check
 * DB/explorer candidates. Short ticks also balance-check launches in-window
 * (few dozen) so new snipes appear without starving pot refresh.
 *
 * @param {{ explorer?: boolean }} [opts]
 */
export async function scanObserveRange(wallet, fromBlock, toBlock, opts = {}) {
  const me = getAddress(wallet);
  const launchMeta = new Map(); // token -> {curve, pair, launch_block, launch_tx}
  const distributors = new Map();
  const candidates = new Map(); // token -> base meta (may be sparse)
  const client = publicClient();
  const useExplorer = opts.explorer !== false;

  const fromB = BigInt(fromBlock);
  const toB = BigInt(toBlock);
  const span = toB >= fromB ? toB - fromB + 1n : 0n;
  /** Newest launches first for capped balance-checks. */
  const launchOrder = [];

  let from = fromB;
  let chunksDone = 0;
  const chunksTotal = span === 0n ? 0 : Number((span + CHUNK - 1n) / CHUNK);
  while (from <= toB) {
    const to = from + CHUNK - 1n > toB ? toB : from + CHUNK - 1n;
    chunksDone += 1;
    if (chunksTotal > 20 && chunksDone % 25 === 0) {
      log(`[observe] launch scan ${chunksDone}/${chunksTotal} →${to}`);
    }
    const [launchLogs, distLogs] = await Promise.all([
      client.getLogs({
        address: getAddress(LAUNCH),
        fromBlock: from,
        toBlock: to,
        topics: [TOPICS.TokenLaunched],
      }),
      client.getLogs({
        address: getAddress(DIST_FACTORY),
        fromBlock: from,
        toBlock: to,
        topics: [TOPICS.DistributorCreated],
      }),
    ]);

    for (const lg of launchLogs) {
      try {
        const { args } = decodeEventLog({
          abi: FactoryAbi,
          data: lg.data,
          topics: lg.topics,
        });
        const token = lower(args.token);
        const base = {
          curve: lower(args.curve),
          pair: lower(args.pairToken),
          launch_block:
            lg.blockNumber != null ? Number(lg.blockNumber) : null,
          launch_tx: lg.transactionHash,
        };
        launchMeta.set(token, base);
        launchOrder.push(token);
      } catch {
        /* */
      }
    }
    for (const lg of distLogs) {
      try {
        const { args } = decodeEventLog({
          abi: DistributorFactoryAbi,
          data: lg.data,
          topics: lg.topics,
        });
        distributors.set(lower(args.token), lower(args.distributor));
      } catch {
        /* */
      }
    }
    from = to + 1n;
  }

  // Newest launches first; cap balanceOf fan-out on huge windows.
  const launchSlice = launchOrder.slice(-MAX_LAUNCH_BALANCE_CHECKS);
  for (const token of launchSlice) {
    candidates.set(token, launchMeta.get(token));
  }
  if (launchOrder.length > MAX_LAUNCH_BALANCE_CHECKS) {
    log(
      `[observe] launch candidates capped ${MAX_LAUNCH_BALANCE_CHECKS}/${launchOrder.length}`,
    );
  }

  // Always re-check pools / positions already in DB
  for (const row of db()
    .prepare(`SELECT token, curve, pair, launch_block, launch_tx FROM pools`)
    .all()) {
    const base = launchMeta.get(row.token) || {
      curve: row.curve ? lower(row.curve) : null,
      pair: row.pair ? lower(row.pair) : null,
      launch_block: row.launch_block,
      launch_tx: row.launch_tx,
    };
    candidates.set(row.token, base);
  }

  // Explorer-held tokens (when API key / Cloudflare allows) — skip on fast ticks
  if (useExplorer) {
    for (const token of await fetchHeldTokenAddresses(me).catch(() => [])) {
      if (candidates.has(token)) continue;
      candidates.set(token, launchMeta.get(token) || {
        curve: null,
        pair: null,
        launch_block: null,
        launch_tx: null,
      });
    }
  }

  const ethPx = await ethUsdMark().catch(() => null);
  let n = 0;
  const buyFrom =
    toB > 50_000n && span > 50_000n ? toB - 50_000n : fromB;

  for (const [token, base0] of candidates) {
    if (KNOWN_QUOTES[token]) continue;
    const base = launchMeta.get(token) || base0;
    const hit = await upsertHeldIfAny(wallet, token, {
      ...base,
      distributor: distributors.get(token) || null,
      ethPx,
      buyFrom,
      buyTo: toB,
    });
    if (hit) n += 1;
  }
  return n;
}

/**
 * Balance-check one token and upsert position if the READ wallet still holds it.
 * @returns {Promise<boolean>} true if a position row was written
 */
export async function upsertHeldIfAny(wallet, token, hints = {}) {
  const client = publicClient();
  const me = getAddress(wallet);
  const t = lower(token);
  if (!t || KNOWN_QUOTES[t]) return false;

  let bal = 0n;
  try {
    bal = await client.readContract({
      address: getAddress(t),
      abi: Erc20Abi,
      functionName: "balanceOf",
      args: [me],
    });
  } catch {
    return false;
  }
  if (bal <= 0n) return false;

  const meta = await fetchMeta(t, hints.curve || null);
  if (!meta.curve) return false;

  const prev = db()
    .prepare(
      `SELECT buy_tx, entry_epoch, quote_in, cost_usd FROM positions WHERE token=?`,
    )
    .get(t);

  let buy = {
    quoteIn: 0n,
    tokens: 0n,
    buyTx: null,
    entryBlock: null,
    n: 0,
  };
  if (!prev?.buy_tx) {
    const tip = hints.buyTo ?? (await client.getBlockNumber());
    const buyFrom =
      hints.buyFrom ?? (tip > 50_000n ? tip - 50_000n : 0n);
    buy = await buysOnCurve(meta.curve, me, buyFrom, tip).catch(() => buy);
  }

  const dist = hints.distributor || meta.creatorFeeRecipient || null;
  const ethPx = hints.ethPx ?? (await ethUsdMark().catch(() => null));

  upsertPool({
    token: t,
    curve: meta.curve || hints.curve,
    distributor: dist,
    pair: meta.pair ?? hints.pair,
    symbol: meta.symbol,
    decimals: meta.decimals,
    buyback: meta.buyback,
    tax_bps: meta.tax_bps,
    launch_block: hints.launch_block ?? null,
    launch_tx: hints.launch_tx ?? null,
  });

  const quoteIn = buy.quoteIn > 0n ? buy.quoteIn : 0n;
  const cost_usd = costUsdFor(meta.pair ?? hints.pair, quoteIn, ethPx);

  upsertPosition({
    token: t,
    entry_block: buy.entryBlock ?? hints.launch_block ?? null,
    entry_epoch: prev?.entry_epoch ?? 0,
    tokens: bal,
    quote_in: quoteIn > 0n ? quoteIn : (prev?.quote_in ?? 0n),
    cost_usd: cost_usd ?? prev?.cost_usd ?? null,
    buy_tx: buy.buyTx ?? prev?.buy_tx ?? null,
    status: "open",
  });

  if (!prev || (buy.buyTx && prev.buy_tx !== buy.buyTx)) {
    insertAction({
      kind: "observe",
      token: t,
      detail:
        (buy.buyTx ? `buy_tx=${buy.buyTx} ` : "balance ") +
        `quote=${quoteIn} bal=${bal}`,
    });
    log(
      `[observe] position ${meta.symbol || t.slice(0, 10)} bal=${bal} quote=${quoteIn}`,
    );
  }
  return true;
}

/**
 * Live observe: WSS factory + fast incremental ticks immediately; boot lookback
 * runs in the background so pot/claims stay real-time.
 */
export async function startObserve(wallet) {
  const client = publicClient();
  let cursor = await client.getBlockNumber();
  setCursor(CURSOR, String(cursor));

  const recheck = BigInt(Math.max(1_000, config.observeRecheckBlocks));
  const wideEvery = Math.max(1, config.observeWideEvery);
  const tickMs = Math.max(1_000, config.observeTickMs);
  let tickN = 0;
  let ticking = false;
  let unwatch = null;
  let stopped = false;

  async function tick() {
    if (ticking || stopped) return;
    ticking = true;
    try {
      const tip = await client.getBlockNumber();
      tickN += 1;
      const wide = tickN % wideEvery === 0;
      let fromTick;
      if (wide) {
        fromTick = tip > recheck ? tip - recheck : 0n;
        log(`[observe] wide recheck ${fromTick}→${tip}`);
      } else if (cursor < tip) {
        fromTick = cursor + 1n;
      } else {
        fromTick = tip; // DB pools + 1-block launch window
      }
      const n = await scanObserveRange(wallet, fromTick, tip, {
        explorer: wide,
      });
      cursor = tip;
      setCursor(CURSOR, String(tip));
      if (n > 0) {
        log(
          `[observe] tick positions=${n} @${tip}${wide ? " (wide)" : ""}`,
        );
      }
    } catch (e) {
      log("[observe] tick err", e.message);
    } finally {
      ticking = false;
    }
  }

  function startFactoryWss() {
    try {
      const wss = wssClient();
      log("[observe/wss] subscribing TokenLaunched + DistributorCreated");
      unwatch = wss.watchEvent({
        address: [getAddress(LAUNCH), getAddress(DIST_FACTORY)],
        onLogs: (logs) => {
          for (const lg of logs) {
            try {
              if (lg.topics?.[0] === TOPICS.TokenLaunched) {
                const { args } = decodeEventLog({
                  abi: FactoryAbi,
                  data: lg.data,
                  topics: lg.topics,
                });
                void upsertHeldIfAny(wallet, args.token, {
                  curve: lower(args.curve),
                  pair: lower(args.pairToken),
                  launch_block:
                    lg.blockNumber != null ? Number(lg.blockNumber) : null,
                  launch_tx: lg.transactionHash,
                });
              } else if (lg.topics?.[0] === TOPICS.DistributorCreated) {
                const { args } = decodeEventLog({
                  abi: DistributorFactoryAbi,
                  data: lg.data,
                  topics: lg.topics,
                });
                void upsertHeldIfAny(wallet, args.token, {
                  distributor: lower(args.distributor),
                });
              }
            } catch {
              /* */
            }
          }
        },
        onError: (err) => {
          log("[observe/wss] err", err?.message || err);
          try {
            unwatch?.();
          } catch {
            /* */
          }
          unwatch = null;
          if (!stopped) setTimeout(startFactoryWss, 2_000);
        },
      });
    } catch (e) {
      log("[observe/wss] start fail", e.message);
      if (!stopped) setTimeout(startFactoryWss, 5_000);
    }
  }

  startFactoryWss();
  const timer = setInterval(() => void tick(), tickMs);
  void tick();

  // Boot lookback in background — short catch-up if DB already has bags.
  void (async () => {
    try {
      const head = await client.getBlockNumber();
      const existing = Number(
        db().prepare(`SELECT COUNT(*) AS c FROM positions`).get()?.c ?? 0,
      );
      const full = BigInt(Math.max(0, config.readLookbackBlocks));
      // Seeded → still scan far enough for recent snipes (~3h); not full 1M.
      const seededCap = BigInt(Math.max(50_000, config.observeRecheckBlocks));
      const lookback =
        existing > 0 ? (full > seededCap ? seededCap : full) : full;
      const from = head > lookback ? head - lookback : 0n;
      log(
        `[observe] sync wallet=${wallet} blocks ${from}→${head} lookback=${lookback}` +
          (existing > 0 ? ` (seeded n=${existing})` : ""),
      );
      const n = await scanObserveRange(wallet, from, head, {
        explorer: true,
      });
      log(`[observe] synced ${n} position(s)`);
      if (head > cursor) cursor = head;
      setCursor(CURSOR, String(head));
    } catch (e) {
      log(`[observe] sync err ${e.message}`);
    }
  })();

  log(`[observe] live tick=${tickMs}ms wallet=${wallet}`);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      try {
        unwatch?.();
      } catch {
        /* */
      }
    },
  };
}
