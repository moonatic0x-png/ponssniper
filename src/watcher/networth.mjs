import { getAddress } from "viem";
import { CurveAbi, Erc20Abi } from "../chain/abis.mjs";
import { KNOWN_QUOTES, ZERO } from "../chain/addresses.mjs";
import { sellOutFor } from "../chain/curveMath.mjs";
import { publicClient } from "../chain/clients.mjs";
import { config } from "../config.mjs";
import { db, insertSnapshot, upsertPoolStats } from "../db/db.mjs";
import { quoteToUsd } from "./price.mjs";

export async function snapshotNetWorth(walletAddress) {
  const client = publicClient();
  const me = getAddress(walletAddress);
  const eth = await client.getBalance({ address: me });
  const ethUsd = (Number(eth) / 1e18) * config.ethUsd;

  const quotes = {};
  let quotesUsd = 0;
  for (const [addr, meta] of Object.entries(KNOWN_QUOTES)) {
    if (addr === ZERO) continue;
    try {
      const bal = await client.readContract({
        address: getAddress(addr),
        abi: Erc20Abi,
        functionName: "balanceOf",
        args: [me],
      });
      const usd = quoteToUsd(addr, bal) ?? 0;
      quotes[meta.symbol] = { raw: String(bal), usd };
      quotesUsd += usd;
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
      const usd = quoteToUsd(pos.pair || ZERO, markQuote) ?? 0;
      bags[pos.token] = {
        symbol: pos.symbol,
        bal: String(bal),
        mark_quote: String(markQuote),
        usd,
        graduated,
      };
      bagsUsd += usd;
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
  const totalUsd = ethUsd + quotesUsd + bagsUsd;

  insertSnapshot({
    eth_wei: eth,
    quotes_json: JSON.stringify(quotes),
    bags_json: JSON.stringify(bags),
    claims_usd: claimsUsd,
    total_usd: totalUsd,
  });

  return { eth, ethUsd, quotes, bags, claimsUsd, totalUsd };
}
