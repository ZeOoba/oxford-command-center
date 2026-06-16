-- 003_capital_config.sql
-- PFI Phase 1 — Capital governance encoding + calibration audit trail.
--
-- capital_config: append-only version history of the ratified financial governors.
--   Every row IS a ratified parameter set. The latest row (ORDER BY version DESC) is live.
-- calibration_log: audit trail for any parameter change to capital_config or INTEL_CONFIG;
--   written by appendCalibrationLog() whenever a governance constant is changed.
--
-- HARD INVARIANTS per CLAUDE.md §4: dscr_floor ≥ 1.25, ltv_ceiling ≤ 0.40.
-- Never modify these values without Gabriel ratification + a new capital_config row.

CREATE TABLE IF NOT EXISTS capital_config (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  version               INTEGER NOT NULL UNIQUE,
  effective_from        TEXT    NOT NULL,   -- ISO date (YYYY-MM-DD) the set was ratified
  dscr_floor            REAL    NOT NULL CHECK (dscr_floor >= 1.25),   -- acquisition governor: DSCR must be ≥ this
  ltv_ceiling           REAL    NOT NULL CHECK (ltv_ceiling <= 0.40),  -- acquisition governor: LTV must be ≤ this
  disposition_cap_rate  REAL    NOT NULL,   -- cap rate below which disposition signal fires
  hold_cap_rate         REAL    NOT NULL,   -- cap rate at or above which hold zone begins
  acq_irr               REAL    NOT NULL,   -- unlevered IRR target for new acquisitions
  capex_irr             REAL    NOT NULL,   -- yield-on-cost floor for capital expenditure approval
  refi_trigger_bps      INTEGER NOT NULL,   -- bps above in-place rate that flags refi candidacy
  payout_pct            REAL    NOT NULL,   -- distribution payout rate (0.0 = full reinvest)
  notes                 TEXT,
  created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Version 1: ratified 2026-06-13 (Gabriel confirmed "full reinvest").
-- Governor set: DISPOSITION <6.5% | HOLD 6.5–7.5% | ACQ-IRR ≥12% | CAPEX-IRR ≥15%
INSERT INTO capital_config
  (version, effective_from, dscr_floor, ltv_ceiling,
   disposition_cap_rate, hold_cap_rate, acq_irr, capex_irr,
   refi_trigger_bps, payout_pct, notes)
VALUES
  (1, '2026-06-13', 1.25, 0.40, 0.065, 0.075, 0.12, 0.15, 150, 0.0,
   'Ratified 2026-06-13. Full-reinvest payout confirmed by Gabriel.')
ON CONFLICT(version) DO NOTHING;

CREATE TABLE IF NOT EXISTS calibration_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  logged_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  config_table  TEXT    NOT NULL,   -- 'capital_config' | 'intel_config'
  param_key     TEXT    NOT NULL,   -- e.g. 'dscr_floor', 'healthWeights.noiGrowth'
  old_value     TEXT,               -- JSON-encoded prior value (null = first-set)
  new_value     TEXT    NOT NULL,   -- JSON-encoded new value
  rationale     TEXT,               -- why this parameter changed
  session_id    TEXT                -- Claude Code session ID for traceability
);
