# Portfolio Trends — Wave 3A (Monthly P&L Ledger, Parsers, Tie-Out, API) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **STATUS: DESIGN-COMPLETE, SAMPLE-GATED.** Tasks 0–3 and 6–8 are fully specified and buildable now. **Tasks 4 and 5 (the three per-system parsers and the ingest wiring) are deliberately NOT specified**: their column layouts are unknown until Gabriel supplies one monthly P&L export per system. Task 1 inspects the samples and *amends this plan* with the exact layouts; do not start Task 4 or 5 before that amendment is committed. Guessing the layouts is how a parser silently mis-reads money.

**Goal:** Ingest monthly P&L exports (QuickBooks, Yardi, AppFolio) into a new monthly ledger that ties out to the existing annual/YTD ledger, and serve `opex`-by-category-by-month per property through `GET /api/warehouse/analytics/expenses/monthly` (conforming to the Wave 3B contract).

**Architecture:** A **separate, additive** pair of tables (`monthly_import_batches`, `ledger_monthly`) — Spine B's annual readers (`metrics.ts`, `noiMatrix`, benchmarks, `warehouse:verify`, `warehouse:drift`, the Wave 2 history) never see them, so no existing analytic can change. Parsers emit one normalized `RawMonthlyStatement` per file; ingest classifies every line through the existing `mapping.ts` (so categories match the annual data) and writes month-grain rows. A tie-out engine proves monthly sums equal the annual ledger per (property, year, classification, category) with explicit, documented per-entity exceptions, and is delivered as a script — **not** a gate step (gate changes need architect + Gabriel approval).

**Tech Stack:** SQLite (better-sqlite3) + numbered migrations, ExcelJS parsers, Zod contracts, Hono, Vitest.

## Global Constraints

