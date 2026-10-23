import { getAddress } from "viem";
import { Erc20Abi, QuoterAbi } from "./abis.mjs";
import { KNOWN_QUOTES, QUOTER, USDG, WETH, ZERO, lower } from "./addresses.mjs";
import { publicClient } from "./clients.mjs";

const decs = new Map(
  Object.entries(KNOWN_QUOTES).map(([a, v]) => [a, v.decimals]),
);

export async function decimalsOf(token) {
  const k = lower(token);
  if (!k || k === ZERO) return 18;
  if (decs.has(k)) return decs.get(k);
  const d = Number(
    await publicClient().readContract({
      address: getAddress(k),
      abi: Erc20Abi,
      functionName: "decimals",
    }),
  );
  decs.set(k, d);
  return d;
}

/** Quoter hop: amountOut for amountIn on one fee tier; 0n when pool missing. */
export async function quoteHop(tokenIn, tokenOut, amountIn, fee) {
  if (amountIn <= 0n) return 0n;
  try {
    const { result } = await publicClient().simulateContract({
      address: getAddress(QUOTER),
      abi: QuoterAbi,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: getAddress(tokenIn),
          tokenOut: getAddress(tokenOut),
          amountIn,
          fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    return result[0];
  } catch {
    return 0n;
  }
}

export async function bestTier(a, b, amountIn) {
  let best = { out: 0n, fee: null };
  for (const fee of [100, 500, 3000, 10_000]) {
    const out = await quoteHop(a, b, amountIn, fee);
    if (out > best.out) best = { out, fee };
  }
  return best;
}

const routes = new Map();

/** Hops from `pair` toward WETH (direct or via USDG); null when unroutable. */
export async function routeFor(pair) {
  const k = lower(pair);
  if (k === ZERO || k === WETH) return [];
  const hit = routes.get(k);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.hops;
  const probe = 10n ** BigInt(await decimalsOf(k)) / 100n || 1n;
  let hops = null;
  const direct = await bestTier(k, WETH, probe);
  if (direct.fee != null) hops = [[k, WETH, direct.fee]];
  else if (k !== USDG) {
    const a = await bestTier(k, USDG, probe);
    const b =
      a.fee != null ? await bestTier(USDG, WETH, a.out || 1n) : { fee: null };
    if (b.fee != null) hops = [[k, USDG, a.fee], [USDG, WETH, b.fee]];
  }
  routes.set(k, { at: Date.now(), hops });
  return hops;
}

export async function along(hops, amount) {
  let v = amount;
  for (const [a, b, fee] of hops) {
    v = await quoteHop(a, b, v, fee);
    if (!v) return null;
  }
  return v;
}

export const reverseHops = (hops) =>
  [...hops].reverse().map(([a, b, f]) => [b, a, f]);
