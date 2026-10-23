/**
 * Farmer-follow: no pool qualification. If a farmer bought a Pons token, we buy.
 * Only spend caps + already-held remain (budget / idempotency).
 *
 * @returns {{ ok: boolean, reason?: string }}
 */
export function evaluateFollowGates({
  alreadyHeld = false,
  openFollows = 0,
  maxOpen = 40,
  dailyUsdSpent = 0,
  dailyUsdCap = 40,
  buyUsd = 0.8,
}) {
  if (alreadyHeld) {
    return { ok: false, reason: "already_held" };
  }
  if (openFollows >= maxOpen) {
    return { ok: false, reason: "max_open" };
  }
  if (dailyUsdSpent + buyUsd > dailyUsdCap + 1e-9) {
    return { ok: false, reason: "daily_usd_cap" };
  }
  return { ok: true };
}
