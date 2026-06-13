# Database Schema — Oxford Command Center

**Status:** Architecture lock file — schema changes MUST go through the migration system. Never use `CREATE TABLE IF NOT EXISTS` to add columns or indexes. Add a new numbered `.sql` file in `server/warehouse/migrations/`.

**Migration runner:** `server/warehouse/migrate.ts`
**Migration files:** `server/warehouse/migrations/*.sql` (applied in numeric order)
**DB path:** `process.env.WAREHOUSE_DB ?? 'data/warehouse/finance.sqlite'`
**Pragmas:** `journal_mode = WAL`, `foreign_keys = ON`

---

## Migration History

| # | File | Description |
|---|------|-------------|
| 001 | `001_initial.sql` | Full warehouse schema (all 5 tables + indexes) |

---

## Tables

### `_migrations` (migration tracking — do NOT modify manually)

```sql
CREATE TABLE IF NOT EXISTS _migrations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  filename    TEXT NOT NULL UNIQUE,
  applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Created automatically by `migrate.ts` on first run. Tracks which `.sql` files have been applied.

---

### `property_master`

```sql
CREATE TABLE IF NOT EXISTS property_master (
  id                TEXT    PRIMARY KEY,
  name              TEXT    NOT NULL,
  market            TEXT,
  address           TEXT,
  property_manager  TEXT,
  pm_contact        TEXT,
  pm_platform       TEXT,
  financial_mode    TEXT    NOT NULL DEFAULT 'pnl',
  rentable_sf       REAL,
  acquisition_date  TEXT,
  ownership_pct     REAL    NOT NULL DEFAULT 1.0,
  ownership_status  TEXT    NOT NULL DEFAULT 'active',
  asset_class       TEXT,
  notes             TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

**Seeded from:** `server/warehouse/property-master.ts` (ratified 14-unit roster, PFI Build Canon).
**`id`:** Stable slug (e.g., `gahanna-industrial`). Never numeric — strings survive reseeds.
**`financial_mode`:** `'pnl'` (P&L statement) or `'cashflow'` (cash flow statement — AppFolio).
**`ownership_pct`:** Oxford's fractional ownership (1.0 = 100%). Applied to NOI for portfolio-level aggregation.
**`basis`** is NOT stored here — it lives on each `import_batch`.

---

### `import_batches`

```sql
CREATE TABLE IF NOT EXISTS import_batches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name       TEXT    NOT NULL,
  file_hash       TEXT    NOT NULL UNIQUE,
  raw_path        TEXT    NOT NULL,
  file_source     TEXT    NOT NULL DEFAULT 'folder',
  imported_at     TEXT    NOT NULL,
  imported_by     TEXT,
  property_id     TEXT    REFERENCES property_master(id),
  period_start    TEXT,
  period_end      TEXT,
  period_grain    TEXT,
  basis           TEXT    NOT NULL DEFAULT 'unknown',
  source_system   TEXT    NOT NULL DEFAULT 'unknown',
  version         INTEGER NOT NULL,
  status          TEXT    NOT NULL,
  superseded_by   INTEGER REFERENCES import_batches(id),
  confidence      REAL,
  detect_notes    TEXT
);
```

**`basis`:** `'accrual'` | `'cash'` | `'unknown'`. Never aggregate across bases without flagging.
**`status`:** `'committed'` | `'pending-review'` | `'rejected'` | `'superseded'`.
**`source_system`:** `'quickbooks'` | `'yardi'` | `'appfolio'` | `'rent-manager'` | `'unknown'`.
**`file_hash`:** SHA-256 of raw file bytes. Enforces deduplicate-on-hash.
**`superseded_by`:** Points to the newer version of the same file. Older versions stay (audit trail).

---

### `account_mappings`

```sql
CREATE TABLE IF NOT EXISTS account_mappings (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_account_key     TEXT    NOT NULL,
  source_system       TEXT,
  normalized_category TEXT    NOT NULL,
  classification      TEXT    NOT NULL,
  match_kind          TEXT    NOT NULL DEFAULT 'seed',
  property_id         TEXT,
  note                TEXT,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mappings_key ON account_mappings(raw_account_key);
```

**`classification`:** `'revenue'` | `'opex'` | `'recovery'` | `'other-income'` | `'below-line'` | `'unknown'`.
**`match_kind`:** `'manual'` (highest precedence) | `'seed'` | `'learned'` (reserved).
**Resolution order:** manual > property-scoped seed > global seed > learned > unmapped.
**Side constraint:** An income-side raw account CANNOT be mapped to an opex classification. Enforced in `mapping.ts`.

---

### `ledger_entries`

```sql
CREATE TABLE IF NOT EXISTS ledger_entries (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id           INTEGER NOT NULL REFERENCES import_batches(id),
  property_id         TEXT    NOT NULL,
  period              TEXT    NOT NULL,
  raw_account         TEXT    NOT NULL,
  gl_code             TEXT,
  amount              REAL    NOT NULL,
  normalized_category TEXT    NOT NULL,
  classification      TEXT    NOT NULL,
  mapping_id          INTEGER,
  is_active           INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_ledger_prop_period
  ON ledger_entries(property_id, period, is_active);
```

**`period`:** Year string (e.g., `'2025'`). Grain inferred from filename; annual only for now.
**`is_active`:** 0 = superseded (the old version's entries); 1 = current. Always filter `WHERE is_active = 1`.
**`amount`:** Sign-normalized: revenue/recovery/other-income are positive, opex is negative.
**Grain discipline:** Never compare YTD periods to full-year periods. The metrics layer enforces this.

---

### `data_quality_issues`

```sql
CREATE TABLE IF NOT EXISTS data_quality_issues (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id   INTEGER,
  property_id TEXT,
  kind        TEXT    NOT NULL,
  detail      TEXT    NOT NULL,
  severity    TEXT    NOT NULL DEFAULT 'warn',
  status      TEXT    NOT NULL DEFAULT 'open',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
```

**`kind`:** `'empty-parse'` | `'foot-mismatch'` | `'unmapped-account'` | `'basis-unknown'` | `'cross-basis-comparison'`.
**`severity`:** `'error'` (blocks commit) | `'warn'` (logged, non-blocking).
**Gate rule:** Zero `empty-parse` issues + zero `foot-mismatch` issues required by `warehouse:verify`.

---

## Planned Future Tables (do NOT create without architect approval)

| Table | Phase | Purpose |
|-------|-------|---------|
| `period_metrics` | Phase 2 | Persisted computed metrics per property/period |
| `scores` | Phase 2 | Persisted health/attention/capital scores |
| `intel_findings` | Phase 3 | AI-generated property findings |
| `briefings` | Phase 3 | Generated briefing records |

---

## Adding a Migration

1. Create `server/warehouse/migrations/NNN_description.sql` (e.g., `002_add_period_metrics.sql`).
2. Write pure DDL (ALTER TABLE, CREATE TABLE, CREATE INDEX). No DML.
3. Test it: `runMigrations(db)` in a test against an in-memory SQLite.
4. Never modify an existing migration file after it has been applied to production.
