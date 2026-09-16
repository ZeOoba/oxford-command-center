-- 029_lease_market.sql
-- Lease Market Intelligence (spec docs/superpowers/specs/2026-09-16-lease-market-intelligence-design.md rev 3, §3.2).
-- Additive only. Property (building) and listing (space) are separate entities (cross-exam A1).
-- suite_norm uses '' for "no suite" so UNIQUE(property_id, suite_norm) holds.

CREATE TABLE IF NOT EXISTS lm_landing (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  source             TEXT NOT NULL CHECK (source IN ('costar_listings','costar_history','costar_lease_comps','alert_email','web','silver')),
  source_ref         TEXT NOT NULL,
  sha256             TEXT NOT NULL,
  market_id          TEXT,
  observed_at        TEXT NOT NULL,
  received_at        TEXT NOT NULL,
  file_path          TEXT,
  row_count          INTEGER NOT NULL DEFAULT 0,
  skipped_count      INTEGER NOT NULL DEFAULT 0,
  header_fingerprint TEXT,
  completeness       TEXT NOT NULL CHECK (completeness IN ('complete','partial','n/a')),
  partial_reason     TEXT,
  owner_screen_ok    INTEGER NOT NULL DEFAULT 0 CHECK (owner_screen_ok IN (0,1)),
  parse_status       TEXT NOT NULL CHECK (parse_status IN ('ok','failed')),
  parse_error        TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_lm_landing_sha_ok ON lm_landing (sha256) WHERE parse_status = 'ok';
CREATE UNIQUE INDEX IF NOT EXISTS ux_lm_landing_email_ref ON lm_landing (source_ref) WHERE source = 'alert_email';
CREATE INDEX IF NOT EXISTS ix_lm_landing_market ON lm_landing (source, market_id, observed_at);

CREATE TABLE IF NOT EXISTS lm_property (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  costar_property_id TEXT,
  address_norm       TEXT NOT NULL UNIQUE,
  address_display    TEXT NOT NULL,
  city               TEXT,
  state              TEXT,
  zip                TEXT,
  lat                REAL CHECK (lat IS NULL OR (lat BETWEEN -90 AND 90)),
  lon                REAL CHECK (lon IS NULL OR (lon BETWEEN -180 AND 180)),
  market_id          TEXT NOT NULL,
  submarket          TEXT,
  subtype            TEXT NOT NULL CHECK (subtype IN ('warehouse','flex')),
  building_status    TEXT NOT NULL CHECK (building_status IN ('existing','proposed','under_construction','unknown')),
  building_sf        REAL,
  year_built         INTEGER,
  clear_height_ft    REAL,
  docks              INTEGER,
  drive_ins          INTEGER,
  office_pct         REAL,
  owner_name         TEXT,
  owner_type         TEXT NOT NULL DEFAULT 'unknown' CHECK (owner_type IN ('institutional','verify','affiliated','never_call','private','unknown')),
  ora_property_key   TEXT,
  first_seen         TEXT NOT NULL,
  last_seen          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_lm_property_costar ON lm_property (costar_property_id);
CREATE INDEX IF NOT EXISTS ix_lm_property_market ON lm_property (market_id);

CREATE TABLE IF NOT EXISTS lm_listing (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id           INTEGER NOT NULL REFERENCES lm_property(id),
  suite_norm            TEXT NOT NULL DEFAULT '',
  first_seen            TEXT NOT NULL,
  last_seen             TEXT NOT NULL,
  first_landing_id      INTEGER NOT NULL REFERENCES lm_landing(id),
  costar_date_on_market TEXT,
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','missing_once','removed','expired')),
  removed_at            TEXT,
  origin_tier           TEXT NOT NULL CHECK (origin_tier IN ('T1','T2','T5')),
  broker_name           TEXT,
  broker_company        TEXT,
  listing_url           TEXT,
  description           TEXT,
  UNIQUE (property_id, suite_norm)
);
CREATE INDEX IF NOT EXISTS ix_lm_listing_status ON lm_listing (status);

CREATE TABLE IF NOT EXISTS lm_observation (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id       INTEGER NOT NULL REFERENCES lm_listing(id),
  landing_id       INTEGER NOT NULL REFERENCES lm_landing(id),
  observed_at      TEXT NOT NULL,
  source_row       INTEGER,
  available_sf     REAL NOT NULL CHECK (available_sf > 0),
  min_divisible_sf REAL,
  rent_low         REAL,
  rent_high        REAL,
  rent_period      TEXT CHECK (rent_period IN ('yr','mo')),
  rent_is_total    INTEGER NOT NULL DEFAULT 0 CHECK (rent_is_total IN (0,1)),
  -- EFFECTIVE basis after normalization (too-wide ranges, ambiguous or out-of-bounds quotes are UNKNOWN)
  rent_basis       TEXT NOT NULL CHECK (rent_basis IN ('NNN','MG','IG','GROSS','FSG','UNKNOWN','WITHHELD')),
  is_sublease      INTEGER NOT NULL CHECK (is_sublease IN (0,1)),
  asking_psf_yr    REAL,
  asking_nnn_eq    REAL,
  opex_quoted_psf  REAL,
  opex_est_psf     REAL,
  opex_source      TEXT,
  costar_dom       INTEGER,
  confidence       TEXT NOT NULL CHECK (confidence IN ('high','low')),
  rejected_reason  TEXT,
  UNIQUE (listing_id, landing_id)
);
CREATE INDEX IF NOT EXISTS ix_lm_observation_listing ON lm_observation (listing_id, observed_at);

CREATE TABLE IF NOT EXISTS lm_listing_event (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id  INTEGER NOT NULL REFERENCES lm_listing(id),
  landing_id  INTEGER NOT NULL REFERENCES lm_landing(id),
  event_date  TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('new','returned','price_cut','price_increase','sf_change','dom_reset','missing','removed')),
  prev_value  REAL,
  new_value   REAL
);
CREATE INDEX IF NOT EXISTS ix_lm_listing_event_listing ON lm_listing_event (listing_id, event_date);
CREATE INDEX IF NOT EXISTS ix_lm_listing_event_landing ON lm_listing_event (landing_id);

CREATE TABLE IF NOT EXISTS lm_signal (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id   INTEGER NOT NULL,
  listing_id    INTEGER,
  kind          TEXT NOT NULL CHECK (kind IN ('new_listing','stale','rent_cut','below_market','withdrawn_after_stale','radar_candidate')),
  severity      TEXT NOT NULL CHECK (severity IN ('info','watch','high')),
  score         INTEGER,
  confidence    TEXT CHECK (confidence IN ('HIGH','MEDIUM','LOW')),
  comp_basis    TEXT CHECK (comp_basis IN ('similarity','cell')),
  cell_key      TEXT,
  computed_at   TEXT NOT NULL,
  evidence_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_lm_signal_kind ON lm_signal (kind, severity);

CREATE TABLE IF NOT EXISTS lm_market_rent_feed (
  ora_property_key TEXT PRIMARY KEY,
  asking_nnn_eq    REAL NOT NULL CHECK (asking_nnn_eq > 0),
  comp_basis       TEXT NOT NULL CHECK (comp_basis IN ('similarity','cell')),
  confidence       TEXT NOT NULL CHECK (confidence IN ('HIGH','MEDIUM','LOW')),
  cell_key         TEXT,
  n                INTEGER NOT NULL,
  computed_at      TEXT NOT NULL
);

-- Append-only decision log (cross-exam A14): never replaced by compute; feeds calibration of the radar score.
CREATE TABLE IF NOT EXISTS lm_radar_decision (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL,
  decided_at  TEXT NOT NULL,
  decision    TEXT NOT NULL CHECK (decision IN ('investigate','monitor','pass','pursued','loi','closed')),
  note        TEXT
);
CREATE INDEX IF NOT EXISTS ix_lm_radar_decision_property ON lm_radar_decision (property_id, decided_at);

-- ── Read-only agent views (P3 skill queries these; never write through them) ────────────────
CREATE VIEW IF NOT EXISTS lm_v_listing_metrics AS
SELECT
  l.id AS listing_id,
  (SELECT o.asking_nnn_eq FROM lm_observation o WHERE o.listing_id = l.id AND o.asking_nnn_eq IS NOT NULL ORDER BY o.observed_at ASC, o.id ASC LIMIT 1) AS original_asking,
  (SELECT o.asking_nnn_eq FROM lm_observation o WHERE o.listing_id = l.id ORDER BY o.observed_at DESC, o.id DESC LIMIT 1) AS current_asking,
  (SELECT MIN(o.asking_nnn_eq) FROM lm_observation o WHERE o.listing_id = l.id) AS min_asking,
  (SELECT COUNT(*) FROM lm_listing_event e WHERE e.listing_id = l.id AND e.kind = 'price_cut') AS reduction_count,
  (SELECT MIN(o.observed_at) FROM lm_observation o WHERE o.listing_id = l.id) AS first_observed,
  (SELECT MAX(o.observed_at) FROM lm_observation o WHERE o.listing_id = l.id) AS last_observed,
  CASE
    WHEN (SELECT o.asking_nnn_eq FROM lm_observation o WHERE o.listing_id = l.id AND o.asking_nnn_eq IS NOT NULL ORDER BY o.observed_at ASC, o.id ASC LIMIT 1) IS NULL
      OR (SELECT o.asking_nnn_eq FROM lm_observation o WHERE o.listing_id = l.id ORDER BY o.observed_at DESC, o.id DESC LIMIT 1) IS NULL THEN NULL
    ELSE (SELECT o.asking_nnn_eq FROM lm_observation o WHERE o.listing_id = l.id ORDER BY o.observed_at DESC, o.id DESC LIMIT 1)
       / (SELECT o.asking_nnn_eq FROM lm_observation o WHERE o.listing_id = l.id AND o.asking_nnn_eq IS NOT NULL ORDER BY o.observed_at ASC, o.id ASC LIMIT 1) - 1.0
  END AS cumulative_reduction_pct
FROM lm_listing l;

CREATE VIEW IF NOT EXISTS lm_v_current_spaces AS
SELECT
  l.id AS listing_id, p.id AS property_id, p.market_id, p.submarket, p.subtype, p.address_display, l.suite_norm,
  p.building_sf, p.year_built, p.clear_height_ft, p.docks, p.drive_ins, p.owner_name, p.owner_type, p.ora_property_key,
  l.status, l.first_seen, l.costar_date_on_market, l.broker_name, l.broker_company, l.listing_url,
  o.observed_at, o.available_sf, o.rent_basis, o.asking_nnn_eq, o.confidence, o.is_sublease,
  m.original_asking, m.reduction_count, m.cumulative_reduction_pct
FROM lm_listing l
JOIN lm_property p ON p.id = l.property_id
JOIN lm_observation o ON o.id = (SELECT o2.id FROM lm_observation o2 WHERE o2.listing_id = l.id ORDER BY o2.observed_at DESC, o2.id DESC LIMIT 1)
JOIN lm_v_listing_metrics m ON m.listing_id = l.id
WHERE l.status IN ('active', 'missing_once');

CREATE VIEW IF NOT EXISTS lm_v_radar AS
SELECT
  s.property_id, s.score, s.confidence, s.computed_at, s.evidence_json,
  p.market_id, p.address_display, p.building_sf, p.owner_name, p.owner_type,
  (SELECT d.decision FROM lm_radar_decision d WHERE d.property_id = s.property_id ORDER BY d.decided_at DESC, d.id DESC LIMIT 1) AS latest_decision
FROM lm_signal s
JOIN lm_property p ON p.id = s.property_id
WHERE s.kind = 'radar_candidate';
