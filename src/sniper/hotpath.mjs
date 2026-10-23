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
  TOPICS,
} from "../chain/abis.mjs";
import {
  DIST_FACTORY,
  KNOWN_QUOTES,
  LAUNCH,
  MULTICALL3,
  ZERO,
  lower,
} from "../chain/addresses.mjs";
import { ethUsdMark } from "../chain/price.mjs";
import { publicClient } from "../chain/clients.mjs";
import { config, log } from "../config.mjs";
import {
  hasPosition,
  insertAction,
  knownPositionTokens,
  sumDailyQuoteSpend,
  upsertPool,
  upsertPosition,
} from "../db/db.mjs";
import { evaluateGates, knownSymbol } from "./gates.mjs";
import { createWarmAccount, executeBuy, planBuy } from "./buy.mjs";
import { startLogListener } from "./wss.mjs";

/**
 * Hot path: WSS → multicall → gate → buy. DB journal is async after send.
 */
export async function startHotpath(wallets) {
  const launches = new Map(); // token -> launch meta
  const distributors = new Map(); // token -> distributor
  const inflight = new Set();
  /** Successful buy_dry / buy_sent — never buy again from any event. */
  const bought = new Set(knownPositionTokens().map(lower));
  /** Tokens we already logged skip=no_distributor (retry when dist appears). */
  const noDistLogged = new Set();
  const warm = createWarmAccount(wallets);
  await warm.refresh();
  setInterval(() => warm.refresh().catch(() => {}), 12_000);

  let headCache = { n: 0n, at: 0 };
  async function currentHead() {
    const now = Date.now();
    if (headCache.n > 0n && now - headCache.at < 2_000) return headCache.n;
    headCache = { n: await publicClient().getBlockNumber(), at: now };
    return headCache.n;
  }

  /** Drop launches older than SNIPER_CATCHUP_BLOCKS (~90s default). */
  async function isStaleLaunch(launch) {
    const maxAge = BigInt(Math.max(0, config.sniperCatchupBlocks));
    if (maxAge === 0n) return false;
    if (launch.blockNumber != null) {
      const head = await currentHead();
      return head > BigInt(launch.blockNumber) &&
        head - BigInt(launch.blockNumber) > maxAge;
    }
    const detect = launch.detect_ts || 0;
    if (!detect) return false;
    // ~0.1s/block → ms ≈ blocks * 100
    return Date.now() - detect > Number(maxAge) * 100;
  }

  async function multicallLaunch(token, curve) {
    const client = publicClient();
    const tokenA = getAddress(token);
    const curveA = getAddress(curve);
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
        target: curveA,
        allowFailure: true,
        callData: encodeFunctionData({
          abi: CurveAbi,
          functionName: "getReserves",
        }),
      },
      {
        target: curveA,
        allowFailure: true,
        callData: encodeFunctionData({
          abi: CurveAbi,
          functionName: "feeBps",
        }),
      },
      {
        target: curveA,
        allowFailure: true,
        callData: encodeFunctionData({
          abi: CurveAbi,
          functionName: "creatorTaxBps",
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
      {
        target: getAddress(DIST_FACTORY),
        allowFailure: true,
        callData: encodeFunctionData({
          abi: DistributorFactoryAbi,
          functionName: "distributorOf",
          args: [tokenA],
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
      return decodeFunctionResult({
        abi,
        functionName: name,
        data: r.returnData,
      });
    };

    const info = decode(0, FactoryAbi, "getLaunchedToken");
    const reserves = decode(1, CurveAbi, "getReserves");
    const feeBps = decode(2, CurveAbi, "feeBps");
    const taxBps = decode(3, CurveAbi, "creatorTaxBps");
    const decimals = decode(4, Erc20Abi, "decimals");
    const symbol = decode(5, Erc20Abi, "symbol");
    const distributorOf = decode(6, DistributorFactoryAbi, "distributorOf");

    if (!info || !reserves) return null;

    const Q = reserves[0];
    const T = reserves[1];
    let dist = null;
    if (distributorOf && lower(distributorOf) !== ZERO) {
      dist = lower(distributorOf);
    }
    return {
      info,
      curveState: {
        Q,
        T,
        feeBps: Number(feeBps ?? 100n),
        taxBps: Number(taxBps ?? info.creatorTaxBps ?? 0),
      },
      decimals: Number(decimals ?? 18),
      symbol: symbol || null,
      distributorOf: dist,
    };
  }

  async function trySnipe(token) {
    const t = lower(token);
    if (bought.has(t) || hasPosition(t)) {
      bought.add(t);
      return;
    }
    if (inflight.has(t)) return;
    const launch = launches.get(t);
    if (!launch?.curve) return;

    if (await isStaleLaunch(launch)) {
      insertAction({
        kind: "skip",
        token: t,
        detail: "stale_launch",
      });
      return;
    }

    inflight.add(t);

    const detect_ts = launch.detect_ts || Date.now();
    let gate_ts = null;
    let tx_hash_ts = null;

    try {
      const mc = await multicallLaunch(t, launch.curve);
      if (!mc) {
        log("[snipe] multicall fail", t);
        insertAction({ kind: "skip", token: t, detail: "multicall_fail" });
        return;
      }

      // WSS map first; else batched distributorOf from the same multicall.
      let dist = distributors.get(t) || mc.distributorOf;
      if (dist) distributors.set(t, dist);

      if (!dist) {
        if (!noDistLogged.has(t)) {
          noDistLogged.add(t);
          log(
            `[snipe] skip ${t.slice(0, 10)} reason=no_distributor (waiting DistCreated)`,
          );
          insertAction({
            kind: "skip",
            token: t,
            detail: "no_distributor",
          });
        }
        return;
      }
      noDistLogged.delete(t);

      const { info, curveState, decimals, symbol } = mc;
      const pair = lower(info.pairToken) || launch.pairToken;
      const gate = evaluateGates({
        buybackEnabled: !!info.buybackEnabled,
        creatorFeeRecipient: info.creatorFeeRecipient,
        distributor: dist,
        pairToken: pair,
        pairSymbol: knownSymbol(pair),
        skipIneligibleQuotes: config.skipIneligibleQuotes,
      });
      gate_ts = Date.now();

      queueMicrotask(() => {
        upsertPool({
          token: t,
          curve: launch.curve,
          distributor: dist,
          pair,
          symbol,
          decimals,
          buyback: !!info.buybackEnabled,
          tax_bps: Number(info.creatorTaxBps ?? 0),
          launch_block: launch.blockNumber,
          launch_tx: launch.txHash,
        });
      });

      if (!gate.ok) {
        log(
          `[snipe] skip ${symbol || t.slice(0, 10)} reason=${gate.reason} detect→gate=${gate_ts - detect_ts}ms`,
        );
        insertAction({
          kind: "skip",
          token: t,
          detail: gate.reason,
          latency_ms: gate_ts - detect_ts,
        });
        return;
      }

      const plan = planBuy({
        curveState,
        decimals,
        pairToken: pair,
      });
      if (!plan.ok) {
        log(`[snipe] plan fail ${plan.reason}`);
        insertAction({ kind: "skip", token: t, detail: plan.reason });
        return;
      }

      if (config.dailyMaxQuote != null) {
        const start = new Date();
        start.setUTCHours(0, 0, 0, 0);
        const spent = sumDailyQuoteSpend(start.getTime());
        if (spent + plan.quoteIn > config.dailyMaxQuote) {
          insertAction({ kind: "skip", token: t, detail: "daily_max_quote" });
          log("[snipe] daily max quote");
          return;
        }
      }

      // Re-check before send — another event may have finished a buy.
      if (bought.has(t) || hasPosition(t)) {
        bought.add(t);
        return;
      }

      insertAction({
        kind: "detect",
        token: t,
        detail: `gate_ok ${symbol || ""}`,
        latency_ms: gate_ts - detect_ts,
      });

      const result = await executeBuy({
        warm,
        curve: launch.curve,
        pairToken: pair,
        plan,
        live: config.live,
      });
      tx_hash_ts = Date.now();

      const coverVia = result.cover?.via ?? "?";
      log(
        `[snipe] ${config.live ? "LIVE" : "DRY"} ${symbol || t.slice(0, 10)} ` +
          `detect→gate=${gate_ts - detect_ts}ms gate→tx=${tx_hash_ts - gate_ts}ms ` +
          `detect→tx=${tx_hash_ts - detect_ts}ms ` +
          `quoteIn=${plan.quoteIn} tokens=${plan.target} cover=${coverVia} ` +
          (result.ok
            ? result.dry
              ? "would-buy"
              : `tx=${result.tx}`
            : `fail=${result.reason}`),
      );

      insertAction({
        kind: result.ok
          ? result.dry
            ? "buy_dry"
            : "buy_sent"
          : "buy_fail",
        token: t,
        detail: result.ok
          ? `${result.tx || `quote=${plan.quoteIn}`} cover=${coverVia}` +
            (result.cover?.ethIn != null ? ` ethIn=${result.cover.ethIn}` : "")
          : result.reason,
        latency_ms: tx_hash_ts - detect_ts,
      });

      if (result.ok) {
        bought.add(t);
        let entryEpoch = 0;
        try {
          entryEpoch = Number(
            await publicClient().readContract({
              address: getAddress(dist),
              abi: DistributorAbi,
              functionName: "epochCount",
            }),
          );
        } catch {
          /* */
        }

        const pairMeta = KNOWN_QUOTES[pair || ZERO];
        let costUsd = null;
        if (pairMeta?.symbol === "ETH" || pair === ZERO) {
          const px = await ethUsdMark();
          if (px != null) costUsd = (Number(plan.quoteIn) / 1e18) * px;
        } else if (pairMeta?.symbol === "USDG") {
          costUsd = Number(plan.quoteIn) / 1e6;
        }

        upsertPosition({
          token: t,
          entry_block: launch.blockNumber,
          entry_epoch: entryEpoch,
          tokens: plan.target,
          quote_in: plan.quoteIn,
          cost_usd: costUsd,
          buy_tx: result.tx,
          status: result.dry ? "dry" : "open",
        });
        upsertPool({
          token: t,
          curve: launch.curve,
          distributor: dist,
          pair,
          symbol,
          decimals,
          buyback: false,
          tax_bps: Number(info.creatorTaxBps ?? 0),
          launch_block: launch.blockNumber,
          launch_tx: launch.txHash,
        });
      }
    } catch (e) {
      log("[snipe] err", e.message);
      insertAction({ kind: "buy_fail", token: t, detail: e.message });
    } finally {
      inflight.delete(t);
    }
  }

  async function ensureLaunchMeta(token, seed = {}) {
    const t = lower(token);
    let L = launches.get(t);
    if (!L) {
      L = {
        token: t,
        curve: null,
        pairToken: null,
        detect_ts: seed.detect_ts ?? Date.now(),
        blockNumber: seed.blockNumber ?? null,
        txHash: seed.txHash ?? null,
      };
      launches.set(t, L);
    } else if (seed.blockNumber != null && L.blockNumber == null) {
      L.blockNumber = seed.blockNumber;
    }
    if (!L.curve) {
      try {
        const info = await publicClient().readContract({
          address: getAddress(LAUNCH),
          abi: FactoryAbi,
          functionName: "getLaunchedToken",
          args: [getAddress(t)],
        });
        if (info?.exists) {
          L.curve = lower(info.curve);
          L.pairToken = lower(info.pairToken);
          launches.set(t, L);
        }
      } catch {
        /* */
      }
    }
    return L;
  }

  const listener = startLogListener({
    async onTokenLaunched(ev) {
      const t = lower(ev.token);
      const prev = launches.get(t);
      launches.set(t, {
        ...ev,
        token: t,
        detect_ts: prev?.detect_ts ?? ev.detect_ts,
      });
      log(
        `[detect] TokenLaunched ${t.slice(0, 12)}… curve=${ev.curve.slice(0, 12)}…`,
      );
      insertAction({
        kind: "detect",
        token: t,
        detail: "TokenLaunched",
      });
      await trySnipe(t);
    },
    async onDistributorCreated(ev) {
      const t = lower(ev.token);
      distributors.set(t, lower(ev.distributor));
      noDistLogged.delete(t);
      log(
        `[detect] DistributorCreated ${t.slice(0, 12)}… dist=${ev.distributor.slice(0, 12)}…`,
      );
      insertAction({
        kind: "detect",
        token: t,
        detail: "DistributorCreated",
      });
      const L = await ensureLaunchMeta(t, ev);
      if (L.curve) await trySnipe(t);
    },
    async onCreatorFeeRecipientUpdated(ev) {
      const t = lower(ev.token);
      log(
        `[detect] CreatorFeeRecipientUpdated ${t.slice(0, 12)}… → ${ev.newRecipient?.slice(0, 12)}…`,
      );
      insertAction({
        kind: "detect",
        token: t,
        detail: "CreatorFeeRecipientUpdated",
      });
      const L = await ensureLaunchMeta(t, ev);
      if (L.curve) await trySnipe(t);
    },
  });

  // Boot catch-up: only last ~90s of factory logs (same bound as max snipe age).
  try {
    const client = publicClient();
    const head = await client.getBlockNumber();
    headCache = { n: head, at: Date.now() };
    const lookback = BigInt(Math.max(0, config.sniperCatchupBlocks));
    const from = head > lookback ? head - lookback : 0n;
    if (from <= head && lookback > 0n) {
      log(`[hotpath] catch-up blocks ${from}→${head} (maxAge=${lookback})`);
      const CHUNK = 2_000n;
      let cur = from;
      while (cur <= head) {
        const to = cur + CHUNK - 1n > head ? head : cur + CHUNK - 1n;
        const logs = await client.getLogs({
          address: [getAddress(LAUNCH), getAddress(DIST_FACTORY)],
          fromBlock: cur,
          toBlock: to,
        });
        const distLogs = logs.filter(
          (l) => l.topics?.[0] === TOPICS.DistributorCreated,
        );
        const other = logs.filter(
          (l) => l.topics?.[0] !== TOPICS.DistributorCreated,
        );
        await listener.replayLogs([...distLogs, ...other]);
        cur = to + 1n;
      }
      log(`[hotpath] catch-up done`);
    }
  } catch (e) {
    log("[hotpath] catch-up err", e.message);
  }

  log(
    `[hotpath] ready live=${config.live ? 1 : 0} wallet=${wallets.sniper.address} tokens=${config.sniperTokens} catchup=${config.sniperCatchupBlocks} delayMs=${config.sniperDelayMs}`,
  );

  return { stop: () => listener.stop(), warm, launches, distributors, bought };
}
