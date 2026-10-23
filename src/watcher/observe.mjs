import { decodeEventLog, getAddress, pad } from "viem";
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
import { config, log } from "../config.mjs";
import {
  db,
  getCursor,
  insertAction,
  setCursor,
  upsertPool,
  upsertPosition,
} from "../db/db.mjs";
import { ethUsdMark } from "../chain/price.mjs";

const CHUNK = 2_000n;
const CURSOR = "observe_head";

function topicAddr(a) {
  return pad(getAddress(a), { size: 32 });
}

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

async function fetchMeta(token, curve) {
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
    curve: curve || (info?.curve ? lower(info.curve) : null),
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

async function resolveTokenFromBuy(lg, me) {
  const client = publicClient();
  try {
    const receipt = await client.getTransactionReceipt({
      hash: lg.transactionHash,
    });
    for (const l of receipt.logs) {
      if (l.topics?.[0] !== TOPICS.Transfer) continue;
      if (l.topics.length < 3) continue;
      const to = lower("0x" + l.topics[2].slice(26));
      if (to !== me) continue;
      return lower(l.address);
    }
  } catch {
    /* */
  }
  return null;
}

/**
 * Scan [from,to] for launches, distributors, and CurveBuy by wallet.
 * Upserts pools + open positions for observed buys.
 */
export async function scanObserveRange(wallet, fromBlock, toBlock) {
  const client = publicClient();
  const me = lower(wallet);
  const meTopic = topicAddr(wallet);
  const curveToToken = new Map();
  const tokenMeta = new Map(); // token -> {curve, pair, launch_block, launch_tx}
  const distributors = new Map();
  const buys = new Map(); // token -> aggregated buy

  let from = BigInt(fromBlock);
  const end = BigInt(toBlock);
  while (from <= end) {
    const to = from + CHUNK - 1n > end ? end : from + CHUNK - 1n;

    const [launchLogs, distLogs, buyAsBuyer, buyAsRecipient] =
      await Promise.all([
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
        client.getLogs({
          fromBlock: from,
          toBlock: to,
          topics: [TOPICS.CurveBuy, meTopic],
        }),
        client.getLogs({
          fromBlock: from,
          toBlock: to,
          topics: [TOPICS.CurveBuy, null, meTopic],
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
        const curve = lower(args.curve);
        curveToToken.set(curve, token);
        tokenMeta.set(token, {
          curve,
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

    const seen = new Set();
    for (const lg of [...buyAsBuyer, ...buyAsRecipient]) {
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
      const buyer = lower(decoded.args.buyer);
      const recipient = lower(decoded.args.recipient);
      if (buyer !== me && recipient !== me) continue;

      const curve = lower(lg.address);
      let token = curveToToken.get(curve);
      if (!token) {
        token = await resolveTokenFromBuy(lg, me);
        if (token) curveToToken.set(curve, token);
      }
      if (!token) {
        log("[observe] CurveBuy unknown token curve=", curve.slice(0, 12));
        continue;
      }

      const prev = buys.get(token);
      const quoteIn = decoded.args.quoteIn;
      const tokensOut = decoded.args.tokensOut;
      if (!prev) {
        buys.set(token, {
          token,
          curve,
          quote_in: quoteIn,
          tokens: tokensOut,
          buy_tx: lg.transactionHash,
          entry_block:
            lg.blockNumber != null ? Number(lg.blockNumber) : null,
        });
      } else {
        prev.quote_in += quoteIn;
        prev.tokens += tokensOut;
      }
    }

    from = to + 1n;
  }

  const ethPx = await ethUsdMark().catch(() => null);
  let n = 0;
  for (const buy of buys.values()) {
    const base = tokenMeta.get(buy.token) || {};
    const meta = await fetchMeta(buy.token, buy.curve || base.curve);
    const dist =
      distributors.get(buy.token) || meta.creatorFeeRecipient || null;

    upsertPool({
      token: buy.token,
      curve: meta.curve || buy.curve,
      distributor: dist,
      pair: meta.pair ?? base.pair,
      symbol: meta.symbol,
      decimals: meta.decimals,
      buyback: meta.buyback,
      tax_bps: meta.tax_bps,
      launch_block: base.launch_block ?? buy.entry_block,
      launch_tx: base.launch_tx ?? buy.buy_tx,
    });

    const cost_usd = costUsdFor(meta.pair ?? base.pair, buy.quote_in, ethPx);
    const prev = db()
      .prepare(`SELECT buy_tx, entry_epoch FROM positions WHERE token=?`)
      .get(buy.token);
    upsertPosition({
      token: buy.token,
      entry_block: buy.entry_block,
      // Unknown at observe time; keep prior if any. Dash uses current_epoch > 0 for Published.
      entry_epoch: prev?.entry_epoch ?? 0,
      tokens: buy.tokens,
      quote_in: buy.quote_in,
      cost_usd,
      buy_tx: buy.buy_tx,
      status: "open",
    });
    if (!prev || prev.buy_tx !== buy.buy_tx) {
      insertAction({
        kind: "observe",
        token: buy.token,
        detail: `buy_tx=${buy.buy_tx} quote=${buy.quote_in}`,
      });
      log(
        `[observe] position ${meta.symbol || buy.token.slice(0, 10)} quote=${buy.quote_in} tokens=${buy.tokens}`,
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
    log(`[observe] synced ${n} buy(s)`);
  }
  setCursor(CURSOR, String(head));

  const timer = setInterval(async () => {
    try {
      const cur = getCursor(CURSOR);
      const start = cur != null ? BigInt(cur) + 1n : head + 1n;
      const tip = await client.getBlockNumber();
      if (start > tip) return;
      const n = await scanObserveRange(wallet, start, tip);
      setCursor(CURSOR, String(tip));
      if (n > 0) log(`[observe] +${n} new buy(s) @${tip}`);
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
