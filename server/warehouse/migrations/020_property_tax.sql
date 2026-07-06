-- 020_property_tax.sql
-- Property tax assessment history + appeal tracking — Design Parity P6 (tax module).
-- Additive only. No existing table is altered.
--
-- property_tax_assessments: one row per (property, tax_year) assessment snapshot, sourced
-- from county assessor portals/PDFs (source is free text, e.g. 'county-portal'). Ships via
-- docs/templates/property-tax-assessments.template.csv until an ingest pipeline exists.
--
-- tax_appeals: independent lifecycle of a challenged assessment. Not 1:1 with an assessment
-- row (a property can appeal a tax_year before this year's assessment row is even entered),
-- so it is its own table rather than columns bolted onto property_tax_assessments.
-- NEVER modify this file after it has been applied to production.

CREATE TABLE IF NOT EXISTS property_tax_assessments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id         TEXT    NOT NULL REFERENCES property_master(id),
  tax_year            INTEGER NOT NULL CHECK (tax_year BETWEEN 1990 AND 2100),
  jurisdiction        TEXT,
  assessed_value      REAL    CHECK (assessed_value IS NULL OR assessed_value >= 0),
  assessment_ratio    REAL    CHECK (assessment_ratio IS NULL OR (assessment_ratio > 0 AND assessment_ratio <= 1)),
  millage_rate        REAL    CHECK (millage_rate IS NULL OR millage_rate >= 0),
  annual_tax_billed   REAL    CHECK (annual_tax_billed IS NULL OR annual_tax_billed >= 0),
  source              TEXT    NOT NULL,
  as_of               TEXT,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(property_id, tax_year)
);

CREATE INDEX IF NOT EXISTS idx_tax_assessments_property ON property_tax_assessments(property_id);

CREATE TABLE IF NOT EXISTS tax_appeals (
  id                        TEXT    PRIMARY KEY,
  property_id               TEXT    NOT NULL REFERENCES property_master(id),
  tax_year                  INTEGER NOT NULL,
  status                    TEXT    NOT NULL CHECK (status IN ('draft','filed','hearing','won','lost','withdrawn')),
  filed_date                TEXT,
  est_savings_annual        REAL    CHECK (est_savings_annual IS NULL OR est_savings_annual >= 0),
  realized_savings_annual   REAL,
  notes                     TEXT,
  created_at                TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT
);

CREATE INDEX IF NOT EXISTS idx_tax_appeals_property ON tax_appeals(property_id);
