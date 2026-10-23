import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
} from "viem";
import {
  CurveAbi,
  DistributorAbi,
  Erc20Abi,
  FactoryAbi,
  Multicall3Abi,
} from "../chain/abis.mjs";
import { KNOWN_QUOTES, LAUNCH, MULTICALL3, ZERO, lower } from "../chain/addresses.mjs";
import { publicClient } from "../chain/clients.mjs";
import { config, log } from "../config.mjs";
import {
  insertAction,
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
  const warm = createWarmAccount(wallets);
  await warm.refresh();
  setInterval(() => warm.refresh().catch(() => {}), 12_000);

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

    if (!info || !reserves) return null;

    const Q = reserves[0];
    const T = reserves[1];
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
    };
  }

  async function trySnipe(token) {
    if (inflight.has(token)) return;
    const launch = launches.get(token);
    const dist = distributors.get(token);
    if (!launch || !dist) return;
    inflight.add(token);

    const detect_ts = launch.detect_ts || Date.now();
    let gate_ts = null;
    let tx_hash_ts = null;

    try {
      const mc = await multicallLaunch(token, launch.curve);
      if (!mc) {
        log("[snipe] multicall fail", token);
        insertAction({ kind: "skip", token, detail: "multicall_fail" });
        return;
      }

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

      // Async journal pool (never blocks send ordering after gate)
      queueMicrotask(() => {
        upsertPool({
          token,
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
          `[snipe] skip ${symbol || token.slice(0, 10)} reason=${gate.reason} detect→gate=${gate_ts - detect_ts}ms`,
        );
        insertAction({
          kind: "skip",
          token,
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
        insertAction({ kind: "skip", token, detail: plan.reason });
        return;
      }

      if (config.dailyMaxQuote != null) {
        const start = new Date();
        start.setUTCHours(0, 0, 0, 0);
        const spent = sumDailyQuoteSpend(start.getTime());
        if (spent + plan.quoteIn > config.dailyMaxQuote) {
          insertAction({ kind: "skip", token, detail: "daily_max_quote" });
          log("[snipe] daily max quote");
          return;
        }
      }

      insertAction({
        kind: "detect",
        token,
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
        `[snipe] ${config.live ? "LIVE" : "DRY"} ${symbol || token.slice(0, 10)} ` +
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
        token,
        detail: result.ok
          ? `${result.tx || `quote=${plan.quoteIn}`} cover=${coverVia}` +
            (result.cover?.ethIn != null ? ` ethIn=${result.cover.ethIn}` : "")
          : result.reason,
        latency_ms: tx_hash_ts - detect_ts,
      });

      if (result.ok) {
        // entry epoch async
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
          costUsd = (Number(plan.quoteIn) / 1e18) * config.ethUsd;
        } else if (pairMeta?.symbol === "USDG") {
          costUsd = Number(plan.quoteIn) / 1e6;
        }

        upsertPosition({
          token,
          entry_block: launch.blockNumber,
          entry_epoch: entryEpoch,
          tokens: plan.target,
          quote_in: plan.quoteIn,
          cost_usd: costUsd,
          buy_tx: result.tx,
          status: result.dry ? "dry" : "open",
        });
        upsertPool({
          token,
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
      insertAction({ kind: "buy_fail", token, detail: e.message });
    } finally {
      inflight.delete(token);
    }
  }

  const listener = startLogListener({
    async onTokenLaunched(ev) {
      const prev = launches.get(ev.token);
      launches.set(ev.token, {
        ...ev,
        detect_ts: prev?.detect_ts ?? ev.detect_ts,
      });
      log(
        `[detect] TokenLaunched ${ev.token.slice(0, 12)}… curve=${ev.curve.slice(0, 12)}…`,
      );
      insertAction({
        kind: "detect",
        token: ev.token,
        detail: "TokenLaunched",
      });
      await trySnipe(ev.token);
    },
    async onDistributorCreated(ev) {
      distributors.set(ev.token, ev.distributor);
      log(
        `[detect] DistributorCreated ${ev.token.slice(0, 12)}… dist=${ev.distributor.slice(0, 12)}…`,
      );
      if (!launches.has(ev.token)) {
        // distributor may arrive first; store and wait for launch
        launches.set(ev.token, {
          token: ev.token,
          curve: null,
          pairToken: null,
          detect_ts: ev.detect_ts,
          blockNumber: ev.blockNumber,
          txHash: ev.txHash,
        });
      }
      // If we only have dist, need curve from getLaunchedToken
      const L = launches.get(ev.token);
      if (!L.curve) {
        try {
          const info = await publicClient().readContract({
            address: getAddress(LAUNCH),
            abi: FactoryAbi,
            functionName: "getLaunchedToken",
            args: [getAddress(ev.token)],
          });
          if (info?.exists) {
            L.curve = lower(info.curve);
            L.pairToken = lower(info.pairToken);
            launches.set(ev.token, L);
          }
        } catch {
          return;
        }
      }
      if (L.curve) await trySnipe(ev.token);
    },
  });

  log(
    `[hotpath] ready live=${config.live ? 1 : 0} wallet=${wallets.sniper.address} tokens=${config.sniperTokens}`,
  );

  return { stop: () => listener.stop(), warm, launches, distributors };
}
