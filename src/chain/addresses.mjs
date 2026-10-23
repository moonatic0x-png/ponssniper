/** Robinhood Chain (4663) constants — lowercase for log compares. */
export const ZERO = "0x0000000000000000000000000000000000000000";
export const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
export const LAUNCH = "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e";
export const DIST_FACTORY = "0x70e95cc5f03db2906081e7a8d16e4c4209291507";
export const ROUTER = "0xcaf681a66d020601342297493863e78c959e5cb2";
export const QUOTER = "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7";
export const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
export const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

/** Quote symbols that never publish — skip by default. */
export const INELIGIBLE_QUOTE_SYMBOLS = new Set(["cbbtc", "weth"]);

export const KNOWN_QUOTES = {
  [ZERO]: { symbol: "ETH", decimals: 18 },
  [USDG]: { symbol: "USDG", decimals: 6 },
  [WETH]: { symbol: "WETH", decimals: 18 },
};

/** System addresses excluded from holder counts. */
export const HOLDER_SKIP = new Set([
  ZERO,
  "0x000000000000000000000000000000000000dead",
  LAUNCH,
  DIST_FACTORY,
  "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044",
  "0x267444d099b10fb5ed7c3cc7b7c767adca574952",
  "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  "0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e",
  "0x42df2a798f82289e177311362e8f5ccc45c1219c",
  "0xc7819b64a1daecd7ec19856d026cb14efbd89046",
  "0xe33e9e479df8802cb0866d5d05258bec4cf62948",
  "0xf5695117b99b6f6401e67d4195bd653628176c6c",
]);

export const lower = (a) => (a == null ? null : String(a).toLowerCase());
export const same = (a, b) => lower(a) === lower(b);
