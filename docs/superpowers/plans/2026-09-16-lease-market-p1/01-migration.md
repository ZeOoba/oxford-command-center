### Task 01: Warehouse migration 029 — lm_* tables

**Files:**
- Create: `server/warehouse/migrations/029_lease_market.sql`
- Modify: `architecture/database-schema.md` (append a section)
- Test: `tests/unit/migration-029-lease-market.test.ts`

**Interfaces:**
- Consumes: `runMigrations(db)` from `server/warehouse/migrate.ts` (applies `NNN_*.sql` in numeric order).
- Produces: tables `lm_landing`, `lm_listing`, `lm_observation`, `lm_signal`, `lm_market_rent_feed` with the exact columns below. Every later server task relies on these names.

- [ ] **Step 0: Confirm the number is free**

Run: `ls server/warehouse/migrations | sort -n | tail -3`
Expected: highest is `028_debt_scores_noi_basis.sql`. If a `029_*` already exists, use the next free number everywhere in this task (file name, header comment, test name).

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

function insertLanding(db: Database.Database, sha: string, parseStatus: 'ok' | 'failed'): number {
  const info = db
    .prepare(
      `INSERT INTO lm_landing (source, source_ref, sha256, market_id, observed_at, received_at, completeness, parse_status)
       VALUES ('costar_listings', 'f.xlsx', ?, 'columbus', '2026-01-01', '2026-01-02T00:00:00Z', ?, ?)`,
    )
    .run(sha, parseStatus === 'ok' ? 'complete' : 'n/a', parseStatus);
  return Number(info.lastInsertRowid);
}

function insertListing(db: Database.Database, landingId: number, addressNorm: string, suiteNorm: string): number {
  const info = db
    .prepare(
      `INSERT INTO lm_listing (address_norm, suite_norm, address_display, market_id, subtype, building_status,
         first_seen, last_seen, first_landing_id, origin_tier)
       VALUES (?, ?, 'x', 'columbus', 'warehouse', 'existing', '2026-01-01', '2026-01-01', ?, 'T1')`,
    )
    .run(addressNorm, suiteNorm, landingId);
  return Number(info.lastInsertRowid);
}

