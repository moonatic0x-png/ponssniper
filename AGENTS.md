# Agent runbook: PONS V2 sniper / farmer-follow → enter position

Instructions for another agent (or human) to run this repo from a clean clone through a real entry. **Never commit secrets.**

## Hard rules

- Do **not** commit, print, or paste: `secrets/wallets.json`, `.env`, private keys, or funded addresses with keys attached.
- Defaults are **DRY** (`SNIPER_LIVE=0`, `FOLLOW_LIVE=0`). Do not set either to `1` unless the operator explicitly asks to go live for that module.
- There is **no sell path**. Entries are hold-forever / collect claims.
- One sniper wallet is enough. Keys are created only via `npm run keys` (refuses overwrite).
- Never import keys or secret code from `indexer`, `pons-fastpath/secrets`, or other projects. Public farmer addresses and event logic only.
- Prefer not running **both** `SNIPER_LIVE=1` and `FOLLOW_LIVE=1` on the same wallet at once (shared nonce races).

## What “entering a position” means (launch sniper)

1. WSS sees `TokenLaunched` / `DistributorCreated` / `CreatorFeeRecipientUpdated`.
   Distributor is resolved from the event **or** on-chain `distributorOf(token)` (not WSS-only).
2. Gates pass: `buybackEnabled === false` **and** `creatorFeeRecipient === distributor`.
   Missing distributor → logged `skip` (`no_distributor`), retried when one appears.
3. Bot sizes **100k whole tokens** (× 10^decimals), computes curve `quoteIn`, simulates, then (if live) sends `curve.buy`.
4. SQLite gets a `positions` row with `strategy='snipe'` (default); dashboard shows it under Positions.

Optional skip: cbBTC/WETH quotes when `SKIP_INELIGIBLE_QUOTES=1` (default).

## What “farmer-follow” means (piggyback module)

Separate process (`npm run follow`). Does **not** change launch hotpath latency.

1. WSS / HTTP poll sees ERC20 `Transfer` **to** a known farmer (boot lookback + live).
   Built-in farmers (public):  
   `0xc736303d0b386675a53138959f981579607bb40f`,  
   `0x5bbe3adb4e5fc0747d7b261acea5be4fc157692c`,  
   `0x8c4987568eaf2a5bdc279f5a2e30e1cc0922ade3`  
   Plus any addresses in `FOLLOW_FARMERS`. (Dynamic “≥20 majority pots last week” needs a full claims index — not in this repo; extend via env.)
2. Token must be a Pons launched curve token; USDG/WETH/other ERC20 → skip (`skip_quote_token` / `not_pons_token`). Normal noise.
3. Farmer still holds ≥ dust; we have no `positions` row for that token.
4. Hard gates: not graduated, `buybackEnabled === false`, `creatorFeeRecipient === distributor`, quote eligible.
   Soft: log pot unallocated (`has_unalloc` / `thin_or_unknown`). **No** `$2` net-floor, trigger cost, wash, or self-harvest.
5. Size ≈ `FOLLOW_BUY_USD` (default **0.8**) quote notional → coverQuote → `curve.buy` (DRY unless `FOLLOW_LIVE=1`).
6. SQLite: `positions.strategy='follow'`; actions `follow_detect` / `follow_skip` / `follow_buy_dry` / `follow_buy_sent`.
7. Wait for farmer harvest → operator publish → `Claimed` (watcher). Hold forever.

Caps: `FOLLOW_MAX_OPEN`, `FOLLOW_DAILY_USD`. One buy per token (idempotent).

---

## Phase A — Clone and install (no chain spend)

```bash
git clone <repo-url> ponssniper
cd ponssniper
# Node >= 22 required
node -v
npm install
cp .env.example .env
```

Edit `.env` only if RPCs differ. Safe defaults are already set for Robinhood Chain (4663).

## Phase B — Create wallet (local only)

```bash
npm run keys          # writes secrets/wallets.json mode 0600; once only
npm run keys -- --show   # prints sniper address only (safe to share)
```

Record the address for funding. Do not commit `secrets/`.

## Phase C — DRY validation (required before live)

