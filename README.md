# PONS V2 Launch Sniper + Farmer-Follow + Hold Dashboard

Greenfield Node 22 ESM bot on **Robinhood Chain (4663)**. Two entry strategies, one wallet, **never sells**:

1. **Launch sniper** — new `TokenLaunched` → snipe **100k tokens** when sharing on / buyback off.
2. **Farmer-follow (piggyback)** — watch known fee-farmers receive tokens, buy ≈ **$0.80** into the same curve pool, wait for their harvest → operator publish → `Claimed`.

Stack: `viem` + built-in `node:sqlite`. Defaults are **DRY** (`SNIPER_LIVE=0`, `FOLLOW_LIVE=0`) — no `sendRawTransaction`.

**Agent / operator runbook (clone → DRY → fund → live entry):** see [AGENTS.md](AGENTS.md).

**Changelog:** [CHANGELOG.md](CHANGELOG.md).

**Secrets:** never commit `.env` or `secrets/wallets.json`. Only `.env.example` and `secrets/.gitkeep` ship in git. Do not import keys from other repos.

## Gates

**Launch sniper** buys only when:

1. `buybackEnabled === false`
2. `creatorFeeRecipient` === the pool’s HolderDistributor (“sharing on”)

**Farmer-follow** keeps those gates, plus: curve not graduated, farmer holds a non-dust bag, we have no position yet, `FOLLOW_MAX_OPEN` / `FOLLOW_DAILY_USD`. No `$2` net-floor / trigger / wash cost (farmer harvests).

Optional: skip cbBTC / WETH quote pairs (`SKIP_INELIGIBLE_QUOTES=1`, default).

## Buy path

Curves use `buy(quoteIn, minTokensOut, to)` (exact-in).

- **Sniper:** fixed token amount (`SNIPER_TOKENS`, default 100000) → `quoteIn` from reserves; `MAX_QUOTE_IN` / `DAILY_MAX_QUOTE` / `SLIPPAGE_BPS`.
- **Follow:** USD notional (`FOLLOW_BUY_USD=0.8`) → quote units → tokens from curve math.

**Quote funding:** wallet is ETH-primary. Before each buy, `coverQuote` uses existing pair balance or swaps only the shortfall ETH→`pairToken` through the router (native ETH pairs skip the swap).

**Snipe tax:** on-chain tax starts ~99% and decays over ~3s. Default `SNIPER_DELAY_MS=3000` for launches; follow defaults `FOLLOW_DELAY_MS=0` (dormant pots).

## Holder count (dashboard)

Non-dust ERC20 holders: walk `Transfer` logs from launch (or recent window), unique addresses, `balanceOf > HOLDER_DUST`, excluding system contracts (factory, hook, locker, dead, etc.).

## Run order

```bash
# 1. Install
npm install

# 2. Env
cp .env.example .env

# 3. Create sniper key once (refuses overwrite; --show prints address only)
npm run keys
# fund the printed address (ETH and/or USDG) before going live

# 4. DRY sniper (WSS listener + would-be buys)
npm run sniper

# 4b. DRY farmer-follow (Transfer→farmer + would-buy ~$0.80) — optional terminal
npm run follow

# 5. Watcher (epochs / Claimed / pot / holders / net worth) — separate terminal
npm run watcher

# 6. Dashboard http://127.0.0.1:42100
npm run dash

# Or sniper + watcher + dash (follow is separate):
npm start

# Tests
npm test
```

**Live buys:** set `SNIPER_LIVE=1` and/or `FOLLOW_LIVE=1` only when you intend to spend. Flags are independent. There is no sell module. Avoid running both LIVE on the same wallet at once (nonce races).

## Hot-path latency

Every attempt logs:

`detect_ts → gate_ts → tx_hash_ts` (as `detect→gate`, `gate→tx`, `detect→tx` ms).

WSS: `RPC_WSS` (default `wss://robinhood.drpc.org`). Writes: official `RPC_HTTP`.

## Scripts

| Script | Role |
|--------|------|
| `npm run keys` | Create `secrets/wallets.json` (0600) once |
| `npm run sniper` | Factory WSS + gates + DRY/LIVE buy |
| `npm run follow` | Farmer Transfer watch + ~$0.80 DRY/LIVE buy |
| `npm run watcher` | Pot, holders, epochs, Claimed, net worth |
| `npm run dash` | Local UI on `:42100` (strategy column on positions) |
| `npm run observe` | Read-only: track `READ_ADDRESS` + dash (no key) |
| `npm start` | sniper + watcher + dash (or observe+dash if `READ_ADDRESS`) |
| `npm test` | Gate + curve math + follow gate unit tests |

**Remote dash:** set `READ_ADDRESS=0x…` in `.env` (safe to share with the sniper machine), then on the dash box run `npm run observe`. Sniper machine keeps using `npm run sniper` / `npm start` with its local key.

## Safety

- Keys only in `secrets/wallets.json` (gitignored). Logs redact `0x`+64 hex.
- No secrets in the dashboard API.
- Claims: watch `Claimed` for our wallet (operator push). No claim executor / no auto-sell.
