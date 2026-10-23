import { encodeFunctionData, getAddress, parseEther } from "viem";
import { CurveAbi } from "../chain/abis.mjs";
import { ZERO, lower } from "../chain/addresses.mjs";
import { entryQuoteFor, buyTokensFor, slip } from "../chain/curveMath.mjs";
import { publicClient, writeClient } from "../chain/clients.mjs";
import { config, log } from "../config.mjs";
import { COVER_GAS, coverQuote, ensureAllowance } from "./coverQuote.mjs";

/**
 * Pre-warmed account state for hot path.
 */
export function createWarmAccount(wallets) {
  const account = wallets.sniper.account;
  const address = wallets.sniper.address;
  const state = {
    account,
    address,
    nonce: null,
    maxFeePerGas: null,
    maxPriorityFeePerGas: null,
    warmedAt: 0,
  };

  async function refresh() {
    const client = publicClient();
    const [nonce, fees] = await Promise.all([
      client.getTransactionCount({ address, blockTag: "pending" }),
      client.estimateFeesPerGas().catch(() => null),
    ]);
    state.nonce = nonce;
    if (fees) {
      state.maxFeePerGas = fees.maxFeePerGas;
      state.maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
    } else {
      state.maxFeePerGas = parseEther("0.000000002");
      state.maxPriorityFeePerGas = parseEther("0.000000001");
    }
    state.warmedAt = Date.now();
  }

  return { state, refresh };
}

/**
 * Build buy plan for fixed token amount.
 */
export function planBuy({
  curveState,
  decimals,
  pairToken,
  targetWhole = config.sniperTokens,
  slippageBps = config.slippageBps,
}) {
  const target = targetWhole * 10n ** BigInt(decimals);
  const quoteIn = entryQuoteFor(curveState, target);
  if (quoteIn == null) return { ok: false, reason: "quote_math_failed" };
  const sim = buyTokensFor(curveState, quoteIn);
  const minTokensOut = slip(target, slippageBps);
  if (sim.tokens < minTokensOut) {
    return {
      ok: false,
      reason: "sim_below_min",
      quoteIn,
      target,
      simTokens: sim.tokens,
    };
  }
  if (config.maxQuoteIn != null && quoteIn > config.maxQuoteIn) {
    return { ok: false, reason: "max_quote_in", quoteIn };
  }
  return {
    ok: true,
    quoteIn,
    target,
    minTokensOut,
    isEth: lower(pairToken) === ZERO || pairToken == null,
  };
}

/**
 * Cover quote (ETH→pair if needed) then submit or DRY-simulate curve buy.
 * No sell path.
 *
 * Order: tax delay → cover → approve → buy (tight). Never swap then wait —
 * a post-cover abort strands quote on the wallet.
 */
export async function executeBuy({
  warm,
  curve,
  pairToken,
  plan,
  live = config.live,
  /** Override snipe-tax wait; follow uses 0 by default (dormant pots). */
  delayMs = config.sniperDelayMs,
}) {
  const client = publicClient();
  const me = warm.state.address;
  const curveAddr = getAddress(curve);
  const isEth = plan.isEth;
  const pair = isEth ? ZERO : getAddress(pairToken);

  // 0) Wait out snipe-tax BEFORE spending ETH on cover
  if (delayMs > 0) {
    await new Promise((r) => setTimeout(r, delayMs));
  }

  // 1) Automatic quote funding — balance or ETH→quote for the shortfall only
  const covered = await coverQuote(warm, pair, plan.quoteIn, { live });
  if (!covered.ok) {
    return { ok: false, reason: covered.reason, cover: covered };
  }
  log(
    `[cover] via=${covered.via}${covered.dry ? " (DRY)" : ""}` +
      (covered.ethIn != null ? ` ethIn=${covered.ethIn}` : "") +
      ` quoteNeeded=${plan.quoteIn}`,
  );

  // 2) Approve curve to pull ERC20 quote (fixed gas; same nonce path as cover)
  if (!isEth) {
    try {
      await ensureAllowance(warm, pair, curveAddr, plan.quoteIn, live);
    } catch (e) {
      return {
        ok: false,
        reason: `approve_fail: ${e.shortMessage || e.message}`,
        cover: covered,
      };
    }
  }

  const data = encodeFunctionData({
    abi: CurveAbi,
    functionName: "buy",
    args: [plan.quoteIn, plan.minTokensOut, me],
  });

  // 3) Simulate buy when we have (or will have) quote; in DRY after eth-cover,
  // eth_call may still fail if wallet lacks quote — log and treat as planned.
  // After a live cover, never abort on simulate — send the buy (revert is cheaper
  // than stranding quote from a false-negative eth_call).
  try {
    await client.call({
      account: me,
      to: curveAddr,
      data,
      value: isEth ? plan.quoteIn : 0n,
    });
  } catch (e) {
    const msg = e.shortMessage || e.message;
    if (!live) {
      if (covered.via !== "balance" && covered.via !== "eth_native") {
        log(`[DRY] buy simulate skipped/failed after planned cover: ${msg}`);
      } else if (covered.dry) {
        log(`[DRY] buy simulate (pre-fund state): ${msg}`);
      } else {
        return {
          ok: false,
          reason: `simulate_fail: ${msg}`,
          cover: covered,
        };
      }
    } else {
      // Live: never abort after funding — eth_call false negatives strand quote.
      log(`[buy] simulate failed — still sending: ${msg}`);
    }
  }

  if (!live) {
    return {
      ok: true,
      dry: true,
      quoteIn: plan.quoteIn,
      tokens: plan.target,
      tx: null,
      cover: covered,
    };
  }

  const wc = writeClient(warm.state.account);
  if (warm.state.nonce == null) await warm.refresh();
  const nonce = warm.state.nonce;
  try {
    const hash = await wc.sendTransaction({
      to: curveAddr,
      data,
      value: isEth ? plan.quoteIn : 0n,
      nonce,
      maxFeePerGas: warm.state.maxFeePerGas,
      maxPriorityFeePerGas: warm.state.maxPriorityFeePerGas,
      gas: COVER_GAS.buy,
    });
    warm.state.nonce = nonce + 1;
    return {
      ok: true,
      dry: false,
      tx: hash,
      quoteIn: plan.quoteIn,
      tokens: plan.target,
      nonce,
      cover: covered,
    };
  } catch (e) {
    await warm.refresh().catch(() => {});
    return {
      ok: false,
      reason: `send_fail: ${e.shortMessage || e.message}`,
      cover: covered,
    };
  }
}
