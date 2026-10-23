import { getAddress } from "viem";
import { lower } from "../chain/addresses.mjs";
import { config } from "../config.mjs";

/**
 * Known Pons fee-farmers (public addresses only).
 * From pons-fastpath history: wallets that repeatedly harvest before operator publish.
 * Dynamic “majority of ≥20 pots last week” needs a full claims index — not available here;
 * extend via FOLLOW_FARMERS env.
 */
export const KNOWN_FARMERS = [
  "0xc736303d0b386675a53138959f981579607bb40f",
  "0x5bbe3adb4e5fc0747d7b261acea5be4fc157692c",
  "0x8c4987568eaf2a5bdc279f5a2e30e1cc0922ade3",
].map((a) => getAddress(a));

/** Lowercase set of farmer wallets (known + FOLLOW_FARMERS). */
export function farmerSet(extra = config.followFarmersExtra) {
  const s = new Set(KNOWN_FARMERS.map(lower));
  for (const a of extra || []) s.add(lower(a));
  return s;
}

export function farmerAddresses(extra = config.followFarmersExtra) {
  return [...farmerSet(extra)].map((a) => getAddress(a));
}

export function isFarmer(addr, set = farmerSet()) {
  return set.has(lower(addr));
}
