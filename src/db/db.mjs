import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.mjs";

const SCHEMA = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "schema.sql"),
  "utf8",
);

let _db;

function migratePositions(_db) {
  const cols = _db.prepare(`PRAGMA table_info(positions)`).all();
  if (!cols.some((c) => c.name === "strategy")) {
    _db.exec(
      `ALTER TABLE positions ADD COLUMN strategy TEXT NOT NULL DEFAULT 'snipe'`,
    );
  }
}

export function openDb(path = config.dbPath) {
  if (_db) return _db;
  mkdirSync(dirname(path), { recursive: true });
  _db = new DatabaseSync(path);
  _db.exec("PRAGMA journal_mode = WAL;");
  _db.exec("PRAGMA synchronous = NORMAL;");
  _db.exec(SCHEMA);
  migratePositions(_db);
  return _db;
}

export function db() {
  return openDb();
}

const now = () => Date.now();

export function upsertPool(row) {
  db()
    .prepare(
      `INSERT INTO pools(token, curve, distributor, pair, symbol, decimals, buyback, tax_bps, launch_block, launch_tx, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(token) DO UPDATE SET
         curve=excluded.curve,
         distributor=COALESCE(excluded.distributor, pools.distributor),
         pair=COALESCE(excluded.pair, pools.pair),
         symbol=COALESCE(excluded.symbol, pools.symbol),
         decimals=COALESCE(excluded.decimals, pools.decimals),
         buyback=COALESCE(excluded.buyback, pools.buyback),
         tax_bps=COALESCE(excluded.tax_bps, pools.tax_bps),
         launch_block=COALESCE(excluded.launch_block, pools.launch_block),
         launch_tx=COALESCE(excluded.launch_tx, pools.launch_tx)`,
    )
    .run(
      row.token,
      row.curve,
      row.distributor ?? null,
      row.pair ?? null,
      row.symbol ?? null,
      row.decimals ?? null,
      row.buyback == null ? null : row.buyback ? 1 : 0,
      row.tax_bps ?? null,
      row.launch_block ?? null,
      row.launch_tx ?? null,
      row.created_at ?? now(),
    );
}

export function upsertPosition(row) {
  db()
    .prepare(
      `INSERT INTO positions(token, entry_block, entry_epoch, tokens, quote_in, cost_usd, buy_tx, status, strategy, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(token) DO UPDATE SET
         entry_block=COALESCE(excluded.entry_block, positions.entry_block),
         entry_epoch=COALESCE(excluded.entry_epoch, positions.entry_epoch),
         tokens=excluded.tokens,
         quote_in=excluded.quote_in,
         cost_usd=COALESCE(excluded.cost_usd, positions.cost_usd),
         buy_tx=COALESCE(excluded.buy_tx, positions.buy_tx),
         status=excluded.status,
         strategy=COALESCE(excluded.strategy, positions.strategy)`,
    )
    .run(
      row.token,
      row.entry_block ?? null,
      row.entry_epoch ?? null,
      String(row.tokens),
      String(row.quote_in),
      row.cost_usd ?? null,
      row.buy_tx ?? null,
      row.status ?? "open",
      row.strategy ?? "snipe",
      row.created_at ?? now(),
    );
}

export function insertAction({ kind, token, detail, latency_ms }) {
  db()
    .prepare(
      `INSERT INTO actions(kind, token, detail, latency_ms, created_at) VALUES(?,?,?,?,?)`,
    )
    .run(kind, token ?? null, detail ?? null, latency_ms ?? null, now());
}

export function upsertEpoch(row) {
  db()
    .prepare(
      `INSERT INTO epochs(token, epoch_id, quote_total, coin_total, published_at, tx)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(token, epoch_id) DO UPDATE SET
         quote_total=excluded.quote_total,
         coin_total=excluded.coin_total,
         published_at=COALESCE(excluded.published_at, epochs.published_at),
         tx=COALESCE(excluded.tx, epochs.tx)`,
    )
    .run(
      row.token,
      row.epoch_id,
      row.quote_total != null ? String(row.quote_total) : null,
      row.coin_total != null ? String(row.coin_total) : null,
      row.published_at ?? null,
      row.tx ?? null,
    );
}

export function insertClaim(row) {
  db()
    .prepare(
      `INSERT INTO claims(token, epoch_id, quote_amount, coin_amount, tx, usd, created_at)
       VALUES(?,?,?,?,?,?,?)`,
    )
    .run(
      row.token,
      row.epoch_id,
      String(row.quote_amount),
      row.coin_amount != null ? String(row.coin_amount) : null,
      row.tx ?? null,
      row.usd ?? null,
      row.created_at ?? now(),
    );
}

export function upsertPoolStats(row) {
  db()
    .prepare(
      `INSERT INTO pool_stats(token, unallocated_quote, epoch_count, holder_count, pot_usd, phase, bag_mark_quote, bag_mark_usd, refreshed_at)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(token) DO UPDATE SET
         unallocated_quote=COALESCE(excluded.unallocated_quote, pool_stats.unallocated_quote),
         epoch_count=COALESCE(excluded.epoch_count, pool_stats.epoch_count),
         holder_count=COALESCE(excluded.holder_count, pool_stats.holder_count),
         pot_usd=COALESCE(excluded.pot_usd, pool_stats.pot_usd),
         phase=COALESCE(excluded.phase, pool_stats.phase),
         bag_mark_quote=COALESCE(excluded.bag_mark_quote, pool_stats.bag_mark_quote),
         bag_mark_usd=COALESCE(excluded.bag_mark_usd, pool_stats.bag_mark_usd),
         refreshed_at=excluded.refreshed_at`,
    )
    .run(
      row.token,
      row.unallocated_quote != null ? String(row.unallocated_quote) : null,
      row.epoch_count ?? null,
      row.holder_count ?? null,
      row.pot_usd ?? null,
      row.phase ?? null,
      row.bag_mark_quote != null ? String(row.bag_mark_quote) : null,
      row.bag_mark_usd ?? null,
      row.refreshed_at ?? now(),
    );
}

