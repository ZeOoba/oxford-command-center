### Task 01: Warehouse migration 029 — lm_* tables and agent views

**Files:**
- Create: `server/warehouse/migrations/029_lease_market.sql`
- Modify: `architecture/database-schema.md` (append a section)
- Test: `tests/unit/migration-029-lease-market.test.ts`

**Interfaces:**
- Consumes: `runMigrations(db)` (`server/warehouse/migrate.ts`).
- Produces: tables `lm_landing`, `lm_property`, `lm_listing`, `lm_observation`, `lm_listing_event`, `lm_signal`, `lm_market_rent_feed`, `lm_radar_decision`; views `lm_v_current_spaces`, `lm_v_listing_metrics`, `lm_v_radar`. Column names below are the contract for Tasks 09–14.

- [ ] **Step 0:** `ls server/warehouse/migrations | sort -n | tail -3` — highest must be `028_*`. If `029_*` exists, use the next free number everywhere in this task.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/migration-029-lease-market.test.ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/warehouse/migrate';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}
function landing(db: Database.Database, sha: string, status: 'ok' | 'failed' = 'ok'): number {
  return Number(
    db.prepare(
      `INSERT INTO lm_landing (source, source_ref, sha256, market_id, observed_at, received_at, completeness, parse_status)
       VALUES ('costar_listings', 'f.xlsx', ?, 'columbus', '2026-01-01', '2026-01-02T00:00:00Z', ?, ?)`,
    ).run(sha, status === 'ok' ? 'complete' : 'n/a', status).lastInsertRowid,
  );
}
function property(db: Database.Database, addressNorm: string): number {
  return Number(
    db.prepare(
      `INSERT INTO lm_property (address_norm, address_display, market_id, subtype, building_status, first_seen, last_seen)
       VALUES (?, 'x', 'columbus', 'warehouse', 'existing', '2026-01-01', '2026-01-01')`,
    ).run(addressNorm).lastInsertRowid,
  );
}
function space(db: Database.Database, propertyId: number, landingId: number, suite: string): number {
  return Number(
    db.prepare(
      `INSERT INTO lm_listing (property_id, suite_norm, first_seen, last_seen, first_landing_id, origin_tier)
       VALUES (?, ?, '2026-01-01', '2026-01-01', ?, 'T1')`,
    ).run(propertyId, suite, landingId).lastInsertRowid,
  );
}
function observe(db: Database.Database, listingId: number, landingId: number, date: string, asking: number | null) {
  db.prepare(
    `INSERT INTO lm_observation (listing_id, landing_id, observed_at, available_sf, rent_basis, is_sublease, rent_is_total, asking_nnn_eq, confidence)
     VALUES (?, ?, ?, 10000, 'NNN', 0, 0, ?, 'high')`,
  ).run(listingId, landingId, date, asking);
}

