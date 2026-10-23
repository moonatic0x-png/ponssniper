import { KNOWN_QUOTES, ZERO, lower } from "../chain/addresses.mjs";
import { buyTokensFor, slip } from "../chain/curveMath.mjs";
import { ethUsdMark } from "../chain/price.mjs";
import { config } from "../config.mjs";

/**
 * Raw quote units for a USD notional on a known pair.
 * @returns {Promise<bigint|null>}
 */
export async function quoteInForUsd(pairToken, usd = config.followBuyUsd) {
  if (!(usd > 0) || !Number.isFinite(usd)) return null;
  const k = lower(pairToken) || ZERO;
  const meta = KNOWN_QUOTES[k];
  if (!meta) return null;
  if (meta.symbol === "USDG") {
    return BigInt(Math.floor(usd * 10 ** meta.decimals));
  }
  if (meta.symbol === "ETH" || meta.symbol === "WETH") {
    const px = await ethUsdMark();
    if (px == null || px <= 0) return null;
    const units = usd / px;
    return BigInt(Math.floor(units * 10 ** meta.decimals));
  }
  return null;
}

/**
 * Size a curve buy from a fixed quoteIn (USD-derived), not fixed token count.
 */
export function planBuyFromQuote({
  curveState,
  pairToken,
  quoteIn,
  slippageBps = config.slippageBps,
  maxQuoteIn = config.maxQuoteIn,
}) {
  if (quoteIn == null || quoteIn <= 0n) {
    return { ok: false, reason: "bad_quote_in" };
  }
  const sim = buyTokensFor(curveState, quoteIn);
  if (sim.tokens <= 0n) {
    return { ok: false, reason: "zero_tokens", quoteIn };
  }
  const minTokensOut = slip(sim.tokens, slippageBps);
  if (maxQuoteIn != null && quoteIn > maxQuoteIn) {
    return { ok: false, reason: "max_quote_in", quoteIn };
  }
  return {
    ok: true,
    quoteIn,
    target: sim.tokens,
    minTokensOut,
    isEth: lower(pairToken) === ZERO || pairToken == null,
  };
}

/**
 * Full USD → plan helper (async for ETH mark).
 */
export async function planBuyUsd({
  curveState,
  pairToken,
  usd = config.followBuyUsd,
  slippageBps = config.slippageBps,
}) {
  const quoteIn = await quoteInForUsd(pairToken, usd);
  if (quoteIn == null) {
    return { ok: false, reason: "quote_usd_unavailable" };
  }
  return planBuyFromQuote({
    curveState,
    pairToken,
    quoteIn,
    slippageBps,
  });
}
