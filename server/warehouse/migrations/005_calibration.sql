-- 005_calibration.sql
-- Score-vs-Outcome Calibration Log — Phase 1 scaffold (the 40-year feedback loop).
-- Spec: docs/superpowers/specs/2026-06-13-calibration-log-design.md (§1).
--
-- Persists every warehouse verdict (health-band / attention / capital-action / anomaly)
-- at the moment it is made, freezing the exact ledger+config state that produced it
-- (calibration_inputs_version). Outcomes attach later via a SEPARATE row so the prediction
-- stays immutable. Append-only by design: a verdict row is never UPDATEd or DELETEd; a
-- superseded resolution flips is_resolution=0 and a new is_resolution=1 row is inserted
-- (partial unique index enforces "at most one live resolution"). Additive only — no existing
-- table is altered. Nothing here is a governor.
--
-- SPEC/CODE DRIFT: the design names the verdict table `calibration_log`, but migration
-- 003_capital_config.sql already owns `calibration_log` as a parameter-change AUDIT trail (a
-- different concept). To avoid the collision the verdict table here is `calibration_verdict`;
-- `calibration_inputs_version` and `calibration_outcome` keep their spec names (no collision).

-- ── inputs_version: the reproducibility key (§1.1) ────────────────────────────────────────
-- A content hash over (active-ledger fingerprint | canonical INTEL_CONFIG | code_version).
-- config_json is stored verbatim so a 2046 analyst can read the literal 2026 weights without
-- git archaeology. A weight change forks config_hash → forks inputs_version, cleanly
-- partitioning verdicts by weight regime.
CREATE TABLE IF NOT EXISTS calibration_inputs_version (
  inputs_version     TEXT    PRIMARY KEY,              -- sha256(...)[:16]
  ledger_fingerprint TEXT    NOT NULL,                 -- max(import_id)|count|max(rowid) of active rows
  config_hash        TEXT    NOT NULL,                 -- sha256 of canonical INTEL_CONFIG JSON
  code_version       TEXT    NOT NULL,                 -- git short sha or 'dev'
  config_json        TEXT    NOT NULL,                 -- the FULL INTEL_CONFIG snapshot, verbatim
  created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ── calibration_verdict: the verdict (prediction) row (§1.2; spec's `calibration_log`) ──────
-- The dedup_key UNIQUE constraint makes logging deterministic + idempotent: re-running the
-- same snapshot against the same inputs_version yields the same key → INSERT OR IGNORE no-ops.
CREATE TABLE IF NOT EXISTS calibration_verdict (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,

  -- WHO/WHAT was judged
  subject_kind    TEXT    NOT NULL,                    -- 'property'|'tenant'|'loan'|'deal'|'portfolio'|'pm'
  subject_id      TEXT    NOT NULL,                    -- property_master.id, tenant id, 'PORTFOLIO', pm name, ...

  -- WHAT KIND of verdict
  verdict_kind    TEXT    NOT NULL,                    -- §2.1 enum
  -- Sub-identity WITHIN a verdict_kind. Empty '' for the singleton scores kinds (health-band /
  -- attention / capital-action — one per subject/period). For anomalies it is the anomaly `kind`
  -- (noi-decline | expense-growth | category-spike | …): a property/period can carry SEVERAL
  -- distinct anomalies that all share verdict_kind='anomaly', so without this discriminator they
  -- collapse to one dedup_key and all but the first are dropped (D3). NOT NULL DEFAULT '' so the
  -- column is additive and the singleton kinds need no special handling.
  verdict_subkind TEXT    NOT NULL DEFAULT '',
  verdict_engine  TEXT    NOT NULL,                    -- 'scores'|'anomalies'|'benchmarks'|...

  -- THE PREDICTION
  predicted_band  TEXT,                                -- categorical verdict (null if purely numeric)
  predicted_value REAL,                                -- numeric prediction (null if purely categorical)
  predicted_unit  TEXT,                                -- 'score-0-100'|'pct-change'|'usd'|'usd-per-sf'|'band'
  confidence      REAL,                                -- 0..1 deterministic proxy (§2.3); null when none
  direction       TEXT,                                -- 'up'|'down'|'flat'|'n/a'
  reasons_json    TEXT    NOT NULL DEFAULT '[]',       -- the reasons[] array verbatim

  -- WHEN / REPRODUCIBILITY
  as_of_period    TEXT    NOT NULL,                    -- metrics period the verdict was computed ON
  horizon_periods INTEGER,                             -- intended eval horizon in periods; null = open-ended
  inputs_version  TEXT    NOT NULL REFERENCES calibration_inputs_version(inputs_version),
  emitted_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  emitted_by      TEXT    NOT NULL,                    -- 'commit:<importId>'|'snapshot:<taskId>'|'recompute'|...

  -- IMMUTABLE DEDUP KEY — one logical verdict per (subject, kind, SUBKIND, as_of, inputs_version)
  dedup_key       TEXT    NOT NULL                     -- subject_kind|subject_id|verdict_kind|verdict_subkind|as_of_period|inputs_version
);

-- Uniqueness carries verdict_subkind explicitly (belt-and-suspenders: dedup_key already embeds it).
-- This is what lets several distinct anomalies for one (subject, period, inputs_version) coexist —
-- they differ only in verdict_subkind, so they map to distinct dedup_keys (D3).
CREATE UNIQUE INDEX IF NOT EXISTS idx_calverdict_dedup ON calibration_verdict(verdict_subkind, dedup_key);
CREATE INDEX IF NOT EXISTS idx_calverdict_subject ON calibration_verdict(subject_kind, subject_id, verdict_kind);
CREATE INDEX IF NOT EXISTS idx_calverdict_asof    ON calibration_verdict(as_of_period, verdict_kind);
CREATE INDEX IF NOT EXISTS idx_calverdict_open    ON calibration_verdict(verdict_kind, as_of_period);

-- ── calibration_outcome: the realized result, back-filled later (§1.3) ────────────────────
-- Separate table so the prediction row stays immutable. One verdict may accrue multiple
-- observations over time; the analyst- or rule-blessed one carries is_resolution=1.
CREATE TABLE IF NOT EXISTS calibration_outcome (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  calibration_id   INTEGER NOT NULL REFERENCES calibration_verdict(id),

  -- WHAT ACTUALLY HAPPENED
  realized_band    TEXT,                               -- same vocabulary as predicted_band
  realized_value   REAL,                               -- same unit as predicted_unit
  realized_unit    TEXT,                               -- echoes predicted_unit; explicit for safety
  outcome_period   TEXT    NOT NULL,                   -- period the realized metric is measured AT
  horizon_actual   INTEGER,                            -- actual periods elapsed prediction→outcome

  -- SCORING THE VERDICT
  hit              INTEGER,                            -- 1 hit / 0 miss / null = not scoreable
  abs_error        REAL,                               -- |realized - predicted| in predicted_unit
  brier_component  REAL,                               -- (confidence - outcome01)^2

  -- TREATMENT EFFECT — was the firm's hand on the scale? (§5)
  action_taken     TEXT    NOT NULL DEFAULT 'unknown', -- 'none'|'acted-aligned'|'acted-counter'|'unknown'
  action_detail    TEXT,                               -- link/text to the action (capex, refi, disposition)
  treatment_note   TEXT,                               -- why this is/isn't a clean test of the verdict

  -- PROVENANCE
  resolved_by      TEXT    NOT NULL,                   -- 'auto:next-period'|'auto:disposition'|'manual:<user>'
  resolution_basis TEXT    NOT NULL,                   -- 'realized-noi-trend'|'actual-disposition'|...
  is_resolution    INTEGER NOT NULL DEFAULT 0,         -- 1 = the blessed scoring observation
  resolved_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  inputs_version   TEXT    REFERENCES calibration_inputs_version(inputs_version)
);

CREATE INDEX IF NOT EXISTS idx_outcome_callog ON calibration_outcome(calibration_id);
-- At most one blessed resolution per verdict (mirrors the supersede pattern in actions.ts).
CREATE UNIQUE INDEX IF NOT EXISTS idx_outcome_resolution
  ON calibration_outcome(calibration_id) WHERE is_resolution = 1;