describe('migration 029 — lease market', () => {
  it('creates all tables and views', () => {
    const db = makeDb();
    const names = (type: string) =>
      db.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name LIKE 'lm_%' ORDER BY name").all(type).map((r) => (r as { name: string }).name);
    expect(names('table')).toEqual(['lm_landing', 'lm_listing', 'lm_listing_event', 'lm_market_rent_feed', 'lm_observation', 'lm_property', 'lm_radar_decision', 'lm_signal']);
    expect(names('view')).toEqual(['lm_v_current_spaces', 'lm_v_listing_metrics', 'lm_v_radar']);
  });

  it('lets a failed landing retry but rejects two ok landings with the same bytes', () => {
    const db = makeDb();
    landing(db, 'abc', 'failed');
    landing(db, 'abc', 'failed');
    landing(db, 'abc', 'ok');
    expect(() => landing(db, 'abc', 'ok')).toThrow(/UNIQUE/);
  });

  it('keys properties by address and spaces by property + suite', () => {
    const db = makeDb();
    const l = landing(db, 's1');
    const p = property(db, '1100 RARIG AVE');
    expect(() => property(db, '1100 RARIG AVE')).toThrow(/UNIQUE/);
    space(db, p, l, 'B');
    space(db, p, l, '');
    expect(() => space(db, p, l, 'B')).toThrow(/UNIQUE/);
  });

  it('enforces check constraints on basis, events, signals and decisions', () => {
    const db = makeDb();
    const l = landing(db, 's2');
    const s = space(db, property(db, '1 MAIN ST'), l, '');
    expect(() =>
      db.prepare(`INSERT INTO lm_observation (listing_id, landing_id, observed_at, available_sf, rent_basis, is_sublease, rent_is_total, confidence) VALUES (?, ?, '2026-01-01', 1000, 'NET', 0, 0, 'high')`).run(s, l),
    ).toThrow(/CHECK/);
    expect(() => db.prepare(`INSERT INTO lm_listing_event (listing_id, landing_id, event_date, kind) VALUES (?, ?, '2026-01-01', 'leased')`).run(s, l)).toThrow(/CHECK/);
    expect(() =>
      db.prepare(`INSERT INTO lm_signal (property_id, kind, severity, computed_at, evidence_json) VALUES (1, 'acq_candidate', 'high', '2026-01-01', '{}')`).run(),
    ).toThrow(/CHECK/);
    expect(() => db.prepare(`INSERT INTO lm_radar_decision (property_id, decided_at, decision) VALUES (1, '2026-01-01', 'buy')`).run()).toThrow(/CHECK/);
  });

  it('lm_v_listing_metrics reports original, current, minimum asking and cuts', () => {
    const db = makeDb();
    const l1 = landing(db, 'a');
    const l2 = landing(db, 'b');
    const l3 = landing(db, 'c');
    const s = space(db, property(db, '9 OAK ST'), l1, '');
    observe(db, s, l1, '2026-01-01', 9.5);
    observe(db, s, l2, '2026-02-01', 9.0);
    observe(db, s, l3, '2026-03-01', 8.5);
    const ev = db.prepare(`INSERT INTO lm_listing_event (listing_id, landing_id, event_date, kind, prev_value, new_value) VALUES (?, ?, ?, 'price_cut', ?, ?)`);
    ev.run(s, l2, '2026-02-01', 9.5, 9.0);
    ev.run(s, l3, '2026-03-01', 9.0, 8.5);
    const m = db.prepare('SELECT * FROM lm_v_listing_metrics WHERE listing_id = ?').get(s) as Record<string, number | string>;
    expect(m).toMatchObject({ original_asking: 9.5, current_asking: 8.5, min_asking: 8.5, reduction_count: 2, first_observed: '2026-01-01', last_observed: '2026-03-01' });
    expect(m.cumulative_reduction_pct as number).toBeCloseTo(-0.10526, 4);
  });
});
```

- [ ] **Step 2:** `npx vitest run tests/unit/migration-029-lease-market.test.ts` — Expected: FAIL (`no such table`).

- [ ] **Step 3: Write the migration**

```sql
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
```

- [ ] **Step 4:** `npx vitest run tests/unit/migration-029-lease-market.test.ts tests/unit/warehouse-migrate.test.ts` — Expected: PASS.

- [ ] **Step 5: Document** — append to `architecture/database-schema.md`:

```markdown
## Lease Market Intelligence (migration 029)

Spec: `docs/superpowers/specs/2026-09-16-lease-market-intelligence-design.md` (rev 3).

| Table / view | Grain | Notes |
|---|---|---|
| `lm_landing` | intake file / email | immutable; sha256 unique among ok parses; completeness drives removal; `owner_screen_ok` gates the radar |
| `lm_property` | building | identity: CoStar property id ▸ address_norm; owner, coordinates, physicals; `ora_property_key` when configured |
| `lm_listing` | space | UNIQUE(property_id, suite_norm); two-strike removal; earliest CoStar date on market kept; broker / URL |
| `lm_observation` | space × landing | effective `rent_basis`; `asking_nnn_eq` null when not derivable or out of bounds (`rejected_reason`); quoted opex |
| `lm_listing_event` | change | new / returned / price_cut / price_increase / sf_change / dom_reset / missing / removed |
| `lm_signal` | derived | replaced on each `npm run lease-market:compute` |
| `lm_market_rent_feed` | ORA property | comparable median asking NNN-eq; merged under manual `overlay.marketRents` |
| `lm_radar_decision` | decision | append-only; calibration of the radar score |
| `lm_v_current_spaces`, `lm_v_listing_metrics`, `lm_v_radar` | views | read-only agent query surface |
```

- [ ] **Step 6: Commit** — `git add server/warehouse/migrations/029_lease_market.sql architecture/database-schema.md tests/unit/migration-029-lease-market.test.ts` then `git commit -F <file>` ("feat(warehouse): migration 029 lease market property/space/event model").
