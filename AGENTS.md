# Agent runbook: PONS V2 sniper → enter position

Instructions for another agent (or human) to run this repo from a clean clone through a real entry. **Never commit secrets.**

## Hard rules

- Do **not** commit, print, or paste: `secrets/wallets.json`, `.env`, private keys, or funded addresses with keys attached.
- Default is **DRY** (`SNIPER_LIVE=0`). Do not set `SNIPER_LIVE=1` unless the operator explicitly asks to go live.
- There is **no sell path**. Entries are hold-forever.
- One sniper wallet is enough. Keys are created only via `npm run keys` (refuses overwrite).

## What “entering a position” means

1. WSS sees `TokenLaunched` and/or `DistributorCreated`.
2. Gates pass: `buybackEnabled === false` **and** `creatorFeeRecipient === distributor`.
3. Bot sizes **100k whole tokens** (× 10^decimals), computes curve `quoteIn`, simulates, then (if live) sends `curve.buy`.
4. SQLite gets a `positions` row; dashboard shows it under Positions.

Optional skip: cbBTC/WETH quotes when `SKIP_INELIGIBLE_QUOTES=1` (default).

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
# Terminal 1 — listen + would-be buys (no sendRawTransaction)
npm run sniper

# Terminal 2 — pot / claims / net worth (optional in DRY)
npm run watcher

# Terminal 3 — UI
npm run dash
# open http://127.0.0.1:42100
```

Or all-in-one: `npm start`.

**Success signals (DRY):**

- Log: `[hotpath] ready live=0 …`
- Log: `[wss] subscribing logs on factory + dist factory`
- On a matching launch: `[snipe] DRY … detect→gate=…ms … would-buy` and an `actions` row `buy_dry`
- Dashboard Activity shows detect / skip / buy_dry
- `npm test` and `npm run smoke` pass on a machine with RPC access

Skips with `buyback_enabled` or `recipient_not_distributor` are normal — not bugs.

## Phase D — Fund for a live entry

Fund the sniper address **primarily in ETH**. Before every buy the sniper auto-covers the pool’s `pairToken`:

1. Size curve buy → `quoteNeeded` (100k tokens, fees/tax in math).
2. If `pairToken` is native ETH → `curve.buy` with `value = quoteNeeded` (no swap).
3. Else if wallet already holds ≥ `quoteNeeded` of the pair → use balance.
4. Else → swap **only the shortfall** ETH → pair via Uniswap router (`exactInput` / multicall), then approve + `curve.buy`.

Keep enough ETH for: cover swap + `quoteNeeded` (ETH pairs) + `GAS_RESERVE_WEI` (default 0.0001 ETH).

Suggested env caps in `.env` before live:

```bash
MAX_QUOTE_IN=<raw quote units>     # e.g. USDG 6dp: 50000000 = 50 USDG
DAILY_MAX_QUOTE=<raw units/day>
SLIPPAGE_BPS=300
SNIPER_TOKENS=100000
SNIPER_DELAY_MS=0                  # raise (e.g. 2500) to wait out ~99%→decay snipe tax (~3s)
GAS_RESERVE_WEI=100000000000000    # 0.0001 ETH left for gas after cover
SNIPER_LIVE=0                      # keep 0 until operator says go
```

## Phase E — Live entry (operator must approve)

Only when the operator says to go live:

```bash
# In .env:
SNIPER_LIVE=1

# Restart sniper (or npm start)
npm run sniper
npm run watcher   # keep for epochs/claims/pot
npm run dash
```

**Success signals (LIVE):**

- Log: `[snipe] LIVE … tx=0x… detect→gate=… gate→tx=…`
- `actions.kind` = `buy_sent` then position `status=open` (not `dry`)
- Dashboard → Positions: token, entry epoch, bag, cost
- Explorer: sniper address shows curve `buy` tx

If `buy_fail` / `simulate_fail` / `insufficient_quote` / `insufficient_eth`: fix funding or caps; do not disable gates.

## Phase F — After entry (hold)

- Leave sniper+watcher running (or at least watcher) for `EpochPublished` / `Claimed` and pot/holder refresh.
- Dashboard: Published? / Payout? / pot USD / holders.
- Claims: watch-only (`Claimed` to our wallet). No claim executor / no auto-sell in v1.
- Never add sell logic on the happy path.

---

## Commands cheat sheet

| Command | Purpose |
|---------|---------|
| `npm run keys` | Create wallet once |
| `npm run keys -- --show` | Address only |
| `npm run sniper` | Hot path listener + buy |
| `npm run watcher` | Epochs, claims, pot, holders, net worth |
| `npm run dash` | http://127.0.0.1:42100 |
| `npm start` | All three |
| `npm test` | Gate + curve math |
| `npm run smoke` | Live RPC/WSS DRY probe |

## Layout (where to look)

- Hot path: `src/sniper/hotpath.mjs`, `buy.mjs`, `gates.mjs`, `wss.mjs`
- Config: `src/config.mjs`, `.env.example`
- DB: `src/db/schema.sql`
- UI: `src/dash/`

## Secrets checklist before any git push

- [ ] `.env` gitignored and absent from staging
- [ ] `secrets/wallets.json` gitignored and absent from staging
- [ ] `data/*.db*` gitignored
- [ ] `git status` / `git diff --cached` show no private keys or RPC auth tokens
- [ ] Only `.env.example` and `secrets/.gitkeep` for templates

## Out of scope (do not build)

Keeper forecasting, pot top-ups, wash trades, multi-wallet fleets, selling after claim, importing keys from other projects.
