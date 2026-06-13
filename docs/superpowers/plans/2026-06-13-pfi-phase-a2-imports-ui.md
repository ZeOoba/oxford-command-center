# PFI Phase A.2 — Imports & Data-Quality UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Property Financial Intelligence" navigation module exposing the Phase A warehouse — NOI matrix, import audit trail with approve/reject review queue, data-quality issues with resolution, and mapping overrides with ledger re-derivation — backed by new `/api/warehouse/*` Hono routes.

**Architecture:** Server: `server/warehouse/queries.ts` (reads) + `server/warehouse/actions.ts` (mutations, all transactional) + `server/warehouse/api.ts` (Hono sub-router mounted in `server/index.ts`; warehouse DB opened as a lazy singleton from `WAREHOUSE_DB` env, default `data/warehouse/finance.sqlite`). Client: one lazy `intel` module (`src/modules/intel/`) with internal views (Overview/NOI, Imports, Data Quality, Mappings) using TanStack Query against the new routes; graceful degradation on the static mirror (routes absent → informational empty state, never a crash). Reuse Card/CardHeader/KpiStat/Badge/DataTable primitives and chart theme tokens.

**Tech Stack:** existing only — Hono 4, better-sqlite3, Zod, React 19, TanStack Query, Tailwind 4, vitest (`app.request()` for route tests). No new dependencies.

**Conventions:** strict TS (`noUncheckedIndexedAccess`, `verbatimModuleSyntax` → `import type`), ESLint `--max-warnings 0`, tests in `tests/unit/`, temp dbs via `mkdtempSync`. Single test file: `npx vitest run tests/unit/<f>.test.ts`. Gate: `npm run gate` (includes reconcile + warehouse:verify). Commit per task with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

**Canon constraints (do not re-decide):** approve requires zero unmapped rows (re-resolve at approve time; fail with the unmapped list otherwise) · approving supersedes prior committed versions for the same (property, period span) and activates rows · nothing is ever deleted (reject = status `rejected`, rows stay inactive) · mapping overrides are `match_kind='manual'` appends (manual beats seed per existing precedence) and re-derive ACTIVE ledger rows matching the account key (+optional property scope) · all amounts/figures rendered with the repo's `fmtUsd`-style formatting (`src/analytics/format.ts`).

---

### Task 1: Warehouse read queries (`server/warehouse/queries.ts`)

**Files:** Create `server/warehouse/queries.ts` · Test `tests/unit/warehouse-queries.test.ts`

- [ ] **Step 1 — failing test.** Build a temp warehouse (openWarehouse + seedPropertyMaster + seedMappings with the ingest-test SEED) and ingest the existing QB fixture from `tests/unit/warehouse-ingest.test.ts` (copy the `writeFixture` helper — do not import across test files). Assert:

```typescript
import { listImports, getImportDetail, listIssues, noiMatrix } from '../../server/warehouse/queries';
// after one committed ingest of 'P&L 2025 -- 1100 Rarig.xlsx':
const imports = listImports(db);
expect(imports).toHaveLength(1);
expect(imports[0]).toMatchObject({
  fileName: 'P&L 2025 -- 1100 Rarig.xlsx',
  propertyId: '1100-rarig-ave-columbus-oh',
  propertyName: '1100 Rarig Ave, Columbus OH',
  status: 'committed', version: 1, period: '2025',
});
const detail = getImportDetail(db, imports[0]!.id);
expect(detail?.rows).toHaveLength(3);
expect(detail?.rows.map(r => r.classification).sort()).toEqual(['excluded', 'opex', 'revenue']);
expect(detail?.issues).toEqual([]);
const issues = listIssues(db);            // open issues across the warehouse, batch-joined
expect(issues).toEqual([]);
const matrix = noiMatrix(db);             // [{propertyId, propertyName, period, noi}]
expect(matrix).toEqual([{ propertyId: '1100-rarig-ave-columbus-oh', propertyName: '1100 Rarig Ave, Columbus OH', period: '2025', noi: 95000 }]);
```

- [ ] **Step 2 — run, watch fail** (module not found).
- [ ] **Step 3 — implement.** Pure read functions over `WarehouseDb` (parameterized SQL only). `listImports`: join `property_master` for the name, order `imported_at DESC`, expose `{id, fileName, propertyId, propertyName, period (period_start year), periodStart, periodEnd, grain, basis, sourceSystem, version, status, confidence, importedAt}`. `getImportDetail(db, id)`: batch row or null + its ledger rows `{rawAccount, glCode, amount, normalizedCategory, classification, isActive}` + its DQ issues. `listIssues(db, status='open')`: issues joined to batch file name + property. `noiMatrix(db)`: the same active-rows NOI SQL used by the backfill CLI, joined to `property_master` names. Camel-case mapping done by hand (`as` aliases), Zod not required for reads.
- [ ] **Step 4 — green; Step 5 — commit** `feat(warehouse): read queries for imports, issues, NOI matrix`.

