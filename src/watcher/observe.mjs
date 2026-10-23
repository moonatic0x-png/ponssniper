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
  const [asBuyer, asRecipient] = await Promise.all([
    client.getLogs({
      address: curveA,
      event: curveBuyEvent,
      args: { buyer: me },
      fromBlock,
      toBlock,
    }),
    client.getLogs({
      address: curveA,
      event: curveBuyEvent,
      args: { recipient: me },
      fromBlock,
      toBlock,
    }),
  ]);
  const seen = new Set();
  let quoteIn = 0n;
  let tokens = 0n;
  let buyTx = null;
  let entryBlock = null;
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
  while (from <= end) {
    const to = from + CHUNK - 1n > end ? end : from + CHUNK - 1n;
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

  const ethPx = await ethUsdMark().catch(() => null);
  const fromB = BigInt(fromBlock);
  const toB = BigInt(toBlock);
  let n = 0;

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

    const buy = await buysOnCurve(base.curve, me, fromB, toB).catch(() => ({
      quoteIn: 0n,
      tokens: 0n,
      buyTx: null,
      entryBlock: null,
      n: 0,
    }));

    if (bal <= 0n && buy.n === 0) continue;

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

    const tokens = bal > 0n ? bal : buy.tokens;
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
 * Backfill from lookback (or last cursor) then follow head for new buys.
 */
export async function startObserve(wallet) {
  const client = publicClient();
  const head = await client.getBlockNumber();
  const saved = getCursor(CURSOR);
  let from;
  if (saved != null && Number.isFinite(Number(saved))) {
    from = BigInt(saved) + 1n;
  } else {
    const lookback = BigInt(Math.max(0, config.readLookbackBlocks));
    from = head > lookback ? head - lookback : 0n;
  }
  if (from <= head) {
    log(
      `[observe] sync wallet=${wallet} blocks ${from}→${head} lookback=${config.readLookbackBlocks}`,
    );
    const n = await scanObserveRange(wallet, from, head);
    log(`[observe] synced ${n} position(s)`);
  }
  setCursor(CURSOR, String(head));

  const timer = setInterval(async () => {
    try {
      const cur = getCursor(CURSOR);
      const start = cur != null ? BigInt(cur) + 1n : head + 1n;
      const tip = await client.getBlockNumber();
      // Overlap a bit so we don't miss; always re-check known pools' balances.
      const fromTick = start > 50n ? start - 50n : start;
      if (fromTick > tip) return;
      const n = await scanObserveRange(wallet, fromTick, tip);
      setCursor(CURSOR, String(tip));
      if (n > 0) log(`[observe] tick positions=${n} @${tip}`);
    } catch (e) {
      log("[observe] tick err", e.message);
    }
  }, 12_000);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