```bash
# Terminal 1 — launch sniper listen + would-be buys (no sendRawTransaction)
npm run sniper

# Terminal 1b — farmer-follow DRY (optional; independent of sniper)
npm run follow

# Terminal 2 — pot / claims / net worth (optional in DRY)
npm run watcher

# Terminal 3 — UI
npm run dash
# open http://127.0.0.1:42100
```

Or sniper + watcher + dash: `npm start` (**follow is not included** — run `npm run follow` separately).

**Success signals (DRY sniper):**

- Log: `[hotpath] ready live=0 …`
- Log: `[wss] subscribing logs on factory + dist factory`
- On a matching launch: `[snipe] DRY … detect→gate=…ms … would-buy` and an `actions` row `buy_dry`
- Dashboard Activity shows detect / skip / buy_dry
- `npm test` and `npm run smoke` pass on a machine with RPC access

**Success signals (DRY follow):**

- Log: `[follow] ready live=0 … farmers=… buyUsd=0.8`
- Log: `[follow/wss] subscribing Transfer→farmer`
- Boot: `[follow] lookback Transfer blocks …` then `lookback done transfers=N` (N may be mostly quote noise)
- On a Pons meme Transfer to a farmer that passes gates: `[follow] DRY … $0.8 … would-buy`  
  → `actions.kind=follow_buy_dry`, position `strategy=follow` `status=dry`
- Dashboard → Positions: Strategy column = `follow`

Skips with `buyback_enabled`, `recipient_not_distributor`, `already_held`, `graduated`, `not_pons_token`, `skip_quote_token` are normal — not bugs.

## Phase D — Fund for a live entry

Fund the sniper address **primarily in ETH**. Before every buy (snipe or follow) the bot auto-covers the pool’s `pairToken`:

1. Size curve buy → `quoteNeeded` (sniper: 100k tokens; follow: ~$0.80 quote).
2. If `pairToken` is native ETH → `curve.buy` with `value = quoteNeeded` (no swap).
3. Else if wallet already holds ≥ `quoteNeeded` of the pair → use balance.
4. Else → swap **only the shortfall** ETH → pair via Uniswap router (`exactInput` / multicall), then approve + `curve.buy`.

Keep enough ETH for: cover swap value + `quoteNeeded` (ETH pairs) + gas for swap/approve/buy
(`max(GAS_RESERVE_WEI, gasUnits×fee)`; at the 2 gwei fallback, ERC20 cover needs ~0.00176 ETH gas).

Suggested env caps in `.env` before live:

```bash
MAX_QUOTE_IN=<raw quote units>     # e.g. USDG 6dp: 50000000 = 50 USDG
DAILY_MAX_QUOTE=<raw units/day>
SLIPPAGE_BPS=300
SNIPER_TOKENS=100000
SNIPER_DELAY_MS=3000               # wait out ~3s snipe-tax window (set 0 only to accept tax for speed)
SNIPER_CATCHUP_BLOCKS=900          # boot replay + max launch age (~90s); older → stale_launch
GAS_RESERVE_WEI=100000000000000    # floor; preflight also sizes gas via fee×units
SNIPER_LIVE=0                      # keep 0 until operator says go

# Farmer-follow (independent of SNIPER_LIVE)
FOLLOW_LIVE=0
FOLLOW_BUY_USD=0.8
FOLLOW_MAX_OPEN=40
FOLLOW_DAILY_USD=40
# FOLLOW_LOOKBACK_BLOCKS=50000     # boot Transfer scan; getLogs chunked (~2k) for free RPC limits
# FOLLOW_FARMERS=                  # extra 0x… addresses, comma/space
# FOLLOW_DELAY_MS=0                # follow skips snipe-tax wait by default
```

## Phase E — Live entry (operator must approve)

Only when the operator says to go live for a module:

```bash
# In .env (pick one or both — independent flags):
SNIPER_LIVE=1      # launch snipes
FOLLOW_LIVE=1      # farmer-follow ~$0.80 bags

# Restart the matching process(es)
npm run sniper     # and/or: npm run follow
npm run watcher    # keep for epochs/claims/pot
npm run dash
```