### Task 2: Warehouse actions (`server/warehouse/actions.ts`)

**Files:** Create `server/warehouse/actions.ts` · Test `tests/unit/warehouse-actions.test.ts`

- [ ] **Step 1 — failing tests** (use a pending-review ingest: seed only the 'Rent' mapping so HVAC Repair + Distribution come back unmapped → status pending-review, rows inactive):

```typescript
import { addMappingOverride, approveImport, rejectImport, resolveIssue } from '../../server/warehouse/actions';
// (a) approve refuses while unmapped rows remain
const refusal = approveImport(db, importId);
expect(refusal.ok).toBe(false);
if (!refusal.ok) expect(refusal.unmapped).toEqual(expect.arrayContaining(['HVAC Repair', 'Distribution to Owner']));
// (b) overrides resolve the gap and re-derive
addMappingOverride(db, { account: 'HVAC Repair', normalizedCategory: 'Repairs & Maintenance', classification: 'opex' });
addMappingOverride(db, { account: 'Distribution to Owner', normalizedCategory: 'Distributions', classification: 'excluded' });
const ok = approveImport(db, importId);
expect(ok.ok).toBe(true);
// rows re-resolved, activated, batch committed
const active = db.prepare("SELECT raw_account, classification FROM ledger_entries WHERE is_active=1 ORDER BY raw_account").all();
expect(active).toHaveLength(3);
expect(db.prepare('SELECT status FROM import_batches WHERE id=?').get(importId)).toMatchObject({ status: 'committed' });
// (c) approving supersedes a prior committed version for the same period (ingest a corrected file → pending → approve → v1 superseded, v1 rows inactive, v2 active)
// (d) rejectImport: status 'rejected', rows stay inactive; approving a rejected import fails
// (e) resolveIssue(db, issueId): status 'resolved', resolved_at set
// (f) addMappingOverride with propertyId scopes the override; re-derivation only touches ACTIVE rows whose accountKey matches (assert an unrelated property's rows untouched)
```

Write (c)–(f) as real tests with concrete assertions, same patterns as (a)/(b).

- [ ] **Step 2 — fail; Step 3 — implement.** All mutations inside `db.transaction`. `approveImport`: load batch (must be `pending-review`); re-run `resolveMapping` (with section recovered from… NOTE: ledger rows do not store section — re-resolve WITHOUT section, acceptable because overrides are side-agnostic manual rulings; document this in a comment); if any resolve to `matchKind==='unmapped'` return `{ok:false, unmapped:[...]}`; else update each row's category/classification/mapping_id, supersede prior committed batches for the same `(property_id, period_start, period_end)` exactly like `ingest.ts` does (reuse by extracting that supersede block from `ingest.ts` into an exported `supersedePriors(db, batch)` helper in `actions.ts`? NO — keep `ingest.ts` untouched; duplicate the 6-line SQL with a comment referencing ingest.ts to avoid touching the proven pipeline in this PR). Set rows `is_active=1`, batch `status='committed'`. `rejectImport`: pending-review → `rejected`. `resolveIssue`: open → resolved + `resolved_at=datetime('now')`. `addMappingOverride`: insert `account_mappings` row (`match_kind='manual'`, `raw_account_key=accountKey(account)`, optional property_id), then `UPDATE ledger_entries SET normalized_category=?, classification=?, mapping_id=? WHERE is_active=1 AND (property scope) AND raw_account-key matches` — match via the same `accountKey` normalization (SQL can't call it: select distinct raw_account of candidate rows, filter in JS, update by id list).
- [ ] **Step 4 — full suite green; Step 5 — commit** `feat(warehouse): review-queue actions (approve/reject, issue resolution, mapping overrides with re-derivation)`.

### Task 3: API routes (`server/warehouse/api.ts` + mount)

**Files:** Create `server/warehouse/api.ts` · Modify `server/index.ts` (mount + lazy singleton) · Test `tests/unit/warehouse-api.test.ts`

- [ ] **Step 1 — failing test** using Hono's `app.request()` against a router built with an injected temp db:

```typescript
import { warehouseRoutes } from '../../server/warehouse/api';
const app = warehouseRoutes(() => db); // factory takes a db-getter for testability
const res = await app.request('/imports');
expect(res.status).toBe(200);
expect((await res.json() as { imports: unknown[] }).imports).toHaveLength(1);
// /imports/:id → 200 detail, 404 unknown id
// /noi → matrix; /issues → list
// POST /imports/:id/action {action:'approve'} → {ok:false, unmapped:[...]} for the pending fixture (HTTP 409)
// POST /mappings {account, normalizedCategory, classification} → 200; then approve → 200 {ok:true}
// POST /issues/:id/resolve → 200
// invalid body → 400 (validate with Zod schemas defined in api.ts)
```

