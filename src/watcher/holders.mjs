import { decodeEventLog, encodeFunctionData, decodeFunctionResult, getAddress } from "viem";
import { Erc20Abi, Multicall3Abi, TOPICS } from "../chain/abis.mjs";
import { HOLDER_SKIP, MULTICALL3, lower } from "../chain/addresses.mjs";
import { publicClient } from "../chain/clients.mjs";
import { config } from "../config.mjs";

/** Publisher drops wallets under this % of total weight/balance and renormalises. */
export const PAYOUT_CUTOFF_PCT = 1.5;

/**
 * Holder count + optional payout share for `me`.
 * Transfer-walk unique addresses, then balanceOf > HOLDER_DUST, excluding
 * system contracts. Share = our balance / sum of non-dust balances; after
 * cutoff drops wallets under 1.5% and renormalises (Pons payout rule).
 *
 * @returns {Promise<number | { holders:number, sharePct:number|null, shareAfterCutoffPct:number|null, ourBal:string|null }>}
 */
export async function countHolders(token, fromBlock, curve, me = null) {
  const stats = await holderStats(token, fromBlock, curve, me);
  return me ? stats : stats.holders;
}

/**
 * @param {string} token
 * @param {number|null|undefined} fromBlock
 * @param {string|null|undefined} curve
 * @param {string|null|undefined} me — wallet to score for payout share
 */
export async function holderStats(token, fromBlock, curve, me = null) {
  const client = publicClient();
  const tokenA = getAddress(token);
  const meL = me ? lower(me) : null;
  const head = await client.getBlockNumber();
  const start = fromBlock != null ? BigInt(fromBlock) : head > 50_000n ? head - 50_000n : 0n;
  const addrs = new Set();
  const skip = new Set([...HOLDER_SKIP]);
  if (curve) skip.add(lower(curve));

  const chunk = 8_000n;
  for (let from = start; from <= head; from += chunk + 1n) {
    const to = from + chunk > head ? head : from + chunk;
    let logs;
    try {
      logs = await client.getLogs({
        address: tokenA,
        event: {
          type: "event",
          name: "Transfer",
          inputs: Erc20Abi.find((x) => x.name === "Transfer").inputs,
        },
        fromBlock: from,
        toBlock: to,
      });
    } catch {
      const mid = from + (to - from) / 2n;
      if (mid <= from) continue;
      logs = await client
        .getLogs({
          address: tokenA,
          fromBlock: from,
          toBlock: mid,
        })
        .catch(() => []);
    }
    for (const lg of logs || []) {
      if (lg.topics?.[0] !== TOPICS.Transfer) continue;
      try {
        const { args } = decodeEventLog({
          abi: Erc20Abi,
          data: lg.data,
          topics: lg.topics,
        });
        if (args.from) addrs.add(lower(args.from));
        if (args.to) addrs.add(lower(args.to));
      } catch {
        /* */
      }
    }
  }

  if (meL) addrs.add(meL);
  const candidates = [...addrs].filter((a) => a && !skip.has(a));
  if (!candidates.length) {
    return { holders: 0, sharePct: meL ? 0 : null, shareAfterCutoffPct: meL ? 0 : null, ourBal: meL ? "0" : null };
  }

  const dust = config.holderDust;
  /** @type {{ addr: string, bal: bigint }[]} */
  const held = [];
  const batch = 80;
  for (let i = 0; i < candidates.length; i += batch) {
    const slice = candidates.slice(i, i + batch);
    const calls = slice.map((a) => ({
      target: tokenA,
      allowFailure: true,
      callData: encodeFunctionData({
        abi: Erc20Abi,
        functionName: "balanceOf",
        args: [getAddress(a)],
      }),
    }));
    const results = await client.readContract({
      address: getAddress(MULTICALL3),
      abi: Multicall3Abi,
      functionName: "aggregate3",
      args: [calls],
    });
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (!r.success) continue;
      const bal = decodeFunctionResult({
        abi: Erc20Abi,
        functionName: "balanceOf",
        data: r.returnData,
      });
      if (bal > dust) held.push({ addr: slice[j], bal });
    }
  }

  const holders = held.length;
  if (!meL) {
    return { holders, sharePct: null, shareAfterCutoffPct: null, ourBal: null };
  }

  const ourBal = held.find((h) => h.addr === meL)?.bal ?? 0n;
  const total = held.reduce((s, h) => s + h.bal, 0n);
  if (total <= 0n) {
    return { holders, sharePct: 0, shareAfterCutoffPct: 0, ourBal: ourBal.toString() };
  }

  const pctOf = (part, whole) => Number((part * 1_000_000n) / whole) / 10_000;
  const sharePct = pctOf(ourBal, total);
  const kept = held.filter((h) => pctOf(h.bal, total) >= PAYOUT_CUTOFF_PCT);
  const keptTotal = kept.reduce((s, h) => s + h.bal, 0n);
  const ourKept = kept.find((h) => h.addr === meL);
  const shareAfterCutoffPct =
    ourKept && keptTotal > 0n ? pctOf(ourKept.bal, keptTotal) : 0;

  return {
    holders,
    sharePct,
    shareAfterCutoffPct,
    ourBal: ourBal.toString(),
  };
}
