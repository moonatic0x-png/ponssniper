# Changelog

All notable changes to this project are documented here.

## [1.1.0] — 2026-10-23

### Added

- **Automatic ETH → quote funding** before every buy (`src/sniper/coverQuote.mjs`), same idea as pons-fastpath `coverQuote`:
  1. Size curve buy for 100k tokens → `quoteNeeded`
  2. Native ETH pair → spend ETH on `curve.buy` (`value`); no swap
  3. Else if wallet already holds ≥ `quoteNeeded` of `pairToken` → use balance
  4. Else → swap **only the shortfall** ETH → pair via router `exactInput` / multicall, then approve + buy
- Route discovery via QuoterV3 (`src/chain/price.mjs`): direct WETH pool or via USDG
- `GAS_RESERVE_WEI` env (default 0.0001 ETH) so cover swaps leave gas
- DRY mode plans cover (`via=eth|balance|mixed`, logs `ethIn`) without sending swaps
- Unit tests for `quoteSpend`
- Live probe: ETH→USDG route quotes successfully on Robinhood Chain

### Changed

- `executeBuy` always runs `coverQuote` before simulate/send (removed `ALLOW_QUOTE_SWAP` gate)
- Sniper / action logs include `cover=` and optional `ethIn=`
- README and AGENTS.md: fund wallet primarily in ETH; no manual pre-swap
- Cover ETH preflight reserves `gasUnits × maxFeePerGas` (swap/approve/buy) with `GAS_RESERVE_WEI` as floor — avoids mid-sequence OOG when the 0.0001 ETH default alone was too small at 2 gwei

## [1.0.0] — 2026-10-23

### Added

- Greenfield Node 22 ESM PONS V2 launch sniper on Robinhood Chain (4663)
- WSS listener on PonsFactory + HolderDistributor factory (`TokenLaunched`, `DistributorCreated`)
- Gates: `buybackEnabled === false` and `creatorFeeRecipient === distributor`
- Fixed-size curve buy (default 100k tokens); DRY by default (`SNIPER_LIVE=0`); never sell
- Hot-path latency logs: `detect_ts → gate_ts → tx_hash_ts`
- SQLite persistence: pools, positions, epochs, claims, actions, balances_snapshot, scanner_cursor
- Watcher: pot (`unallocatedQuote`), holders (Transfer-walk + dust), epochs, `Claimed`, net worth
- Local dashboard on `:42100` (net worth / activity, positions, held-pool pot table)
- `npm run keys` (create-once wallets, mode 0600); secrets gitignored
- AGENTS.md runbook (clone → DRY → fund → live entry)
- Gate + curve-math unit tests; `npm run smoke` DRY chain probe
- Published to GitHub with no secrets (`.env` / `secrets/wallets.json` excluded)
