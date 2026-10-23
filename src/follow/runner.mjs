import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
} from "viem";
import {
  CurveAbi,
  DistributorAbi,
  DistributorFactoryAbi,
  Erc20Abi,
  FactoryAbi,
  Multicall3Abi,
} from "../chain/abis.mjs";
import {
  DIST_FACTORY,
  KNOWN_QUOTES,
  LAUNCH,
  MULTICALL3,
  WETH,
  USDG,
  ZERO,
  lower,
} from "../chain/addresses.mjs";

/** Quote / system tokens — never Pons launch tokens. */
const SKIP_TOKENS = new Set([ZERO, WETH, USDG, lower(LAUNCH), lower(DIST_FACTORY)]);
import { ethUsdMark } from "../chain/price.mjs";
import { publicClient } from "../chain/clients.mjs";
import { config, log } from "../config.mjs";
import {
  countOpenFollows,
  hasPosition,
  insertAction,
  knownPositionTokens,
  sumDailyFollowUsd,
  upsertPool,
  upsertPosition,
} from "../db/db.mjs";
import { knownSymbol } from "../sniper/gates.mjs";
import { createWarmAccount, executeBuy } from "../sniper/buy.mjs";
import { balanceOf } from "../sniper/coverQuote.mjs";
import {
  lookbackFarmerTransfers,
  startFarmerTransferListener,
} from "./detect.mjs";
import { farmerAddresses } from "./farmers.mjs";
import { evaluateFollowGates } from "./gates.mjs";
import { planBuyUsd } from "./plan.mjs";

async function resolvePool(token) {
  const client = publicClient();
  const tokenA = getAddress(token);
  const calls = [
    {
      target: getAddress(LAUNCH),
      allowFailure: true,
      callData: encodeFunctionData({
        abi: FactoryAbi,
        functionName: "getLaunchedToken",
        args: [tokenA],
      }),
    },
    {
      target: getAddress(DIST_FACTORY),
      allowFailure: true,
      callData: encodeFunctionData({
        abi: DistributorFactoryAbi,
        functionName: "distributorOf",
        args: [tokenA],
      }),
    },
    {
      target: tokenA,
      allowFailure: true,
      callData: encodeFunctionData({
        abi: Erc20Abi,
        functionName: "decimals",
      }),
    },
    {
      target: tokenA,
      allowFailure: true,
      callData: encodeFunctionData({
        abi: Erc20Abi,
        functionName: "symbol",
      }),
    },
  ];
  const results = await client.readContract({
    address: getAddress(MULTICALL3),
    abi: Multicall3Abi,
    functionName: "aggregate3",
    args: [calls],
  });

  const decode = (i, abi, name) => {
    const r = results[i];
    if (!r?.success) return null;
    const data = r.returnData;
    if (data == null || data === "0x" || data === "0x0") return null;
    try {
      return decodeFunctionResult({ abi, functionName: name, data });
    } catch {
      return null;
    }
  };

  const info = decode(0, FactoryAbi, "getLaunchedToken");
  if (!info?.exists) return null;
  const distributorOf = decode(1, DistributorFactoryAbi, "distributorOf");
  const decimals = Number(decode(2, Erc20Abi, "decimals") ?? 18);
  const symbol = decode(3, Erc20Abi, "symbol") || null;
  const curve = lower(info.curve);
  const pair = lower(info.pairToken) || ZERO;

  const [reserves, feeBps, taxBps, graduated] = await Promise.all([
    client.readContract({
      address: getAddress(curve),
      abi: CurveAbi,
      functionName: "getReserves",
    }),
    client
      .readContract({
        address: getAddress(curve),
        abi: CurveAbi,
        functionName: "feeBps",
      })
      .catch(() => 100n),
    client
      .readContract({
        address: getAddress(curve),
        abi: CurveAbi,
        functionName: "creatorTaxBps",
      })
      .catch(() => BigInt(info.creatorTaxBps ?? 0)),
    client
      .readContract({
        address: getAddress(curve),
        abi: CurveAbi,
        functionName: "graduated",
      })
      .catch(() => false),
  ]);

  let dist = null;
  if (distributorOf && lower(distributorOf) !== ZERO) {
    dist = lower(distributorOf);
  }

  let unallocated = null;
  if (dist) {
    try {
      unallocated = await client.readContract({
        address: getAddress(dist),
        abi: DistributorAbi,
        functionName: "unallocatedQuote",
      });
    } catch {
      /* soft */
    }
  }

  return {
    info,
    curve,
    pair,
    decimals,
    symbol,
    distributor: dist,
    graduated: !!graduated,
    curveState: {
      Q: reserves[0],
      T: reserves[1],
      feeBps: Number(feeBps ?? 100n),
      taxBps: Number(taxBps ?? info.creatorTaxBps ?? 0),
    },
    unallocated,
  };
}