export function insertSnapshot(row) {
  db()
    .prepare(
      `INSERT INTO balances_snapshot(eth_wei, quotes_json, bags_json, claims_usd, total_usd, created_at)
       VALUES(?,?,?,?,?,?)`,
    )
    .run(
      row.eth_wei != null ? String(row.eth_wei) : null,
      row.quotes_json ?? null,
      row.bags_json ?? null,
      row.claims_usd ?? null,
      row.total_usd ?? null,
      row.created_at ?? now(),
    );
}

export function setCursor(name, value) {
  db()
    .prepare(
      `INSERT INTO scanner_cursor(name, value, updated_at) VALUES(?,?,?)
       ON CONFLICT(name) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    )
    .run(name, String(value), now());
}

export function getCursor(name) {
  const r = db()
    .prepare(`SELECT value FROM scanner_cursor WHERE name=?`)
    .get(name);
  return r?.value ?? null;
}

export function hasPosition(token) {
  const r = db()
    .prepare(`SELECT 1 AS ok FROM positions WHERE token=?`)
    .get(token);
  return !!r;
}

export function knownPositionTokens() {
  return db()
    .prepare(`SELECT token FROM positions`)
    .all()
    .map((r) => r.token);
}

export function sumDailyQuoteSpend(sinceMs) {
  const rows = db()
    .prepare(
      `SELECT quote_in FROM positions WHERE created_at >= ? AND status != 'dry'`,
    )
    .all(sinceMs);
  let s = 0n;
  for (const r of rows) {
    try {
      s += BigInt(r.quote_in);
    } catch {
      /* ignore */
    }
  }
  return s;
}

/** Open + dry follow positions (idempotency / FOLLOW_MAX_OPEN). */
export function countOpenFollows() {
  const r = db()
    .prepare(
      `SELECT COUNT(*) AS n FROM positions
       WHERE strategy = 'follow' AND status IN ('open','dry')`,
    )
    .get();
  return Number(r?.n ?? 0);
}

/** Sum cost_usd for follow positions created since `sinceMs` (incl. dry). */
export function sumDailyFollowUsd(sinceMs) {
  const r = db()
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS u FROM positions
       WHERE strategy = 'follow' AND created_at >= ?`,
    )
    .get(sinceMs);
  return Number(r?.u ?? 0);
}

export function getState() {
  const positions = db()
    .prepare(
      `SELECT p.*, pl.symbol, pl.curve, pl.distributor, pl.pair, pl.decimals,
              s.epoch_count AS current_epoch, s.unallocated_quote, s.holder_count,
              s.pot_usd, s.phase, s.bag_mark_quote, s.bag_mark_usd, s.refreshed_at
       FROM positions p
       JOIN pools pl ON pl.token = p.token
       LEFT JOIN pool_stats s ON s.token = p.token
       ORDER BY p.created_at DESC`,
    )
    .all();

  const claimsByToken = {};
  for (const c of db()
    .prepare(
      `SELECT token, SUM(CAST(quote_amount AS REAL)) AS q, SUM(COALESCE(usd,0)) AS usd, COUNT(*) AS n
       FROM claims GROUP BY token`,
    )
    .all()) {
    claimsByToken[c.token] = c;
  }

  const actions = db()
    .prepare(
      `SELECT id, kind, token, detail, latency_ms, created_at FROM actions
       ORDER BY id DESC LIMIT 80`,
    )
    .all();

  const snap = db()
    .prepare(
      `SELECT * FROM balances_snapshot ORDER BY id DESC LIMIT 1`,
    )
    .get();

  const claimsTotalUsd =
    db()
      .prepare(`SELECT COALESCE(SUM(usd),0) AS u FROM claims`)
      .get()?.u ?? 0;

  return {
    positions: positions.map((p) => {
      const cl = claimsByToken[p.token];
      const published =
        (p.current_epoch != null &&
          p.entry_epoch != null &&
          Number(p.current_epoch) > Number(p.entry_epoch)) ||
        Number(p.current_epoch || 0) > 0;
      return {
        ...p,
        published: !!published,
        payout: !!(cl && cl.n > 0),
        claim_count: cl?.n ?? 0,
        claim_quote: cl?.q ?? 0,
        claim_usd: cl?.usd ?? 0,
      };
    }),
    actions,
    snapshot: snap ?? null,
    claims_total_usd: claimsTotalUsd,
    held_pools: positions.map((p) => ({
      token: p.token,
      symbol: p.symbol,
      pot_usd: p.pot_usd,
      holder_count: p.holder_count,
      phase: p.phase,
      unallocated_quote: p.unallocated_quote,
      refreshed_at: p.refreshed_at,
    })),
  };
}
