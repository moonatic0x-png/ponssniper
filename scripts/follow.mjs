#!/usr/bin/env node
import { openDb } from "../src/db/db.mjs";
import { loadWallets } from "../src/keys.mjs";
import { config, log } from "../src/config.mjs";
import { startFollow } from "../src/follow/runner.mjs";

openDb();
const wallets = loadWallets();
if (!wallets.sniper.account) {
  console.error(
    "Follow needs secrets/wallets.json (npm run keys). Use a funded sniper key; FOLLOW_LIVE is independent of SNIPER_LIVE.",
  );
  process.exit(1);
}
log(
  `follow start DRY=${config.followLive ? 0 : 1} LIVE=${config.followLive ? 1 : 0} ` +
    `addr=${wallets.sniper.address} buyUsd=${config.followBuyUsd}`,
);
await startFollow(wallets);
await new Promise(() => {});
