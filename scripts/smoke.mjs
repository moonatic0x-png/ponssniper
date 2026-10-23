#!/usr/bin/env node
/**
 * DRY smoke: connect RPC + WSS, fetch a recent TokenLaunched (if any),
 * run getLaunchedToken + gate timing. Does not send txs.
 */
import { decodeEventLog, getAddress } from "viem";
import { FactoryAbi, TOPICS } from "../src/chain/abis.mjs";
import { LAUNCH, lower } from "../src/chain/addresses.mjs";
import { publicClient, wssClient } from "../src/chain/clients.mjs";
import { evaluateGates } from "../src/sniper/gates.mjs";
import { log } from "../src/config.mjs";

const client = publicClient();
const head = await client.getBlockNumber();
log(`[smoke] head=${head} chain ok`);

const from = head > 5000n ? head - 5000n : 0n;
const t0 = Date.now();
const logs = await client.getLogs({
  address: getAddress(LAUNCH),
  fromBlock: from,
  toBlock: head,
});
const launched = logs.filter((l) => l.topics[0] === TOPICS.TokenLaunched);
log(`[smoke] TokenLaunched in last ~5k blocks: ${launched.length}`);

if (launched.length) {
  const lg = launched[launched.length - 1];
  const detect_ts = Date.now();
  const { args } = decodeEventLog({
    abi: FactoryAbi,
    data: lg.data,
    topics: lg.topics,
  });
  const info = await client.readContract({
    address: getAddress(LAUNCH),
    abi: FactoryAbi,
    functionName: "getLaunchedToken",
    args: [args.token],
  });
  const gate_ts = Date.now();
  const gate = evaluateGates({
    buybackEnabled: !!info.buybackEnabled,
    creatorFeeRecipient: info.creatorFeeRecipient,
    distributor: info.creatorFeeRecipient, // smoke: treat recipient as candidate
    pairToken: lower(info.pairToken),
  });
  log(
    `[smoke] sample token=${args.token} buyback=${info.buybackEnabled} ` +
      `detect→gate(read)=${gate_ts - detect_ts}ms getLogs_span=${detect_ts - t0}ms ` +
      `gate_ok=${gate.ok} reason=${gate.reason || "pass"}`,
  );
}

// WSS brief listen
log("[smoke] opening WSS 8s…");
const wss = wssClient();
let n = 0;
const unwatch = wss.watchEvent({
  address: getAddress(LAUNCH),
  onLogs: (ls) => {
    n += ls.length;
    log(`[smoke] wss logs +${ls.length}`);
  },
  onError: (e) => log("[smoke] wss err", e?.message),
});
await new Promise((r) => setTimeout(r, 8000));
try {
  unwatch();
} catch {
  /* */
}
log(`[smoke] wss done events=${n} OK`);
process.exit(0);