async function costUsdFor(pair, quoteIn) {
  const pairMeta = KNOWN_QUOTES[pair || ZERO];
  if (pairMeta?.symbol === "ETH" || pair === ZERO || pairMeta?.symbol === "WETH") {
    const px = await ethUsdMark();
    if (px == null) return null;
    return (Number(quoteIn) / 1e18) * px;
  }
  if (pairMeta?.symbol === "USDG") {
    return Number(quoteIn) / 1e6;
  }
  return null;
}

/**
 * Process one farmer Transfer / bag signal. Idempotent per token.
 * Exported for unit tests (inject resolve/buy).
 */
export async function tryFollow(ev, ctx) {
  const t = lower(ev.token);
  const {
    warm,
    bought,
    inflight,
    live = config.followLive,
    buyUsd = config.followBuyUsd,
    dust = config.holderDust,
    resolve = resolvePool,
    buy = executeBuy,
  } = ctx;

  if (!t || bought.has(t) || hasPosition(t)) {
    bought.add(t);
    return { ok: false, reason: "already_held" };
  }
  if (inflight.has(t)) return { ok: false, reason: "inflight" };
  if (SKIP_TOKENS.has(t)) {
    return { ok: false, reason: "skip_quote_token" };
  }
  if (ev.value != null && ev.value < dust) {
    return { ok: false, reason: "dust_transfer" };
  }

  inflight.add(t);
  const detect_ts = ev.detect_ts || Date.now();
  try {
    const pool = await resolve(t);
    if (!pool) {
      // Quiet — farmers also receive USDG/WETH/random ERC20s.
      if (!ev.lookback) {
        log(`[follow] skip ${t.slice(0, 10)} reason=not_pons_token`);
      }
      insertAction({
        kind: "follow_skip",
        token: t,
        detail: "not_pons_token",
      });
      return { ok: false, reason: "not_pons_token" };
    }

    // Confirm farmer still holds (lookback) or just received (live Transfer).
    let farmerBal = 0n;
    if (ctx.farmerBalance != null) {
      farmerBal = ctx.farmerBalance;
    } else {
      try {
        farmerBal = await balanceOf(t, ev.to);
      } catch {
        farmerBal = ev.value ?? 0n;
      }
    }
    const farmerHolds = farmerBal >= dust || (ev.value != null && ev.value >= dust);

    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const gate = evaluateFollowGates({
      buybackEnabled: !!pool.info.buybackEnabled,
      creatorFeeRecipient: pool.info.creatorFeeRecipient,
      distributor: pool.distributor,
      pairToken: pool.pair,
      pairSymbol: knownSymbol(pool.pair) || pool.symbol,
      skipIneligibleQuotes: config.skipIneligibleQuotes,
      graduated: pool.graduated,
      alreadyHeld: bought.has(t) || hasPosition(t),
      farmerHolds,
      openFollows: countOpenFollows(),
      maxOpen: config.followMaxOpen,
      dailyUsdSpent: sumDailyFollowUsd(start.getTime()),
      dailyUsdCap: config.followDailyUsd,
      buyUsd,
    });
    const gate_ts = Date.now();

    upsertPool({
      token: t,
      curve: pool.curve,
      distributor: pool.distributor,
      pair: pool.pair,
      symbol: pool.symbol,
      decimals: pool.decimals,
      buyback: !!pool.info.buybackEnabled,
      tax_bps: Number(pool.info.creatorTaxBps ?? 0),
      launch_block: ev.blockNumber ?? null,
      launch_tx: ev.txHash ?? null,
    });

    if (!gate.ok) {
      log(
        `[follow] skip ${pool.symbol || t.slice(0, 10)} reason=${gate.reason} farmer=${ev.to?.slice(0, 10)}`,
      );
      insertAction({
        kind: "follow_skip",
        token: t,
        detail: gate.reason,
        latency_ms: gate_ts - detect_ts,
      });
      return { ok: false, reason: gate.reason };
    }

    // Soft pot signal (never hard-fails).
    const potSoft =
      pool.unallocated != null && pool.unallocated > 0n ? "has_unalloc" : "thin_or_unknown";

    const plan = await planBuyUsd({
      curveState: pool.curveState,
      pairToken: pool.pair,
      usd: buyUsd,
    });
    if (!plan.ok) {
      insertAction({ kind: "follow_skip", token: t, detail: plan.reason });
      return { ok: false, reason: plan.reason };
    }

    if (bought.has(t) || hasPosition(t)) {
      bought.add(t);
      return { ok: false, reason: "already_held" };
    }

    insertAction({
      kind: "follow_detect",
      token: t,
      detail: `farmer=${ev.to?.slice(0, 12)} pot=${potSoft} $${buyUsd}`,
      latency_ms: gate_ts - detect_ts,
    });

    const result = await buy({
      warm,
      curve: pool.curve,
      pairToken: pool.pair,
      plan,
      live,
      delayMs: config.followDelayMs,
    });
    const tx_ts = Date.now();
    const coverVia = result.cover?.via ?? "?";
    const costUsd = (await costUsdFor(pool.pair, plan.quoteIn)) ?? buyUsd;

    log(
      `[follow] ${live ? "LIVE" : "DRY"} ${pool.symbol || t.slice(0, 10)} ` +
        `farmer=${ev.to?.slice(0, 10)} $${buyUsd} quoteIn=${plan.quoteIn} ` +
        `tokens=${plan.target} pot=${potSoft} cover=${coverVia} ` +
        (result.ok
          ? result.dry
            ? "would-buy"
            : `tx=${result.tx}`
          : `fail=${result.reason}`),
    );

    insertAction({
      kind: result.ok
        ? result.dry
          ? "follow_buy_dry"
          : "follow_buy_sent"
        : "follow_buy_fail",
      token: t,
      detail: result.ok
        ? `${result.tx || `quote=${plan.quoteIn}`} cover=${coverVia} $${costUsd?.toFixed?.(2) ?? costUsd}`
        : result.reason,
      latency_ms: tx_ts - detect_ts,
    });

    if (result.ok) {
      bought.add(t);
      let entryEpoch = 0;
      if (pool.distributor) {
        try {
          entryEpoch = Number(
            await publicClient().readContract({
              address: getAddress(pool.distributor),
              abi: DistributorAbi,
              functionName: "epochCount",
            }),
          );
        } catch {
          /* */
        }
      }
      upsertPosition({
        token: t,
        entry_block: ev.blockNumber ?? null,
        entry_epoch: entryEpoch,
        tokens: plan.target,
        quote_in: plan.quoteIn,
        cost_usd: costUsd,
        buy_tx: result.tx,
        status: result.dry ? "dry" : "open",
        strategy: "follow",
      });
      upsertPool({
        token: t,
        curve: pool.curve,
        distributor: pool.distributor,
        pair: pool.pair,
        symbol: pool.symbol,
        decimals: pool.decimals,
        buyback: false,
        tax_bps: Number(pool.info.creatorTaxBps ?? 0),
        launch_block: ev.blockNumber ?? null,
        launch_tx: ev.txHash ?? null,
      });
    }
    return result.ok
      ? { ok: true, dry: !!result.dry, plan, costUsd, symbol: pool.symbol }
      : { ok: false, reason: result.reason };
  } catch (e) {
    log("[follow] err", e.message);
    insertAction({ kind: "follow_buy_fail", token: t, detail: e.message });
    return { ok: false, reason: e.message };
  } finally {
    inflight.delete(t);
  }
}

