#!/usr/bin/env node
import { openDb } from "../src/db/db.mjs";
import { loadWallets } from "../src/keys.mjs";
import { config, log } from "../src/config.mjs";
import { startHotpath } from "../src/sniper/hotpath.mjs";
import { startWatcher } from "../src/watcher/index.mjs";
import { startDash } from "../src/dash/server.mjs";

openDb();
const wallets = loadWallets();
const canSnipe = !!wallets.sniper.account;

if (canSnipe) {
  log(`start LIVE=${config.live ? 1 : 0} wallet=${wallets.sniper.address}`);
  await startHotpath(wallets);
  await startWatcher(wallets, { observe: false });
  startDash({ readOnly: false, wallet: wallets.sniper.address });
} else {
  log(
    `start READ wallet=${wallets.sniper.address} (no local key — observe + dash only)`,
  );
  startDash({ readOnly: true, wallet: wallets.sniper.address });
  await startWatcher(wallets, { observe: true });
}
await new Promise(() => {});
