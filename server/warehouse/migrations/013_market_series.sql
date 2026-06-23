CREATE TABLE IF NOT EXISTS market_series (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cluster TEXT NOT NULL,
  as_of TEXT NOT NULL,
  source TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL,
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  source_detail TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS ix_market_series_cluster_asof ON market_series (cluster, as_of);
