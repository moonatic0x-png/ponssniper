import { evaluateGates } from "../sniper/gates.mjs";

/**
 * Hard gates for farmer-follow. No NET_FLOOR / TRIGGER_COST / wash logic.
 * Soft pot preference is logged by the runner; it does not fail the gate.
 *
 * @returns {{ ok: boolean, reason?: string }}
 */
export function evaluateFollowGates({
  buybackEnabled,
  creatorFeeRecipient,
  distributor,
  pairToken,
  pairSymbol,
  skipIneligibleQuotes = true,
  graduated = false,
  alreadyHeld = false,
  farmerHolds = false,
  openFollows = 0,
  maxOpen = 40,
  dailyUsdSpent = 0,
  dailyUsdCap = 40,
  buyUsd = 0.8,
}) {
  if (alreadyHeld) {
    return { ok: false, reason: "already_held" };
  }
  if (!farmerHolds) {
    return { ok: false, reason: "farmer_no_bag" };
  }
  if (graduated) {
    return { ok: false, reason: "graduated" };
  }
  if (openFollows >= maxOpen) {
    return { ok: false, reason: "max_open" };
  }
  if (dailyUsdSpent + buyUsd > dailyUsdCap + 1e-9) {
    return { ok: false, reason: "daily_usd_cap" };
  }

  const base = evaluateGates({
    buybackEnabled,
    creatorFeeRecipient,
    distributor,
    pairToken,
    pairSymbol,
    skipIneligibleQuotes,
  });
  if (!base.ok) return base;

  return { ok: true };
}
