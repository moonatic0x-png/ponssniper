import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress } from "viem";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvFile() {
  const p = resolve(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

loadEnvFile();

const bool = (k, d = false) => {
  const v = process.env[k];
  if (v == null || v === "") return d;
  return v === "1" || v.toLowerCase() === "true";
};
const num = (k, d) => {
  const v = process.env[k];
  if (v == null || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const big = (k) => {
  const v = process.env[k];
  if (v == null || v === "") return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
};
const addr = (k) => {
  const v = process.env[k];
  if (v == null || v === "") return null;
  if (!isAddress(v)) throw new Error(`Invalid ${k}: ${v}`);
  return getAddress(v);
};

export const ROOT_DIR = ROOT;
export const CHAIN_ID = 4663;
export const BLOCK_TIME_S = 0.1008;

/**
 * Optional remote sniper address for `npm run observe`.
 * Safe in a shared .env: does NOT disable sniper when secrets/wallets.json exists.
 */
const readAddress = addr("READ_ADDRESS");

export const config = {
  live: bool("SNIPER_LIVE", false),
  readAddress,
  /** How far back to scan launches/buys on observe start (~0.1s blocks). */
  readLookbackBlocks: num("READ_LOOKBACK_BLOCKS", 1_000_000),
  /**
   * Boot catch-up + max launch age for a snipe (blocks ≈ 0.1s).
   * Default 900 ≈ 90s — older pools are not snipes.
   */
  sniperCatchupBlocks: num("SNIPER_CATCHUP_BLOCKS", 900),
  rpcHttp: process.env.RPC_HTTP || "https://rpc.mainnet.chain.robinhood.com",
  rpcWss: process.env.RPC_WSS || "wss://robinhood.drpc.org",
  rpcHttpFallback:
    process.env.RPC_HTTP_FALLBACK || "https://robinhood.drpc.org",
  sniperTokens: BigInt(process.env.SNIPER_TOKENS || "100000"),
  maxQuoteIn: big("MAX_QUOTE_IN"),
  dailyMaxQuote: big("DAILY_MAX_QUOTE"),
  slippageBps: num("SLIPPAGE_BPS", 300),
  sniperDelayMs: num("SNIPER_DELAY_MS", 0),
  skipIneligibleQuotes: bool("SKIP_INELIGIBLE_QUOTES", true),
  /**
   * Floor for ETH left for gas after cover (wei). Actual reserve is
   * max(this, gasUnits × maxFeePerGas) via gasReserveFor().
   */
  gasReserveWei: big("GAS_RESERVE_WEI") ?? 100_000_000_000_000n, // 0.0001 ETH
  holderDust: BigInt(process.env.HOLDER_DUST || "1"),
  networthIntervalMs: num("NETWORTH_INTERVAL_MS", 30_000),
  potRefreshMs: num("POT_REFRESH_MS", 15_000),
  dbPath: resolve(ROOT, process.env.DB_PATH || "data/pons.db"),
  walletsPath: resolve(ROOT, "secrets/wallets.json"),
  dashHost: process.env.DASH_HOST || "127.0.0.1",
  dashPort: num("DASH_PORT", 42100),
};

/** Redact private-key-shaped hex from log strings. */
export function redact(s) {
  return String(s).replace(/0x[a-fA-F0-9]{64}/g, "0x[REDACTED]");
}

export function log(...args) {
  console.log(
    ...args.map((a) => (typeof a === "string" ? redact(a) : a)),
  );
}
