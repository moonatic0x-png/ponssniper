#!/usr/bin/env node
import { openDb } from "../src/db/db.mjs";
import { loadWallets } from "../src/keys.mjs";
import { config, log } from "../src/config.mjs";
import { startHotpath } from "../src/sniper/hotpath.mjs";

openDb();
const wallets = loadWallets();
log(
  `sniper start DRY=${config.live ? 0 : 1} LIVE=${config.live ? 1 : 0} addr=${wallets.sniper.address}`,
);
await startHotpath(wallets);
// keep alive
await new Promise(() => {});
