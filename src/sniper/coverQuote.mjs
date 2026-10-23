import { encodeFunctionData, encodePacked, getAddress, maxUint256 } from "viem";
import { Erc20Abi, RouterAbi } from "../chain/abis.mjs";
import { ROUTER, WETH, ZERO, lower } from "../chain/addresses.mjs";
import { along, reverseHops, routeFor } from "../chain/price.mjs";
import { publicClient, writeClient } from "../chain/clients.mjs";
import { config, log } from "../config.mjs";
import { slip } from "../chain/curveMath.mjs";

const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);

/** Matches createWarmAccount fee fallback in buy.mjs (2 gwei). */
const FEE_FALLBACK_WEI = 2_000_000_000n;

/** Conservative gas limits used on the live cover → approve → buy path. */
export const COVER_GAS = {
  swap: 350_000n,
  approve: 80_000n,
  buy: 450_000n,
};

/**
 * Wei to reserve for gas so ethIn/value spend leaves room for remaining txs.
 * Uses warm maxFeePerGas when set; else 2 gwei. Floor: config.gasReserveWei.
 *
 * @param {'eth_native'|'erc20_balance'|'erc20_cover'} kind
 * @param {bigint|null|undefined} feePerGas
 */
export function gasReserveFor(kind, feePerGas) {
  const fee =
    feePerGas != null && feePerGas > 0n ? feePerGas : FEE_FALLBACK_WEI;
  let units = COVER_GAS.buy;
  if (kind === "erc20_cover") {
    units += COVER_GAS.swap + COVER_GAS.approve;
  } else if (kind === "erc20_balance") {
    units += COVER_GAS.approve;
  }
  const computed = units * fee;
  const floor = config.gasReserveWei;
  return computed > floor ? computed : floor;
}

/** How much of `need` is already held, and how much is still short. */
export function quoteSpend(held, need) {
  const h = held > 0n ? held : 0n;
  const n = need > 0n ? need : 0n;
  if (h >= n) return { spend: n, short: 0n };
  return { spend: h, short: n - h };
}

export function pathOf(hops) {
  const types = ["address"];
  const values = [getAddress(hops[0][0])];
  for (const [, b, f] of hops) {
    types.push("uint24", "address");
    values.push(f, getAddress(b));
  }
  return encodePacked(types, values);
}

export async function balanceOf(token, owner) {
  const client = publicClient();
  if (lower(token) === ZERO) {
    return client.getBalance({ address: getAddress(owner) });
  }
  return client.readContract({
    address: getAddress(token),
    abi: Erc20Abi,
    functionName: "balanceOf",
    args: [getAddress(owner)],
  });
}

async function sendWarm(warm, label, tx) {
  const client = publicClient();
  const wc = writeClient(warm.state.account);
  if (warm.state.nonce == null) await warm.refresh();
  const nonce = warm.state.nonce;
  log(`[cover] ${label} nonce=${nonce}`);
  const hash = await wc.sendTransaction({
    ...tx,
    nonce,
    maxFeePerGas: warm.state.maxFeePerGas,
    maxPriorityFeePerGas: warm.state.maxPriorityFeePerGas,
  });
  warm.state.nonce = nonce + 1;
  const rc = await client.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") {
    await warm.refresh().catch(() => {});
    throw new Error(`${label} reverted ${hash}`);
  }
  return hash;
}

async function ensureAllowance(warm, token, spender, amount, live) {
  const client = publicClient();
  const cur = await client.readContract({
    address: getAddress(token),
    abi: Erc20Abi,
    functionName: "allowance",
    args: [warm.state.address, getAddress(spender)],
  });
  if (cur >= amount) return null;
  if (!live) {
    log(`[DRY] would approve ${token} → ${spender}`);
    return "dry";
  }
  const data = encodeFunctionData({
    abi: Erc20Abi,
    functionName: "approve",
    args: [getAddress(spender), maxUint256],
  });
  return sendWarm(warm, "approve", {
    to: getAddress(token),
    data,
    gas: 80_000n,
  });
}

/** ETH wei needed to buy at least `quoteIn` of pair (null if unroutable). */
export async function ethForQuote(pair, quoteIn) {
  if (lower(pair) === ZERO) return quoteIn;
  if (lower(pair) === WETH) return quoteIn;
  const hops = await routeFor(pair);
  if (!hops?.length) return null;
  let ethIn = await along(hops, quoteIn);
  if (ethIn == null) return null;
  for (let k = 0; k < 6; k++) {
    ethIn = (ethIn * 102n) / 100n;
    const out = await along(reverseHops(hops), ethIn);
    if (out && out >= quoteIn) return ethIn;
  }
  return null;
}