describe('migration 029 — lease market tables', () => {
  it('creates all five lm_* tables', () => {
    const db = makeDb();
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'lm_%' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(names).toEqual(['lm_landing', 'lm_listing', 'lm_market_rent_feed', 'lm_observation', 'lm_signal']);
  });

  it('allows a failed landing to be retried with the same sha, but not two ok landings', () => {
    const db = makeDb();
    insertLanding(db, 'abc', 'failed');
    insertLanding(db, 'abc', 'failed');
    insertLanding(db, 'abc', 'ok');
    expect(() => insertLanding(db, 'abc', 'ok')).toThrow(/UNIQUE/);
  });

  it('enforces UNIQUE(address_norm, suite_norm) on lm_listing', () => {
    const db = makeDb();
    const landing = insertLanding(db, 's1', 'ok');
    insertListing(db, landing, '1100 RARIG AVE', 'B');
    insertListing(db, landing, '1100 RARIG AVE', '');
    expect(() => insertListing(db, landing, '1100 RARIG AVE', 'B')).toThrow(/UNIQUE/);
  });

  it('rejects an invalid rent_basis and one observation per listing per landing', () => {
    const db = makeDb();
    const landing = insertLanding(db, 's2', 'ok');
    const listing = insertListing(db, landing, '1 MAIN ST', '');
    const obs = (basis: string) =>
      db
        .prepare(
          `INSERT INTO lm_observation (listing_id, landing_id, observed_at, available_sf, rent_basis, is_sublease, confidence)
           VALUES (?, ?, '2026-01-01', 1000, ?, 0, 'high')`,
        )
        .run(listing, landing, basis);
    expect(() => obs('NET')).toThrow(/CHECK/);
    obs('NNN');
    expect(() => obs('NNN')).toThrow(/UNIQUE/);
  });

  it('rejects a non-positive feed rent', () => {
    const db = makeDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO lm_market_rent_feed (ora_property_key, asking_nnn_eq, cell_key, n, quoted_share, computed_at)
           VALUES ('1100 Rarig', 0, 'k', 5, 1, '2026-01-01')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/migration-029-lease-market.test.ts`
Expected: FAIL — `no such table: lm_landing`.

- [ ] **Step 3: Write the migration**

```sql
-- 029_lease_market.sql
-- Lease Market Intelligence (spec docs/superpowers/specs/2026-09-16-lease-market-intelligence-design.md §3.2).
-- Additive only. Quarterly rent history reuses market_series (013/017) in P2; nothing here duplicates it.
-- suite_norm uses '' (never NULL) for "no suite" so UNIQUE(address_norm, suite_norm) holds.

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
  header_fingerprint TEXT,
  completeness       TEXT NOT NULL CHECK (completeness IN ('complete','partial','n/a')),
  partial_reason     TEXT,
  owner_screen_ok    INTEGER NOT NULL DEFAULT 0 CHECK (owner_screen_ok IN (0,1)),
  parse_status       TEXT NOT NULL CHECK (parse_status IN ('ok','failed')),
  parse_error        TEXT
);
-- A failed parse must not block a retry of the same bytes after the header map is fixed.
CREATE UNIQUE INDEX IF NOT EXISTS ux_lm_landing_sha_ok ON lm_landing (sha256) WHERE parse_status = 'ok';
-- P3 alert-email dedup by Message-ID.
CREATE UNIQUE INDEX IF NOT EXISTS ux_lm_landing_email_ref ON lm_landing (source_ref) WHERE source = 'alert_email';
CREATE INDEX IF NOT EXISTS ix_lm_landing_market ON lm_landing (source, market_id, observed_at);

CREATE TABLE IF NOT EXISTS lm_listing (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  costar_property_id    TEXT,
  address_norm          TEXT NOT NULL,
  suite_norm            TEXT NOT NULL DEFAULT '',
  address_display       TEXT NOT NULL,
  city                  TEXT,
  state                 TEXT,
  market_id             TEXT NOT NULL,
  submarket             TEXT,
  subtype               TEXT NOT NULL CHECK (subtype IN ('warehouse','flex')),
  building_status       TEXT NOT NULL CHECK (building_status IN ('existing','proposed','under_construction','unknown')),
  building_sf           REAL,
  year_built            INTEGER,
  clear_height_ft       REAL,
  docks                 INTEGER,
  drive_ins             INTEGER,
  office_pct            REAL,
  owner_name            TEXT,
  owner_type            TEXT NOT NULL DEFAULT 'unknown' CHECK (owner_type IN ('institutional','verify','affiliated','never_call','private','unknown')),
  ora_property_key      TEXT,
  first_seen            TEXT NOT NULL,
  last_seen             TEXT NOT NULL,
  first_landing_id      INTEGER NOT NULL REFERENCES lm_landing(id),
  costar_date_on_market TEXT,
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','missing_once','removed','expired')),
  removed_at            TEXT,
  origin_tier           TEXT NOT NULL CHECK (origin_tier IN ('T1','T2','T5')),
  UNIQUE (address_norm, suite_norm)
);
CREATE INDEX IF NOT EXISTS ix_lm_listing_market_status ON lm_listing (market_id, status);
CREATE INDEX IF NOT EXISTS ix_lm_listing_costar ON lm_listing (costar_property_id, suite_norm);

CREATE TABLE IF NOT EXISTS lm_observation (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id       INTEGER NOT NULL REFERENCES lm_listing(id),
  landing_id       INTEGER NOT NULL REFERENCES lm_landing(id),
  observed_at      TEXT NOT NULL,
  available_sf     REAL NOT NULL CHECK (available_sf > 0),
  min_divisible_sf REAL,
  rent_low         REAL,
  rent_high        REAL,
  rent_period      TEXT CHECK (rent_period IN ('yr','mo')),
  -- EFFECTIVE basis after normalization (a too-wide range is stored as UNKNOWN).
  rent_basis       TEXT NOT NULL CHECK (rent_basis IN ('NNN','MG','IG','GROSS','FSG','UNKNOWN','WITHHELD')),
  is_sublease      INTEGER NOT NULL CHECK (is_sublease IN (0,1)),
  asking_psf_yr    REAL,
  asking_nnn_eq    REAL,
  opex_est_psf     REAL,
  opex_source      TEXT,
  costar_dom       INTEGER,
  confidence       TEXT NOT NULL CHECK (confidence IN ('high','low')),
  UNIQUE (listing_id, landing_id)
);
CREATE INDEX IF NOT EXISTS ix_lm_observation_listing ON lm_observation (listing_id, observed_at);

CREATE TABLE IF NOT EXISTS lm_signal (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id    INTEGER NOT NULL REFERENCES lm_listing(id),
  kind          TEXT NOT NULL CHECK (kind IN ('new_listing','stale','rent_cut','below_market','acq_candidate')),
  severity      TEXT NOT NULL CHECK (severity IN ('info','watch','high')),
  cell_key      TEXT,
  computed_at   TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  dismissed_at  TEXT
);
CREATE INDEX IF NOT EXISTS ix_lm_signal_kind ON lm_signal (kind, severity);

CREATE TABLE IF NOT EXISTS lm_market_rent_feed (
  ora_property_key TEXT PRIMARY KEY,
  asking_nnn_eq    REAL NOT NULL CHECK (asking_nnn_eq > 0),
  cell_key         TEXT NOT NULL,
  n                INTEGER NOT NULL,
  quoted_share     REAL NOT NULL,
  computed_at      TEXT NOT NULL
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/migration-029-lease-market.test.ts tests/unit/warehouse-migrate.test.ts`
Expected: PASS (both files).

- [ ] **Step 5: Document the schema**

Append to the end of `architecture/database-schema.md`:

```markdown
## Lease Market Intelligence (migration 029)

Spec: `docs/superpowers/specs/2026-09-16-lease-market-intelligence-design.md`.

| Table | Grain | Notes |
|---|---|---|
| `lm_landing` | one intake file / email | immutable; `sha256` unique among `parse_status='ok'`; `completeness` complete/partial drives removal; `owner_screen_ok` gates acquisition candidates |
| `lm_listing` | one space (address_norm + suite_norm) | `status` active → missing_once → removed only on consecutive complete exports; `costar_date_on_market` keeps the earliest value seen; `ora_property_key` set when the address matches `config/lease-market.json` oraProperties |
| `lm_observation` | listing × landing | `rent_basis` is the effective basis; `asking_nnn_eq` null when not derivable; `confidence` high only for NNN with an explicit or unambiguous period |
| `lm_signal` | derived | fully replaced on each `npm run lease-market:compute` |
| `lm_market_rent_feed` | ORA property | cell median asking NNN-eq; merged under manual `overlay.marketRents` at read time |
```

- [ ] **Step 6: Commit**

```bash
git add server/warehouse/migrations/029_lease_market.sql architecture/database-schema.md tests/unit/migration-029-lease-market.test.ts
git commit -F <message-file>   # "feat(warehouse): migration 029 lease market tables"
```