/**
 * Farmer-follow hot path. Independent of launch sniper; uses FOLLOW_LIVE.
 */
export async function startFollow(wallets) {
  const farmers = farmerAddresses();
  const bought = new Set(knownPositionTokens().map(lower));
  const inflight = new Set();
  const warm = createWarmAccount(wallets);
  await warm.refresh();
  setInterval(() => warm.refresh().catch(() => {}), 12_000);

  const ctx = {
    warm,
    bought,
    inflight,
    live: config.followLive,
    buyUsd: config.followBuyUsd,
    dust: config.holderDust,
  };

  async function onFarmerTransfer(ev) {
    await tryFollow(ev, ctx);
  }

  try {
    await lookbackFarmerTransfers({ onFarmerTransfer, farmers });
  } catch (e) {
    log("[follow] lookback err", e.message);
  }

  const listener = startFarmerTransferListener({
    onFarmerTransfer,
    farmers,
  });

  log(
    `[follow] ready live=${config.followLive ? 1 : 0} wallet=${wallets.sniper.address} ` +
      `buyUsd=${config.followBuyUsd} maxOpen=${config.followMaxOpen} ` +
      `dailyUsd=${config.followDailyUsd} farmers=${farmers.length} ` +
      `lookback=${config.followLookbackBlocks}`,
  );

  return { stop: () => listener.stop(), warm, bought, farmers };
}
