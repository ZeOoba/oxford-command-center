-- 011_lease_events.sql — Phase 3 leasing-velocity event log (Spine B).
-- A lease lifecycle event per (property, suite): vacate / commence. Enables days-vacant→leased.
CREATE TABLE IF NOT EXISTS lease_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id   TEXT NOT NULL,
  suite         TEXT,                 -- null = single-tenant
  tenant        TEXT,
  event_kind    TEXT NOT NULL CHECK (event_kind IN ('vacate','commence')),
  event_date    TEXT NOT NULL,        -- ISO YYYY-MM-DD
  source_file   TEXT,                 -- provenance
  abstract_date TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_lease_events_property ON lease_events (property_id, event_date);
