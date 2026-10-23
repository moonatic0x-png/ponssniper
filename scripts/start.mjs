#!/usr/bin/env node
import { openDb } from "../src/db/db.mjs";
import { loadWallets } from "../src/keys.mjs";
import { config, log } from "../src/config.mjs";
import { startHotpath } from "../src/sniper/hotpath.mjs";
import { startWatcher } from "../src/watcher/index.mjs";
import { startDash } from "../src/dash/server.mjs";

openDb();
const wallets = loadWallets();
log(`start LIVE=${config.live ? 1 : 0} wallet=${wallets.sniper.address}`);
await startHotpath(wallets);
await startWatcher(wallets);
startDash();
await new Promise(() => {});
