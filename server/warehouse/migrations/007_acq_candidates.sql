-- 007_acq_candidates.sql
-- Acquisition Intelligence Engine — candidate parcel and deal-input persistence (Phase 4).
-- ADDITIVE ONLY. No existing table is altered. Governor constants are NOT stored here —
-- they live in capital_config (003) and are loaded at query time via loadGovernors().

-- Source of a candidate: county-parcel-screen workbook batch OR Notion pipeline pull.
CREATE TABLE IF NOT EXISTS acq_candidates (
  id              TEXT    PRIMARY KEY,          -- stable slug: 'parcel:<state>:<county>:<apn>' OR 'deal:<notion-id>'
  source          TEXT    NOT NULL,             -- 'parcel-screen' | 'notion-pipeline' | 'hubspot-pipeline' | 'manual'
  source_batch_id TEXT    REFERENCES acq_source_batches(id),  -- links to acq_source_batches.id
  address         TEXT,
  county          TEXT,
  state           TEXT,
  market          TEXT,                         -- ORA cluster label (owned-submarket | established | entry | satellite | none)
  rentable_sf     REAL,
  year_built      INTEGER,
  owner_name      TEXT,
  parcel_screen_score INTEGER,                  -- raw 0-100 from county-parcel-screen skill (motivation screen)
  status          TEXT    NOT NULL DEFAULT 'active',   -- 'active' | 'archived' | 'acquired' | 'passed'
  notion_deal_id  TEXT,                         -- Notion page ID if synced from pipeline
  acquired_property_id TEXT,                   -- FK to property_master(id) when status = 'acquired' (Step 8 hook)
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_acqcand_market   ON acq_candidates(market, status);
CREATE INDEX IF NOT EXISTS idx_acqcand_source   ON acq_candidates(source, source_batch_id);
CREATE INDEX IF NOT EXISTS idx_acqcand_notion   ON acq_candidates(notion_deal_id);

-- Tracks each import batch (parcel-screen workbook upload or Notion pull).
CREATE TABLE IF NOT EXISTS acq_source_batches (
  id              TEXT    PRIMARY KEY,          -- 'parcel-screen:<state>:<county>:<YYYY-MM-DD>' | 'notion:<YYYY-MM-DDTHH:mm:ssZ>'
  source          TEXT    NOT NULL,
  label           TEXT,                         -- human-readable: "Franklin County OH — 2026-06-20"
  imported_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  candidate_count INTEGER NOT NULL DEFAULT 0,
  notes           TEXT
);

-- Persists each scored AcquisitionInput snapshot — one row per (candidate, scoring_event).
-- The inputs_version field IS the dedup key for calibration_verdict correlation.
-- This table is the warehouse-side store of what the Cowork skill / API computed.
CREATE TABLE IF NOT EXISTS acq_score_inputs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id    TEXT    NOT NULL REFERENCES acq_candidates(id),
  inputs_version  TEXT    NOT NULL,             -- sha256 of (input_json, rulesetVersion, rctVersion)[:16]
  input_json      TEXT    NOT NULL,             -- AcquisitionInput JSON snapshot (frozen at scoring time)
  ruleset_version TEXT    NOT NULL DEFAULT '1.0.0',
  rct_version     TEXT    NOT NULL DEFAULT 'replacement-cost.v1',
  scored_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  scored_by       TEXT    NOT NULL DEFAULT 'engine',   -- 'engine' | 'cowork-skill' | 'api'
  UNIQUE(candidate_id, inputs_version)          -- idempotent re-score on same inputs is a no-op
);
CREATE INDEX IF NOT EXISTS idx_acqinput_candidate ON acq_score_inputs(candidate_id);
CREATE INDEX IF NOT EXISTS idx_acqinput_version   ON acq_score_inputs(inputs_version);

-- Persists each AcquisitionScore result — one row per (inputs snapshot).
-- The composite / tier / verdict columns are denormalized for fast ranked queries; the
-- full score_json is the authoritative re-playable result. Never mutated after insert.
CREATE TABLE IF NOT EXISTS acq_scores (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id    TEXT    NOT NULL REFERENCES acq_candidates(id),
  score_input_id  INTEGER NOT NULL REFERENCES acq_score_inputs(id),
  inputs_version  TEXT    NOT NULL,
  composite       REAL    NOT NULL,             -- 0-100
  tier            TEXT    NOT NULL,             -- 'T1' | 'T2' | 'PASS' | 'KILLED'
  verdict         TEXT    NOT NULL,             -- 'PURSUE' | 'WATCH' | 'PASS' | 'KILLED'
  advisory_only   INTEGER NOT NULL DEFAULT 1,   -- 1 until ruleset + RCT ratified
  capped_at_t2    INTEGER NOT NULL DEFAULT 0,
  gates_passed    INTEGER NOT NULL DEFAULT 0,
  floors_passed   INTEGER NOT NULL DEFAULT 0,
  floor_indeterminate INTEGER NOT NULL DEFAULT 0,
  governor_dscr_cleared INTEGER,               -- 1 = cleared / 0 = failed / NULL = not evaluated
  governor_ltv_cleared  INTEGER,               -- 1 = cleared / 0 = failed / NULL = not evaluated
  score_json      TEXT    NOT NULL,             -- full AcquisitionScore JSON (authoritative)
  calibration_verdict_id INTEGER REFERENCES calibration_verdict(id),  -- FK to calibration_verdict once logged
  scored_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(score_input_id)                        -- one score row per input snapshot
);
CREATE INDEX IF NOT EXISTS idx_acqscores_cand    ON acq_scores(candidate_id);
CREATE INDEX IF NOT EXISTS idx_acqscores_verdict ON acq_scores(verdict, composite DESC);
CREATE INDEX IF NOT EXISTS idx_acqscores_tier    ON acq_scores(tier);
CREATE INDEX IF NOT EXISTS idx_acqscores_scored  ON acq_scores(candidate_id, scored_at DESC);
