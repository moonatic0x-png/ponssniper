import { KNOWN_QUOTES, ZERO, lower } from "../chain/addresses.mjs";
import { along, ethUsdMark, routeFor } from "../chain/price.mjs";

export { ethUsdMark as ethUsdOnchain };

/**
 * USD value of `amount` raw quote units for pair.
 * ETH/WETH/USDG use direct marks; other pairs (NVDA, GME, …) route via Quoter → WETH → USD.
 * Null when mark unavailable.
 */
export async function quoteToUsd(pair, amount) {
  if (amount == null) return null;
  const a = typeof amount === "bigint" ? amount : BigInt(amount);
  if (a === 0n) return 0;
  const k = lower(pair) || ZERO;
  const meta = KNOWN_QUOTES[k];
  if (meta?.symbol === "USDG") return Number(a) / 10 ** meta.decimals;
  if (meta?.symbol === "ETH" || meta?.symbol === "WETH") {
    const px = await ethUsdMark();
    if (px == null) return null;
    return (Number(a) / 10 ** meta.decimals) * px;
  }

  // Stock / other ERC20 quotes on Robinhood Chain.
  try {
    const hops = await routeFor(k);
    if (hops == null) return null;
    const wethOut = hops.length === 0 ? a : await along(hops, a);
    if (wethOut == null || wethOut <= 0n) return null;
    const px = await ethUsdMark();
    if (px == null) return null;
    const usd = (Number(wethOut) / 1e18) * px;
    return Number.isFinite(usd) ? usd : null;
  } catch {
    return null;
  }
}
