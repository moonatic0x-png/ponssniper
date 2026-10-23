import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";
import { config } from "./config.mjs";

/**
 * wallets.json shape: { sniper: { privateKey, address } }
 * Mode 0600. Created once by npm run keys; refuses overwrite.
 *
 * READ mode: when config.readAddress is set, returns address-only (no key).
 */
export function loadWallets(path = config.walletsPath) {
  if (config.readOnly && config.readAddress) {
    return {
      sniper: {
        privateKey: null,
        address: getAddress(config.readAddress),
        account: null,
        readOnly: true,
      },
    };
  }
  if (!existsSync(path)) {
    throw new Error(
      `Missing ${path}. Run: npm run keys  (or set READ_ADDRESS for observe-only)`,
    );
  }
  const j = JSON.parse(readFileSync(path, "utf8"));
  if (!j.sniper?.privateKey) throw new Error("wallets.json missing sniper.privateKey");
  const account = privateKeyToAccount(j.sniper.privateKey);
  return {
    sniper: {
      privateKey: j.sniper.privateKey,
      address: account.address,
      account,
      readOnly: false,
    },
  };
}

export function createWalletsOnce(path = config.walletsPath) {
  if (existsSync(path)) {
    throw new Error(`Refusing overwrite: ${path} already exists. Use --show for addresses.`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const body = {
    sniper: { privateKey, address: account.address },
  };
  writeFileSync(path, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* windows */
  }
  return { address: account.address, path };
}

export function showAddresses(path = config.walletsPath) {
  if (config.readOnly && config.readAddress) {
    return { sniper: getAddress(config.readAddress), readOnly: true };
  }
  const w = loadWallets(path);
  return { sniper: w.sniper.address };
}
