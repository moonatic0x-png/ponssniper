import { KNOWN_QUOTES, ZERO, lower } from "../chain/addresses.mjs";
import { ethUsdMark } from "../chain/price.mjs";

export { ethUsdMark as ethUsdOnchain };

/** USD value of `amount` raw quote units for pair. Null when mark unavailable. */
export async function quoteToUsd(pair, amount) {
  if (amount == null) return null;
  const a = typeof amount === "bigint" ? amount : BigInt(amount);
  if (a === 0n) return 0;
  const k = lower(pair) || ZERO;
  const meta = KNOWN_QUOTES[k];
  if (!meta) return null;
  if (meta.symbol === "USDG") return Number(a) / 10 ** meta.decimals;
  if (meta.symbol === "ETH" || meta.symbol === "WETH") {
    const px = await ethUsdMark();
    if (px == null) return null;
    return (Number(a) / 10 ** meta.decimals) * px;
  }
  return null;
}
