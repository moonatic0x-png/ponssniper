import { getAddress } from "viem";
import { QuoterAbi } from "../chain/abis.mjs";
import { KNOWN_QUOTES, QUOTER, USDG, WETH, ZERO, lower } from "../chain/addresses.mjs";
import { publicClient } from "../chain/clients.mjs";
import { config } from "../config.mjs";

/** USD value of `amount` raw quote units for pair. */
export function quoteToUsd(pair, amount) {
  if (amount == null) return null;
  const a = typeof amount === "bigint" ? amount : BigInt(amount);
  const k = lower(pair) || ZERO;
  const meta = KNOWN_QUOTES[k];
  if (!meta) return null;
  if (meta.symbol === "USDG") return Number(a) / 10 ** meta.decimals;
  if (meta.symbol === "ETH" || meta.symbol === "WETH") {
    return (Number(a) / 10 ** meta.decimals) * config.ethUsd;
  }
  return null;
}

/** Rough ETH→USDG via quoter (fee 3000) for unknown marks. */
export async function ethUsdOnchain() {
  try {
    const one = 10n ** 18n;
    const [amountOut] = await publicClient().readContract({
      address: getAddress(QUOTER),
      abi: QuoterAbi,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: getAddress(WETH),
          tokenOut: getAddress(USDG),
          amountIn: one,
          fee: 3000,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    return Number(amountOut) / 1e6;
  } catch {
    return config.ethUsd;
  }
}
