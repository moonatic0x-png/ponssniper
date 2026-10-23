CREATE TABLE IF NOT EXISTS pools (
  token TEXT PRIMARY KEY,
  curve TEXT NOT NULL,
  distributor TEXT,
  pair TEXT,
  symbol TEXT,
  decimals INTEGER,
  buyback INTEGER,
  tax_bps INTEGER,
  launch_block INTEGER,
  launch_tx TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
  token TEXT PRIMARY KEY,
  entry_block INTEGER,
  entry_epoch INTEGER,
  tokens TEXT NOT NULL,
  quote_in TEXT NOT NULL,
  cost_usd REAL,
  buy_tx TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  strategy TEXT NOT NULL DEFAULT 'snipe',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (token) REFERENCES pools(token)
);

CREATE TABLE IF NOT EXISTS epochs (
  token TEXT NOT NULL,
  epoch_id INTEGER NOT NULL,
  quote_total TEXT,
  coin_total TEXT,
  published_at INTEGER,
  tx TEXT,
  PRIMARY KEY (token, epoch_id)
);

CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL,
  epoch_id INTEGER NOT NULL,
  quote_amount TEXT NOT NULL,
  coin_amount TEXT,
  tx TEXT,
  usd REAL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  token TEXT,
  detail TEXT,
  latency_ms REAL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS balances_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  eth_wei TEXT,
  quotes_json TEXT,
  bags_json TEXT,
  claims_usd REAL,
  total_usd REAL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scanner_cursor (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pool_stats (
  token TEXT PRIMARY KEY,
  unallocated_quote TEXT,
  epoch_count INTEGER,
  holder_count INTEGER,
  pot_usd REAL,
  phase TEXT,
  bag_mark_quote TEXT,
  bag_mark_usd REAL,
  refreshed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_actions_created ON actions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_claims_token ON claims(token);
