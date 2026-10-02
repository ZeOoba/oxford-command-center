# Portfolio Trends — Wave 2 (Recorded Month-End History) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop reconstructing history from today's leases. Capture real per-property month snapshots (rent, leased SF, lease count, workbook occupancy) into the warehouse on every workbook refresh, freeze each month once it ends, serve them through an API, and have the Trends tab prefer recorded months over reconstructed ones — which makes unbiased MoM/YoY possible and resolves the lease-SF-vs-workbook-occupancy basis gap flagged in Wave 1's final review.

**Architecture:** New additive table `portfolio_month_snapshot` (one row per property per month; current month upserts until the month rolls, then freezes). Capture runs beside `captureOccupancy` on the server's `brain.on('snapshot')` hook, reusing the Wave 1 engine (`buildPortfolioTrend`) to compute each property's point so the recorded and reconstructed series share one definition. Reconstructed data is NEVER written to the DB (it is biased — leases already off the roll are missing); the DB only ever holds what was observed. A read-only route returns recorded series; the client merges recorded-over-reconstructed per month and labels each month's source.

**Tech Stack:** SQLite (better-sqlite3) + numbered migrations, Hono routes, Zod contracts, TanStack Query, Vitest.

## Global Constraints

- **Architect-owned files — claim first.** Before touching any of: `server/warehouse/migrations/`, `src/contracts/` (incl. `index.ts`), `server/index.ts`, `architecture/database-schema.md`, `package.json`, `scripts/governance-check.ts` — add your entry to `architecture/status.json` with `review_needed: true` and wait for acknowledgment (CLAUDE.md §4–5). Task 0 does this. Gabriel co-develops this tree; read `status.json` for another session's claim on the same files first (shared-infra rule, CLAUDE.md §2).
- **Migrations:** never use `CREATE TABLE IF NOT EXISTS` to change an existing table; additive new table only. **Migration number:** this plan writes `033` because the highest existing file at planning time (2026-10-02) is `032_lm_cumulative_reduction_event_chain.sql`. Task 0 re-checks `ls server/warehouse/migrations`; if `033` is taken, use the next free integer in the three places it appears (filename, test filename, `database-schema.md` row). Duplicate numeric prefixes are forbidden (`database-schema.md` note on 017).
- **Basis discipline:** recorded points are lease-derived (same definition as Wave 1) plus workbook `occPct` stored as a separate column — never blended. Never compare to `Property.noi` or warehouse ledger NOI.
- **Scope:** `isInvestmentProperty` only (residence excluded, ruling 2026-09-24).
- **Time:** the capture month is the **US-Eastern calendar month of `meta.generatedAt`** — never `meta.asOf` (the workbook dateline, which only moves when the workbook is saved) and never UTC slicing. This is the trap documented in `occupancy.ts` `captureOccupancy`.
- **Live-DB safety:** never DDL against `data/warehouse/finance.sqlite` directly; migrations only; tests use temp DBs. Run dev servers from a worktree with `WAREHOUSE_DB` pointed at a scratch file.
- **Do NOT touch:** `data/overlay.json`, `confidential-terms.json`, `data/snapshots/portfolio.json` (Gabriel's dirty file), CORS config, the gate (do not add or remove gate steps without architect + Gabriel approval).
- **Gate:** `npm run gate` green on every commit. The `reconcile` step is known-red on main (snapshot cash-history drift; memory `reconcile-cash-history-drift-main`) — prove the later steps manually and say so. `npm test` can exit `0xC0000005` intermittently — rerun. CI hosted runners are blocked by Actions billing (memory `ci-blocked-by-actions-billing`) — use `CI_RUNNER=self` (#399) if CI evidence is needed.
- **Commits:** explicit paths only (never `git add -A`); commit-message trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- **Financial-decision code:** this feature is read-only reporting and must not feed capital-allocation verdicts. If a task ends up wiring recorded rent into any scoring/verdict path, STOP — that triggers the `refute-financial-change` workflow.

## Sequencing & contingencies (read before Task 0 — depends on PR #423)

Wave 2 builds on Wave 1's `src/analytics/portfolio-trends.ts` (`MonthPoint`, `buildPortfolioTrend`, `monthOf`, `addMonths`) and `src/modules/portfolio/{TrendsView,trends-chart-data,tabs}.ts*`. At execution time, determine PR #423's state (`gh pr view 423 --repo ZeOoba/oxford-command-center --json state,mergeStateStatus,reviewDecision`) and take exactly one branch:

| #423 state | Action |
|---|---|
| **Merged (squash) to main** | `git fetch`; new worktree off `origin/main` (`npm run worktree -- add .claude/worktrees/trends-w2 origin/main feat/trends-wave2`). Everything below applies as written. |
| **Open, no changes requested** | Stacked PR: worktree off `origin/feat/portfolio-trends`; open the Wave 2 PR with body line `Base branch: feat/portfolio-trends. Merge #423 first.` After #423 squash-merges: `git rebase --onto origin/main <old-base-sha> HEAD`, retarget, force-with-lease (ask first), close/reopen to fire CI (memory `stacked-pr-restack`). |
| **Open, changes requested / review edits land on the branch** | Re-read the diff (`git diff <your-base>..origin/feat/portfolio-trends`) before starting. Tasks 1–4 and 6 (server side) are independent of #423 and can proceed on a fresh branch off `origin/main` immediately; defer Tasks 5 and 7 (client merge + UI) until #423's `MonthPoint`/`TrendsView` shape settles. Task 5 is written against `MonthPoint` only through its public fields (`month, isForecast, inPlaceRent, leasedSf, totalSf, vacantSf, vacancyPct, leaseCount`); if review renames any, adapt Task 5's mapper in one place (`recordedToMonthPoint`) and its test. |
| **Closed unmerged / abandoned** | Stop. Ask Gabriel whether to (a) reopen/re-land Wave 1 first, or (b) cherry-pick the Wave 1 commits (`a920f1b..b45d630`) onto the Wave 2 branch. Do not silently re-implement Wave 1. |
| **Merge conflicts or main drifted** | Merge `origin/main` in (never rebase a shared branch, never force-push main); resolve; re-run the focused tests. |

Server-side Tasks 1–4 only need `buildPortfolioTrend` from Wave 1's engine. If #423 is not merged when they run, they import it from the stacked base; if the engine's signature changed in review, adjust only the single call in `month-snapshot.ts` (`computeMonthPoints`) and its test.

---

## File structure

- Create `server/warehouse/migrations/033_portfolio_month_snapshot.sql` — table + indexes.
- Create `server/warehouse/month-snapshot.ts` — capture (`captureMonthSnapshot`), freeze, read (`monthSnapshotSeries`).
- Modify `server/warehouse/occupancy.ts` — `export` the existing private `easternCalendarDay` (no behavior change).
- Modify `server/index.ts` — call `captureMonthSnapshot` in the existing `brain.on('snapshot')` handler (guarded like its siblings).
- Create `src/contracts/trends.ts` + modify `src/contracts/index.ts` — Zod response schema.
- Modify `server/warehouse/api.ts` — `GET /analytics/trends/history`.
- Modify `scripts/bake-warehouse.ts` — add the endpoint to the baked mirror list (static-mirror parity), if `tests/unit/warehouse-mirror-bake.test.ts` shows the endpoint list is enumerated.
- Create `src/modules/portfolio/trends-history.ts` — `useTrendsHistory` hook + pure `mergeRecorded` / `recordedToMonthPoint` / `recordedYoY`.
- Modify `src/modules/portfolio/TrendsView.tsx` — consume merged points, source badge, restore YoY when recorded.
- Tests: `tests/unit/migration-033-portfolio-month-snapshot.test.ts`, `tests/unit/warehouse-month-snapshot.test.ts`, `tests/unit/warehouse-trends-history-api.test.ts`, `tests/unit/trends-history-merge.test.ts`, additions to `tests/unit/portfolio-trends-view.test.tsx` and `tests/unit/warehouse-occupancy.test.ts`.
- Modify `architecture/database-schema.md` (migration row + table section), `architecture/api-contracts.md` (route), `architecture/status.json` (claim).

### Task 0: Preflight, branch, and architect claim

**Files:**
- Modify: `architecture/status.json`
- Copy: this plan into the new worktree's `docs/superpowers/plans/` (it is untracked in the main checkout)

- [ ] **Step 1: Determine PR #423 state and pick the branch row** from the contingency table above.
  Run: `gh pr view 423 --repo ZeOoba/oxford-command-center --json state,mergeStateStatus,reviewDecision,headRefOid`
  Expected: one of the five rows applies. Record which one in your task report.

- [ ] **Step 2: Create the worktree** (real `npm install`, no junction — memory `node-modules-junction-footgun`):
  Run: `npm run worktree -- add .claude/worktrees/trends-w2 <base-ref> feat/trends-wave2`
  where `<base-ref>` is `origin/main` or `origin/feat/portfolio-trends` per Step 1.

- [ ] **Step 3: Re-verify the migration number.**
  Run: `ls server/warehouse/migrations | tail -3`
  Expected: highest is `032_…` (or higher). Use the next free integer everywhere this plan says `033`.

- [ ] **Step 4: Read `architecture/status.json`; confirm no other entry claims `server/index.ts`, `server/warehouse/migrations/`, or `src/contracts/`.** If one does, coordinate (ask Gabriel) before editing. Then add your entry:

```json
"trends-wave2": {
  "agent_role": "Integration Agent + UX Agent — Claude Code",
  "phase": "Portfolio Trends Wave 2: portfolio_month_snapshot table + capture hook + /analytics/trends/history + Trends UI merge",
  "status": "in_progress",
  "blocked_by": null,
  "review_needed": true,
  "review_detail": "Architect-owned: migration 033, src/contracts/trends.ts (+ index export), server/index.ts capture call, architecture/database-schema.md. Additive only; no existing table altered.",
  "last_updated": "2026-10-02T00:00:00Z"
}
```
  (Set `last_updated` to the real UTC time.) Commit it alone: `git add architecture/status.json && git commit -m "chore(status): claim trends-wave2"`; wait for acknowledgment before Task 1's migration is merged (local work may proceed).

- [ ] **Step 5: Copy this plan into the worktree and commit:** `git add docs/superpowers/plans/2026-10-02-portfolio-trends-wave2.md && git commit -m "docs(plan): portfolio trends wave 2"`.

### Task 1: Migration 033 — `portfolio_month_snapshot`

**Files:**
- Create: `server/warehouse/migrations/033_portfolio_month_snapshot.sql`
- Test: `tests/unit/migration-033-portfolio-month-snapshot.test.ts`
- Modify: `architecture/database-schema.md` (migration-history row + a table section; update the "next free migration number" note to 034)

**Interfaces:**
- Produces: table `portfolio_month_snapshot(id, property_id, month, captured_through, total_sf, leased_sf, in_place_rent, lease_count, occ_pct, frozen, recorded_at)` with `UNIQUE(property_id, month)`.

- [ ] **Step 1: Write the failing test** (mirror `tests/unit/migration-032-lm-cumulative-reduction.test.ts`: `new Database(':memory:')`, `foreign_keys = ON`, `runMigrations(db)`; seed one `property_master` row inline with the minimal NOT NULL columns `id`, `name`):

```ts
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/warehouse/migrate';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare("INSERT INTO property_master (id, name) VALUES ('p1', 'P1')").run();
  return db;
}
const ins = (db: Database.Database, o: Record<string, unknown> = {}) => {
  const r = { property_id: 'p1', month: '2026-10', captured_through: '2026-10-02', total_sf: 1000, leased_sf: 800, in_place_rent: 9000, lease_count: 3, occ_pct: 0.8, ...o };
  return db.prepare(
    `INSERT INTO portfolio_month_snapshot (property_id, month, captured_through, total_sf, leased_sf, in_place_rent, lease_count, occ_pct)
     VALUES (@property_id, @month, @captured_through, @total_sf, @leased_sf, @in_place_rent, @lease_count, @occ_pct)`,
  ).run(r);
};

describe('migration 033 portfolio_month_snapshot', () => {
  it('creates the table and enforces UNIQUE(property_id, month)', () => {
    const db = makeDb();
    ins(db);
    expect(() => ins(db)).toThrow(/UNIQUE/);
  });
  it('rejects a malformed month key', () => {
    expect(() => ins(makeDb(), { month: '2026-1' })).toThrow(/CHECK/);
    expect(() => ins(makeDb(), { month: 'October' })).toThrow(/CHECK/);
  });
  it('rejects negative SF / rent / count and out-of-range occ_pct; allows NULL occ_pct', () => {
    expect(() => ins(makeDb(), { leased_sf: -1 })).toThrow(/CHECK/);
    expect(() => ins(makeDb(), { in_place_rent: -5 })).toThrow(/CHECK/);
    expect(() => ins(makeDb(), { lease_count: -1 })).toThrow(/CHECK/);
    expect(() => ins(makeDb(), { occ_pct: 1.2 })).toThrow(/CHECK/);
    expect(() => ins(makeDb(), { occ_pct: null })).not.toThrow();
  });
  it('defaults frozen to 0 and cascades on property delete', () => {
    const db = makeDb();
    ins(db);
    expect((db.prepare('SELECT frozen FROM portfolio_month_snapshot').get() as { frozen: number }).frozen).toBe(0);
    db.prepare("DELETE FROM property_master WHERE id = 'p1'").run();
    expect((db.prepare('SELECT COUNT(*) AS n FROM portfolio_month_snapshot').get() as { n: number }).n).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**
  Run: `npx vitest run tests/unit/migration-033-portfolio-month-snapshot.test.ts`
  Expected: FAIL — `no such table: portfolio_month_snapshot`.

- [ ] **Step 3: Write the migration**

```sql
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
```

- [ ] **Step 4: Run to verify it passes**
  Run: `npx vitest run tests/unit/migration-033-portfolio-month-snapshot.test.ts tests/unit/warehouse-migrate.test.ts`
  Expected: PASS (the second file proves the migration chain/ordering still holds; if it asserts a migration count or last filename, update that assertion legitimately and say so in the report).

- [ ] **Step 5: Update `architecture/database-schema.md`** — add the `033` row to the history table (note: "Portfolio Trends Wave 2 — recorded month snapshots; additive"), add a `### portfolio_month_snapshot` section with the DDL above, and change the "next free migration number" sentence to `034`.

- [ ] **Step 6: Commit**
  ```bash
  git add server/warehouse/migrations/033_portfolio_month_snapshot.sql tests/unit/migration-033-portfolio-month-snapshot.test.ts architecture/database-schema.md
  git commit -m "feat(warehouse): migration 033 portfolio_month_snapshot"
  ```

### Task 2: Capture + freeze (`captureMonthSnapshot`)

**Files:**
- Modify: `server/warehouse/occupancy.ts` (export `easternCalendarDay`)
- Create: `server/warehouse/month-snapshot.ts`
- Test: `tests/unit/warehouse-month-snapshot.test.ts`; add one test to `tests/unit/warehouse-occupancy.test.ts` for the export

**Interfaces:**
- Consumes: `buildPortfolioTrend(leases, properties, { asOf, monthsBack, monthsForward })` and `MonthPoint` from `src/analytics/portfolio-trends.ts` (Wave 1); `isInvestmentProperty`; `WarehouseDb`.
- Produces:
  - `easternCalendarDay(iso: string | undefined | null): string | null` (now exported from `occupancy.ts`)
  - `interface MonthSnapshotView { properties: ReadonlyArray<{ id: string; sf: number; occPct: number; type?: string }>; leases: ReadonlyArray<Lease>; meta: { generatedAt: string } }`
  - `captureMonthSnapshot(db: WarehouseDb, snapshot: MonthSnapshotView | null): { recorded: number; skipped: number; frozen: number }`
  - `interface MonthSnapshotRow { propertyId: string; month: string; capturedThrough: string; totalSf: number; leasedSf: number; inPlaceRent: number; leaseCount: number; occPct: number | null; frozen: boolean }`
  - `monthSnapshotSeries(db: WarehouseDb, propertyId?: string): MonthSnapshotRow[]` (ordered by property then month ascending)

Semantics (pin each in a test):
1. Capture day = `easternCalendarDay(generatedAt)`; capture month = its first 7 chars. A null snapshot or unparseable `generatedAt` is a safe no-op `{0,0,0}`.
2. For each investment property in `property_master`: compute the property's point via `buildPortfolioTrend(leases, [thatProperty-only list… or all], { asOf: captureDay, monthsBack: 0, monthsForward: 0 }).byProperty[id][0]` and upsert `(property_id, month)` with `ON CONFLICT … DO UPDATE … WHERE frozen = 0` (a frozen row is never overwritten; count it as `skipped`).
3. After upserting month M, mark every row for the same property with `month < M` and `frozen = 0` as `frozen = 1` (returns the count as `frozen`).
4. Roster-drift guard identical in spirit to `recordOccupancyBatch`: ids not in `property_master` are skipped with one `console.warn` listing them; an empty `property_master` with a non-empty property list THROWS (so the server's catch surfaces it, never a silent `{0}`); duplicate ids in one batch — first wins.
5. Non-finite `sf`/`occPct` → skip that property (never write NaN); `occPct` outside [0,1] stores `NULL` for `occ_pct` but still records the lease-derived columns.

- [ ] **Step 1: Write the failing tests** in `tests/unit/warehouse-month-snapshot.test.ts` using the `freshDb()` idiom from `tests/unit/warehouse-occupancy.test.ts` (`openWarehouse` on a temp file + `seedPropertyMaster`). Build a minimal view with two seeded property ids (read two real ids from `seedPropertyMaster`'s roster, e.g. `1100-rarig-ave-columbus-oh`), two leases per property with explicit dates/rent/SF, `generatedAt: '2026-10-02T15:00:00.000Z'`. Cover, one `it` each: (a) records one row per investment property with the hand-computed `leasedSf/inPlaceRent/leaseCount/totalSf/occPct`; (b) a second capture the same ET day with changed rent overwrites (idempotent upsert, still one row); (c) a capture whose `generatedAt` is `2026-11-02T15:00:00.000Z` creates a November row AND freezes October (`frozen: true`), and a later October-dated re-capture (use a fresh call with an October `generatedAt`) does NOT overwrite the frozen row (assert values unchanged, `skipped` counts it); (d) `generatedAt: '2026-11-01T02:00:00.000Z'` (evening of Oct 31 in ET) books to month `2026-10` — pins the ET attribution; (e) residence property excluded (`type: 'Residence'`); (f) unknown id skipped with a warn spy; empty `property_master` throws; (g) `occPct: 1.4` stores `occPct: null`; (h) `captureMonthSnapshot(db, null)` → `{recorded:0, skipped:0, frozen:0}`.

- [ ] **Step 2: Run to verify it fails**
  Run: `npx vitest run tests/unit/warehouse-month-snapshot.test.ts`
  Expected: FAIL — module `server/warehouse/month-snapshot` not found.

- [ ] **Step 3: Export `easternCalendarDay`** from `server/warehouse/occupancy.ts` (change `function` to `export function`; no other change) and add to `tests/unit/warehouse-occupancy.test.ts`:

```ts
import { easternCalendarDay } from '../../server/warehouse/occupancy';
it('easternCalendarDay books an evening-ET UTC instant onto the ET day', () => {
  expect(easternCalendarDay('2026-11-01T02:00:00.000Z')).toBe('2026-10-31');
  expect(easternCalendarDay('garbage')).toBeNull();
});
```

- [ ] **Step 4: Implement `server/warehouse/month-snapshot.ts`.** Import types/engine from `../../src/analytics/portfolio-trends` and `isInvestmentProperty` from `../../src/analytics/property-basis` (server already imports from `src/analytics` — see `server/reconcile-runtime.ts`). Prepared statements:

```ts
const UPSERT = `
  INSERT INTO portfolio_month_snapshot
    (property_id, month, captured_through, total_sf, leased_sf, in_place_rent, lease_count, occ_pct)
  VALUES (@propertyId, @month, @day, @totalSf, @leasedSf, @inPlaceRent, @leaseCount, @occPct)
  ON CONFLICT (property_id, month) DO UPDATE SET
    captured_through = excluded.captured_through, total_sf = excluded.total_sf,
    leased_sf = excluded.leased_sf, in_place_rent = excluded.in_place_rent,
    lease_count = excluded.lease_count, occ_pct = excluded.occ_pct,
    recorded_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE portfolio_month_snapshot.frozen = 0`;
const FREEZE = `UPDATE portfolio_month_snapshot SET frozen = 1 WHERE property_id = ? AND month < ? AND frozen = 0`;
```
  Use `result.changes === 0` from the upsert to detect a frozen-row skip. Wrap the per-property loop in `db.transaction`. Compute points with ONE `buildPortfolioTrend` call over the in-scope properties (asOf = capture day, monthsBack 0, monthsForward 0) and read `byProperty[id]![0]`.

- [ ] **Step 5: Run to verify it passes**
  Run: `npx vitest run tests/unit/warehouse-month-snapshot.test.ts tests/unit/warehouse-occupancy.test.ts && npm run typecheck && npm run lint`
  Expected: PASS; typecheck and lint clean.

- [ ] **Step 6: Commit**
  ```bash
  git add server/warehouse/occupancy.ts server/warehouse/month-snapshot.ts tests/unit/warehouse-month-snapshot.test.ts tests/unit/warehouse-occupancy.test.ts
  git commit -m "feat(warehouse): captureMonthSnapshot with ET month attribution, freeze, roster guard"
  ```

### Task 3: Wire capture into the refresh hook (architect-owned `server/index.ts`)

**Files:**
- Modify: `server/index.ts` (import near line 37; call inside the existing `brain.on('snapshot', …)` handler, after the occupancy block ~line 159)
- Test: extend an existing server-wiring test if one exists for the occupancy hook (`grep -rn "captureOccupancy" tests/unit` — mirror it); otherwise a focused unit test that imports the handler is NOT possible (index.ts is a script) — in that case verify by the integration run in Step 4 and record that no unit seam exists.

**Interfaces:**
- Consumes: `captureMonthSnapshot` (Task 2), `brain.getSnapshot()`.

- [ ] **Step 1:** Add the import next to `captureOccupancy`. Add, directly after the occupancy `try/catch` and BEFORE the insurance block, an independently guarded call:

```ts
  try {
    captureMonthSnapshot(getWarehouse(), brain.getSnapshot());
  } catch (err) {
    // Best-effort like its siblings — but never silent: a total capture failure must be visible in the log.
    console.warn('⚠ Month-snapshot capture skipped:', err instanceof Error ? err.message : String(err));
  }
```
  It must sit under the SAME early-return that already skips `action:` and `:fallback` reasons (so overlay edits and failed-parse fallbacks never write a month row) — verify by reading the surrounding lines; do not duplicate the filter.

- [ ] **Step 2:** `npm run typecheck && npm run lint`. Expected: clean.

- [ ] **Step 3: Integration check against a scratch DB** (never the live DB): from the worktree, `WAREHOUSE_DB=<scratch path> npx tsx server/index.ts` in the background, wait for `/api/snapshot` 200, then inspect: `node -e "const D=require('better-sqlite3');const db=new D(process.env.WAREHOUSE_DB,{readonly:true});console.log(db.prepare('select property_id,month,leased_sf,in_place_rent,lease_count,occ_pct,frozen from portfolio_month_snapshot').all())"`. The scratch DB's `property_master` is empty until `npm run warehouse:backfill` runs against it — run it first (`WAREHOUSE_DB=<scratch> npm run warehouse:backfill`), then restart the server. Expected: ≥1 row per investment property for the current ET month, `frozen = 0`; sum of `in_place_rent` ≈ the Trends tab's in-place rent KPI.

- [ ] **Step 4: Soft reconciliation check** (log-only, no gate step): the sum of captured `in_place_rent` × 12 vs `snapshot.workbookTotals.rent` (annual Σ annualRent). They may differ legitimately — leases not active in the capture month (future-dated or already ended but still on the roll) are excluded from the monthly capture. Record the observed percentage difference in the task report; do NOT assert equality in a test and do NOT add a gate step.

- [ ] **Step 5: Stop the server; commit** `git add server/index.ts [test file if any] && git commit -m "feat(server): capture month snapshots on workbook refresh"`.

### Task 4: Contract + read API — `GET /api/warehouse/analytics/trends/history`

**Files:**
- Create: `src/contracts/trends.ts`; Modify: `src/contracts/index.ts` (add `export * from './trends';` — match the file's style)
- Modify: `server/warehouse/api.ts` (add the route beside the other `/analytics/*` routes, ~line 297–360)
- Test: `tests/unit/warehouse-trends-history-api.test.ts` (mirror `tests/unit/warehouse-api.test.ts`'s harness for the 503/withDb behavior and Zod parse)
- Modify: `architecture/api-contracts.md`

**Interfaces:**
- Consumes: `monthSnapshotSeries` (Task 2).
- Produces:
  - `TrendsHistoryPointSchema = z.object({ propertyId: z.string(), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), capturedThrough: z.string(), totalSf: z.number().nonnegative(), leasedSf: z.number().nonnegative(), inPlaceRent: z.number().nonnegative(), leaseCount: z.number().int().nonnegative(), occPct: z.number().min(0).max(1).nullable(), frozen: z.boolean() })`
  - `TrendsHistoryResponseSchema = z.object({ points: z.array(TrendsHistoryPointSchema) })` and the inferred types `TrendsHistoryPoint`, `TrendsHistoryResponse`.

- [ ] **Step 1: Write the failing API test** — seed a temp warehouse with two properties' snapshot rows via `captureMonthSnapshot` (Task 2) or direct inserts; `GET /analytics/trends/history` → 200, body parses with `TrendsHistoryResponseSchema`, rows ordered property-then-month, `frozen` is a boolean (not 0/1); with no rows → `{ points: [] }`; a `?propertyId=` query filters to one property; an unknown/garbage `propertyId` returns `{ points: [] }` (not 500); the 503 path matches the sibling routes' behavior when the DB is unavailable (copy the sibling test's approach).

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/unit/warehouse-trends-history-api.test.ts`; Expected: FAIL (404 / schema missing).

- [ ] **Step 3: Implement** the schema file, the index export, and the route:

```ts
  app.get('/analytics/trends/history', (c) =>
    withDb((db) => {
      const propertyId = c.req.query('propertyId') || undefined;
      return c.json(TrendsHistoryResponseSchema.parse({ points: monthSnapshotSeries(db, propertyId) }));
    }),
  );
```
  (`monthSnapshotSeries` returns camelCase rows; `frozen` mapped to boolean inside it.) Governance's duplicate-route-prefix scan must stay green — run `npm run governance` (or the gate's first step) to confirm.

- [ ] **Step 4: Run** `npx vitest run tests/unit/warehouse-trends-history-api.test.ts tests/unit/warehouse-api.test.ts tests/unit/warehouse-zod-boundary.test.ts tests/unit/contracts.test.ts` + typecheck + lint. Expected: PASS.

- [ ] **Step 5: Update `architecture/api-contracts.md`** with the route, then commit:
  ```bash
  git add src/contracts/trends.ts src/contracts/index.ts server/warehouse/api.ts tests/unit/warehouse-trends-history-api.test.ts architecture/api-contracts.md
  git commit -m "feat(api): GET /analytics/trends/history + TrendsHistory contract"
  ```

### Task 5: Static-mirror parity (bake the endpoint)

**Files:**
- Modify: `scripts/bake-warehouse.ts` (add the endpoint to the baked list)
- Test: `tests/unit/warehouse-mirror-bake.test.ts` (extend)

- [ ] **Step 1:** Read `scripts/bake-warehouse.ts` around the endpoint-list construction (~line 140–170) and `tests/unit/warehouse-mirror-bake.test.ts`. If the baked list is enumerated (it is, for `benchmarks`/`drivers`), add `'/analytics/trends/history'` as a fixed path. If the mirror has a schema-version/hash that must be bumped when endpoints change, bump it per the file's own comment and say so in the report.

- [ ] **Step 2:** Add/adjust a test asserting the baked endpoint list contains `/analytics/trends/history` and that the baked payload parses with `TrendsHistoryResponseSchema` (empty `points` is valid on a fresh warehouse).

- [ ] **Step 3:** Run `npx vitest run tests/unit/warehouse-mirror-bake.test.ts`; Expected PASS. Commit: `git add scripts/bake-warehouse.ts tests/unit/warehouse-mirror-bake.test.ts && git commit -m "feat(bake): include trends history in the static mirror"`.

*(If `bake-warehouse.ts` turns out to be owned by another active claim in `status.json`, coordinate first. If the mirror cannot carry this endpoint without a larger change, skip this task — the client falls back to pure reconstruction on 503/absent (Task 6), which is the intended degraded mode — and record it as a deferral.)*

### Task 6: Client merge — recorded over reconstructed

**Files:**
- Create: `src/modules/portfolio/trends-history.ts`
- Test: `tests/unit/trends-history-merge.test.ts`

**Interfaces:**
- Consumes: `MonthPoint`, `MonthKey`, `addMonths` (Wave 1 engine); `TrendsHistoryResponse`/`TrendsHistoryPoint` (Task 4); `fetchParsedOrMirror`, `QUERY_OPTS`, `isWarehouseUnavailable` from `src/modules/intel/hooks.ts` (read its signatures first; mirror how `src/modules/intel/analytics-hooks.ts` calls them).
- Produces:
  - `type MonthSource = 'recorded' | 'reconstructed'`
  - `interface SourcedMonthPoint extends MonthPoint { source: MonthSource }`
  - `recordedToMonthPoint(r: TrendsHistoryPoint): MonthPoint` — `vacantSf = max(0, totalSf − leasedSf)`, `vacancyPct = totalSf > 0 ? vacantSf/totalSf : 0`, `isForecast: false`.
  - `mergeRecorded(reconstructed: MonthPoint[], recorded: TrendsHistoryPoint[], scope: { propertyIds: readonly string[]; propertyId?: string }): SourcedMonthPoint[]` — for a single-property scope use that property's recorded row for the month; for the portfolio scope use the SUM across `scope.propertyIds` ONLY IF every id in scope has a recorded row for that month (otherwise keep the reconstructed point for that month — a partial portfolio month would silently understate). Forecast months (`isForecast`) are never replaced. Every returned point carries its `source`.
  - `recordedYoY(points: SourcedMonthPoint[], asOfMonth: MonthKey): number | null` — fraction; non-null only if BOTH the as-of month and the month 12 earlier are `recorded` and the earlier `inPlaceRent > 0`.
  - `useTrendsHistory(): UseQueryResult<TrendsHistoryResponse>` — TanStack Query over `/analytics/trends/history`, `QUERY_OPTS`, parsed with `TrendsHistoryResponseSchema`; on warehouse-unavailable the consumer treats it as "no recorded history" (never an error banner).

- [ ] **Step 1: Write the failing tests** (pure functions only; no network): (a) `recordedToMonthPoint` math incl. zero-SF and `leasedSf > totalSf` clamps; (b) a recorded single-property month replaces the reconstructed point and gets `source: 'recorded'`, other months stay `'reconstructed'`; (c) portfolio merge uses the sum when all in-scope properties are present and falls back when one is missing; (d) forecast months are never replaced even if a recorded row exists for that month; (e) `recordedYoY` is null unless both ends recorded, computes `cur/prev − 1` when they are, null for zero prior rent.

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/unit/trends-history-merge.test.ts`; Expected FAIL (module missing).

- [ ] **Step 3: Implement** per the interfaces above (pure functions + the hook). Keep `MonthPoint` untouched; `SourcedMonthPoint` extends it in this file only (decouples Wave 2 from further Wave 1 edits).

- [ ] **Step 4: Run** `npx vitest run tests/unit/trends-history-merge.test.ts && npm run typecheck && npm run lint`; Expected PASS.

- [ ] **Step 5: Commit** — `git add src/modules/portfolio/trends-history.ts tests/unit/trends-history-merge.test.ts && git commit -m "feat(trends): merge recorded month snapshots over reconstruction"`.

### Task 7: Trends UI — source-aware, YoY restored, basis honest

**Files:**
- Modify: `src/modules/portfolio/TrendsView.tsx`
- Test: `tests/unit/portfolio-trends-view.test.tsx` (extend; reuse its snapshot-mock idiom and add a mock for `useTrendsHistory`)

**Interfaces:**
- Consumes: Task 6's `useTrendsHistory`, `mergeRecorded`, `recordedYoY`, `SourcedMonthPoint`; Wave 1's `kpiAt`, chart-data mappers.

Behavior to implement and test (one `it` each):
1. With no recorded history (hook returns `[]` or unavailable): the page is byte-for-byte the Wave 1 experience (existing assertions still pass) — recorded history is purely additive.
2. With recorded history: a badge near the existing "Reconstructed from current leases" badge reads `Recorded: N months (since YYYY-MM)` where N counts recorded months in the visible scope; the "Reconstructed" badge text becomes `Earlier months reconstructed from current leases` only when at least one reconstructed non-forecast month remains, and disappears when none do.
3. The KPI tiles compute MoM from the merged points (`kpiAt(mergedPoints, asOfMonth)` accepts `MonthPoint[]`; `SourcedMonthPoint` is assignable).
4. The "In-place rent YoY" tile (removed in Wave 1's fix) returns ONLY when `recordedYoY` is non-null, labelled `YoY (recorded)`; otherwise it is not rendered (grid back to 3 tiles).
5. Vacancy tile: when the as-of month is recorded and `occPct` is known for the scope, show a second line `Workbook occupancy: X%` beside the lease-SF vacancy so the two bases are visible side by side rather than mismatched across tabs. (Portfolio scope: SF-weighted average of recorded `occPct` using `totalSf`; skip the line if any property lacks `occPct`.)
6. The scope selector and the stale-scope fallback from Wave 1 keep working with merged points.

- [ ] **Step 1:** Write the failing tests for behaviors 1–5 (mock `useTrendsHistory` to return crafted `points`; build merged expectations by hand).
- [ ] **Step 2:** `npx vitest run tests/unit/portfolio-trends-view.test.tsx` — Expected: new tests FAIL, old ones pass.
- [ ] **Step 3:** Implement in `TrendsView.tsx`. Hooks stay above every early return (rules-of-hooks — Wave 1's review checked this).
- [ ] **Step 4:** `npx vitest run tests/unit/portfolio-trends-view.test.tsx tests/unit/portfolio-module-other-holdings.test.tsx tests/unit/ia-registry.test.ts && npm run typecheck && npm run lint` — Expected PASS.
- [ ] **Step 5: Visual check on live data** — start a scratch-DB server and the worktree's vite (the `preview_start` tool may be unusable in a worktree — "cwd must be a relative path"; fall back to Bash background processes and stop them afterwards, as in Wave 1). Verify: with a fresh scratch warehouse there is exactly one recorded month (the current), the "Recorded: 1 month" badge shows, YoY tile is absent, and the page otherwise matches Wave 1. Screenshot desktop + mobile.
- [ ] **Step 6: Commit** — `git add src/modules/portfolio/TrendsView.tsx tests/unit/portfolio-trends-view.test.tsx && git commit -m "feat(trends): show recorded history, recorded YoY, workbook occupancy beside lease-SF vacancy"`.

### Task 8: Final verification and PR

- [ ] **Step 1:** Run the focused set: `npx vitest run tests/unit/migration-033-portfolio-month-snapshot.test.ts tests/unit/warehouse-month-snapshot.test.ts tests/unit/warehouse-trends-history-api.test.ts tests/unit/trends-history-merge.test.ts tests/unit/portfolio-trends*.test.ts* tests/unit/warehouse-occupancy.test.ts tests/unit/warehouse-mirror-bake.test.ts tests/unit/warehouse-migrate.test.ts tests/unit/ia-registry.test.ts`.
- [ ] **Step 2:** `npm run gate`. Expected: every step green EXCEPT the known-red `reconcile` step (snapshot cash-history drift on main); run `warehouse:verify`, `warehouse:drift` and the remaining steps individually and report the evidence. `warehouse:drift` compares the live warehouse to a fresh re-ingest — confirm the new table does not register as drift (it is not part of the P&L ingest).
- [ ] **Step 3: Adversarial pass.** This adds a shared-state writer on every workbook refresh (`captureMonthSnapshot` writes a ledger-like table, takes transactions) → the Engineering OS done bar requires an adversarial review. Dispatch the `adversarial-reviewer` agent with an explicit `model` (never below the implementer's) on the diff, asking it to break: ET month boundary attribution, freeze race on a month rollover refresh, partial-property portfolio sums, duplicate/orphan ids, and a refresh fired during migration. This is NOT the `refute-financial-change` workflow (no financial-decision code) — if any change touches scoring/verdicts, use that workflow instead and carry its `Refute-Reviewed` trailer.
- [ ] **Step 4:** Update `architecture/status.json` entry to `status: "review_needed"` → `merged` after merge. Push the branch and open the PR (title `feat(trends): Wave 2 — recorded month-end history`); body lists the files, tests, deferred items, and the base-branch line if stacked. Do not enable auto-merge. Do not poll CI; the desktop app's Auto-fix monitors it.

---

## Self-review

- **Coverage:** capture ✔ (T2–T3), freeze ✔ (T2), table/migration ✔ (T1), API ✔ (T4), static mirror ✔ (T5), client merge + source labelling ✔ (T6–T7), basis divergence resolved by storing workbook `occPct` beside lease-SF vacancy ✔ (T1/T7), recorded YoY ✔ (T6–T7), #423 contingencies ✔ (Sequencing table).
- **Deliberate deviation from the Wave 1 outline:** the outline's `source ∈ ('captured','reconstructed')` column and "backfill by reconstruction" were dropped — persisting back-cast values would launder biased data into the record of truth. Reconstruction stays client-side.
- **Known limits (stated, not hidden):** history only starts at first capture (no real backfill exists in any store — `property_occupancy`'s 21 workbook-occupancy points since 2026-06-14 are a different basis and are not imported); a refresh-gap month records its last observed values, not a true month-end; monthly rent capture excludes leases not active in the capture month, so the ×12 total can differ from `workbookTotals.rent` (reported, not gated).
- **Placeholder scan:** Task 2 Step 1 and Task 7 Step 1 specify each test case's inputs and expected values in prose rather than full code because the fixtures depend on `seedPropertyMaster`'s live roster ids and the existing view-test mocking idiom, which the implementer must read first; every behavior and expected value is pinned. All code the plan introduces (DDL, SQL, route, schemas, signatures) is shown.
- **Type consistency:** `MonthSnapshotRow` (T2) ⇄ `TrendsHistoryPointSchema` (T4) share field names and the boolean `frozen`; `SourcedMonthPoint`/`mergeRecorded`/`recordedYoY`/`recordedToMonthPoint`/`useTrendsHistory` names are identical across T6–T7.
- **Out of scope here (Wave 3):** monthly expense ledger, stacked expense charts, heatmap, alerts.
