#!/usr/bin/env node
import { openDb } from "../src/db/db.mjs";
import { loadWallets } from "../src/keys.mjs";
import { config, log } from "../src/config.mjs";
import { startHotpath } from "../src/sniper/hotpath.mjs";

if (config.readOnly) {
  console.error(
    "READ_ADDRESS is set — refusing to start sniper. Use npm run observe / npm start for read-only dash.",
  );
  process.exit(1);
}

openDb();
const wallets = loadWallets();
if (!wallets.sniper.account) {
  console.error("Sniper needs a private key (npm run keys).");
  process.exit(1);
}
log(
  `sniper start DRY=${config.live ? 0 : 1} LIVE=${config.live ? 1 : 0} addr=${wallets.sniper.address}`,
);
await startHotpath(wallets);
// keep alive
await new Promise(() => {});
