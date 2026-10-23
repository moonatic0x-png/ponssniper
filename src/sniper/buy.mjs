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
      state.maxFeePerGas = parseEther("0.000000002"); // 2 gwei fallback
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
    return { ok: false, reason: "sim_below_min", quoteIn, target, simTokens: sim.tokens };
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
 * Submit or DRY-simulate curve buy. No sell path.
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

  if (!isEth) {
    const pair = getAddress(pairToken);
    const bal = await client.readContract({
      address: pair,
      abi: Erc20Abi,
      functionName: "balanceOf",
      args: [me],
    });
    if (bal < plan.quoteIn) {
      if (!config.allowQuoteSwap) {
        return { ok: false, reason: `insufficient_quote bal=${bal} need=${plan.quoteIn}` };
      }
      return { ok: false, reason: "quote_swap_not_implemented_on_hot_path" };
    }
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
        const hash = await wc.writeContract({
          address: pair,
          abi: Erc20Abi,
          functionName: "approve",
          args: [curveAddr, maxUint256],
          nonce: warm.state.nonce++,
          maxFeePerGas: warm.state.maxFeePerGas,
          maxPriorityFeePerGas: warm.state.maxPriorityFeePerGas,
        });
        await client.waitForTransactionReceipt({ hash });
      }
    }
  } else {
    const ethBal = await client.getBalance({ address: me });
    if (ethBal < plan.quoteIn) {
      return { ok: false, reason: `insufficient_eth bal=${ethBal} need=${plan.quoteIn}` };
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

  // Simulate always
  try {
    await client.call({
      account: me,
      to: curveAddr,
      data,
      value: isEth ? plan.quoteIn : 0n,
    });
  } catch (e) {
    return { ok: false, reason: `simulate_fail: ${e.shortMessage || e.message}` };
  }

  if (!live) {
    return {
      ok: true,
      dry: true,
      quoteIn: plan.quoteIn,
      tokens: plan.target,
      tx: null,
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
    };
  } catch (e) {
    // refresh nonce on failure
    await warm.refresh().catch(() => {});
    return { ok: false, reason: `send_fail: ${e.shortMessage || e.message}` };
  }
}
