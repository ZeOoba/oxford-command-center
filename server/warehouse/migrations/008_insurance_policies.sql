-- 008_insurance_policies.sql
-- Insurance policy persistence layer — Phase 5 G foundation.
-- Additive only. No existing table is altered. No governor constants stored here.
-- Source: PortfolioSnapshot.insurance (workbook "Insurance Renewals" tab, ~24 active policies).

CREATE TABLE IF NOT EXISTS property_insurance_policies (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id      TEXT    NOT NULL,
  insurer          TEXT    NOT NULL,
  policy_number    TEXT,
  effective_date   TEXT,
  expiration_date  TEXT,
  premium_annual   REAL,
  coverage_tiv     REAL,
  policy_type      TEXT    NOT NULL,
  source           TEXT    NOT NULL,
  source_date      TEXT    NOT NULL,
  ingested_by      TEXT    NOT NULL,
  ingested_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(property_id, policy_number, effective_date)
);

CREATE INDEX IF NOT EXISTS idx_ins_property ON property_insurance_policies(property_id);
CREATE INDEX IF NOT EXISTS idx_ins_expiry   ON property_insurance_policies(expiration_date);
