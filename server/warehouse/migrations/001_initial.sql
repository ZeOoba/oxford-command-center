-- 001_initial.sql
-- Full warehouse schema — all 5 tables + indexes.
-- Applied once on first openWarehouse() call via migrate.ts.
-- NEVER modify this file after it has been applied to production.
-- For schema changes: create 002_description.sql instead.

CREATE TABLE IF NOT EXISTS property_master (
  id                TEXT    PRIMARY KEY,
  name              TEXT    NOT NULL,
  market            TEXT,
  address           TEXT,
  property_manager  TEXT,
  pm_contact        TEXT,
  pm_platform       TEXT,
  financial_mode    TEXT    NOT NULL DEFAULT 'pnl',
  rentable_sf       REAL,
  acquisition_date  TEXT,
  ownership_pct     REAL    NOT NULL DEFAULT 1.0,
  ownership_status  TEXT    NOT NULL DEFAULT 'active',
  asset_class       TEXT,
  notes             TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS import_batches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name       TEXT    NOT NULL,
  file_hash       TEXT    NOT NULL UNIQUE,
  raw_path        TEXT    NOT NULL,
  file_source     TEXT    NOT NULL DEFAULT 'folder',
  imported_at     TEXT    NOT NULL,
  imported_by     TEXT,
  property_id     TEXT    REFERENCES property_master(id),
  period_start    TEXT,
  period_end      TEXT,
  period_grain    TEXT,
  basis           TEXT    NOT NULL DEFAULT 'unknown',
  source_system   TEXT    NOT NULL DEFAULT 'unknown',
  version         INTEGER NOT NULL,
  status          TEXT    NOT NULL,
  superseded_by   INTEGER REFERENCES import_batches(id),
  confidence      REAL,
  detect_notes    TEXT
);

CREATE TABLE IF NOT EXISTS account_mappings (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_account_key     TEXT    NOT NULL,
  source_system       TEXT,
  normalized_category TEXT    NOT NULL,
  classification      TEXT    NOT NULL,
  match_kind          TEXT    NOT NULL DEFAULT 'seed',
  property_id         TEXT,
  note                TEXT,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mappings_key
  ON account_mappings(raw_account_key);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id           INTEGER NOT NULL REFERENCES import_batches(id),
  property_id         TEXT    NOT NULL,
  period              TEXT    NOT NULL,
  raw_account         TEXT    NOT NULL,
  gl_code             TEXT,
  amount              REAL    NOT NULL,
  normalized_category TEXT    NOT NULL,
  classification      TEXT    NOT NULL,
  mapping_id          INTEGER,
  is_active           INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_ledger_prop_period
  ON ledger_entries(property_id, period, is_active);

CREATE TABLE IF NOT EXISTS data_quality_issues (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id   INTEGER,
  property_id TEXT,
  kind        TEXT    NOT NULL,
  detail      TEXT    NOT NULL,
  severity    TEXT    NOT NULL DEFAULT 'warn',
  status      TEXT    NOT NULL DEFAULT 'open',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
