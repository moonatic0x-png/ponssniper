#!/usr/bin/env node
import { createWalletsOnce, showAddresses } from "../src/keys.mjs";
import { config } from "../src/config.mjs";

const show = process.argv.includes("--show");

try {
  if (show) {
    const a = showAddresses();
    console.log("sniper:", a.sniper);
  } else {
    const r = createWalletsOnce();
    console.log("Created", r.path);
    console.log("sniper address:", r.address);
    console.log("Mode 0600. Fund this address before SNIPER_LIVE=1.");
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
