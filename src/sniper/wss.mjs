import { decodeEventLog, getAddress } from "viem";
import {
  DistributorFactoryAbi,
  FactoryAbi,
  TOPICS,
} from "../chain/abis.mjs";
import { DIST_FACTORY, LAUNCH, lower } from "../chain/addresses.mjs";
import { publicClient, wssClient } from "../chain/clients.mjs";
import { log } from "../config.mjs";

/**
 * Subscribe to TokenLaunched + DistributorCreated via WSS.
 * Falls back to HTTP getLogs polling on disconnect.
 */
export function startLogListener({ onTokenLaunched, onDistributorCreated }) {
  let stopped = false;
  let unwatch = null;
  let pollTimer = null;
  let lastBlock = null;
  let mode = "wss";

  async function handleLogs(logs) {
    for (const lg of logs) {
      const topic = lg.topics?.[0];
      const addr = lower(lg.address);
      try {
        if (topic === TOPICS.TokenLaunched && addr === LAUNCH) {
          const { args } = decodeEventLog({
            abi: FactoryAbi,
            data: lg.data,
            topics: lg.topics,
          });
          await onTokenLaunched({
            token: lower(args.token),
            curve: lower(args.curve),
            deployer: lower(args.deployer),
            pairToken: lower(args.pairToken),
            launchConfigId: args.launchConfigId,
            graduationThreshold: args.graduationThreshold,
            blockNumber: lg.blockNumber != null ? Number(lg.blockNumber) : null,
            txHash: lg.transactionHash,
            detect_ts: Date.now(),
          });
        } else if (
          topic === TOPICS.DistributorCreated &&
          addr === DIST_FACTORY
        ) {
          const { args } = decodeEventLog({
            abi: DistributorFactoryAbi,
            data: lg.data,
            topics: lg.topics,
          });
          await onDistributorCreated({
            token: lower(args.token),
            distributor: lower(args.distributor),
            blockNumber: lg.blockNumber != null ? Number(lg.blockNumber) : null,
            txHash: lg.transactionHash,
            detect_ts: Date.now(),
          });
        }
      } catch (e) {
        log("[wss] decode err", e.message);
      }
    }
  }

  async function startWss() {
    const client = wssClient();
    log("[wss] subscribing logs on factory + dist factory");
    unwatch = client.watchEvent({
      address: [getAddress(LAUNCH), getAddress(DIST_FACTORY)],
      events: [
        {
          type: "event",
          name: "TokenLaunched",
          inputs: FactoryAbi.find((x) => x.name === "TokenLaunched").inputs,
        },
        {
          type: "event",
          name: "DistributorCreated",
          inputs: DistributorFactoryAbi.find(
            (x) => x.name === "DistributorCreated",
          ).inputs,
        },
      ],
      onLogs: (logs) => {
        mode = "wss";
        handleLogs(logs);
      },
      onError: (err) => {
        log("[wss] error, falling back to HTTP poll:", err?.message || err);
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
    log("[wss] HTTP poll fallback from block", lastBlock);
    pollTimer = setInterval(async () => {
      if (stopped) return;
      try {
        const head = Number(await client.getBlockNumber());
        const from = lastBlock + 1;
        if (from > head) return;
        const to = Math.min(head, from + 2000);
        const logs = await client.getLogs({
          address: [getAddress(LAUNCH), getAddress(DIST_FACTORY)],
          fromBlock: BigInt(from),
          toBlock: BigInt(to),
        });
        await handleLogs(logs);
        lastBlock = to;
      } catch (e) {
        log("[poll] err", e.message);
      }
    }, 1500);
  }

  startWss().catch((e) => {
    log("[wss] start failed:", e.message);
    startPoll();
  });

  // Seed lastBlock for catch-up
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
  };
}
