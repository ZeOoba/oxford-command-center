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
| 002 | `002_parser_version.sql` | `import_batches`: adds `parser_version INTEGER NOT NULL DEFAULT 0` — enables re-derive on parser upgrade without re-ingest |
| 003 | `003_capital_config.sql` | New tables: `capital_config` (governor version history, seed v1) + `calibration_log` (parameter-change audit trail) |
| 004 | `004_occupancy.sql` | New table: `property_occupancy` — per-property occupancy time-series snapshots (workbook-sourced, separate from P&L spine) |
| 005 | `005_calibration.sql` | New tables: `calibration_inputs_version`, `calibration_verdict`, `calibration_outcome` — 40-year score-vs-outcome feedback loop scaffold |
| 006 | `006_lease_terms.sql` | New table: `lease_terms` — per-tenant lease data (rent schedule, renewal options, diligence notes) for forward cash-flow modeling |
| 007 | `007_acq_candidates.sql` | New tables: `acq_candidates`, `acq_source_batches`, `acq_score_inputs`, `acq_scores` — Acquisition Intelligence Engine (Phase 4) |
| 008 | `008_insurance_policies.sql` | New table: `property_insurance_policies` — insurance policy snapshots (Phase 5) |
| 009 | `009_debt_positions.sql` | New table: `debt_positions` — borrower-side debt snapshots (lender-side excluded); raw terms never reach client |
| 010 | `010_debt_scores.sql` | New table: `debt_scores` — persisted debt-score output (DSCR, LTV, signal, band) for trend tracking |
| 011 | `011_lease_events.sql` | New table: `lease_events` — lease lifecycle events (vacate/commence) enabling days-vacant-to-leased velocity metric |
| 012 | `012_prospect_demand.sql` | New table: `prospect_demand_events` — external demand signals (showings, inquiries, LOIs, tours); source='manual' today, 'outlook' future |
| 013 | `013_market_series.sql` | New table: `market_series` — per-cluster market data time series (vacancy, rent growth, cap rates) |
| 014 | `014_recommendations.sql` | New table: `recommendations` — capital-action recommendations (buy/hold/sell/refinance/improve) with confidence and reasons |
| 015 | `015_hurdle_rate.sql` | `capital_config`: adds `hurdle_rate_pct`, `hurdle_rate_ratification`, `hurdle_rate_ratified_by`, `hurdle_rate_ratified_date` columns |
| 016 | `016_property_onboarding.sql` | New table: `property_onboarding` — per-property PM system + authoritative source config (Phase 5 W4) |
| 017a | `017_market_series_constraints.sql` | `market_series`: adds unique index `ux_market_series_tuple (cluster, as_of, source, metric)` — deferred from migration 013 |
| 017b | `017_ratify_hurdle_rate.sql` | `capital_config`: stamps hurdle-rate ratification (`ratified` / Gabriel Goldberg / 2026-06-22) on latest config row |
| 018 | `018_recommendations_constraints.sql` | `recommendations`: table-recreate to add `CHECK (expected_return_pct BETWEEN -1.0 AND 5.0)`, `CHECK (timeline_months > 0)`, and unique index `ux_recommendations_versioned (property_id, as_of, inputs_version)` |
| 019 | `019_account_mappings_period.sql` | `account_mappings`: adds `period TEXT` (nullable). NULL = unscoped (all periods); non-null = scoped to a specific year string (e.g. `'2025'`). Enables period-scoped one-time exclusions (H4: FVC 2025 cell-tower easement). `resolveMapping()` applies `AND (period IS NULL OR period = ?)` when caller passes a period. |
| 020 | `020_property_tax.sql` | New tables: `property_tax_assessments` (per property/tax_year assessment snapshot: assessed value, assessment ratio, millage rate, annual tax billed) + `tax_appeals` (appeal lifecycle: draft/filed/hearing/won/lost/withdrawn, estimated + realized annual savings) |
| 021 | `021_recommendation_feedback.sql` | New table: `recommendation_feedback` — append-only human accept/dismiss decisions on insight/alert/allocation subjects (no UPDATE path; a changed mind is a new row) |
| 022 | `022_insurance_loss_events.sql` | New table: `insurance_loss_events` — broker loss-run history (ships empty until broker data arrives); `property_insurance_policies`: adds `deductible`, `coverage_limit` (nullable, additive) |
| 025 | `025_acq_hubspot_sync_content_hash.sql` | `acq_candidates`: adds `content_hash TEXT` (nullable, additive). `syncHubSpotPipeline()`'s upsert now hashes each deal's synced (address, status) and only bumps `updated_at` when the hash actually changes, fixing `updated_at` previously being stamped to `datetime('now')` on every sync run regardless of whether the deal's data changed (same anti-pattern as migration 024's property_master fix — a batch-sync signature, not a real edit-tracking column) |

**NOTE — duplicate migration-number prefix (017):** two files share the `017` numeric prefix — `017_market_series_constraints.sql` and `017_ratify_hurdle_rate.sql` (see rows 017a/017b above). `migrate.ts` sorts filenames by parsed numeric prefix only (`parseInt(a.split('_')[0])`, `migrate.ts:41-45`); files sharing a prefix fall back to `readdirSync` enumeration order for their relative order, which is filesystem-dependent and not a guaranteed alphabetical or creation-order tiebreak. In this case it is harmless — the two `017` files touch disjoint tables (`market_series` vs. `capital_config`) with no dependency between them, so either application order produces the same end state. **Duplicate migration numbers are forbidden going forward** — this note documents the one exception already on disk, not a pattern to repeat. 023 (`023_debt_rate_reset.sql`) and 024 (`024_property_master_content_hash.sql`, branch `fix/property-master-content-hash`, pending merge) are also taken. The next free migration number after this change is **026**.

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
  detect_notes    TEXT,
  parser_version  INTEGER NOT NULL DEFAULT 0
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
  period              TEXT,    -- added migration 019; NULL = all periods
  note                TEXT,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mappings_key ON account_mappings(raw_account_key);
```

**`classification`:** `'revenue'` | `'opex'` | `'recovery'` | `'other-income'` | `'below-line'` | `'unknown'`.
**`match_kind`:** `'manual'` (highest precedence) | `'seed'` | `'learned'` (reserved).
**`period`:** Optional year string (e.g. `'2025'`). NULL = unscoped (matches any period). Non-null = matches only the exact period. Used for one-time GL items that must be excluded from a specific year only (e.g. H4: FVC 2025 cell-tower easement sale). `resolveMapping()` applies `AND (period IS NULL OR period = ?)` when the caller passes a period.
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
