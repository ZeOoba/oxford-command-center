-- 022_insurance_loss_events.sql
-- Insurance loss-run history — Design Parity P4 (insurance analysis / TIV framework).
-- Framework table per Direction 3 pattern (012_prospect_demand.sql): ships EMPTY. It is
-- populated once broker loss runs arrive; until then the schema just exists so the
-- insurance-analysis engine has a stable table to query against.
--
-- Additive only. insurance_loss_events is a new table; the two ALTERs on
-- property_insurance_policies are nullable, additive columns (deductible, coverage_limit) —
-- no existing row's data changes and no NOT NULL is introduced.
-- NEVER modify this file after it has been applied to production.

CREATE TABLE IF NOT EXISTS insurance_loss_events (
  id              TEXT PRIMARY KEY,
  property_id     TEXT REFERENCES property_master(id),
  policy_ref      TEXT,
  loss_date       TEXT NOT NULL,
  cause           TEXT,
  gross_incurred  REAL CHECK (gross_incurred IS NULL OR gross_incurred >= 0),
  paid            REAL,
  reserve         REAL,
  source          TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(property_id, loss_date, cause, gross_incurred)
);

CREATE INDEX IF NOT EXISTS idx_loss_events_property ON insurance_loss_events(property_id);

ALTER TABLE property_insurance_policies ADD COLUMN deductible REAL;
ALTER TABLE property_insurance_policies ADD COLUMN coverage_limit REAL;
