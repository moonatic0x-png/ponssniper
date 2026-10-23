# PONS V2 Launch Sniper + Hold Dashboard

Greenfield Node 22 ESM bot on **Robinhood Chain (4663)**. Listens for new Pons V2 launches, snipes **100k tokens** when holder-sharing is on and buyback is off, **never sells**, and shows holds / payouts / pot on a local dashboard.

Stack: `viem` + built-in `node:sqlite`. Default is **DRY** (`SNIPER_LIVE=0`) — no `sendRawTransaction`.

**Agent / operator runbook (clone → DRY → fund → live entry):** see [AGENTS.md](AGENTS.md).

**Changelog:** [CHANGELOG.md](CHANGELOG.md).

**Secrets:** never commit `.env` or `secrets/wallets.json`. Only `.env.example` and `secrets/.gitkeep` ship in git.

## Gates

Buy only when:

1. `buybackEnabled === false`
2. `creatorFeeRecipient` === the pool’s HolderDistributor (“sharing on”)

Optional: skip cbBTC / WETH quote pairs (`SKIP_INELIGIBLE_QUOTES=1`, default).

## Buy path

Curves use `buy(quoteIn, minTokensOut, to)` (exact-in). We size a fixed token amount (`SNIPER_TOKENS`, default 100000 whole tokens × 10^decimals), compute `quoteIn` from reserves, and guard with `MAX_QUOTE_IN` / `DAILY_MAX_QUOTE` / `SLIPPAGE_BPS`.

**Quote funding:** wallet is ETH-primary. Before each buy, `coverQuote` uses existing pair balance or swaps only the shortfall ETH→`pairToken` through the router (native ETH pairs skip the swap).

**Snipe tax:** on-chain tax starts ~99% (`snipeTaxStartBps`) and decays over ~3s. Default `SNIPER_DELAY_MS=0` for max speed; raise if you want to wait out the tax.

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

# 5. Watcher (epochs / Claimed / pot / holders / net worth) — separate terminal
npm run watcher

# 6. Dashboard http://127.0.0.1:42100
npm run dash

# Or all three:
npm start

# Tests
npm test
```

**Live buys:** set `SNIPER_LIVE=1` in `.env` only when you intend to spend. There is no sell module.

## Hot-path latency

Every attempt logs:

`detect_ts → gate_ts → tx_hash_ts` (as `detect→gate`, `gate→tx`, `detect→tx` ms).

WSS: `RPC_WSS` (default `wss://robinhood.drpc.org`). Writes: official `RPC_HTTP`.

## Scripts

| Script | Role |
|--------|------|
| `npm run keys` | Create `secrets/wallets.json` (0600) once |
| `npm run sniper` | Factory WSS + gates + DRY/LIVE buy |
| `npm run watcher` | Pot, holders, epochs, Claimed, net worth |
| `npm run dash` | Local UI on `:42100` |
| `npm start` | sniper + watcher + dash |
| `npm test` | Gate + curve math unit tests |

## Safety

- Keys only in `secrets/wallets.json` (gitignored). Logs redact `0x`+64 hex.
- No secrets in the dashboard API.
- Claims: watch `Claimed` for our wallet (operator push). No claim executor / no auto-sell.
