import {
  INELIGIBLE_QUOTE_SYMBOLS,
  KNOWN_QUOTES,
  ZERO,
  lower,
  same,
} from "../chain/addresses.mjs";

/**
 * Pure gate logic for launch snipes.
 * @returns {{ ok: boolean, reason?: string }}
 */
export function evaluateGates({
  buybackEnabled,
  creatorFeeRecipient,
  distributor,
  pairToken,
  pairSymbol,
  skipIneligibleQuotes = true,
}) {
  if (buybackEnabled === true) {
    return { ok: false, reason: "buyback_enabled" };
  }
  if (!distributor) {
    return { ok: false, reason: "no_distributor" };
  }
  if (!creatorFeeRecipient) {
    return { ok: false, reason: "no_recipient" };
  }
  if (!same(creatorFeeRecipient, distributor)) {
    return { ok: false, reason: "recipient_not_distributor" };
  }
  if (skipIneligibleQuotes) {
    const sym = (pairSymbol || knownSymbol(pairToken) || "").toLowerCase();
    if (sym && INELIGIBLE_QUOTE_SYMBOLS.has(sym)) {
      return { ok: false, reason: `ineligible_quote:${sym}` };
    }
  }
  return { ok: true };
}

function knownSymbol(pair) {
  const k = lower(pair) || ZERO;
  return KNOWN_QUOTES[k]?.symbol ?? null;
}

export { knownSymbol };