**Success signals (LIVE sniper):**

- Log: `[snipe] LIVE … tx=0x… detect→gate=… gate→tx=…`
- `actions.kind` = `buy_sent` then position `status=open` `strategy=snipe`
- Dashboard → Positions: token, entry epoch, bag, cost
- Explorer: sniper address shows curve `buy` tx

**Success signals (LIVE follow):**

- Log: `[follow] LIVE … $0.8 … tx=0x…`
- `actions.kind` = `follow_buy_sent` then position `status=open` `strategy=follow`
- Dashboard Strategy = `follow`; watcher tracks publish / Claimed like snipes

If `buy_fail` / `follow_buy_fail` / `simulate_fail` / `insufficient_quote` / `insufficient_eth`: fix funding or caps; do not disable gates.

## Phase F — After entry (hold)

- Leave sniper and/or follow + watcher running (or at least watcher) for `EpochPublished` / `Claimed` and pot/holder refresh.
- Dashboard: Strategy, Published? / Payout? / pot USD / holders.
- Claims: watch-only (`Claimed` to our wallet). No claim executor / no auto-sell in v1.
- Never add sell logic on the happy path. Follow does not wash or self-harvest.

---

## Phase G — Read-only dash (remote sniper)

Same repo / shared `.env` on two machines is fine. `READ_ADDRESS` does **not** turn off sniping when `secrets/wallets.json` is present.

| Machine | Has key? | Run |
|---------|----------|-----|
| Sniper | `secrets/wallets.json` | `npm run sniper` and/or `npm run follow` (or `npm start` for sniper+watcher+dash) |
| Dash | no key needed | `npm run observe` — tracks `READ_ADDRESS` |

```bash
# .env (can be identical on both machines)
READ_ADDRESS=0xYourSniperAddress
# On the dash machine only, optional separate DB:
# DB_PATH=data/pons-read.db
# READ_LOOKBACK_BLOCKS=1000000

# Dash machine:
npm run observe
# open http://127.0.0.1:42100 — badge shows READ + wallet
```

- Observer backfills launches + per-curve `CurveBuy` / balances into local SQLite; then pot/claims/net worth work like the normal watcher.
- `npm start` without a key file falls back to observe mode; with a key file it always starts the launch hot path (not follow).

## Commands cheat sheet

| Command | Purpose |
|---------|---------|
| `npm run keys` | Create wallet once |
| `npm run keys -- --show` | Address only |
| `npm run sniper` | Launch hot path listener + buy |
| `npm run follow` | Farmer-follow Transfer watch + ~$0.80 buy |
| `npm run watcher` | Epochs, claims, pot, holders, net worth |
| `npm run dash` | http://127.0.0.1:42100 |
| `npm run observe` | Read-only: backfill remote wallet + dash |
| `npm start` | sniper + watcher + dash (follow **not** included) |
| `npm test` | Gate + curve math + follow gates / DRY persist |
| `npm run smoke` | Live RPC/WSS DRY probe |

## Layout (where to look)

- Launch hot path: `src/sniper/hotpath.mjs`, `buy.mjs`, `gates.mjs`, `wss.mjs`
- Farmer-follow: `src/follow/` — `runner.mjs`, `detect.mjs`, `gates.mjs`, `plan.mjs`, `farmers.mjs`
- Config: `src/config.mjs`, `.env.example`
- DB: `src/db/schema.sql` (`positions.strategy`)
- UI: `src/dash/` (Strategy column on Positions)

## Secrets checklist before any git push

- [ ] `.env` gitignored and absent from staging
- [ ] `secrets/wallets.json` gitignored and absent from staging
- [ ] `data/*.db*` gitignored
- [ ] `git status` / `git diff --cached` show no private keys or RPC auth tokens
- [ ] Only `.env.example` and `secrets/.gitkeep` for templates

## Out of scope (do not build)

Keeper forecasting, pot top-ups, wash trades, self-harvest for follow, multi-wallet fleets, selling after claim, importing keys from other projects, dynamic farmer discovery from a full claims index.
