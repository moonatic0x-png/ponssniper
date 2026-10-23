#!/usr/bin/env node
/**
 * Read-only dash: watch a remote sniper address (READ_ADDRESS) — no keys, no buys.
 */
import { openDb } from "../src/db/db.mjs";
import { loadWallets } from "../src/keys.mjs";
import { config, log } from "../src/config.mjs";
import { startWatcher } from "../src/watcher/index.mjs";
import { startDash } from "../src/dash/server.mjs";

if (!config.readOnly) {
  console.error(
    "Set READ_ADDRESS=0x… in .env to run observe mode (no private key needed).",
  );
  process.exit(1);
}

openDb();
const wallets = loadWallets();
log(`[observe] wallet=${wallets.sniper.address} dash=:${config.dashPort}`);
startDash(); // up during backfill
await startWatcher(wallets);
await new Promise(() => {});