- [ ] **Step 2 — fail; Step 3 — implement.** `warehouseRoutes(getDb)` returns a `new Hono()` with the routes above (JSON bodies Zod-validated; map `{ok:false}` approve to 409). In `server/index.ts`: lazy singleton `let _wh: WarehouseDb | null` opened from `process.env.WAREHOUSE_DB ?? join(process.cwd(),'data','warehouse','finance.sqlite')` on first request; `app.route('/api/warehouse', warehouseRoutes(getWarehouse))`. If the sqlite file/dir cannot be opened, routes return 503 `{error:'warehouse unavailable'}` (mirror/cold environments) — never crash the server.
- [ ] **Step 4 — green (incl. existing server tests); Step 5 — commit** `feat(warehouse): /api/warehouse routes (imports, issues, noi, actions) mounted in brain server`.

### Task 4: Client hooks (`src/modules/intel/hooks.ts`)

**Files:** Create `src/modules/intel/hooks.ts` · Test `tests/unit/intel-hooks.test.ts` (pure helpers only)

- [ ] Implement TanStack Query hooks following `src/data/queries.ts` patterns: `useWarehouseImports()`, `useImportDetail(id|null)`, `useWarehouseIssues()`, `useNoiMatrix()` (staleTime 30s, retry 1) and mutations `useImportAction()` (approve/reject → invalidate imports+noi+issues), `useAddMapping()`, `useResolveIssue()`. All fetches via relative `/api/warehouse/...`; a shared `fetchJson` that throws a typed `WarehouseUnavailableError` on 503/404-html (mirror) — hooks expose `isUnavailable`. Unit-test the pure response-shaping helpers (e.g. `groupNoiByProperty(matrix)` → rows keyed by property with period columns, used by the Overview table); UI hooks themselves are covered by the route tests + e2e smoke, not jsdom fetch mocking.
- [ ] Commit `feat(intel): warehouse data hooks`.

### Task 5: Intel module UI (`src/modules/intel/`)

**Files:** Create `src/modules/intel/IntelModule.tsx`, `ImportsView.tsx`, `DataQualityView.tsx`, `MappingsView.tsx` · Modify `src/shell/modules.tsx`, `src/shell/module-order.ts` (after 'portfolio' for both profiles), `src/shell/AppShell.tsx` TITLES (`intel: 'Property Financial Intelligence'`).

- [ ] Structure (match module conventions — read `src/modules/portfolio/PortfolioModule.tsx` and `close/CloseModule.tsx` first):
  - `IntelModule`: internal tab state `'overview'|'imports'|'quality'|'mappings'` (Badge-style tab buttons in a CardHeader). **Overview**: KpiStat row (committed imports, open issues, properties covered, latest period) + NOI-by-property table (rows = properties, columns = periods from `groupNoiByProperty`, mono `fmtUsd`, YTD column labeled with grain). **Imports**: DataTable (file, property, period, version, status Badge — committed=green, pending-review=amber, superseded=neutral, rejected=red, needs-adapter=blue) → row click opens an inline detail panel (ledger rows table + issues + Approve/Reject buttons for pending; approve 409 shows the unmapped list with a per-account "Add mapping" inline form that calls `useAddMapping` then retries). **Data Quality**: issues DataTable (severity Badge, kind, file, detail, Resolve button). **Mappings**: read-only count summary + add-override form (account, category select from the canonical list, classification select, optional property) — this is the manual-ruling surface.
  - Unavailable state (mirror/static): single Card "Warehouse requires the live brain server" when `isUnavailable`.
  - Lazy registration identical to other modules; icon `Database` (lucide), group `'Assets'`.
- [ ] Verify in browser per the repo's dev flow (`npm run dev`, module renders, tabs work, approve flow on a staged pending import if any exists — otherwise verify empty states). Use the preview tools; capture a screenshot.
- [ ] Commit `feat(intel): Property Financial Intelligence module (overview, imports review queue, data quality, mappings)`.

### Task 6: Gate + bundle + changelog

- [ ] `npm run gate` green end-to-end; `npm run build && npm run check:bundle` (entry budget — the module must be lazy).
- [ ] CHANGELOG entry "PFI Phase A.2 — Imports & Data-Quality UI". Commit `docs: changelog for PFI Phase A.2`.

## Out of scope (Phase B+)
Per-property intelligence pages, analytics/trends, scores, benchmarking, briefings, PDF exports, PM scorecards, Northwood PDF adapter.

## Self-review
- Spec coverage: review queue ✓ (Task 2/3/5), audit trail ✓ (Task 1 listImports + detail, Task 5 Imports view), mapping overrides + re-derivation ✓ (Task 2/5), DQ visibility incl. sign-normalized/foot-mismatch ✓ (Task 1/5), correction workflows ✓ (approve-after-override loop).
- Types: `WarehouseDb` from db.ts everywhere; `accountKey` reused from mapping.ts; statuses match ImportStatus enum in contracts.
- The proven Phase A pipeline (`ingest.ts`, parser, verify) is NOT modified by this plan.
