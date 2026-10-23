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
const addrList = (k) => {
  const v = process.env[k];
  if (v == null || v === "") return [];
  return v
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((a) => {
      if (!isAddress(a)) throw new Error(`Invalid address in ${k}: ${a}`);
      return getAddress(a);
    });
};
/** Comma/space/semicolon URL list; drops empties; preserves order; dedupes. */
const urlList = (k) => {
  const v = process.env[k];
  if (v == null || v === "") return [];
  const out = [];
  const seen = new Set();
  for (const raw of v.split(/[,;\s]+/)) {
    const u = raw.trim();
    if (!u) continue;
    const key = u.replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u.replace(/\/$/, ""));
  }
  return out;
};

/** Built-in public HTTP RPCs (no API key). Official first for eth_sendRawTransaction. */
const DEFAULT_RPC_HTTP = [
  "https://rpc.mainnet.chain.robinhood.com",
  "https://robinhood.drpc.org",
  "https://robinhood-rpc.publicnode.com",
  "https://rpc-robinhood.blockmachine.io",
  "https://robinhood.rpc.blxrbdn.com",
  "https://rpc.ordofi.network",
  "https://robinhood.daybreak-rpc.network",
  "https://api.blockvectra.com/v1/robinhood_mainnet/public",
];

const DEFAULT_RPC_WSS = [
  "wss://robinhood.drpc.org",
  "wss://robinhood-rpc.publicnode.com",
];

function resolveRpcHttpUrls() {
  const fromList = urlList("RPC_HTTP_URLS");
  if (fromList.length) return fromList;
  // Backward-compat: RPC_HTTP + RPC_HTTP_FALLBACK (+ any extras in RPC_HTTP_EXTRA)
  const primary =
    process.env.RPC_HTTP || "https://rpc.mainnet.chain.robinhood.com";
  const fb = process.env.RPC_HTTP_FALLBACK || "https://robinhood.drpc.org";
  const extra = urlList("RPC_HTTP_EXTRA");
  const merged = [primary, fb, ...extra, ...DEFAULT_RPC_HTTP];
  const out = [];
  const seen = new Set();
  for (const u of merged) {
    const key = u.replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u.replace(/\/$/, ""));
  }
  return out;
}

function resolveRpcWssUrls() {
  const fromList = urlList("RPC_WSS_URLS");
  if (fromList.length) return fromList;
  const primary = process.env.RPC_WSS || "wss://robinhood.drpc.org";
  const extra = urlList("RPC_WSS_EXTRA");
  const merged = [primary, ...extra, ...DEFAULT_RPC_WSS];
  const out = [];
  const seen = new Set();
  for (const u of merged) {
    const key = u.replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u.replace(/\/$/, ""));
  }
  return out;
}

export const ROOT_DIR = ROOT;
export const CHAIN_ID = 4663;
export const BLOCK_TIME_S = 0.1008;

/**
 * Optional remote sniper address for `npm run observe`.
 * Safe in a shared .env: does NOT disable sniper when secrets/wallets.json exists.
 */
const readAddress = addr("READ_ADDRESS");
const rpcHttpUrls = resolveRpcHttpUrls();
const rpcWssUrls = resolveRpcWssUrls();

