import {
  encodeFunctionData,
  getAddress,
  maxUint256,
  parseEther,
} from "viem";
import { CurveAbi, Erc20Abi } from "../chain/abis.mjs";
import { ZERO, lower } from "../chain/addresses.mjs";
import { entryQuoteFor, buyTokensFor, slip } from "../chain/curveMath.mjs";
import { publicClient, writeClient } from "../chain/clients.mjs";
import { config, log } from "../config.mjs";
import { coverQuote } from "./coverQuote.mjs";

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
 */
export async function executeBuy({
  warm,
  curve,
  pairToken,
  plan,
  live = config.live,
}) {
  const client = publicClient();
  const me = warm.state.address;
  const curveAddr = getAddress(curve);
  const isEth = plan.isEth;
  const pair = isEth ? ZERO : getAddress(pairToken);

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

  // 2) Approve curve to pull ERC20 quote
  if (!isEth) {
    const allowance = await client.readContract({
      address: pair,
      abi: Erc20Abi,
      functionName: "allowance",
      args: [me, curveAddr],
    });
    if (allowance < plan.quoteIn) {
      if (!live) {
        log("[DRY] would approve", pair, "→", curveAddr);
      } else {
        const wc = writeClient(warm.state.account);
        if (warm.state.nonce == null) await warm.refresh();
        const nonce = warm.state.nonce;
        const hash = await wc.writeContract({
          address: pair,
          abi: Erc20Abi,
          functionName: "approve",
          args: [curveAddr, maxUint256],
          nonce,
          maxFeePerGas: warm.state.maxFeePerGas,
          maxPriorityFeePerGas: warm.state.maxPriorityFeePerGas,
        });
        warm.state.nonce = nonce + 1;
        await client.waitForTransactionReceipt({ hash });
      }
    }
  }

  const data = encodeFunctionData({
    abi: CurveAbi,
    functionName: "buy",
    args: [plan.quoteIn, plan.minTokensOut, me],
  });

  if (config.sniperDelayMs > 0) {
    await new Promise((r) => setTimeout(r, config.sniperDelayMs));
  }

  // 3) Simulate buy when we have (or will have) quote; in DRY after eth-cover,
  // eth_call may still fail if wallet lacks quote — log and treat as planned.
  try {
    await client.call({
      account: me,
      to: curveAddr,
      data,
      value: isEth ? plan.quoteIn : 0n,
    });
  } catch (e) {
    if (!live && covered.via !== "balance" && covered.via !== "eth_native") {
      log(
        `[DRY] buy simulate skipped/failed after planned cover: ${e.shortMessage || e.message}`,
      );
    } else if (!live && covered.dry) {
      log(
        `[DRY] buy simulate (pre-fund state): ${e.shortMessage || e.message}`,
      );
    } else {
      return {
        ok: false,
        reason: `simulate_fail: ${e.shortMessage || e.message}`,
        cover: covered,
      };
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
      gas: 450_000n,
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
