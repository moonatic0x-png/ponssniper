# Changelog

All notable changes to this project are documented here.

## [1.2.0] — 2026-10-23

### Added

- **Farmer-follow (piggyback)** module (`src/follow/`, `npm run follow`): watch ERC20 `Transfer` to known fee-farmers, gate, buy ≈ `$FOLLOW_BUY_USD` (default 0.8), hold forever / collect claims — no sell, no wash, no `$2` net-floor.
- Independent live flag `FOLLOW_LIVE` (default 0); caps `FOLLOW_MAX_OPEN`, `FOLLOW_DAILY_USD`; `FOLLOW_FARMERS` + lookback env.
- Positions `strategy` column (`snipe` | `follow`); dash Strategy label; actions `follow_detect` / `follow_skip` / `follow_buy_dry` / `follow_buy_sent`.
- Unit tests for follow gates + USDG `$0.80` sizing plan.
- Docs: README / AGENTS.md / `.env.example` for the second module.

### Changed

- `executeBuy` accepts optional `delayMs` (follow defaults to 0; sniper still uses `SNIPER_DELAY_MS`).
- Snipe-tax `delayMs` now runs **before** ETH→quote cover (not after), so a failed buy cannot strand freshly swapped quote.

### Fixed

- Cover→buy abort could leave quote on the wallet with no `curve.buy`: router `minOut` used slipped shortfall (fill could be `< need` → `cover_short`), approve used `estimateGas`, and live `simulate_fail` aborted after funding. Now require full fill (+ one top-up), fixed-gas approve via the cover nonce path, and still send the buy after a live simulate miss.

## [1.1.0] — 2026-10-23

### Added

- **Read-only observe mode** (`READ_ADDRESS`): `npm run observe` backfills remote sniper buys into local DB + dash (`READ` badge). Shared-repo safe — local `secrets/wallets.json` still runs sniper; `READ_ADDRESS` alone is keyless fallback.
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

### Fixed

- Hotpath no longer silently drops launches waiting for a WSS `DistributorCreated` only — resolves `distributorOf(token)`, logs `skip=no_distributor`, listens for `CreatorFeeRecipientUpdated`, and catch-up-replays recent blocks on boot
- Bound snipe age / catch-up to ~90s (`SNIPER_CATCHUP_BLOCKS=900`); batch `distributorOf` into the launch multicall; durable `bought` + DB position guard against double buys from launch/dist/recipient events
- Default `SNIPER_DELAY_MS=3000` to wait out the ~3s snipe-tax window (set `0` only to accept tax for speed)
- Multicall decode treats empty `"0x"` returnData as failure (RPC lag on brand-new curves) and retries once after 400ms instead of throwing `buy_fail`

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
