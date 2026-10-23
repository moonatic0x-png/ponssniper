import {
  createPublicClient,
  createWalletClient,
  http,
  webSocket,
  fallback,
} from "viem";
import { CHAIN_ID, config, log } from "../config.mjs";

export const robinhood = {
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: config.rpcHttpUrls,
      webSocket: config.rpcWssUrls,
    },
  },
};

let _public;
let _write;
let _writeAddr;
let _loggedPool = false;
/** Round-robin cursor for follow/read rotation (separate single-URL clients). */
let _rotateIdx = 0;
/** @type {{ url: string, client: ReturnType<typeof createPublicClient> }[] | null} */
let _httpPool = null;

function logPoolOnce() {
  if (_loggedPool) return;
  _loggedPool = true;
  log(
    `[rpc] http×${config.rpcHttpUrls.length} ${config.rpcHttpUrls.map(shortUrl).join(" | ")}`,
  );
  log(
    `[rpc] wss×${config.rpcWssUrls.length} ${config.rpcWssUrls.map(shortUrl).join(" | ")}`,
  );
}

function shortUrl(u) {
  try {
    const { host, pathname } = new URL(u);
    return pathname && pathname !== "/" ? `${host}${pathname}` : host;
  } catch {
    return u;
  }
}

function httpTransports({ timeout = 20_000, retryCount = 1 } = {}) {
  const urls = config.rpcHttpUrls.length
    ? config.rpcHttpUrls
    : [config.rpcHttp];
  return urls.map((url) => http(url, { timeout, retryCount }));
}

function wssTransports() {
  const urls = config.rpcWssUrls.length ? config.rpcWssUrls : [config.rpcWss];
  return urls.map((url) =>
    webSocket(url, {
      reconnect: true,
      retryCount: 10,
    }),
  );
}

/**
 * Read client — walks the HTTP pool on error (no background rank; keeps process exit clean).
 */
export function publicClient() {
  if (_public) return _public;
  logPoolOnce();
  _public = createPublicClient({
    chain: robinhood,
    transport: fallback(httpTransports({ timeout: 20_000, retryCount: 1 }), {
      retryCount: 3,
    }),
  });
  return _public;
}

/**
 * Write client — same HTTP pool (official first). Failover on send/estimate errors.
 * Recreates if a different account is requested (singleton was previously sticky).
 */
export function writeClient(account) {
  const addr = account?.address ? String(account.address).toLowerCase() : null;
  if (_write && _writeAddr === addr) return _write;
  logPoolOnce();
  _write = createWalletClient({
    account,
    chain: robinhood,
    transport: fallback(httpTransports({ timeout: 30_000, retryCount: 1 }), {
      retryCount: 3,
    }),
  });
  _writeAddr = addr;
  return _write;
}

/**
 * WSS client — tries each URL in the pool (fallback) for log subscriptions.
 */
export function wssClient() {
  const transports = wssTransports();
  if (transports.length === 1) {
    return createPublicClient({
      chain: robinhood,
      transport: transports[0],
    });
  }
  return createPublicClient({
    chain: robinhood,
    transport: fallback(transports, { retryCount: 2 }),
  });
}

function httpPoolClients() {
  if (_httpPool) return _httpPool;
  logPoolOnce();
  const urls = config.rpcHttpUrls.length
    ? config.rpcHttpUrls
    : [config.rpcHttp];
  _httpPool = urls.map((url) => ({
    url,
    client: createPublicClient({
      chain: robinhood,
      transport: http(url, { timeout: 20_000, retryCount: 1 }),
    }),
  }));
  return _httpPool;
}

/**
 * Follow / heavy-read helper: round-robin which RPC is tried first, then walk
 * the rest of the pool on error. Spreads eth_getLogs load so one endpoint
 * does not soak every lookback/poll chunk (unlike sticky fallback).
 *
 * @template T
 * @param {(client: ReturnType<typeof createPublicClient>) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withRotatedHttp(fn) {
  const pool = httpPoolClients();
  if (!pool.length) throw new Error("no RPC HTTP urls");
  const start = _rotateIdx % pool.length;
  _rotateIdx = (_rotateIdx + 1) % 1_000_000_000;
  let lastErr;
  for (let i = 0; i < pool.length; i++) {
    const { url, client } = pool[(start + i) % pool.length];
    try {
      return await fn(client);
    } catch (e) {
      lastErr = e;
      if (i < pool.length - 1) {
        log(
          `[rpc] rotate skip ${shortUrl(url)}:`,
          e?.shortMessage || e?.message || e,
        );
      }
    }
  }
  throw lastErr;
}
