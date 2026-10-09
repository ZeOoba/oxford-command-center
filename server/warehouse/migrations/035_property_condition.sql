-- 035_property_condition.sql
-- Property Condition ledger: PCA reports, consultant component estimates, contractor quotes,
-- install/warranty facts, and the extraction register's open items. Additive only — no existing
-- table is altered. NEVER modify this file after it has been applied to production.
--
-- Source: 2026-10-06_PCA-Extraction_Register_v01_2.xlsx, loaded by scripts/import-pca-register.ts.
-- The register is the interim source of record; the importer REFRESHES these tables wholesale in
-- one transaction (nothing else writes them), so a re-run is idempotent and a corrected register
-- replaces — never duplicates — the prior load.
--
-- property_key is the register's own grain (e.g. 'banwick', 'old-morrison', 'e-fulton'). Several
-- reported buildings are NOT property_master rows (Banwick/Morrison roll up into the Sepich
-- portfolio row; E Fulton is a deal; Muirkirk/St. Michaels/Sheriff are unmapped), so
-- property_master_id is NULLABLE and the importer only fills it when the id exists. A NULL is
-- "unmapped", never a guess.
--
-- Basis discipline: pca_components.basis is CHECKed to 'estimate' — consultant unit costs must never
-- share a benchmark aggregate with capex_quotes (contractor prices). Mixing them is the failure
-- this schema exists to prevent.

CREATE TABLE IF NOT EXISTS pca_reports (
  report_id            TEXT PRIMARY KEY,
  property_key         TEXT NOT NULL,
  property_master_id   TEXT REFERENCES property_master(id),
  property_label       TEXT NOT NULL,
  location             TEXT,
  consultant           TEXT,
  client               TEXT,
  ora_commissioned     INTEGER CHECK (ora_commissioned IS NULL OR ora_commissioned IN (0,1)),
  purpose              TEXT,
  inspection_date      TEXT,
  report_date          TEXT,
  sf                   REAL    CHECK (sf IS NULL OR sf >= 0),
  buildings            INTEGER CHECK (buildings IS NULL OR buildings >= 0),
  year_built           TEXT,
  immediate_usd        REAL    CHECK (immediate_usd IS NULL OR immediate_usd >= 0),
  short_term_usd       REAL    CHECK (short_term_usd IS NULL OR short_term_usd >= 0),
  reserves_uninfl_usd  REAL    CHECK (reserves_uninfl_usd IS NULL OR reserves_uninfl_usd >= 0),
  reserves_infl_usd    REAL    CHECK (reserves_infl_usd IS NULL OR reserves_infl_usd >= 0),
  term_years           INTEGER CHECK (term_years IS NULL OR term_years > 0),
  psf_yr_stated        REAL,
  usability_raw        TEXT,
  usability_class      TEXT NOT NULL CHECK (usability_class IN ('current','draft','limited','stale','unknown')),
  source_files         TEXT,
  notes                TEXT,
  imported_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pca_reports_property ON pca_reports(property_key, report_date);
CREATE INDEX IF NOT EXISTS idx_pca_reports_master ON pca_reports(property_master_id);

CREATE TABLE IF NOT EXISTS pca_components (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id    TEXT    NOT NULL REFERENCES pca_reports(report_id),
  row_seq      INTEGER NOT NULL,
  system       TEXT    NOT NULL,
  qty          REAL,
  uom          TEXT,
  unit_cost    REAL    CHECK (unit_cost IS NULL OR unit_cost >= 0),
  factor       TEXT,
  eul          INTEGER CHECK (eul IS NULL OR eul > 0),
  age          INTEGER CHECK (age IS NULL OR age >= 0),
  rul          INTEGER,
  rul_raw      TEXT,
  total_usd    REAL    CHECK (total_usd IS NULL OR total_usd >= 0),
  timing       TEXT,
  basis        TEXT    NOT NULL CHECK (basis = 'estimate'),
  note         TEXT,
  UNIQUE(report_id, row_seq)
);

CREATE TABLE IF NOT EXISTS capex_quotes (
  quote_key          TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  property_key       TEXT NOT NULL,
  property_master_id TEXT REFERENCES property_master(id),
  property_label     TEXT NOT NULL,
  vendor             TEXT,
  record_type        TEXT,
  status             TEXT,
  trade              TEXT,
  doc_date           TEXT,
  quoted_usd         REAL    CHECK (quoted_usd IS NULL OR quoted_usd >= 0),
  actual_usd         REAL    CHECK (actual_usd IS NULL OR actual_usd >= 0),
  qty                REAL,
  uom                TEXT,
  scope_summary      TEXT,
  source_ref         TEXT,
  confidence         TEXT,
  verified           INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
  funding_class      TEXT,
  lease_recovery     TEXT,
  notes              TEXT
);
CREATE INDEX IF NOT EXISTS idx_capex_quotes_property ON capex_quotes(property_key);

CREATE TABLE IF NOT EXISTS asset_facts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  property_key       TEXT NOT NULL,
  property_master_id TEXT REFERENCES property_master(id),
  property_label     TEXT NOT NULL,
  component          TEXT NOT NULL,
  install_fact       TEXT,
  install_year       INTEGER CHECK (install_year IS NULL OR install_year BETWEEN 1900 AND 2100),
  warranty           TEXT,
  warranty_end_year  INTEGER CHECK (warranty_end_year IS NULL OR warranty_end_year BETWEEN 1900 AND 2100),
  source             TEXT,
  flag               TEXT,
  row_seq            INTEGER NOT NULL,
  UNIQUE(property_key, row_seq)
);
CREATE INDEX IF NOT EXISTS idx_asset_facts_property ON asset_facts(property_key);

-- Curated estimate-vs-executed pairs (the register's Est_vs_Actual sheet). Stored as printed: the
-- pairing of a consultant/budget estimate to a contractor price on the SAME scope is a human judgement
-- the engine cannot re-derive from pca_components + capex_quotes. The delta is computed at read time.
CREATE TABLE IF NOT EXISTS capex_calibration_pairs (
  row_seq            INTEGER PRIMARY KEY,
  property_key       TEXT NOT NULL,
  property_master_id TEXT REFERENCES property_master(id),
  property_label     TEXT NOT NULL,
  scope              TEXT NOT NULL,
  estimate_source    TEXT,
  estimate_usd       REAL CHECK (estimate_usd IS NULL OR estimate_usd >= 0),
  estimate_psf       REAL CHECK (estimate_psf IS NULL OR estimate_psf >= 0),
  contractor_source  TEXT,
  contractor_usd     REAL CHECK (contractor_usd IS NULL OR contractor_usd >= 0),
  contractor_psf     REAL CHECK (contractor_psf IS NULL OR contractor_psf >= 0),
  comment            TEXT
);

CREATE TABLE IF NOT EXISTS pca_open_items (
  item_no       INTEGER PRIMARY KEY,
  severity      TEXT NOT NULL CHECK (severity IN ('High','Med','Low','Info')),
  property_text TEXT,
  issue         TEXT NOT NULL,
  action_needed TEXT
);
