-- 010_debt_scores.sql
-- Persisted debt-score output for trend tracking. Written by the scoring engine (Phase 2
-- Step 4) after each scoreDebtPositions() run. Empty on initial migration — schema only.
CREATE TABLE IF NOT EXISTS debt_scores (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id            TEXT NOT NULL REFERENCES property_master(id),
  scored_at              TEXT NOT NULL,
  snapshot_date          TEXT NOT NULL,
  noi_period             TEXT NOT NULL,
  dscr                   REAL,
  dscr_headroom          REAL,
  ltv                    REAL,
  ltv_headroom           REAL,
  debt_yield             REAL,
  signal                 TEXT NOT NULL,
  signal_reason          TEXT,
  refi_trigger_bps       INTEGER NOT NULL,
  capital_config_version INTEGER NOT NULL,
  score                  REAL NOT NULL CHECK (score >= 0 AND score <= 100),
  score_band             TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_debt_scores_property ON debt_scores(property_id, scored_at);
