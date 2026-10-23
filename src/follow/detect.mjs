import { decodeEventLog, getAddress, parseAbiItem } from "viem";
import { Erc20Abi, TOPICS } from "../chain/abis.mjs";
import { lower } from "../chain/addresses.mjs";
import { publicClient, wssClient } from "../chain/clients.mjs";
import { config, log } from "../config.mjs";
import { farmerAddresses } from "./farmers.mjs";

const TransferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

async function decodeFarmerTransfers(logs, farmerSet, onFarmerTransfer, extra = {}) {
  let n = 0;
  for (const lg of logs) {
    if (lg.topics?.[0] !== TOPICS.Transfer) continue;
    try {
      const { args } = decodeEventLog({
        abi: Erc20Abi,
        data: lg.data,
        topics: lg.topics,
      });
      const to = lower(args.to);
      if (!farmerSet.has(to)) continue;
      const value = args.value;
      if (value == null || value <= 0n) continue;
      n++;
      await onFarmerTransfer({
        token: lower(lg.address),
        from: lower(args.from),
        to,
        value,
        blockNumber: lg.blockNumber != null ? Number(lg.blockNumber) : null,
        txHash: lg.transactionHash,
        detect_ts: Date.now(),
        ...extra,
      });
    } catch (e) {
      log("[follow/wss] decode err", e.message);
    }
  }
  return n;
}

/** getLogs for Transfer→any of `farmers` in [fromBlock, toBlock]. */
async function fetchFarmerTransfers(client, farmers, fromBlock, toBlock) {
  return client.getLogs({
    event: TransferEvent,
    args: { to: farmers.map((a) => getAddress(a)) },
    fromBlock,
    toBlock,
  });
}

/**
 * Watch ERC20 Transfer → farmer (any token). WSS with HTTP getLogs poll fallback.
 */
export function startFarmerTransferListener({
  onFarmerTransfer,
  farmers = farmerAddresses(),
}) {
  let stopped = false;
  let unwatch = null;
  let pollTimer = null;
  let lastBlock = null;
  let mode = "wss";

  const farmerSet = new Set(farmers.map(lower));
  const farmerAddrs = farmers.map((a) => getAddress(a));

  async function handleLogs(logs) {
    await decodeFarmerTransfers(logs, farmerSet, onFarmerTransfer);
  }

  async function startWss() {
    const client = wssClient();
    log(
      `[follow/wss] subscribing Transfer→farmer (${farmers.length} wallets)`,
    );
    unwatch = client.watchEvent({
      event: TransferEvent,
      args: { to: farmerAddrs },
      onLogs: (logs) => {
        mode = "wss";
        handleLogs(logs);
      },
      onError: (err) => {
        log(
          "[follow/wss] error, falling back to HTTP poll:",
          err?.message || err,
        );
        mode = "poll";
        try {
          unwatch?.();
        } catch {
          /* */
        }
        unwatch = null;
        startPoll();
      },
    });
  }

  async function startPoll() {
    if (pollTimer || stopped) return;
    const client = publicClient();
    if (lastBlock == null) {
      lastBlock = Number(await client.getBlockNumber()) - 2;
    }
    log("[follow/poll] HTTP from block", lastBlock);
    pollTimer = setInterval(async () => {
      if (stopped) return;
      try {
        const head = Number(await client.getBlockNumber());
        const from = lastBlock + 1;
        if (from > head) return;
        const to = Math.min(head, from + 1_999);
        const logs = await fetchFarmerTransfers(
          client,
          farmerAddrs,
          BigInt(from),
          BigInt(to),
        );
        await handleLogs(logs);
        lastBlock = to;
      } catch (e) {
        log("[follow/poll] err", e.message);
      }
    }, 2_000);
  }

  startWss().catch((e) => {
    log("[follow/wss] start failed:", e.message);
    startPoll();
  });

  publicClient()
    .getBlockNumber()
    .then((b) => {
      lastBlock = Number(b);
    })
    .catch(() => {});

  return {
    stop() {
      stopped = true;
      try {
        unwatch?.();
      } catch {
        /* */
      }
      if (pollTimer) clearInterval(pollTimer);
    },
    mode: () => mode,
    async replayLogs(logs) {
      await handleLogs(logs);
    },
  };
}

/**
 * Boot lookback: Transfer logs to farmers in [head-lookback, head].
 */
export async function lookbackFarmerTransfers({
  onFarmerTransfer,
  farmers = farmerAddresses(),
  lookbackBlocks = config.followLookbackBlocks,
}) {
  const client = publicClient();
  const head = await client.getBlockNumber();
  const lookback = BigInt(Math.max(0, lookbackBlocks));
  if (lookback === 0n) return { from: head, head, n: 0 };
  const from = head > lookback ? head - lookback : 0n;
  const farmerSet = new Set(farmers.map(lower));
  const farmerAddrs = farmers.map((a) => getAddress(a));
  log(`[follow] lookback Transfer blocks ${from}→${head}`);
  // Keep chunks small — some free RPC plans reject large eth_getLogs ranges.
  const CHUNK = 1_999n;
  let cur = from;
  let n = 0;
  while (cur <= head) {
    const to = cur + CHUNK - 1n > head ? head : cur + CHUNK - 1n;
    const logs = await fetchFarmerTransfers(client, farmerAddrs, cur, to);
    n += await decodeFarmerTransfers(logs, farmerSet, onFarmerTransfer, {
      lookback: true,
    });
    cur = to + 1n;
  }
  log(`[follow] lookback done transfers=${n}`);
  return { from, head, n };
}
