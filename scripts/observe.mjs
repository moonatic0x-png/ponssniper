#!/usr/bin/env node
/**
 * Read-only dash: watch READ_ADDRESS (remote sniper) — no buys.
 * Safe alongside a sniper machine that shares the same .env; this script
 * always uses READ_ADDRESS and never starts the hot path.
 */
import { openDb } from "../src/db/db.mjs";
import { loadObserveWallet } from "../src/keys.mjs";
import { config, log } from "../src/config.mjs";
import { startWatcher } from "../src/watcher/index.mjs";
import { startDash } from "../src/dash/server.mjs";

const wallets = loadObserveWallet();
openDb();
log(`[observe] wallet=${wallets.sniper.address} dash=:${config.dashPort}`);
startDash({ readOnly: true, wallet: wallets.sniper.address });
await startWatcher(wallets, { observe: true });
await new Promise(() => {});
