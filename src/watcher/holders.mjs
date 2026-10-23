import { decodeEventLog, encodeFunctionData, decodeFunctionResult, getAddress } from "viem";
import { Erc20Abi, Multicall3Abi, TOPICS } from "../chain/abis.mjs";
import { HOLDER_SKIP, MULTICALL3, lower } from "../chain/addresses.mjs";
import { publicClient } from "../chain/clients.mjs";
import { config } from "../config.mjs";

/**
 * Holder count: Transfer-walk unique addresses, then balanceOf > HOLDER_DUST,
 * excluding system contracts. Documented definition for the dashboard.
 */
export async function countHolders(token, fromBlock, curve) {
  const client = publicClient();
  const tokenA = getAddress(token);
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
      // shrink on RPC limits
      const mid = from + (to - from) / 2n;
      if (mid <= from) continue;
      logs = await client.getLogs({
        address: tokenA,
        fromBlock: from,
        toBlock: mid,
      }).catch(() => []);
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

  const candidates = [...addrs].filter((a) => a && !skip.has(a));
  if (!candidates.length) return 0;

  const dust = config.holderDust;
  let holders = 0;
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
    for (const r of results) {
      if (!r.success) continue;
      const bal = decodeFunctionResult({
        abi: Erc20Abi,
        functionName: "balanceOf",
        data: r.returnData,
      });
      if (bal > dust) holders++;
    }
  }
  return holders;
}
