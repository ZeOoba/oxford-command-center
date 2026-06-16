# Eric Live Phase 1b — "Fat Mirror" (PFI + Calibration-read) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. TDD throughout (test first, watched to fail).

**Goal:** Make the two server-only read modules — Property Financial Intelligence (PFI) and the Calibration Log (READ) — work on the Access-gated Cloudflare Pages mirror, where `/api/warehouse/*` does not exist, by baking the **computed API results** into `public/warehouse.json` and falling the client back to those precomputed payloads on 404/unavailable.

**Architecture:** The bake invokes the **real Hono warehouse router in-process** (`warehouseRoutes(() => db)` + `app.request(path)`) — or the live Brain Server over HTTP when it is up — and captures each route's JSON verbatim, so a baked payload is identical-by-construction to the live route (no engine port, no route-logic reimplementation, no `scores.ts`/`metrics.ts`/`queries.ts` signature change). The client wraps its existing `fetchJson`→`schema.parse` path so that on `WarehouseUnavailableError` it reads the precomputed payload from a memoized `/warehouse.json` (mirroring the existing `/snapshot.json` fallback in `src/data/client.ts`). Honesty guardrails: a `schemaVersion` stamp that **fail-closes** the client (offline, not stale) on mismatch; a per-spine "Computed from snapshot baked _N_h ago" freshness badge; and all warehouse WRITES hidden on the mirror.

**Tech Stack:** TypeScript, Hono (`app.request` for in-process routing), better-sqlite3 (read + `wal_checkpoint(TRUNCATE)`), Zod (contract schemas — the read boundary), TanStack Query (client hooks), Vitest (TDD).

---

## Constraints / Guardrails (hard)