export const config = {
  live: bool("SNIPER_LIVE", false),
  readAddress,
  /** How far back to scan launches/buys on observe start (~0.1s blocks). */
  readLookbackBlocks: num("READ_LOOKBACK_BLOCKS", 1_000_000),
  /**
   * Rolling window of TokenLaunched for periodic observe “wide” re-checks.
   * Must be wide enough to cover “buy shortly after launch”; default ~3h.
   * Normal ticks only advance the cursor (fast); wide runs every
   * OBSERVE_WIDE_EVERY ticks so free RPCs are not saturated.
   */
  observeRecheckBlocks: num("OBSERVE_RECHECK_BLOCKS", 100_000),
  /** How often (in observe ticks) to run the wide launch re-scan. Default ~5m. */
  observeWideEvery: num("OBSERVE_WIDE_EVERY", 100),
  /** Incremental observe tick (ms). Default 3s for near-real-time READ. */
  observeTickMs: num("OBSERVE_TICK_MS", 3_000),
  /**
   * Optional Blockscout REST base for observe token discovery (held ERC-20s).
   * Finds follow bags whose launches fall outside READ_LOOKBACK_BLOCKS.
   * Cloudflare may block keyless calls — set BLOCKSCOUT_API_KEY if needed.
   */
  blockscoutApi:
    process.env.BLOCKSCOUT_API || "https://robinhoodchain.blockscout.com",
  blockscoutApiKey: process.env.BLOCKSCOUT_API_KEY || "",
  /**
   * Boot catch-up + max launch age for a snipe (blocks ≈ 0.1s).
   * Default 900 ≈ 90s — older pools are not snipes.
   */
  sniperCatchupBlocks: num("SNIPER_CATCHUP_BLOCKS", 900),
  /** Ordered HTTP RPC pool (failover / rank). Prefer RPC_HTTP_URLS. */
  rpcHttpUrls,
  /** Ordered WSS pool for log subscriptions. Prefer RPC_WSS_URLS. */
  rpcWssUrls,
  /** Primary HTTP (first in pool) — kept for scripts / logs. */
  rpcHttp: rpcHttpUrls[0] || "https://rpc.mainnet.chain.robinhood.com",
  rpcWss: rpcWssUrls[0] || "wss://robinhood.drpc.org",
  /** @deprecated use rpcHttpUrls — still accepted via RPC_HTTP_FALLBACK merge */
  rpcHttpFallback:
    process.env.RPC_HTTP_FALLBACK || "https://robinhood.drpc.org",
  sniperTokens: BigInt(process.env.SNIPER_TOKENS || "100000"),
  maxQuoteIn: big("MAX_QUOTE_IN"),
  dailyMaxQuote: big("DAILY_MAX_QUOTE"),
  slippageBps: num("SLIPPAGE_BPS", 300),
  /**
   * Wait after sizing before send. Snipe tax starts ~99% and decays over ~3s;
   * default 3000 waits the window out (no snipe tax). Set 0 for max speed / accept tax.
   */
  sniperDelayMs: num("SNIPER_DELAY_MS", 3000),
  skipIneligibleQuotes: bool("SKIP_INELIGIBLE_QUOTES", true),
  /**
   * Floor for ETH left for gas after cover (wei). Actual reserve is
   * max(this, gasUnits × maxFeePerGas) via gasReserveFor().
   */
  gasReserveWei: big("GAS_RESERVE_WEI") ?? 100_000_000_000_000n, // 0.0001 ETH
  holderDust: BigInt(process.env.HOLDER_DUST || "1"),
  networthIntervalMs: num("NETWORTH_INTERVAL_MS", 20_000),
  /** Fast pot/epoch refresh (no holder walk). Default 3s. */
  potRefreshMs: num("POT_REFRESH_MS", 3_000),
  /**
   * Slow holder recount (ms). 0 = fall through to SHARE_REFRESH_MS.
   * Transfer walks are heavy — keep this off (0) and use share cadence.
   */
  holderRefreshMs: num("HOLDER_REFRESH_MS", 0),
  /**
   * Holder count + payout share refresh (ms) when HOLDER_REFRESH_MS is 0.
   * Default 120s. Set 0 to disable Transfer walks entirely.
   */
  shareRefreshMs: num("SHARE_REFRESH_MS", 120_000),
  /** HTTP fallback poll for EpochPublished/Claimed (ms). Default 2s. */
  eventPollMs: num("EVENT_POLL_MS", 2_000),
  dbPath: resolve(ROOT, process.env.DB_PATH || "data/pons.db"),
  walletsPath: resolve(ROOT, "secrets/wallets.json"),
  dashHost: process.env.DASH_HOST || "127.0.0.1",
  dashPort: num("DASH_PORT", 42100),
  /** Pons launchpad token page base (append /0x…). */
  ponsAppBase:
    process.env.PONS_APP_BASE || "https://ponsfamily.com/launchpad",
  /** Block explorer base for token/tx links. */
  explorerBase:
    process.env.EXPLORER_BASE || "https://robinhoodchain.blockscout.com",

  // --- Farmer-follow (piggyback) — independent of SNIPER_LIVE -----------------
  /** 0 = DRY (default). Live curve buys only when FOLLOW_LIVE=1. */
  followLive: bool("FOLLOW_LIVE", false),
  /** Target quote notional in USD per pool (~$0.80). */
  followBuyUsd: num("FOLLOW_BUY_USD", 0.8),
  /** Cap concurrent open/dry follow positions. */
  followMaxOpen: num("FOLLOW_MAX_OPEN", 40),
  /** Cap USD spent on follows per UTC day (cost_usd sum). */
  followDailyUsd: num("FOLLOW_DAILY_USD", 40),
  /** Boot Transfer lookback (blocks ≈ 0.1s). Default 50k ≈ 1.4h. */
  followLookbackBlocks: num("FOLLOW_LOOKBACK_BLOCKS", 50_000),
  /** Wait before follow buy (ms). Default 0 — pots are usually past snipe tax. */
  followDelayMs: num("FOLLOW_DELAY_MS", 0),
  /**
   * Extra farmer addresses (comma/space). Merged with built-in known set.
   * Public addresses only — never import keys from other repos.
   */
  followFarmersExtra: addrList("FOLLOW_FARMERS"),
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
