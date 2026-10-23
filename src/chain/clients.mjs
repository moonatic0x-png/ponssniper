import {
  createPublicClient,
  createWalletClient,
  http,
  webSocket,
  fallback,
} from "viem";
import { CHAIN_ID, config } from "../config.mjs";

export const robinhood = {
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [config.rpcHttp], webSocket: [config.rpcWss] },
  },
};

let _public;
let _write;

export function publicClient() {
  if (_public) return _public;
  const transports = [
    http(config.rpcHttp, { timeout: 20_000, retryCount: 2 }),
  ];
  if (config.rpcHttpFallback && config.rpcHttpFallback !== config.rpcHttp) {
    transports.push(
      http(config.rpcHttpFallback, { timeout: 20_000, retryCount: 1 }),
    );
  }
  _public = createPublicClient({
    chain: robinhood,
    transport: fallback(transports),
  });
  return _public;
}

/** Write client — official RPC only. */
export function writeClient(account) {
  if (_write) return _write;
  _write = createWalletClient({
    account,
    chain: robinhood,
    transport: http(config.rpcHttp, { timeout: 30_000, retryCount: 1 }),
  });
  return _write;
}

export function wssClient() {
  return createPublicClient({
    chain: robinhood,
    transport: webSocket(config.rpcWss, {
      reconnect: true,
      retryCount: 10,
    }),
  });
}
