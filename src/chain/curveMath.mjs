/**
 * Constant-product curve math (phantom quote + real reserves).
 * Q = quoteReserve (phantom + real), T = tokenReserve on curve.
 */

/** Gross quote (raw) needed to receive `tokens` after fee + tax. */
export function entryQuoteFor(curve, tokens) {
  const { Q, T, feeBps, taxBps } = curve;
  if (tokens <= 0n || tokens >= T) return null;
  const net = (tokens * Q) / (T - tokens) + 1n;
  const keep = 10_000n - BigInt(feeBps) - BigInt(taxBps);
  if (keep <= 0n) return null;
  return (net * 10_000n) / keep + 1n;
}

/** Tokens out for a gross quote spend. */
export function buyTokensFor(curve, gross) {
  const { Q, T, feeBps, taxBps } = curve;
  const fee = (gross * BigInt(feeBps)) / 10_000n;
  const tax = (gross * BigInt(taxBps)) / 10_000n;
  const net = gross - fee - tax;
  if (net <= 0n) return { tokens: 0n, net: 0n };
  return { tokens: (net * T) / (Q + net), net };
}

/** Quote out (after fee + tax) for selling `tokens` — mark-to-curve only; never used to sell. */
export function sellOutFor(curve, tokens) {
  const { Q, T, feeBps, taxBps } = curve;
  if (tokens <= 0n || T <= 0n) return 0n;
  const gross = (tokens * Q) / (T + tokens);
  return (
    gross -
    (gross * BigInt(feeBps)) / 10_000n -
    (gross * BigInt(taxBps)) / 10_000n
  );
}

export function slip(amount, slippageBps) {
  return (amount * (10_000n - BigInt(slippageBps))) / 10_000n;
}