/**
 * Swap `ethWei` into pair token on wallet. Returns quote received.
 */
export async function swapEthToQuote(warm, pair, ethWei, minOut, live) {
  if (lower(pair) === ZERO) return ethWei;
  if (!live) {
    log(`[DRY] would swap ETH→quote ethIn=${ethWei} minOut=${minOut} pair=${pair}`);
    return 0n;
  }

  if (lower(pair) === WETH) {
    // WETH.deposit()
    const data = "0xd0e30db0";
    const before = await balanceOf(WETH, warm.state.address);
    await sendWarm(warm, "wrap WETH", {
      to: getAddress(WETH),
      data,
      value: ethWei,
      gas: 60_000n,
    });
    return (await balanceOf(WETH, warm.state.address)) - before;
  }

  const hops = await routeFor(pair);
  if (!hops?.length) throw new Error("no route to quote");
  const before = await balanceOf(pair, warm.state.address);
  const swap = encodeFunctionData({
    abi: RouterAbi,
    functionName: "exactInput",
    args: [
      {
        path: pathOf(reverseHops(hops)),
        recipient: warm.state.address,
        amountIn: ethWei,
        amountOutMinimum: minOut,
      },
    ],
  });
  const data = encodeFunctionData({
    abi: RouterAbi,
    functionName: "multicall",
    args: [deadline(), [swap]],
  });
  await sendWarm(warm, "swap ETH→quote", {
    to: getAddress(ROUTER),
    data,
    value: ethWei,
    gas: 350_000n,
  });
  return (await balanceOf(pair, warm.state.address)) - before;
}

/**
 * Ensure wallet holds `need` of `pair` before a curve buy.
 * Native ETH pair: no swap (value on buy).
 * ERC20: use balance; shortfall → swap only enough ETH→quote via router.
 *
 * @returns {{ ok:boolean, via?:string, spend?:bigint, ethIn?:bigint, short?:bigint, dry?:boolean, reason?:string }}
 */
export async function coverQuote(warm, pair, need, { live = config.live } = {}) {
  const n = BigInt(need ?? 0);
  if (n <= 0n) return { ok: true, via: "balance", spend: 0n };

  if (lower(pair) === ZERO || pair == null) {
    const ethBal = await balanceOf(ZERO, warm.state.address);
    const gasReserve = gasReserveFor("eth_native", warm.state.maxFeePerGas);
    if (ethBal < n + gasReserve) {
      return {
        ok: false,
        reason: `insufficient_eth bal=${ethBal} need=${n} gasReserve=${gasReserve}`,
      };
    }
    return { ok: true, via: "eth_native", spend: n };
  }

  const before = await balanceOf(pair, warm.state.address);
  const { short } = quoteSpend(before, n);
  if (short === 0n) {
    const ethBal = await balanceOf(ZERO, warm.state.address);
    const gasReserve = gasReserveFor("erc20_balance", warm.state.maxFeePerGas);
    if (ethBal < gasReserve) {
      return {
        ok: false,
        reason: `insufficient_eth_for_gas bal=${ethBal} gasReserve=${gasReserve}`,
      };
    }
    return { ok: true, via: "balance", spend: n, held: before };
  }

  let ethIn = await ethForQuote(pair, short);
  if (ethIn == null || ethIn <= 0n) {
    return {
      ok: false,
      reason: `no_eth_route short=${short} held=${before} need=${n}`,
    };
  }
  // Pad a bit for slippage between quote and swap
  ethIn = (ethIn * 103n) / 100n;

  const ethBal = await balanceOf(ZERO, warm.state.address);
  const gasReserve = gasReserveFor("erc20_cover", warm.state.maxFeePerGas);
  if (ethBal < ethIn + gasReserve) {
    return {
      ok: false,
      reason: `insufficient_eth_for_cover ethBal=${ethBal} ethIn=${ethIn} gasReserve=${gasReserve}`,
    };
  }

  const minOut = slip(short, config.slippageBps);
  log(
    `[cover] need=${n} held=${before} short=${short} ethIn=${ethIn} live=${live ? 1 : 0}`,
  );

  if (!live) {
    return {
      ok: true,
      dry: true,
      via: before > 0n ? "mixed" : "eth",
      spend: n,
      ethIn,
      short,
      held: before,
    };
  }

  const got = await swapEthToQuote(warm, pair, ethIn, minOut, true);
  const after = await balanceOf(pair, warm.state.address);
  if (after < n) {
    return {
      ok: false,
      reason: `cover_short after=${after} need=${n} got=${got}`,
      via: "eth",
      ethIn,
    };
  }
  return {
    ok: true,
    via: before > 0n ? "mixed" : "eth",
    spend: n,
    ethIn,
    short,
    got,
    held: after,
  };
}
