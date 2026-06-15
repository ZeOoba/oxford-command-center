-- 004_occupancy.sql
-- PFI Phase 1 — Occupancy time-series.
--
-- Stores per-property occupancy snapshots sourced from the workbook PortfolioSnapshot
-- (Property.occPct). Each row = one snapshot at one point in time. Multiple snapshots
-- accumulate an occupancy time-series per property for trend analysis.
--
-- Source discipline: occPct is workbook-sourced (rent-roll derived), NOT P&L derived.
-- The warehouse P&L pipeline (import_batches / ledger_entries) is income-statement only;
-- occupancy comes from a separate data path. These two streams are intentionally separate.

CREATE TABLE IF NOT EXISTS property_occupancy (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id   TEXT    NOT NULL REFERENCES property_master(id) ON DELETE CASCADE,
  as_of         TEXT    NOT NULL,   -- ISO date (YYYY-MM-DD) of the snapshot
  occ_pct       REAL    NOT NULL    CHECK (occ_pct >= 0 AND occ_pct <= 1),
  source        TEXT    NOT NULL DEFAULT 'workbook',  -- 'workbook' | 'rent-roll' | 'manual'
  recorded_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (property_id, as_of, source)               -- one snapshot per (property, date, source)
);

CREATE INDEX IF NOT EXISTS idx_property_occupancy_property
  ON property_occupancy(property_id, as_of);