- **Do not disturb Spine B.** Monthly data must never appear in `import_batches`/`ledger_entries` (their readers select `status='committed'` rows by property and period — a monthly batch there would be picked up by `propertyPeriodMetrics`, NOI matrix, benchmarks and `warehouse:verify`, which asserts `committed >= 32` and unique hashes). Separate tables only.
- **Basis discipline:** store `basis` per monthly batch exactly as the file declares (`cash`/`accrual`); never convert; the tie-out compares like with like only. Existing entities: cash — 1100 Rarig, 3540 E 5th, 3034 Westerville, 3875-3883 E Livingston, 9620 Raytown, Sepich portfolio, 1900 N Broadway, 29000 Information Ln, 9050 Red Branch, 2203-2207 Northwood; accrual — 55 New Plant Ct, 1851 S Club Solar.
- **Classification parity:** every monthly line is classified by `resolveMapping(db, rawAccount, propertyId, section, side?)` with the **month's year as `period`**, so period-scoped exclusions (migration 019 — e.g. the FVC 2025 cell-tower easement) apply identically to monthly and annual data. Side constraint holds (an income-side account can never map to opex).
- **No fabricated or inferred months.** A month with no column in the file is absent, not zero. Annual-total ÷ 12 is never used.
- **Architect-owned — claim first** in `architecture/status.json` (`review_needed: true`) and obtain Gabriel's in-turn `architect-edit-ok` sentinel for the worktree (60-min TTL; he places it — do not create it unprompted): `server/warehouse/migrations/` (035), `src/contracts/` (+ `index.ts`), `server/index.ts` (only if the ingest CLI needs a hook — it should not), `architecture/database-schema.md`, `package.json` (new scripts), `scripts/governance-check.ts`.
- **`server/` and `scripts/` are default-deny for `check:refute`:** every commit that touches them needs a `Refute-Reviewed: wf_<id>` or a justified `Refute-Skip:` trailer **in its own message**. These tasks write shared state and money-adjacent numbers: run the `adversarial-reviewer` agent (explicit `model`, never below the implementer) before attesting; use the `refute-financial-change` workflow if anything touches NOI/verdict math (it should not).
- **Live data safety:** never DDL against `data/warehouse/finance.sqlite`; migrations only. Real P&L files are **read locally and never committed** (raw files live under the gitignored `data/warehouse/raw/` / Gabriel's drop folder). Test fixtures are **synthetic**, generated in-test by an ExcelJS writer that mimics the layout recorded in Task 1's format notes (the idiom in `tests/unit/warehouse-api.test.ts`'s `writeFixture`). Back up the live warehouse with the SQLite backup API before the first live ingest.
- Dev servers and any ingest against a non-test DB use a scratch `WAREHOUSE_DB` until Task 8's live-run step, which needs Gabriel's go-ahead.
- Gate: green except the known-red `reconcile` step when it recurs; run later steps by hand. Commits: explicit paths only; trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; never `--no-verify`.

## Open decisions (ask Gabriel with `AskUserQuestion`, recommended option first)

1. **Drop folder** for the monthly exports (suggest: a new gitignored `data/warehouse/monthly-inbox/`, files named `P&L Monthly 2025 -- 1100 Rarig.xlsx`). Existing annual files live in `data/warehouse/raw/` (content-hashed copies).
2. **Filename convention** for monthly files (needed by Task 3's detection). Recommended: `P&L Monthly <year> -- <token>.<ext>` (token aliases reuse `PROPERTY_ALIASES` in `detect.ts`).
3. **Sepich portfolio:** one roll-up entity today (`sepich-portfolio-columbus-oh-8-props`). Ingest the roll-up only (recommended) unless per-building exports exist — per-building would need a property-master change, which is out of scope here.

## Sequencing & contingencies (check at Task 0)

| State at execution | Action |
|---|---|
| Wave 3B contract (`src/contracts/expenses-monthly.ts`) already on main | Task 7 conforms to it; do not redefine it. |
| Contract not on main | Task 7 creates it exactly as specified in the 3B plan (Task 1 there) — one owner; note in `status.json` and tell the 3B session. |
| Samples not yet provided | Run Tasks 0, 2, 3 (migration, contract-agnostic detection) and 6 (tie-out engine on synthetic data); **stop before Task 1's amendment gate**. Tell Gabriel exactly which three files are needed (one per system, each for a year that already has an annual file so the tie-out can be proven). |
| Sample provided for only some systems | Build only those parsers; the others stay `needs-adapter` (the existing ingest already returns `needs-adapter` for unsupported formats) — never a partial guess. |

---

## File structure

- Create `server/warehouse/migrations/035_monthly_ledger.sql` — `monthly_import_batches`, `ledger_monthly`.
- Create `server/warehouse/monthly/types.ts` — `RawMonthlyStatement` types + Zod schema (the parser↔ingest contract).
- Create `server/warehouse/monthly/detect-monthly.ts` — filename detection.
- Create `server/warehouse/monthly/parse-quickbooks.ts`, `parse-yardi.ts`, `parse-appfolio.ts` — **Task 4, sample-gated**.
- Create `server/warehouse/monthly/ingest-monthly.ts` — registration, classification, write — **Task 5, sample-gated** (its sample-independent core is Task 5a below).
- Create `server/warehouse/monthly/tie-out.ts` + `scripts/reconcile-monthly.ts` — tie-out engine and CLI.
- Create `server/warehouse/monthly/monthly-expenses.ts` — read model for the API.
- Modify `server/warehouse/api.ts` — the route; `scripts/bake-warehouse.ts` — optional mirror entry; `src/contracts/expenses-monthly.ts` (+ index).
- Docs: `docs/superpowers/specs/monthly-pl-formats.md` (Task 1 output), `architecture/database-schema.md`, `architecture/api-contracts.md`, `architecture/status.json`.

### Task 0: Preflight, branch, claim

- [ ] **Step 1:** `git fetch`; check open PRs and `architecture/status.json` for claims on `server/warehouse/migrations/`, `src/contracts/`, `package.json`. Confirm the next free migration number: `git ls-tree --name-only origin/main server/warehouse/migrations/ | tail -3` (planned **035**; Oxford Edge (PR #427) holds 034; if taken use the next free integer in the three places it appears — filename, test filename, `database-schema.md`).
- [ ] **Step 2:** `npm run worktree -- add .claude/worktrees/trends-w3a origin/main feat/trends-wave3a`.
- [ ] **Step 3:** append a `trends-wave3a` entry to `architecture/status.json` as a **pure textual append** (verify `git diff` shows 0 removed lines); copy this plan in; two separate commits. Ask Gabriel for the sentinel before Task 2's migration edit.
- [ ] **Step 4:** ask the three open decisions above; record the answers at the top of Task 1's format-notes doc.

### Task 1: Sample inspection → format notes → PLAN AMENDMENT (the gate)

**Precondition:** Gabriel has supplied at least one monthly export per system (QuickBooks "Profit & Loss by Month", Yardi 12-month Income Statement, AppFolio monthly Cash Flow). If not, stop and report which are missing.

- [ ] **Step 1:** For each sample, read it **locally** (ExcelJS or the `xlsx` skill; the Excel MCP is also available) and document in `docs/superpowers/specs/monthly-pl-formats.md`, per system: sheet name(s); where the property name, period range and basis appear (cell/row patterns, exact regexes); how month column headers are written (`Jan 2025`, `Jan 25`, dates, merged cells); where the account name/GL code sit; section headers (`Income`, `Cost of Goods`, `Expenses`, `Other Income/Expense`…) and total rows to ignore; sign conventions (are expenses positive? credits?); a `Total` column and whether it equals the sum of months; hidden/empty columns; the **row labels that mark section totals** (so the tie-out can use them as a self-check, as `qb-excel.ts` does with its "stated value" capture); anything odd (merged header cells, subtotals inside sections, "Unclassified"). **No real figures in the doc** — structure and patterns only.
- [ ] **Step 2:** Record a **ground-truth number set per sample privately** (not committed): the sample's annual total for opex and income, and the per-category totals, so the first tie-out (Task 6) can be proven on real data.
- [ ] **Step 3: Amend this plan.** Replace Tasks 4 and 5 below with fully specified tasks — real column/regex rules, synthetic-fixture builders that reproduce the documented layout, exact expected values — in the same TDD format as the other tasks (complete code, exact commands). Commit the amendment (`docs(plan): wave 3a parsers specified from samples`) and **stop for Gabriel's review of the format notes before Task 4 starts**.

### Task 2: Migration 035 — monthly tables

**Files:** Create `server/warehouse/migrations/035_monthly_ledger.sql`; Test `tests/unit/migration-035-monthly-ledger.test.ts`; Modify `architecture/database-schema.md`.

```sql
-- 035_monthly_ledger.sql — Portfolio Trends Wave 3A: monthly P&L ledger.
-- Separate from import_batches/ledger_entries on purpose: Spine B readers select status='committed'
-- batches by property+period and warehouse:verify asserts their count/hash uniqueness; a monthly
-- batch in those tables would be picked up by annual analytics. Additive only.

CREATE TABLE IF NOT EXISTS monthly_import_batches (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name      TEXT    NOT NULL,
  file_hash      TEXT    NOT NULL UNIQUE,
  raw_path       TEXT    NOT NULL,
  imported_at    TEXT    NOT NULL,
  property_id    TEXT    NOT NULL REFERENCES property_master(id) ON DELETE CASCADE,
  first_month    TEXT    NOT NULL CHECK (first_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  last_month     TEXT    NOT NULL CHECK (last_month  GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  basis          TEXT    NOT NULL CHECK (basis IN ('cash','accrual')),
  source_system  TEXT    NOT NULL CHECK (source_system IN ('quickbooks','yardi','appfolio','rent-manager','unknown')),
  parser_version INTEGER NOT NULL,
  status         TEXT    NOT NULL CHECK (status IN ('committed','pending-review','rejected','superseded')),
  superseded_by  INTEGER REFERENCES monthly_import_batches(id),
  detect_notes   TEXT,
  CHECK (first_month <= last_month)
);

CREATE TABLE IF NOT EXISTS ledger_monthly (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id            INTEGER NOT NULL REFERENCES monthly_import_batches(id) ON DELETE CASCADE,
  property_id         TEXT    NOT NULL REFERENCES property_master(id) ON DELETE CASCADE,
  month               TEXT    NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  raw_account         TEXT    NOT NULL,
  gl_code             TEXT,
  amount              REAL    NOT NULL,
  normalized_category TEXT    NOT NULL,
  classification      TEXT    NOT NULL,
  mapping_id          INTEGER,
  is_active           INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
);

CREATE INDEX IF NOT EXISTS idx_ledger_monthly_prop_month ON ledger_monthly(property_id, month, is_active);
CREATE INDEX IF NOT EXISTS idx_ledger_monthly_batch ON ledger_monthly(batch_id);
```

- [ ] **Step 1: Failing test** (idiom of `tests/unit/migration-033-portfolio-month-snapshot.test.ts` — `:memory:` DB, `foreign_keys = ON`, `runMigrations`, seed `property_master (id, name)`): insert a batch + two ledger rows OK; duplicate `file_hash` rejects; bad `month` (`'2026-1'`, `'October'`), bad `basis` (`'tax'`), `first_month > last_month`, bad `source_system`, bad `status` each reject; deleting the property cascades batches and ledger rows; deleting a batch cascades its rows; `ledger_monthly` has no FK path to `import_batches`.
- [ ] **Step 2:** run → FAIL (no such table).
- [ ] **Step 3:** add the migration verbatim; update `database-schema.md` (history row + two table sections with DDL byte-identical to the `.sql`; the doc's "next free migration number" sentence → 036).
- [ ] **Step 4:** run the new test + `tests/unit/warehouse-migrate.test.ts` + `npm run governance`; typecheck/lint.
- [ ] **Step 5:** commit `feat(warehouse): migration 035 monthly ledger tables` with a `Refute-` trailer in its message.

### Task 3: Monthly filename detection

**Files:** Create `server/warehouse/monthly/detect-monthly.ts`; Test `tests/unit/detect-monthly.test.ts`.

**Interfaces — Produces:**
```ts
export interface MonthlyDetection { propertyId: string | null; propertyToken: string; year: number; format: 'xlsx' | 'xlsm' | 'csv' | 'pdf'; confidence: number }
export function detectMonthlyFromFilename(fileName: string): MonthlyDetection | null;
```
Convention per open decision 2 (recommended `P&L Monthly <year> -- <token>.<ext>`; case-insensitive; spaces around `--` tolerant). Reuse `PROPERTY_ALIASES` — **export it from `detect.ts` if it is not already (a one-word change, covered by its own test)** rather than duplicating the alias table. The existing annual `detectFromFilename` must NOT match monthly names and vice versa (an annual file must never be ingested as monthly).

- [ ] **Step 1: Failing tests:** `P&L Monthly 2025 -- 1100 Rarig.xlsx` → property `1100-rarig-ave-columbus-oh`, year 2025, confidence 0.95; `P&L Monthly 2026 -- 2203 -2207 Northwood.xlsx` (stray space) resolves; unknown token → `propertyId: null`, confidence 0.4; `P&L 2025 -- 1100 Rarig.xlsx` and `P&L 2026 YTD -- FVC.xlsx` → `null` (annual names rejected); `P&L Monthly 2025 -- 1100 Rarig.xlsx.tmp`/`.docx` → `null`; case variations accepted; the annual detector returns `null` for the monthly name (assert both directions).
- [ ] **Step 2–5:** red → implement → green → typecheck/lint → commit `feat(warehouse): monthly P&L filename detection` (touches `server/` ⇒ `Refute-` trailer).

### Task 4: Per-system parsers — **SAMPLE-GATED (specified by Task 1's amendment)**

One sub-task per system with a sample: `parse-quickbooks.ts`, `parse-yardi.ts`, `parse-appfolio.ts`, each returning:

```ts
export interface RawMonthlyLine { rawAccount: string; glCode: string | null; section: string; amounts: Record<string /* 'YYYY-MM' */, number> }
export interface RawMonthlyStatement {
  propertyRaw: string | null; basis: 'cash' | 'accrual'; sourceSystem: 'quickbooks' | 'yardi' | 'appfolio';
  months: string[];                       // ordered 'YYYY-MM' columns actually present
  lines: RawMonthlyLine[];                // leaf accounts only — no subtotal/total rows
  statedTotals: { income: Record<string, number>; expense: Record<string, number> };   // per month, from the file's own total rows, when present — the parser's self-check
}
```
Each parser must self-check: for every month, the sum of `lines` in income-side sections equals `statedTotals.income[month]` and likewise expense, to the cent; a mismatch makes the parse **fail loudly** (never return partial data) — mirrors the foot-check in `qb-excel.ts`. Layout rules, regexes and fixtures come from the amended plan.

### Task 5: Ingest — **5a sample-independent core is specified now; 5b per-system wiring is sample-gated**

**5a Files:** Create `server/warehouse/monthly/ingest-monthly.ts` (core) ; Test `tests/unit/ingest-monthly.test.ts`.

**Interfaces — Consumes:** `RawMonthlyStatement` (Task 4 types — define just the types in `server/warehouse/monthly/types.ts` in this task so 5a does not wait for a parser), `resolveMapping`, `accountKey`, `classificationSide`, `sectionSide` from `mapping.ts`; `sha256File` and the raw-copy helper from `raw-store.ts` (read it; reuse the file-copy + hashing, **not** `registerImport`, which writes `import_batches`). **Produces:**
```ts
export interface IngestMonthlyResult { file: string; status: 'committed' | 'pending-review' | 'duplicate' | 'skipped' | 'needs-adapter' | 'failed'; reason?: string; batchId?: number; months?: number; lines?: number; unmapped?: number }
export function writeMonthlyStatement(db: WarehouseDb, input: { stmt: RawMonthlyStatement; propertyId: string; fileName: string; fileHash: string; rawPath: string; importedAt: string; parserVersion: number }): IngestMonthlyResult;
```
Rules (each pinned by a test): one transaction per file; classification per (line, month) via `resolveMapping(db, line.rawAccount, propertyId, line.section, side)` with `period = month.slice(0,4)`; unmapped accounts land `classification 'excluded'`, category `Unmapped` and the batch becomes `pending-review` (never silently `committed`) — same policy as annual ingest; duplicate `file_hash` → `duplicate`, no rows; a newer file for the same (property, overlapping months, basis) supersedes the older batch (`superseded_by`, old rows `is_active = 0`) — never deleted; basis conflict with an existing active batch for the same property/months → `pending-review` with a reason (cash vs accrual is never merged); a month present in two active batches for the same property → refuse (`failed`) rather than double count; `is_active` rows only counted downstream.
- [ ] **Step 1: Failing tests** with a hand-built `RawMonthlyStatement` (3 months, 4 accounts incl. one unmapped and one dual-side account like "Gas" appearing on income and expense sides): rows written per month with the right classification; unmapped → `pending-review` + `Unmapped`; re-ingest same hash → `duplicate`; superseding file deactivates old rows; overlapping-month conflict → `failed`; basis conflict → `pending-review`; a period-scoped exclusion (seed a mapping with `period '2025'` for one account) excludes that account in 2025 months and not in 2026 months.
- [ ] **Step 2–5:** red → implement → green → typecheck/lint → commit (`Refute-` trailer; this is a shared-state writer — adversarial review before attesting).

**5b (sample-gated):** the orchestrator `ingestMonthlyFile(db, filePath, opts)` (detect → parse per system → `writeMonthlyStatement`), the CLI script `scripts/ingest-monthly.ts` (`npm run warehouse:ingest-monthly -- <folder>`; dry-run by default, `--commit` to write; prints per-file result table), and per-system integration tests with the synthetic layout fixtures from Task 1's amendment. Specified by that amendment.

### Task 6: Tie-out engine and script

**Files:** Create `server/warehouse/monthly/tie-out.ts`, `scripts/reconcile-monthly.ts`; Test `tests/unit/monthly-tie-out.test.ts`; Modify `package.json` (`"reconcile:monthly": "tsx scripts/reconcile-monthly.ts"` — **not** added to the `gate` script).

**Interfaces — Produces:**
```ts
export interface TieOutRow { propertyId: string; year: string; classification: string; category: string; monthlySum: number; annual: number; delta: number; status: 'tied' | 'mismatch' | 'no-annual' | 'partial-year' }
export interface TieOutReport { rows: TieOutRow[]; summary: { tied: number; mismatch: number; noAnnual: number; partialYear: number } }
export function tieOutMonthlyToAnnual(db: WarehouseDb, opts?: { tolerance?: number; propertyId?: string; year?: string }): TieOutReport;   // tolerance default 0.005 (half a cent) — i.e. exact to the cent
```
Rules: compare `Σ ledger_monthly` (active rows, committed batches, `classification` and `normalized_category` grouped) against the **annual** `ledger_entries` total for the same (property, year, basis-compatible batch), using the same active-batch selection the annual analytics use (`selectCoherentBatch` in `metrics.ts` — read it and reuse its result; do not reimplement batch selection); a year with fewer than 12 monthly columns present is `partial-year` and compared against the matching YTD batch only when that batch's period end equals the last monthly column's month-end (else `partial-year` with no verdict — **never** a false pass/fail); a (property, year) with monthly data and no annual batch is `no-annual`; basis mismatch between the monthly batch and the annual batch → the pair is skipped and reported (`basis-mismatch` reason), never compared. Known real-world wrinkles the tests must cover with synthetic data: a period-scoped exclusion (`period '2025'`) that applies to both sides; YTD files whose stamped `period_end` is wrong (e.g. `2026-12-31` on a mid-year file) — such a batch is reported as `partial-year`/untrustworthy with a data-quality note, not compared; Sepich roll-up compared as one entity.
- [ ] **Step 1: Failing tests** (build a temp warehouse with a hand-seeded annual batch + ledger and a monthly batch whose 12 months sum exactly / off by $1.00 / sum to the annual but with one category moved): `tied`; `mismatch` with the exact delta; the category-shift case flags both categories; `partial-year` handling; `no-annual`; basis mismatch skipped and reported; the exclusion case ties.
- [ ] **Step 2–5:** red → implement → green; the script prints a table and exits non-zero on any `mismatch` (zero otherwise; `partial-year`/`no-annual` are reported but not failures); commit with `Refute-` trailer.
- [ ] **Step 6 (real-data proof — only once Task 4's first parser exists and Gabriel supplied a sample whose annual file is in the warehouse):** run `reconcile:monthly` against a **scratch copy** of the warehouse (SQLite backup API) with the sample ingested; every category must tie to the cent against the private ground-truth numbers from Task 1 Step 2. Report any category that does not and why before proceeding — do not loosen the tolerance to make it pass.

### Task 7: Read model, contract and API

**Files:** Create `server/warehouse/monthly/monthly-expenses.ts`; Modify `server/warehouse/api.ts`, `src/contracts/expenses-monthly.ts` (create only if absent — see contingencies) + `index.ts`, `scripts/bake-warehouse.ts`, `architecture/api-contracts.md`; Tests `tests/unit/monthly-expenses.test.ts`, `tests/unit/warehouse-expenses-monthly-api.test.ts`, extend `tests/unit/warehouse-mirror-bake.test.ts`.

**Interfaces — Produces:** `monthlyExpensePoints(db): { points: ExpenseMonthPoint[]; coverage: {...} }` and `GET /analytics/expenses/monthly` returning `ExpensesMonthlyResponseSchema` (contract defined in the 3B plan, Task 1: points `{propertyId, month, category, amount, basis, sourceSystem}` — opex only; `coverage {propertiesLoaded, propertiesExpected, firstMonth, lastMonth}`). Rules: `classification = 'opex'` and `is_active = 1` rows of `committed` batches only (never `pending-review`); `excluded`/`capex`/`ti`/`leasing`/`debt-service` never appear; amounts summed per (property, month, category); `propertiesExpected` = active investment properties in `property_master` that have `financial_mode = 'pnl'` or `'cashflow'` (not `lease-run`); `basis`/`sourceSystem` come from the batch; the route parses through the schema before `c.json` behind the usual 503 guard; baked as an **optional** mirror route (add to `FIXED_ROUTES` and the optional set, like `/analytics/trends/history`).
- [ ] **Step 1–5:** failing tests (opex-only filter incl. a `pending-review` batch invisible; per-category sums hand-computed over two properties and two months; coverage counts; empty table → `{points: [], coverage zeros}`; route 200/503/Zod-parse; bake plan contains the path and its failure does not abort the bake) → implement → green → typecheck/lint/governance (duplicate-route-prefix scan) → commit with `Refute-` trailer.

### Task 8: Verification, live-run, PR

- [ ] Focused tests for every file above; `npm run gate` (known-red `reconcile` step aside; later steps by hand, including `warehouse:verify` — it must still report `committed >= 32` and the same hashes, proving Spine B was untouched — and `warehouse:drift`).
- [ ] Prove **Spine B untouched**: before/after row counts and a content hash of `import_batches` and `ledger_entries` on a scratch copy after a full monthly ingest — identical.
- [ ] `adversarial-reviewer` (explicit `model`) on the whole branch: double counting across overlapping/superseding batches, basis mixing, period-scoped exclusion parity, pending-review leakage into the API, parsers accepting wrong columns, any path that lets monthly rows reach `import_batches`/`ledger_entries` readers, the tie-out passing vacuously (zero rows compared).
- [ ] **Live run (needs Gabriel's go-ahead):** back up the live warehouse (SQLite backup API → `data/_backup/finance.sqlite.pre-035-<date>`), apply migration 035 by starting the Brain server (migrations run on open), ingest the real files with `--commit`, run `reconcile:monthly`, report the tie-out table. Real files are never committed.
- [ ] Push and open the PR only with Gabriel's go-ahead; `Refute-` trailers per commit (`npx tsx scripts/check-refute-required.ts --strict --base=origin/main --head=$(git rev-parse HEAD)`); squash message carries the union of trailers.

---

## Self-review

- **Coverage:** monthly ingestion for all three systems ✔ (T4/5b, sample-gated), classification parity incl. period-scoped exclusions ✔ (T5a, T6), tie-out to the annual ledger ✔ (T6), API + contract + mirror ✔ (T7), Spine B isolation ✔ (T2 design, T8 proof), basis discipline ✔ (T2 CHECK, T5a, T6).
- **Deliberately unspecified (and why):** Task 4 and Task 5b — their layouts are unknown; Task 1 forces a plan amendment and a Gabriel review before any parser code exists.
- **Risks called out:** wrong YTD `period_end` stamps in existing batches (T6 reports instead of comparing); cash/accrual entities (T6 skips mismatches); a monthly batch leaking into Spine B (separate tables); partial years (T6 `partial-year`).
- **Placeholder scan:** the parser and 5b task bodies are explicit gated stubs by design (stated at the top and in Task 1 Step 3); every other task shows its DDL, interfaces, rules and test cases.
