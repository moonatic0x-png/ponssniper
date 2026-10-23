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
import { publicClient } from "../chain/clients.mjs";
import { ethUsdMark } from "../chain/price.mjs";
import { config, log } from "../config.mjs";
import {
  db,
  getCursor,
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
 * Scan factory launches in [from,to], then for each pool check wallet balance /
 * CurveBuy (per-curve). Upserts open positions.
 */
export async function scanObserveRange(wallet, fromBlock, toBlock) {
  const client = publicClient();
  const me = getAddress(wallet);
  const pools = new Map(); // token -> {curve, pair, launch_block, launch_tx}
  const distributors = new Map();

  let from = BigInt(fromBlock);
  const end = BigInt(toBlock);
  const span = end >= from ? end - from + 1n : 0n;
  let chunksDone = 0;
  const chunksTotal = span === 0n ? 0 : Number((span + CHUNK - 1n) / CHUNK);
  while (from <= end) {
    const to = from + CHUNK - 1n > end ? end : from + CHUNK - 1n;
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
        pools.set(token, {
          curve: lower(args.curve),
          pair: lower(args.pairToken),
          launch_block:
            lg.blockNumber != null ? Number(lg.blockNumber) : null,
          launch_tx: lg.transactionHash,
        });
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

  // Also re-check pools already in DB (launched before this window)
  for (const row of db()
    .prepare(`SELECT token, curve, pair, launch_block, launch_tx FROM pools`)
    .all()) {
    if (!pools.has(row.token) && row.curve) {
      pools.set(row.token, {
        curve: lower(row.curve),
        pair: row.pair ? lower(row.pair) : null,
        launch_block: row.launch_block,
        launch_tx: row.launch_tx,
      });
    }
  }

  // Explorer-held tokens: catches follow bags launched outside the lookback window.
  for (const token of await fetchHeldTokenAddresses(me).catch(() => [])) {
    if (pools.has(token)) continue;
    const meta = await fetchMeta(token, null);
    if (!meta.curve) continue;
    pools.set(token, {
      curve: meta.curve,
      pair: meta.pair,
      launch_block: null,
      launch_tx: null,
    });
  }

  const ethPx = await ethUsdMark().catch(() => null);
  const fromB = BigInt(fromBlock);
  const toB = BigInt(toBlock);
  let n = 0;

  // Balance-first: only pull CurveBuy history for tokens the wallet still holds.
  // (Per-curve getLogs over the full lookback for every launch is too heavy.)
  for (const [token, base] of pools) {
    if (!base.curve) continue;
    let bal = 0n;
    try {
      bal = await client.readContract({
        address: getAddress(token),
        abi: Erc20Abi,
        functionName: "balanceOf",
        args: [me],
      });
    } catch {
      continue;
    }
    if (bal <= 0n) continue;

    const buy = await buysOnCurve(base.curve, me, fromB, toB).catch(() => ({
      quoteIn: 0n,
      tokens: 0n,
      buyTx: null,
      entryBlock: null,
      n: 0,
    }));

    const meta = await fetchMeta(token, base.curve);
    const dist =
      distributors.get(token) || meta.creatorFeeRecipient || null;

    upsertPool({
      token,
      curve: meta.curve || base.curve,
      distributor: dist,
      pair: meta.pair ?? base.pair,
      symbol: meta.symbol,
      decimals: meta.decimals,
      buyback: meta.buyback,
      tax_bps: meta.tax_bps,
      launch_block: base.launch_block,
      launch_tx: base.launch_tx,
    });

    const tokens = bal;
    const quoteIn = buy.quoteIn > 0n ? buy.quoteIn : 0n;
    const cost_usd = costUsdFor(meta.pair ?? base.pair, quoteIn, ethPx);
    const prev = db()
      .prepare(`SELECT buy_tx, entry_epoch, quote_in FROM positions WHERE token=?`)
      .get(token);

    upsertPosition({
      token,
      entry_block: buy.entryBlock ?? base.launch_block,
      entry_epoch: prev?.entry_epoch ?? 0,
      tokens,
      quote_in: quoteIn > 0n ? quoteIn : (prev?.quote_in ?? 0n),
      cost_usd,
      buy_tx: buy.buyTx ?? prev?.buy_tx ?? null,
      status: "open",
    });

    if (!prev || (buy.buyTx && prev.buy_tx !== buy.buyTx)) {
      insertAction({
        kind: "observe",
        token,
        detail:
          (buy.buyTx ? `buy_tx=${buy.buyTx} ` : "balance ") +
          `quote=${quoteIn} bal=${bal}`,
      });
      log(
        `[observe] position ${meta.symbol || token.slice(0, 10)} bal=${bal} quote=${quoteIn}`,
      );
    }
    n += 1;
  }
  return n;
}

/**
 * Backfill lookback on every start (cursor must not skip that), then tick with a
 * wide launch re-check window so buys on slightly-older pools still appear.
 */
export async function startObserve(wallet) {
  const client = publicClient();
  const head = await client.getBlockNumber();
  const lookback = BigInt(Math.max(0, config.readLookbackBlocks));
  const from = head > lookback ? head - lookback : 0n;
  log(
    `[observe] sync wallet=${wallet} blocks ${from}→${head} lookback=${config.readLookbackBlocks}`,
  );
  try {
    const n = await scanObserveRange(wallet, from, head);
    log(`[observe] synced ${n} position(s)`);
  } catch (e) {
    log(`[observe] sync err ${e.message}`);
  }
  setCursor(CURSOR, String(head));

  const recheck = BigInt(Math.max(1_000, config.observeRecheckBlocks));
  let ticking = false;
  const timer = setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      const tip = await client.getBlockNumber();
      const fromTick = tip > recheck ? tip - recheck : 0n;
      const n = await scanObserveRange(wallet, fromTick, tip);
      setCursor(CURSOR, String(tip));
      if (n > 0) log(`[observe] tick positions=${n} @${tip}`);
    } catch (e) {
      log("[observe] tick err", e.message);
    } finally {
      ticking = false;
    }
  }, 12_000);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
