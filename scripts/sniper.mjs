#!/usr/bin/env node
import { openDb } from "../src/db/db.mjs";
import { loadWallets } from "../src/keys.mjs";
import { config, log } from "../src/config.mjs";
import { startHotpath } from "../src/sniper/hotpath.mjs";

openDb();
const wallets = loadWallets();
if (!wallets.sniper.account) {
  console.error(
    "Sniper needs secrets/wallets.json (npm run keys). READ_ADDRESS alone is observe-only — use npm run observe on the dash machine.",
  );
  process.exit(1);
}
log(
  `sniper start DRY=${config.live ? 0 : 1} LIVE=${config.live ? 1 : 0} addr=${wallets.sniper.address}` +
    (config.readAddress ? ` (READ_ADDRESS set; sniper still active)` : ""),
);
await startHotpath(wallets);
// keep alive
await new Promise(() => {});
