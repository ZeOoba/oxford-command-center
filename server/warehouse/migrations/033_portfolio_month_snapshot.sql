-- 033_portfolio_month_snapshot.sql
-- Portfolio Trends Wave 2 — recorded per-property monthly snapshots.
--
-- One row per (property, month). The CURRENT month is upserted on every workbook refresh
-- (frozen = 0); when a later month's capture arrives, the earlier month is frozen (frozen = 1)
-- and never overwritten again, so each closed month keeps its last observed values.
--
-- Source discipline: values are lease-derived (leased_sf / in_place_rent / lease_count, computed
-- with the same engine as the client reconstruction) and total_sf is Property.sf. occ_pct is the
-- WORKBOOK's own occupancy at capture time, stored separately — the two vacancy bases are never
-- blended. Reconstructed (back-cast) history is NEVER written here: it is biased because leases
-- already off the roll are missing. This table holds only what was observed.
-- Additive only; no existing table is altered.

CREATE TABLE IF NOT EXISTS portfolio_month_snapshot (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id      TEXT    NOT NULL REFERENCES property_master(id) ON DELETE CASCADE,
  month            TEXT    NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  captured_through TEXT    NOT NULL,                 -- ET calendar day of the last capture into this row
  total_sf         REAL    NOT NULL CHECK (total_sf >= 0),
  leased_sf        REAL    NOT NULL CHECK (leased_sf >= 0),
  in_place_rent    REAL    NOT NULL CHECK (in_place_rent >= 0),   -- monthly $
  lease_count      INTEGER NOT NULL CHECK (lease_count >= 0),
  occ_pct          REAL             CHECK (occ_pct IS NULL OR (occ_pct >= 0 AND occ_pct <= 1)),
  frozen           INTEGER NOT NULL DEFAULT 0 CHECK (frozen IN (0, 1)),
  recorded_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (property_id, month)
);

CREATE INDEX IF NOT EXISTS idx_pms_month ON portfolio_month_snapshot(month);
