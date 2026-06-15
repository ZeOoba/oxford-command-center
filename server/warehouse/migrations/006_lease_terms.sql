-- 006_lease_terms.sql
-- PFI Lease-Run Pro Forma — forward lease-cashflow source data.
-- Spec: docs/superpowers/specs/2026-06-14-pfi-lease-run-proforma-feature.md (Data model & provenance).
--
-- One row per tenant-lease (single-tenant today; the schema admits multi-tenant via
-- property_id + suite). property_id FKs the 14-unit master (foreign_keys=ON), so the seed
-- (seedLeaseTerms in server/warehouse/lease-terms.ts) must run AFTER seedPropertyMaster.
-- Additive only — no existing table is altered. Nothing here is a governor.
--
-- The rent schedule / renewal options / diligence notes / provenance are stored as JSON TEXT
-- (read back through the LeaseTerm Zod contract, fail-closed on bad JSON). The status field
-- inside rent_schedule drives whether a period is hard data or a flagged assumption.

CREATE TABLE IF NOT EXISTS lease_terms (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id      TEXT    NOT NULL REFERENCES property_master(id),
  -- suite is NULL for single-tenant; suite_key is the generated NOT-NULL collapse of suite
  -- ('' when null) so the (property_id, suite_key) uniqueness works under SQLite NULL semantics
  -- (NULLs are distinct in a UNIQUE index, which would let duplicate single-tenant rows through).
  suite            TEXT,
  suite_key        TEXT    NOT NULL GENERATED ALWAYS AS (COALESCE(suite, '')) VIRTUAL,
  tenant           TEXT    NOT NULL,
  rentable_sf      REAL    NOT NULL,                 -- the LEASE rentable SF (authoritative for the
                                                     -- engine; may differ from the rounded master sf)
  structure        TEXT    NOT NULL,                 -- 'absolute_nnn'|'nnn'|'modified_gross'|'gross'
  commencement     TEXT    NOT NULL,                 -- ISO date
  current_expiry   TEXT    NOT NULL,                 -- ISO date
  rent_schedule    TEXT    NOT NULL,                 -- JSON: ordered RentScheduleEntry[]
  renewal_options  TEXT    NOT NULL DEFAULT '[]',    -- JSON: RenewalOption[]
  diligence_notes  TEXT    NOT NULL DEFAULT '[]',    -- JSON: string[]
  provenance       TEXT,                             -- JSON: LeaseProvenance | null
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- One lease row per (property, suite). suite_key makes single-tenant rows (suite NULL) dedup
-- correctly, so a re-seed UPSERTs in place rather than inserting a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_lease_terms_property_suite
  ON lease_terms (property_id, suite_key);
CREATE INDEX IF NOT EXISTS idx_lease_terms_property ON lease_terms (property_id);
