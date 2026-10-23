#!/usr/bin/env node
import { openDb } from "../src/db/db.mjs";
import { loadWallets } from "../src/keys.mjs";
import { startWatcher } from "../src/watcher/index.mjs";

openDb();
const wallets = loadWallets();
await startWatcher(wallets);
await new Promise(() => {});