- **No engine refactor.** `scores.ts`/`metrics.ts`/`queries.ts`/`benchmarks.ts`/`drivers.ts`/`calibration.ts` are imported and CALLED only via the router — **never edited** (Analytics-owned; signatures frozen).
- **No Architect-owned files.** Do NOT touch `server/index.ts`, `src/contracts/*`, `server/warehouse/db.ts`, `package.json`, `tsconfig*`, `architecture/*`. The bake uses a **flag** (no new npm script → no `package.json` edit, also avoids colliding with the `test-coverage-analysis` worktree that is editing `package.json`).
- **No governor/financial-constant files** (DSCR 1.25 / LTV 40). Untouched.
- **Read-only mirror.** Calibration `resolve`, lease-run-assumptions, and the PFI import/mapping/issue writes have no edge home — hide them when not live.
- **Never label baked data "Live."** Per-spine badge = "Computed from snapshot baked _N_h ago"; schema-version mismatch ⇒ offline (fail-closed), never stale.
- **WAL correctness.** Prefer querying a running Brain Server's `/api/warehouse/*`; else force `wal_checkpoint(TRUNCATE)` before reading `finance.sqlite` (an un-checkpointed read can bake LESS than the server has).
- **Cadence decoupling.** The hourly snapshot bake (`npm run bake`) stays light (snapshot+macro only); `warehouse.json` bakes only under the `--warehouse`/`BAKE_WAREHOUSE=1` flag (daily/on-backfill). Recommended chain: `warehouse:backfill && warehouse:drift && bake --warehouse`.
- **Do NOT deploy** (invariant 2 — Gabriel's per-deploy permission). **Open a PR; do not merge** financial-adjacent code without Gabriel.
- **Gated decisions are out of scope** (DNS migration, new-machine timing, remote calibration writes, freshness cadence): build the read-only path; flag them.

## File Inventory

**Create:**
- `src/lib/warehouse-mirror.ts` — schema-version constant, envelope Zod, memoized `/warehouse.json` loader (fail-closed), `getMirrorEndpoint`, `filterCalibrationLogRows`, mirror-meta react-query hook.
- `scripts/bake-warehouse.ts` — `buildWarehouseEnvelope(resolver, opts)`, `inProcessResolver(db)`, `httpResolver(baseUrl)`, `warehouseEndpointPlan(metrics, leaseRunIds)`, `bakeWarehouseJson()` orchestrator.
- `tests/unit/warehouse-mirror-bake.test.ts` — deterministic: every planned endpoint present; each baked payload validates against the SAME contract schema the server `.parse()`s; baked payload deep-equals the in-process router response; envelope/schemaVersion/bakedAt shape.
- `tests/unit/warehouse-mirror-client.test.ts` — schema-version mismatch ⇒ unavailable (fail-closed); `getMirrorEndpoint` lookup; `filterCalibrationLogRows` equals server `calibrationLog`; warehouse freshness label + staleness threshold.

**Modify (all non-Architect):**
- `scripts/bake-mirror.ts` (Integration-owned) — call `bakeWarehouseJson()` when `--warehouse`/`BAKE_WAREHOUSE=1`; guard `main()` so the module is importable.
- `src/lib/freshness.ts` (Core) — add `computeWarehouseFreshness(meta, now)` ("Computed from snapshot baked _N_h ago"; fail-closed on null/mismatch).
- `src/modules/intel/hooks.ts` (UX) — add `fetchParsedOrMirror`, `useWarehouseLive()`, `useWarehouseFreshness()`.
- `src/modules/intel/analytics-hooks.ts` (UX) — route `fetchParsed` through `fetchParsedOrMirror`.
- `src/modules/calibration/hooks.ts` (UX) — fallback for pending/report; log via unfiltered mirror + `filterCalibrationLogRows`.
- `src/modules/intel/IntelModule.tsx`, `src/modules/calibration/CalibrationModule.tsx` (UX) — per-spine freshness badge; thread `live` to hide writes.
- `src/modules/intel/LeaseRunView.tsx`, `ImportsView.tsx`, `MappingsView.tsx`, `DataQualityView.tsx`, `src/modules/calibration/{PendingView,LogView,ResolveDialog}.tsx` (UX) — hide write actions + "read-only on the mirror" note when `!live`.

**Must NOT be touched:** `server/index.ts`, `src/contracts/*`, `server/warehouse/*` engines, `server/warehouse/db.ts`, `package.json`, `tsconfig*`, `architecture/*`, any governor file.

## Risk assessment

- **Reversible:** all changes are additive (new files + additive code paths). Blast radius if a step fails is contained to the new branch; nothing merges without Gabriel + PR CI. The bake reads the live `finance.sqlite` only at Gabriel's invocation; tests use tmpdir fixtures (never the live DB).
- **Financial-adjacent:** the baked payloads are scoring/analytics output ⇒ MANDATORY adversarial REFUTE review (opus) before "done".
- **Confirmation required:** deploy (Gabriel). Merge (Gabriel).

---

## Shared interfaces (locked)

```ts
// src/lib/warehouse-mirror.ts
export const WAREHOUSE_MIRROR_SCHEMA_VERSION = 'wh-v1';

export interface WarehouseMirrorMeta {
  schemaVersion: string;
  bakedAt: string;            // ISO 8601
  warehouseSource: 'live-server' | 'checkpoint-read';
}
export interface WarehouseMirrorEnvelope extends WarehouseMirrorMeta {
  endpoints: Record<string, unknown>;   // key = exact client request path (+query), value = route JSON
}
```

Endpoint keys are the exact paths the client fetches, e.g. `/api/warehouse/analytics/scores`,
`/api/warehouse/analytics/benchmarks?period=2025&metric=noiPerSf`,
`/api/warehouse/analytics/drivers/<id>?from=2024&to=2025`, `/api/warehouse/calibration/log`.

---

## Task 1: Shared mirror contract module

**Files:**
- Create: `src/lib/warehouse-mirror.ts`
- Test: `tests/unit/warehouse-mirror-client.test.ts`

- [ ] **Step 1 — failing test (schema-version fail-close + lookup):**

```ts
import { describe, it, expect } from 'vitest';
import {
  WAREHOUSE_MIRROR_SCHEMA_VERSION, parseWarehouseMirror, getMirrorEndpoint,
} from '../../src/lib/warehouse-mirror';

describe('warehouse-mirror envelope', () => {
  const good = {
    schemaVersion: WAREHOUSE_MIRROR_SCHEMA_VERSION,
    bakedAt: '2026-06-15T00:00:00.000Z',
    warehouseSource: 'checkpoint-read',
    endpoints: { '/api/warehouse/analytics/scores': { scores: [] } },
  };

  it('parses a valid envelope', () => {
    const env = parseWarehouseMirror(good);
    expect(env).not.toBeNull();
    expect(getMirrorEndpoint(env!, '/api/warehouse/analytics/scores')).toEqual({ scores: [] });
  });

  it('fail-closes (returns null) on a schema-version mismatch', () => {
    expect(parseWarehouseMirror({ ...good, schemaVersion: 'wh-v0' })).toBeNull();
  });

  it('fail-closes on a malformed envelope', () => {
    expect(parseWarehouseMirror({ nope: true })).toBeNull();
    expect(getMirrorEndpoint(parseWarehouseMirror(good)!, '/api/warehouse/missing')).toBeUndefined();
  });
});
```

- [ ] **Step 2 — run, expect FAIL** (`vitest run tests/unit/warehouse-mirror-client.test.ts` → "parseWarehouseMirror is not a function").

- [ ] **Step 3 — implement** the constant, `WarehouseMirrorEnvelopeSchema` (Zod), `parseWarehouseMirror(raw): WarehouseMirrorEnvelope | null` (returns `null` on Zod failure OR `schemaVersion !== WAREHOUSE_MIRROR_SCHEMA_VERSION` — **fail-closed**), `getMirrorEndpoint(env, url)`. Add `filterCalibrationLogRows(rows, { subject, kind, status })` mirroring the server WHERE (`subject_id ===`, `verdict_kind ===`, `status: open ⇒ !resolved / resolved ⇒ resolved`). Add the memoized loader `loadWarehouseMirror(): Promise<WarehouseMirrorEnvelope | null>` (module-level cached promise; `fetch('/warehouse.json')`; on non-ok / parse fail / version mismatch ⇒ `null`).

- [ ] **Step 4 — run, expect PASS.**

- [ ] **Step 5 — failing test for `filterCalibrationLogRows`** (equivalence proven against the server in Task 5's bake test; here assert the predicate directly on hand-rolled rows for open/resolved/subject/kind). Implement, run PASS.

- [ ] **Step 6 — commit** `feat(mirror): warehouse-mirror envelope + fail-closed loader + log filter`.

## Task 2: Warehouse freshness (extend `src/lib/freshness.ts`)

**Files:** Modify `src/lib/freshness.ts`; Test `tests/unit/warehouse-mirror-client.test.ts`.

- [ ] **Step 1 — failing test:**

```ts
import { computeWarehouseFreshness } from '../../src/lib/freshness';

it('labels baked warehouse data honestly (never "Live")', () => {
  const now = Date.parse('2026-06-15T06:00:00Z');
  const f = computeWarehouseFreshness(
    { schemaVersion: 'wh-v1', bakedAt: '2026-06-15T00:00:00Z', warehouseSource: 'checkpoint-read' }, now);
  expect(f.label).toMatch(/Computed from snapshot/i);
  expect(f.detail).toMatch(/baked 6h ago/);
  expect(f.isStale).toBe(false);
  expect(f.kind).not.toBe('live');
});

it('marks the warehouse bake stale past the threshold and fail-closes on null meta', () => {
  const now = Date.parse('2026-06-17T00:00:00Z');
  const stale = computeWarehouseFreshness(
    { schemaVersion: 'wh-v1', bakedAt: '2026-06-15T00:00:00Z', warehouseSource: 'checkpoint-read' }, now);
  expect(stale.isStale).toBe(true);
  const offline = computeWarehouseFreshness(null, now);
  expect(offline.kind).toBe('offline');
});
```

- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** `computeWarehouseFreshness(meta: WarehouseMirrorMeta | null, now = Date.now()): Freshness` — `null` ⇒ `{ kind:'offline', label:'Offline', ... }`; else age = `now - Date.parse(meta.bakedAt)`, `isStale = age > STALENESS_HOURS*3.6e6`, `label = 'Computed from snapshot'`, `detail = 'baked ' + formatAge(age)`, `kind = isStale ? 'stale' : 'static'`. Reuse `formatAge`/`STALENESS_HOURS`.
- [ ] **Step 4 — run, expect PASS. Commit** `feat(mirror): honest warehouse freshness badge`.

## Task 3: Bake `warehouse.json` (engine via in-process router)

**Files:** Create `scripts/bake-warehouse.ts`; Test `tests/unit/warehouse-mirror-bake.test.ts`.

Resolver contract: `type RouteResolver = (routerPath: string) => Promise<{ status: number; json: unknown }>`.
`routerPath` is the path WITHOUT the `/api/warehouse` mount prefix (e.g. `/analytics/scores`); the envelope key is `'/api/warehouse' + routerPath`.

Enumeration (`warehouseEndpointPlan`): fixed paths `[/noi, /imports, /issues, /analytics/metrics, /analytics/scores, /analytics/pm, /analytics/growth, /analytics/anomalies, /analytics/lease-run, /calibration/log, /calibration/pending, /calibration/report]`; `+ /analytics/lease-run/<id>` for each id in `leaseRunIds`; `+ /analytics/benchmarks?period=<FY>&metric=<m>` for each full-year period (`/^\d{4}$/` from metrics) × `NumericMetricKey.options`; `+ /analytics/drivers/<id>?from=<FY>&to=<FY>` for each property × ordered full-year pair (superset — robust to client's `driverPeriods` choice). Only 200 responses are stored; non-200 are logged and skipped.

- [ ] **Step 1 — failing test** (uses the repo's warehouse test fixture builder — see `tests/unit/warehouse-*.test.ts` for the existing in-memory/tmpdir DB helper; reuse it):

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { warehouseRoutes } from '../../server/warehouse/api';
import {
  ScoresResponseSchema, MetricsResponseSchema, BenchmarksResponseSchema,
  CalibrationLogResponseSchema, CalibrationReportSchema,
} from '../../src/contracts/warehouse';
import { buildWarehouseEnvelope, inProcessResolver } from '../../scripts/bake-warehouse';
import { makeFixtureWarehouse } from './helpers/warehouse-fixture'; // existing pattern

let db: ReturnType<typeof makeFixtureWarehouse>['db'];
beforeAll(() => { db = makeFixtureWarehouse().db; });   // seed ≥2 FY periods + ≥2 properties
afterAll(() => db.close());

it('bakes every planned endpoint; each validates against the server contract schema', async () => {
  const env = await buildWarehouseEnvelope(inProcessResolver(db), {
    now: Date.parse('2026-06-15T00:00:00Z'), warehouseSource: 'checkpoint-read',
  });
  expect(env.schemaVersion).toBe('wh-v1');
  expect(env.warehouseSource).toBe('checkpoint-read');

  // Required fixed endpoints present.
  for (const k of ['/api/warehouse/analytics/scores', '/api/warehouse/analytics/metrics',
                   '/api/warehouse/noi', '/api/warehouse/calibration/log',
                   '/api/warehouse/calibration/report']) {
    expect(env.endpoints[k], `missing ${k}`).toBeDefined();
  }
  // Contract-schema parity — the real "shape matches server" proof.
  expect(() => ScoresResponseSchema.parse(env.endpoints['/api/warehouse/analytics/scores'])).not.toThrow();
  expect(() => MetricsResponseSchema.parse(env.endpoints['/api/warehouse/analytics/metrics'])).not.toThrow();
  expect(() => CalibrationLogResponseSchema.parse(env.endpoints['/api/warehouse/calibration/log'])).not.toThrow();
  expect(() => CalibrationReportSchema.parse(env.endpoints['/api/warehouse/calibration/report'])).not.toThrow();

  // Byte-parity with a fresh router request for a parameterized endpoint.
  const app = warehouseRoutes(() => db);
  const periods = MetricsResponseSchema.parse(env.endpoints['/api/warehouse/analytics/metrics'])
    .metrics.map((m) => m.period).filter((p) => /^\d{4}$/.test(p));
  const fy = periods.sort()[periods.length - 1];
  const url = `/analytics/benchmarks?period=${fy}&metric=noiPerSf`;
  const live = await (await app.request(url)).json();
  expect(env.endpoints[`/api/warehouse${url}`]).toEqual(live);
  expect(() => BenchmarksResponseSchema.parse(env.endpoints[`/api/warehouse${url}`])).not.toThrow();
});
```

- [ ] **Step 2 — run, expect FAIL** ("buildWarehouseEnvelope is not a function").
- [ ] **Step 3 — implement `scripts/bake-warehouse.ts`:** `inProcessResolver(db)` builds `warehouseRoutes(() => db)` once and returns `async (p) => { const r = await app.request(p); return { status: r.status, json: r.status===200 ? await r.json() : null }; }`. `httpResolver(baseUrl)` ⇒ `fetch(baseUrl + '/api/warehouse' + p)`. `buildWarehouseEnvelope(resolver, {now, warehouseSource})`: resolve `/analytics/metrics` for the enumeration (periods, property ids) and `/analytics/lease-run` for lease-term ids; build the plan; resolve each path; store `200` payloads under `'/api/warehouse'+path`; return `{ schemaVersion: WAREHOUSE_MIRROR_SCHEMA_VERSION, bakedAt: new Date(now).toISOString(), warehouseSource, endpoints }`.
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — implement `bakeWarehouseJson()`** orchestrator: try `httpResolver(BRAIN_BAKE_SOURCE_URL ?? http://127.0.0.1:${SERVER_PORT})` via a probe (`GET /api/warehouse/noi` → 200 JSON) ⇒ `warehouseSource='live-server'`; else `openWarehouse(WAREHOUSE_DB)`, `db.pragma('wal_checkpoint(TRUNCATE)')`, `inProcessResolver(db)` ⇒ `'checkpoint-read'`. Write `public/warehouse.json`. (No DB write beyond the checkpoint; close the db.)
- [ ] **Step 6 — commit** `feat(mirror): bake computed warehouse API results to warehouse.json`.

## Task 4: Wire `bake-mirror.ts` (flag-gated, importable)

**Files:** Modify `scripts/bake-mirror.ts`.

- [ ] **Step 1 — guard `main()`** so importing the module has no side effects (mirror `safe-worktree.ts`'s entry check). Add: after baking snapshot+macro, `if (process.argv.includes('--warehouse') || process.env.BAKE_WAREHOUSE === '1') await bakeWarehouseJson();`.
- [ ] **Step 2 — verify** `tsx scripts/bake-mirror.ts` (no flag) still bakes only snapshot+macro (no `warehouse.json` written); `tsx scripts/bake-mirror.ts --warehouse` additionally writes `public/warehouse.json`. (Manual smoke against a fixture / tmp `WAREHOUSE_DB`; do NOT touch the live DB in tests.)
- [ ] **Step 3 — commit** `feat(mirror): bake --warehouse flag (cadence-decoupled from hourly snapshot bake)`.

## Task 5: Client fallback wiring

**Files:** Modify `src/modules/intel/hooks.ts`, `analytics-hooks.ts`, `src/modules/calibration/hooks.ts`. Tests: extend `warehouse-mirror-client.test.ts` (+ a component-level test only if a view test already exists for the touched view).

- [ ] **Step 1 — failing test (`fetchParsedOrMirror` falls back on unavailable):** mock global `fetch` so `/api/warehouse/analytics/scores` returns `text/html` (mirror) and `/warehouse.json` returns a valid envelope with that endpoint; assert `fetchParsedOrMirror('/api/warehouse/analytics/scores', ScoresResponseSchema)` resolves the baked payload; when `/warehouse.json` is absent (404) it rethrows `WarehouseUnavailableError`.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** in `intel/hooks.ts`: `export async function fetchParsedOrMirror<S extends z.ZodTypeAny>(path, schema)` = live `schema.parse(await fetchJson(path))`; `catch (e)` if `isWarehouseUnavailable(e)` ⇒ `const env = await loadWarehouseMirror(); if (!env) throw e; const p = getMirrorEndpoint(env, path); if (p===undefined) throw new WarehouseUnavailableError('not in mirror'); return schema.parse(p);` else `throw e`. Point `analytics-hooks.ts`'s `fetchParsed` and `calibration/hooks.ts`'s `fetchParsed` (pending/report) at it. For `useCalibrationLog`: live first; on unavailable, `loadWarehouseMirror()` → `getMirrorEndpoint(env,'/api/warehouse/calibration/log')` → `CalibrationLogResponseSchema.parse` → `filterCalibrationLogRows(r.log, query)`.
- [ ] **Step 4 — run, expect PASS. Commit** `feat(mirror): client falls back to warehouse.json on 404 (PFI + calibration read)`.

## Task 6: Live signal + freshness badge + write-hiding

**Files:** Modify `src/modules/intel/hooks.ts` (add `useWarehouseLive()`, `useWarehouseFreshness()`), `IntelModule.tsx`, `CalibrationModule.tsx`, `LeaseRunView.tsx`, `ImportsView.tsx`, `MappingsView.tsx`, `DataQualityView.tsx`, calibration `PendingView.tsx`/`LogView.tsx`/`ResolveDialog.tsx`.

- [ ] **Step 1** — `useWarehouseLive(): boolean` = a `['warehouse','live-probe']` query that `await fetchJson('/api/warehouse/noi')` returns `true`; the hook returns `q.data === true` (**fail-safe: hide writes unless proven live**). `useWarehouseFreshness()` = `loadWarehouseMirror()` query → `computeWarehouseFreshness(meta)`.
- [ ] **Step 2** — PFI (`IntelModule`) + Calibration (`CalibrationModule`) headers render the freshness badge from `useWarehouseFreshness()` when `!live`. Each write control (`ImportsView` approve/reject, `MappingsView` add, `DataQualityView` resolve, `LeaseRunView` assumptions editor, calibration `ResolveDialog`/resolve action) is gated on `useWarehouseLive()`; when `!live` it is not rendered and a one-line "Read-only on the baked mirror — open on the workstation to edit." note shows.
- [ ] **Step 3** — extend/adjust any existing `*-view.test.tsx` for the touched views to assert the write control is absent when `live=false` (only where a test already exists; do not invent heavy new component tests). **Commit** `feat(mirror): honest freshness badge + read-only write-hiding on the mirror`.

## Task 7: Verify + adversarial review + PR

- [ ] **Targeted tests:** `vitest run tests/unit/warehouse-mirror-bake.test.ts tests/unit/warehouse-mirror-client.test.ts` green; typecheck `tsc --noEmit -p tsconfig.json && -p tsconfig.node.json` clean for touched files. (Full `npm run gate` is RAM-heavy — rely on PR CI; run it only if RAM allows.)
- [ ] **Bundle guard:** confirm the client never transitively imports `better-sqlite3`/`node:*` (the mirror module + hooks import only contracts + global `fetch`). `npm run check:bundle` if cheap.
- [ ] **Adversarial REFUTE review** (MANDATORY, financial-adjacent): dispatch `refute-financial-change` (or an independent opus reviewer told to BREAK it) over the bake fidelity (baked == live route), the fail-closed schema-version, the freshness honesty, and the write-hiding. Pin model **opus**.
- [ ] **Update `architecture/status.json`** with this worktree's entry (in_progress → review_needed); **PR** off `origin/main` titled `feat(mirror): Fat Mirror — PFI + Calibration-read on the Access-gated mirror (Phase 1b)`, body listing files/tests/deferrals + the 5 gated decisions + the Gabriel deploy chain. **Do not merge.**

## Self-review notes (coverage)

- Spec §3 Phase 1b: bake `warehouse.json` ✓ (Task 3), client fallback ✓ (Task 5), honest freshness + schema-version fail-close ✓ (Tasks 1–2,6), WAL/live-server preference ✓ (Task 3 Step 5), writes workstation-only ✓ (Task 6), deterministic client==server shape test ✓ (Task 3 + 5), adversarial review ✓ (Task 7). No engine port (user override of the spec's row-materialization approach) — bake uses the router verbatim.
- **Deferred (honest offline, documented in PR):** `imports/:id` DETAIL drill-down (heavy admin read, not core PFI). **Calibration-log filters** — only the UNFILTERED log is baked (faithful incl. the server's LIMIT 500, and the only request the current UI issues); a subject/kind/status filter is **not** baked, so on the mirror it degrades to honest OFFLINE via exact-key lookup, never wrong/truncated data. (The adversarial review caught that re-filtering a pre-capped baked slice client-side diverges from the server's filter-then-cap; the fix was to drop client-side filtering. When a calibration filter UI lands, enumerate those keys at bake time like benchmarks/drivers.) Phase-0 dead-man heartbeat + Phase 2 tunnel/writes are out of scope (scheduler/new-machine — Gabriel).
