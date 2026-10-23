import { getAddress } from "viem";
import { CurveAbi, Erc20Abi } from "../chain/abis.mjs";
import { KNOWN_QUOTES, ZERO, lower } from "../chain/addresses.mjs";
import { ethUsdMark } from "../chain/price.mjs";
import { sellOutFor } from "../chain/curveMath.mjs";
import { publicClient } from "../chain/clients.mjs";
import { db, insertSnapshot, upsertPoolStats } from "../db/db.mjs";
import { quoteToUsd } from "./price.mjs";

export async function snapshotNetWorth(walletAddress) {
  const client = publicClient();
  const me = getAddress(walletAddress);
  const eth = await client.getBalance({ address: me });
  const ethPx = eth === 0n ? null : await ethUsdMark();
  const ethUsd =
    eth === 0n ? 0 : ethPx == null ? null : (Number(eth) / 1e18) * ethPx;

  const quotes = {};
  let quotesUsd = 0;
  let quotesMarked = true;
  for (const [addr, meta] of Object.entries(KNOWN_QUOTES)) {
    if (addr === ZERO) continue;
    try {
      const bal = await client.readContract({
        address: getAddress(addr),
        abi: Erc20Abi,
        functionName: "balanceOf",
        args: [me],
      });
      const usd = await quoteToUsd(addr, bal);
      if (usd == null && bal > 0n) quotesMarked = false;
      quotes[meta.symbol] = { raw: String(bal), usd };
      if (usd != null) quotesUsd += usd;
    } catch {
      /* */
    }
  }

  const positions = db()
    .prepare(
      `SELECT p.token, p.tokens, pl.curve, pl.pair, pl.symbol, pl.decimals
       FROM positions p JOIN pools pl ON pl.token=p.token
       WHERE p.status IN ('open','dry')`,
    )
    .all();

  const bags = {};
  let bagsUsd = 0;
  let bagsMarked = true;
  for (const pos of positions) {
    try {
      const bal = await client.readContract({
        address: getAddress(pos.token),
        abi: Erc20Abi,
        functionName: "balanceOf",
        args: [me],
      });
      let markQuote = 0n;
      let graduated = false;
      try {
        graduated = await client.readContract({
          address: getAddress(pos.curve),
          abi: CurveAbi,
          functionName: "graduated",
        });
      } catch {
        /* */
      }
      if (!graduated && bal > 0n) {
        const [Q, T] = await client.readContract({
          address: getAddress(pos.curve),
          abi: CurveAbi,
          functionName: "getReserves",
        });
        const feeBps = await client.readContract({
          address: getAddress(pos.curve),
          abi: CurveAbi,
          functionName: "feeBps",
        });
        const taxBps = await client.readContract({
          address: getAddress(pos.curve),
          abi: CurveAbi,
          functionName: "creatorTaxBps",
        });
        markQuote = sellOutFor(
          { Q, T, feeBps: Number(feeBps), taxBps: Number(taxBps) },
          bal,
        );
      }
      const usd = await quoteToUsd(pos.pair || ZERO, markQuote);
      // Unknown / ineligible pairs (e.g. cbBTC) have no USD mark — skip them in
      // the total instead of blanking the whole portfolio.
      const pairKey = lower(pos.pair) || ZERO;
      if (usd == null && markQuote > 0n && KNOWN_QUOTES[pairKey]) {
        bagsMarked = false;
      }
      bags[pos.token] = {
        symbol: pos.symbol,
        bal: String(bal),
        mark_quote: String(markQuote),
        usd,
        graduated,
      };
      if (usd != null) bagsUsd += usd;
      upsertPoolStats({
        token: pos.token,
        bag_mark_quote: markQuote,
        bag_mark_usd: usd,
        phase: graduated ? "graduated" : "curve",
      });
    } catch {
      bags[pos.token] = { error: true };
    }
  }

  const claimsUsd =
    db().prepare(`SELECT COALESCE(SUM(usd),0) AS u FROM claims`).get()?.u ?? 0;

  // Wallet net worth: ETH + quote balances + marked bags.
  // Cumulative claims already sit in quote balances once paid; we surface claimsUsd separately.
  // Null total when any ETH/quote mark failed — never invent a USD price.
  const totalUsd =
    ethUsd == null || !quotesMarked || !bagsMarked
      ? null
      : ethUsd + quotesUsd + bagsUsd;

  insertSnapshot({
    eth_wei: eth,
    quotes_json: JSON.stringify(quotes),
    bags_json: JSON.stringify(bags),
    claims_usd: claimsUsd,
    total_usd: totalUsd,
  });

  return { eth, ethUsd, quotes, bags, claimsUsd, totalUsd };
}
