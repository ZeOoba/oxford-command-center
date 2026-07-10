# P4c + C2 Placeholder Buildout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the two data-gated deferred items — insurance P4c (EAL / deductible review / self-insure split / re-bid pipeline) and tax C2 refinements (cost-seg + entity strategies + metadata-only Filed Returns) — running on clearly-marked placeholder fixtures with automatic warehouse cutover when real broker/assessor data arrives.

**Architecture:** Placeholder data lives in `server/warehouse/placeholders/*.placeholder.json`, never in warehouse tables. A loader (`placeholder-data.ts`) resolves each input warehouse-first and stamps a `dataSource` discriminator; pure engines compute real arithmetic on whatever inputs they get; UI renders an amber `PlaceholderBanner` whenever any discriminator is `'placeholder'`. Spec: `docs/superpowers/specs/2026-07-09-p4c-c2-placeholder-buildout-design.md`.

**Tech Stack:** TypeScript strict, Zod contracts, better-sqlite3 (in-memory for tests), Hono, React 19 + TanStack Query, vitest + @testing-library/react.

## Global Constraints

- Worktree: `C:\Users\Owner\oxford-command-center\.claude\worktrees\p4c-placeholders`, branch `feat/cc-p4c-c2-placeholders`. Never touch the main checkout.
- **No migrations.** Migration 022 (insurance_loss_events + deductible/coverage_limit columns) already shipped.
- **No calibration writes when any input dataSource is `'placeholder'`.** Hard rule; tested.
- Banned constants stay banned: no 1.6× EAL risk load, no 62% transfer share, no marginal-tax-rate assumption. Savings-in-tax-dollars fields stay `null` in v1.
- Every derived figure: `prov: Provenance` with `confidence: 'estimated'` and `source` naming the fixture file when placeholder; report-level `advisoryOnly: z.literal(true)`.
- Semantic tokens only in UI (`--surface-*`, `--text-*`, `--accent*`, `--color-*`); no raw hex; text on accent fills uses `var(--text-on-accent)`.
- Use the Edit tool for existing files (CRLF preservation — repo stores CRLF blobs, autocrlf=true).
- Commit trailer on every commit: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Engine/financial commits add `Refute-Reviewed: wf_<runId>` at PR time (Task 13); UI/docs commits carry `Refute-Skip: display-only placeholder surface — no ratified financial math`.
- Tests: `npx vitest run tests/unit/<file>` for a single file. A spurious `0xC0000005` crash with zero FAIL markers = known flaky teardown → rerun once, don't debug.
- Property ids in fixtures MUST be real roster slugs (verify against `server/warehouse/property-master.ts` `CANON_PROPERTIES`): `3540-e-5th-ave-columbus-oh`, `3034-westerville-rd-columbus-oh`, `29000-information-lane-easton-md`, `9620-e-state-route-350-raytown-mo`, `9050-red-branch-rd-columbia-md`, `sepich-portfolio-columbus-oh-8-props`.
- Line numbers cited from the 2026-07-09 integration map are "approximately here — re-grep to confirm" before editing.

---

### Task 1: `PlaceholderBanner` primitive

**Files:**
- Create: `src/primitives/PlaceholderBanner.tsx`
- Test: `tests/unit/placeholder-banner.test.tsx`

**Interfaces:**
- Produces: `PlaceholderBanner({ detail, label? }: { detail: string; label?: string }): JSX.Element` — amber `role="status"` banner. Default label `"PLACEHOLDER DATA"`.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PlaceholderBanner } from '../../src/primitives/PlaceholderBanner';

afterEach(cleanup);

describe('PlaceholderBanner', () => {
  it('renders label, detail, and role=status', () => {
    render(<PlaceholderBanner detail="Synthetic loss runs pending broker data." />);
    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('PLACEHOLDER DATA');
    expect(banner.textContent).toContain('Synthetic loss runs pending broker data.');
  });

  it('accepts a custom label', () => {
    render(<PlaceholderBanner label="PLACEHOLDER BASIS" detail="x" />);
    expect(screen.getByRole('status').textContent).toContain('PLACEHOLDER BASIS');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/placeholder-banner.test.tsx`
Expected: FAIL — cannot resolve `../../src/primitives/PlaceholderBanner`.

- [ ] **Step 3: Write minimal implementation**

Model on `src/modules/capital/HurdleRateBanner.tsx` and `src/shell/StaleBanner.tsx` (read both first for the exact tint idiom). Content:

```tsx
// src/primitives/PlaceholderBanner.tsx
//
// Amber advisory banner for surfaces running on placeholder fixture data
// (server/warehouse/placeholders/*). Rendered whenever a report's dataSource
// discriminator is 'placeholder' — see docs/placeholder-data.md. Figures under
// this banner are never decision-grade.

export function PlaceholderBanner({ detail, label = 'PLACEHOLDER DATA' }: { detail: string; label?: string }) {
  return (
    <div
      role="status"
      style={{
        background: 'color-mix(in srgb, var(--color-warn) 14%, transparent)',
        border: '1px solid color-mix(in srgb, var(--color-warn) 45%, transparent)',
        borderRadius: 8,
        padding: '8px 12px',
        marginBottom: 12,
        fontSize: 13,
        color: 'var(--text-primary)',
      }}
    >
      <strong style={{ color: 'var(--color-warn)', marginRight: 8 }}>{label}</strong>
      {detail}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes** — same command, expect PASS.

- [ ] **Step 5: Commit**

```bash
git add src/primitives/PlaceholderBanner.tsx tests/unit/placeholder-banner.test.tsx
git commit -m "feat(primitives): PlaceholderBanner for placeholder-data surfaces

Refute-Skip: display-only primitive — no financial math

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Placeholder fixtures + loader with warehouse-first cutover

**Files:**
- Create: `server/warehouse/placeholders/loss-runs.placeholder.json`
- Create: `server/warehouse/placeholders/dec-pages.placeholder.json`
- Create: `server/warehouse/placeholders/depreciable-basis.placeholder.json`
- Create: `server/warehouse/placeholders/filed-returns.placeholder.json`
- Create: `server/warehouse/placeholder-data.ts`
- Test: `tests/unit/placeholder-data.test.ts`

**Interfaces:**
- Produces (exact, consumed by Tasks 4/5/8/9):

```ts
export type DataSource = 'warehouse' | 'placeholder' | 'absent';
export interface LossEventRow { id: string; propertyId: string; policyRef: string | null; lossDate: string; cause: string | null; grossIncurred: number; paid: number | null; reserve: number | null; source: string; }
export interface LossEventsResolved { rows: LossEventRow[]; source: DataSource; droppedRows: number; }
export function resolveLossEvents(db: WarehouseDb): LossEventsResolved;
export interface DecPageEntry { deductible: number | null; coverageLimit: number | null; source: DataSource; }
export interface DecPagesResolved { byPolicyId: ReadonlyMap<string, DecPageEntry>; anyPlaceholder: boolean; }
export function resolveDecPages(db: WarehouseDb): DecPagesResolved;
export interface BasisRow { propertyId: string; depreciableBasis: number; landAllocationPct: number; placedInServiceYear: number; reclassifiablePct: number; }
export interface BasisResolved { rows: BasisRow[]; source: DataSource; bonusPctByYear: Record<string, number>; scheduleNote: string; droppedRows: number; }
export function resolveDepreciableBasis(db: WarehouseDb): BasisResolved;
export interface FiledReturnRow { id: string; taxYear: number; entity: string; preparer: string | null; status: 'filed' | 'extended' | 'amended'; storageNote: string; }
export function resolveFiledReturns(): { rows: FiledReturnRow[]; source: DataSource };
```

Resolution rules (all fail-soft — a missing/corrupt fixture yields `source:'absent'`, empty rows, never a throw):
- `resolveLossEvents`: `SELECT count(*) FROM insurance_loss_events` > 0 → map warehouse rows (`source:'warehouse'`); else fixture rows filtered to property ids present in `property_master` (dropped count disclosed), `source:'placeholder'`; fixture missing/corrupt → `'absent'`.
- `resolveDecPages`: for every row of `property_insurance_policies` (latest per policy id is irrelevant here — key by `p.id`): real non-null `deductible`/`coverage_limit` → `source:'warehouse'` for that policy; else blanket values from `dec-pages.placeholder.json` → `'placeholder'`; fixture missing → entry `source:'absent'` with nulls.
- `resolveDepreciableBasis`: fixture-only in v1; rows filtered to real property ids (drops disclosed).
- `resolveFiledReturns`: fixture-only in v1.

- [ ] **Step 1: Write the fixtures** (exact content; `source`/notes must scream placeholder)

`loss-runs.placeholder.json`:
```json
{
  "_note": "PLACEHOLDER loss-run history — synthetic, obviously-round figures. Replace by importing real broker loss runs via `npm run warehouse:import-loss-runs -- <file>`; once insurance_loss_events has rows this file is ignored automatically.",
  "events": [
    { "id": "PLC-2023-001", "propertyId": "3540-e-5th-ave-columbus-oh", "policyRef": "PLACEHOLDER", "lossDate": "2023-04-12", "cause": "hail", "grossIncurred": 18000, "paid": 18000, "reserve": 0 },
    { "id": "PLC-2023-002", "propertyId": "3034-westerville-rd-columbus-oh", "policyRef": "PLACEHOLDER", "lossDate": "2023-09-02", "cause": "water", "grossIncurred": 7500, "paid": 7500, "reserve": 0 },
    { "id": "PLC-2024-001", "propertyId": "3540-e-5th-ave-columbus-oh", "policyRef": "PLACEHOLDER", "lossDate": "2024-02-20", "cause": "wind", "grossIncurred": 42000, "paid": 40000, "reserve": 2000 },
    { "id": "PLC-2024-002", "propertyId": "29000-information-lane-easton-md", "policyRef": "PLACEHOLDER", "lossDate": "2024-07-15", "cause": "theft", "grossIncurred": 5000, "paid": 5000, "reserve": 0 },
    { "id": "PLC-2024-003", "propertyId": "sepich-portfolio-columbus-oh-8-props", "policyRef": "PLACEHOLDER", "lossDate": "2024-11-30", "cause": "fire", "grossIncurred": 120000, "paid": 95000, "reserve": 25000 },
    { "id": "PLC-2025-001", "propertyId": "9620-e-state-route-350-raytown-mo", "policyRef": "PLACEHOLDER", "lossDate": "2025-03-08", "cause": "water", "grossIncurred": 9000, "paid": 9000, "reserve": 0 },
    { "id": "PLC-2025-002", "propertyId": "9050-red-branch-rd-columbia-md", "policyRef": "PLACEHOLDER", "lossDate": "2025-06-21", "cause": "wind", "grossIncurred": 15000, "paid": 12000, "reserve": 3000 },
    { "id": "PLC-2025-003", "propertyId": "3034-westerville-rd-columbus-oh", "policyRef": "PLACEHOLDER", "lossDate": "2025-10-05", "cause": "liability", "grossIncurred": 30000, "paid": 10000, "reserve": 20000 }
  ]
}
```

`dec-pages.placeholder.json`:
```json
{
  "_note": "PLACEHOLDER blanket deductible/limit assumptions pending broker dec pages. Real per-policy values imported into property_insurance_policies.deductible/coverage_limit win automatically per policy.",
  "blanketDeductible": 25000,
  "blanketCoverageLimit": 2000000
}
```

`depreciable-basis.placeholder.json`:
```json
{
  "_note": "PLACEHOLDER depreciable basis / land allocation — synthetic. Real accountant data gets its own migration + importer (see docs/placeholder-data.md); this file is the interim shape.",
  "bonusPctByYear": { "2025": 0.4, "2026": 0.4 },
  "scheduleNote": "PLACEHOLDER bonus-depreciation schedule — statutory rates shift; confirm with accountant before any reliance.",
  "rows": [
    { "propertyId": "3540-e-5th-ave-columbus-oh", "depreciableBasis": 1200000, "landAllocationPct": 0.2, "placedInServiceYear": 2024, "reclassifiablePct": 0.25 },
    { "propertyId": "3034-westerville-rd-columbus-oh", "depreciableBasis": 900000, "landAllocationPct": 0.2, "placedInServiceYear": 2023, "reclassifiablePct": 0.25 },
    { "propertyId": "29000-information-lane-easton-md", "depreciableBasis": 2000000, "landAllocationPct": 0.25, "placedInServiceYear": 2025, "reclassifiablePct": 0.3 },
    { "propertyId": "9620-e-state-route-350-raytown-mo", "depreciableBasis": 800000, "landAllocationPct": 0.15, "placedInServiceYear": 2024, "reclassifiablePct": 0.2 },
    { "propertyId": "9050-red-branch-rd-columbia-md", "depreciableBasis": 1500000, "landAllocationPct": 0.2, "placedInServiceYear": 2025, "reclassifiablePct": 0.25 }
  ]
}
```

`filed-returns.placeholder.json`:
```json
{
  "_note": "PLACEHOLDER filed-return METADATA only. Return contents NEVER enter this system (cut-list C2 confidentiality boundary — permanent). Real future data = metadata + SharePoint link-out only.",
  "rows": [
    { "id": "PLR-2024-A", "taxYear": 2024, "entity": "PLACEHOLDER — Entity A LLC", "preparer": "PLACEHOLDER CPA", "status": "filed", "storageNote": "Contents in SharePoint — metadata only by design" },
    { "id": "PLR-2024-B", "taxYear": 2024, "entity": "PLACEHOLDER — Entity B LLC", "preparer": "PLACEHOLDER CPA", "status": "extended", "storageNote": "Contents in SharePoint — metadata only by design" },
    { "id": "PLR-2025-A", "taxYear": 2025, "entity": "PLACEHOLDER — Entity A LLC", "preparer": "PLACEHOLDER CPA", "status": "filed", "storageNote": "Contents in SharePoint — metadata only by design" }
  ]
}
```

- [ ] **Step 2: Write the failing loader test** (`tests/unit/placeholder-data.test.ts`, `// @vitest-environment node`)

```ts
// @vitest-environment node
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../server/warehouse/migrate';
import { resolveLossEvents, resolveDecPages, resolveDepreciableBasis, resolveFiledReturns } from '../../server/warehouse/placeholder-data';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare('INSERT INTO property_master (id, name) VALUES (?, ?)').run('3540-e-5th-ave-columbus-oh', '3540 E 5th Ave');
  db.prepare('INSERT INTO property_master (id, name) VALUES (?, ?)').run('3034-westerville-rd-columbus-oh', '3034 Westerville Rd');
  return db;
}

describe('resolveLossEvents cutover', () => {
  it('empty table -> placeholder fixture, filtered to known properties, drops disclosed', () => {
    const r = resolveLossEvents(freshDb());
    expect(r.source).toBe('placeholder');
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.every((e) => ['3540-e-5th-ave-columbus-oh', '3034-westerville-rd-columbus-oh'].includes(e.propertyId))).toBe(true);
    expect(r.droppedRows).toBeGreaterThan(0); // fixture rows for unseeded properties dropped
  });

  it('one real row -> warehouse source, fixture ignored', () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO insurance_loss_events (id, property_id, policy_ref, loss_date, cause, gross_incurred, paid, reserve, source)
       VALUES ('REAL-1', '3540-e-5th-ave-columbus-oh', 'P-1', '2025-01-01', 'wind', 12345, 12345, 0, 'broker-loss-run.xlsx')`,
    ).run();
    const r = resolveLossEvents(db);
    expect(r.source).toBe('warehouse');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.grossIncurred).toBe(12345);
  });
});

describe('resolveDecPages', () => {
  it('null columns -> blanket placeholder; real value wins per policy', () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO property_insurance_policies (id, property_id, insurer, policy_number, premium, source, source_date)
       VALUES ('pol-1', '3540-e-5th-ave-columbus-oh', 'Acme', 'PN-1', 10000, 'workbook', '2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO property_insurance_policies (id, property_id, insurer, policy_number, premium, deductible, coverage_limit, source, source_date)
       VALUES ('pol-2', '3034-westerville-rd-columbus-oh', 'Acme', 'PN-2', 8000, 50000, 5000000, 'dec-page', '2026-01-01')`,
    ).run();
    const r = resolveDecPages(db);
    expect(r.byPolicyId.get('pol-1')).toEqual({ deductible: 25000, coverageLimit: 2000000, source: 'placeholder' });
    expect(r.byPolicyId.get('pol-2')).toEqual({ deductible: 50000, coverageLimit: 5000000, source: 'warehouse' });
    expect(r.anyPlaceholder).toBe(true);
  });
});

describe('fixture-only resolvers', () => {
  it('basis rows filter to known properties and expose the placeholder schedule', () => {
    const r = resolveDepreciableBasis(freshDb());
    expect(r.source).toBe('placeholder');
    expect(r.rows.length).toBe(2); // only the two seeded properties survive
    expect(r.droppedRows).toBe(3);
    expect(r.bonusPctByYear['2026']).toBe(0.4);
    expect(r.scheduleNote).toMatch(/PLACEHOLDER/);
  });

  it('filed returns are metadata-only placeholder rows', () => {
    const r = resolveFiledReturns();
    expect(r.source).toBe('placeholder');
    expect(r.rows.every((x) => x.entity.includes('PLACEHOLDER'))).toBe(true);
  });
});
```

NOTE for implementer: check the actual `property_insurance_policies` column list in `server/warehouse/migrations/008_insurance_policies.sql` before writing the INSERTs — adjust column names (`insurer`, `policy_number`, `source`, `source_date`, NOT-NULL columns) to the real schema. The test must insert real-schema rows.

- [ ] **Step 3: Run test to verify it fails** — `npx vitest run tests/unit/placeholder-data.test.ts` → module not found.

- [ ] **Step 4: Implement `server/warehouse/placeholder-data.ts`**

```ts
// server/warehouse/placeholder-data.ts
//
// Fixture-fallback resolvers for the P4c/C2 placeholder buildout (spec:
// docs/superpowers/specs/2026-07-09-p4c-c2-placeholder-buildout-design.md).
// Placeholder data NEVER enters warehouse tables — it lives in
// server/warehouse/placeholders/*.placeholder.json and is used only when the
// corresponding warehouse source is empty. Cutover to real data is automatic.
// Every resolver is fail-soft: missing/corrupt fixture -> source 'absent',
// empty rows, never a throw.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { WarehouseDb } from './db';

const PLACEHOLDER_DIR = join(dirname(fileURLToPath(import.meta.url)), 'placeholders');

export type DataSource = 'warehouse' | 'placeholder' | 'absent';

function readFixture(name: string): unknown | null {
  try {
    return JSON.parse(readFileSync(join(PLACEHOLDER_DIR, name), 'utf-8'));
  } catch {
    return null;
  }
}

function knownPropertyIds(db: WarehouseDb): Set<string> {
  const rows = db.prepare('SELECT id FROM property_master').all() as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

export interface LossEventRow { /* as in Interfaces block above */ }
// ... (implement exactly the Interfaces block; warehouse read:
//   SELECT id, property_id, policy_ref, loss_date, cause, gross_incurred, paid, reserve, source
//   FROM insurance_loss_events ORDER BY loss_date
// fixture path: events filtered by knownPropertyIds, droppedRows = filtered-out count,
// each fixture row mapped with source: 'loss-runs.placeholder.json')
```

Implement the full four resolvers per the Interfaces block. Key details:
- `resolveDecPages` reads `SELECT id, deductible, coverage_limit FROM property_insurance_policies`; blanket only fills nulls; if the fixture is missing, null-column policies get `{ deductible: null, coverageLimit: null, source: 'absent' }`.
- `resolveDepreciableBasis(db)` filters fixture rows to `knownPropertyIds(db)`.
- Type the fixture parses defensively (validate shape field-by-field; skip malformed rows, count them in `droppedRows`).

- [ ] **Step 5: Run test to verify it passes**, then run the neighboring suites to catch schema drift: `npx vitest run tests/unit/placeholder-data.test.ts tests/unit/insurance-persistence.test.ts`

- [ ] **Step 6: Commit**

```bash
git add server/warehouse/placeholders/ server/warehouse/placeholder-data.ts tests/unit/placeholder-data.test.ts
git commit -m "feat(warehouse): placeholder fixtures + warehouse-first resolvers (P4c/C2)

Refute-Skip: data plumbing only — resolvers select sources, no financial math

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Contract `src/contracts/insurance-loss.ts` (ARCHITECT-OWNED — declared in status.json entry `p4c-c2-placeholder-buildout`)

**Files:**
- Create: `src/contracts/insurance-loss.ts`
- Test: `tests/unit/contracts-insurance-loss.test.ts`

**Interfaces (produces — consumed by Tasks 4/5/6):**

```ts
import { z } from 'zod';
import { Provenance } from './common';

export const LossDataSource = z.enum(['warehouse', 'placeholder', 'absent']);

export const PropertyEal = z.object({
  propertyId: z.string().min(1),
  property: z.string(),
  eventsN: z.number().int().nonnegative(),
  grossIncurredTotal: z.number().nonnegative(),
  observationYears: z.number().int().nonnegative(),
  ealAnnual: z.number().nonnegative().nullable(), // null when indeterminate
  indeterminate: z.boolean(),
  prov: Provenance,
});

export const DeductibleReview = z.object({
  policyId: z.string().min(1),
  property: z.string(),
  propertyId: z.string().nullable(),
  deductible: z.number().nonnegative().nullable(),
  coverageLimit: z.number().nonnegative().nullable(),
  decSource: LossDataSource,
  eventsN: z.number().int().nonnegative(),
  lossesBelowDeductible: z.number().int().nonnegative(),
  lossesAboveDeductible: z.number().int().nonnegative(),
  retainedUsd: z.number().nonnegative(),
  transferredUsd: z.number().nonnegative(),
  overLimitUsd: z.number().nonnegative(),
  lossRatio: z.number().nonnegative().nullable(), // grossIncurredTotal / premium; null when premium 0
  prov: Provenance,
});

export const SelfInsureSplit = z.object({
  retainedUsd: z.number().nonnegative(),
  transferredUsd: z.number().nonnegative(),
  overLimitUsd: z.number().nonnegative(),
  premiumAnnualTotal: z.number().nonnegative(),
  portfolioEalAnnual: z.number().nonnegative().nullable(),
  observationYears: z.number().int().nonnegative(),
});

export const RebidStage = z.enum(['watch', 'quote', 'rebid']);
export const RebidPipelineItem = z.object({
  policyId: z.string().min(1),
  property: z.string(),
  stage: RebidStage,
  excessPremiumVsMedian: z.number().nullable(),
  renewalBucket: z.string(),
  reason: z.string(),
});

export const InsuranceLossReport = z.object({
  asOf: z.string(),
  lossDataSource: LossDataSource,
  decPageDataSource: LossDataSource, // 'placeholder' if ANY policy fell back to blanket values
  droppedFixtureRows: z.number().int().nonnegative(),
  eal: z.array(PropertyEal),
  deductibleReviews: z.array(DeductibleReview),
  selfInsure: SelfInsureSplit,
  rebidPipeline: z.array(RebidPipelineItem),
  basisNote: z.string(),
  advisoryOnly: z.literal(true),
});

export type PropertyEal = z.infer<typeof PropertyEal>;
export type DeductibleReview = z.infer<typeof DeductibleReview>;
export type SelfInsureSplit = z.infer<typeof SelfInsureSplit>;
export type RebidPipelineItem = z.infer<typeof RebidPipelineItem>;
export type InsuranceLossReport = z.infer<typeof InsuranceLossReport>;
```

(Follow the schema/type same-name convention used by `src/contracts/insurance-analysis.ts`. Read `src/contracts/common.ts` to confirm the `Provenance` export name/shape first. Header comment must state: dispersion/arithmetic only, no risk-load or transfer-share constants, placeholder discriminators, calibration writes forbidden on placeholder inputs.)

- [ ] **Step 1: Write the failing contract round-trip test**

```ts
import { describe, expect, it } from 'vitest';
import { InsuranceLossReport } from '../../src/contracts/insurance-loss';

const minimal = {
  asOf: '2026-07-09',
  lossDataSource: 'placeholder',
  decPageDataSource: 'placeholder',
  droppedFixtureRows: 0,
  eal: [{ propertyId: 'p', property: 'P', eventsN: 1, grossIncurredTotal: 10, observationYears: 3, ealAnnual: 3.33, indeterminate: false, prov: { source: 'loss-runs.placeholder.json', confidence: 'estimated' } }],
  deductibleReviews: [],
  selfInsure: { retainedUsd: 0, transferredUsd: 0, overLimitUsd: 0, premiumAnnualTotal: 0, portfolioEalAnnual: null, observationYears: 3 },
  rebidPipeline: [],
  basisNote: 'placeholder',
  advisoryOnly: true,
} as const;

describe('InsuranceLossReport contract', () => {
  it('round-trips a valid report', () => {
    expect(InsuranceLossReport.parse(minimal)).toBeTruthy();
  });
  it('rejects advisoryOnly false and negative EAL', () => {
    expect(() => InsuranceLossReport.parse({ ...minimal, advisoryOnly: false })).toThrow();
    expect(() => InsuranceLossReport.parse({ ...minimal, eal: [{ ...minimal.eal[0], grossIncurredTotal: -1 }] })).toThrow();
  });
});
```

- [ ] **Step 2: Run to fail** → module not found. **Step 3: Implement the contract exactly as the Interfaces block.** **Step 4: Run to pass.** **Step 5: Commit** (`feat(contracts): insurance-loss report contract (P4c placeholder buildout)` + `Refute-Skip: contract shape only` + trailer).

---

### Task 4: Engine `server/warehouse/insurance-loss-analysis.ts`

**Files:**
- Create: `server/warehouse/insurance-loss-analysis.ts`
- Test: `tests/unit/insurance-loss-analysis.test.ts`

**Interfaces:**
- Consumes: `PolicyEconomics` (from `src/contracts/insurance-analysis`), Task 2 resolver outputs, Task 3 contract.
- Produces: `buildInsuranceLossReport(inputs: LossAnalysisInputs): InsuranceLossReport` where

```ts
export interface LossAnalysisInputs {
  asOf: string;
  policies: PolicyEconomics[];              // from buildInsuranceAnalysis(db, asOf) — already deduped
  decPages: DecPagesResolved;               // Task 2
  lossEvents: LossEventsResolved;           // Task 2
}
export const MIN_LOSS_YEARS = 3;
```

Pure function; Zod-parses its own output. Math (the refute pass will re-verify):
- `observationYears` = count of DISTINCT calendar years in `lossEvents.rows` (0 when empty).
- Per property EAL: group events by `propertyId`; `ealAnnual = grossIncurredTotal / observationYears` when `observationYears >= MIN_LOSS_YEARS`, else `null` + `indeterminate: true`. `prov.source` = `'insurance_loss_events'` when lossDataSource `'warehouse'`, else `'loss-runs.placeholder.json'`; `confidence: 'estimated'`; `formula: 'Σ gross_incurred ÷ observed years'`.
- Deductible review: one row per property-package policy (reuse `cohort === 'property-package'`); events matched by `propertyId`. Per event with deductible `d`, limit `L`: `retained += min(gross, d ?? 0)`; `transferred += max(0, min(gross, L ?? Infinity) - (d ?? 0))`; `overLimit += max(0, gross - (L ?? Infinity) → 0 when L null)`. `lossesBelowDeductible` counts events with `gross <= d` (0 when `d` null). `lossRatio = grossIncurredTotal / premium` (null when premium 0). Events on properties with no property-package policy are EXCLUDED from reviews (they still count in EAL) — disclose nothing extra; the EAL table is the complete event view.
- `selfInsure` = sums over deductible reviews + `premiumAnnualTotal` = Σ premium over ALL policies + `portfolioEalAnnual` = Σ non-null property EALs (null when every property is indeterminate).
- Re-bid pipeline, derive-only: for policies with `excessPremiumVsMedian > 0`: `renewalBucket === 'now-45'` → `'rebid'`; `'soon-90'` → `'quote'`; else `'watch'`. `reason` is a human sentence naming the excess $ and bucket.
- `decPageDataSource`: `'warehouse'` only when EVERY reviewed policy's entry came from warehouse; `'placeholder'` if any placeholder; `'absent'` if all absent.
- `basisNote`: one sentence stating dispersion-not-savings + placeholder status.
- **No DB access, no calibration calls in this file.**

- [ ] **Step 1: Write failing tests with hand-computed fixtures** — cover: (a) EAL 18000+42000 over years {2023,2024,2025} → 20000/yr for the property with both events; (b) indeterminate when only 2 distinct years; (c) retained/transferred split with d=25000, L=2000000, gross=42000 → retained 25000, transferred 17000; (d) over-limit disclosure with gross > L; (e) lossRatio null on premium 0; (f) pipeline stage mapping for all three buckets; (g) decPageDataSource mixing rules; (h) `advisoryOnly` true and output Zod-parses. Use literal `PolicyEconomics` objects (build via `InsuranceAnalysisReport`-shaped fixtures or plain objects satisfying the type).

- [ ] **Step 2: Run to fail.** **Step 3: Implement.** **Step 4: Run to pass.** **Step 5: Commit:**

```bash
git commit -m "feat(warehouse): insurance loss analytics engine — EAL, deductible review, self-insure split, re-bid pipeline (P4c)

Pure arithmetic on resolver inputs; no risk-load/transfer-share constants;
placeholder inputs surface via dataSource discriminators. Refute pass runs
pre-PR per governance capsule §5.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: API `server/warehouse/insurance-loss-api.ts` + mount (ARCHITECT-OWNED mount line — declared)

**Files:**
- Create: `server/warehouse/insurance-loss-api.ts`
- Modify: `server/index.ts` (ONE line, after the existing `/api/warehouse/insurance/analysis` mount ≈L67 — re-grep)
- Test: `tests/unit/insurance-loss-api.test.ts` (model harness on the existing `tests/unit/lease-forecast-api.test.ts`)

**Interfaces:**
- Produces route `GET /api/warehouse/insurance/loss` → `InsuranceLossReport` JSON; 503 `{ error: 'warehouse unavailable' }`; 500 `{ error: 'insurance loss analysis failed' }`.

Implementation shape (mirror `insurance-analysis-api.ts`'s `withDb` guard):

```ts
export function insuranceLossApi(getDb: () => WarehouseDb): Hono {
  // GET / :
  //   const db = withDb(); const asOf = new Date().toISOString().slice(0, 10);
  //   const base = buildInsuranceAnalysis(db, asOf);         // reuse P4a policy economics
  //   const report = buildInsuranceLossReport({ asOf, policies: [...base.rebidCandidates-independent full list], decPages: resolveDecPages(db), lossEvents: resolveLossEvents(db) });
  //   NOTE: buildInsuranceAnalysis's report does not expose the full policy list in one array —
  //   read its envelope (renewalCalendar contains EVERY deduped policy sorted by expiry; verify
  //   by reading insurance-analysis.ts before relying on it; if it is filtered, export a small
  //   `policyEconomics(db, asOf): PolicyEconomics[]` helper from insurance-analysis.ts instead
  //   — a non-math, read-only export).
  //   CALIBRATION GUARD: call NOTHING from calibration.ts here. Add the comment:
  //   "No logVerdicts on this route — placeholder-tainted verdicts must never enter calibration history.
  //    When lossDataSource === 'warehouse' && decPageDataSource === 'warehouse', a future phase may add it."
  //   return c.json(report);
}
```

Mount in `server/index.ts` (below the insurance/analysis line):

```ts
app.route('/api/warehouse/insurance/loss', insuranceLossApi(getWarehouse));
```

- [ ] **Step 1: Failing test** — in-memory db via the lease-forecast-api test harness pattern: seed 2 properties + 2 policies (one with real dec-page values), call the Hono app with `app.request('/')`, assert 200, `InsuranceLossReport.parse(body)` succeeds, `lossDataSource === 'placeholder'`, and `SELECT count(*) FROM calibration_verdict` (or the actual verdict table name — check migration 005) is 0. Add a 503 test with a throwing `getDb`.
- [ ] **Step 2: Run to fail. Step 3: Implement (including the one-line mount). Step 4: Run to pass; also `npx tsc --noEmit`. Step 5: Commit** (`feat(api): GET /api/warehouse/insurance/loss (P4c) — no calibration writes on placeholder inputs` + `Refute-Skip: delivery-only route — engine math refuted at PR` + trailer).

---

### Task 6: Insurance UI — Self-Insure & Bids tab + SavingsBoard Optimize tier

**Files:**
- Create: `src/modules/insurance/SelfInsureView.tsx`
- Modify: `src/modules/insurance/InsuranceModule.tsx` (TABS ≈L25-29, body switch ≈L128)
- Modify: `src/modules/insurance/SavingsBoard.tsx` (third tier; update the "exactly two tiers" header comment ≈L4-6)
- Modify: `src/modules/insurance/hooks.ts` (new hook + tier builder)
- Test: modify `tests/unit/insurance-module.test.tsx` (+ new cases; existing two-tab/two-tier pins updated deliberately)

**Interfaces:**
- Consumes: Task 3 contract, Task 5 route, Task 1 `PlaceholderBanner`, primitives `TierBoard`/`DataTable`/`KpiStat`/`Card`/`Badge`.
- Produces in `hooks.ts`:

```ts
export const INSURANCE_LOSS_KEY = ['warehouse', 'insurance', 'loss'] as const;
export function useInsuranceLoss(): UseQueryResult<InsuranceLossReport>; // fetchParsedOrMirror('/api/warehouse/insurance/loss', InsuranceLossReport), QUERY_OPTS from ../intel/hooks
export function buildOptimizeTier(report: InsuranceLossReport): Tier;    // key 'optimize', title 'Optimize Coverage', tone 'accent'
export function isAnyPlaceholder(report: InsuranceLossReport): boolean;  // lossDataSource or decPageDataSource === 'placeholder'
export function placeholderDetailInsurance(report: InsuranceLossReport): string;
```

UI content:
- `InsuranceModule`: `type Tab = 'savings' | 'register' | 'selfinsure'`; third pill "Self-Insure & Bids" → `<SelfInsureView />`.
- `SelfInsureView`: `useInsuranceLoss()`; loading → `Skeleton`; `WarehouseUnavailableError` → existing offline Card pattern (copy from InsuranceModule's handling); then: `PlaceholderBanner` when `isAnyPlaceholder(report)` (detail: "Synthetic loss runs and blanket deductible/limit assumptions pending broker loss runs + dec pages. No figure on this tab is decision-grade."); split bar Card — two flex segments sized by `retainedUsd`/`transferredUsd` (`background: var(--color-warn)` retained / `var(--color-info)` transferred, labels + $ in `var(--text-primary)`, min-width guard when either is 0); EAL `DataTable` (property, events, gross Σ, years, EAL/yr or "—", `Badge tone="amber"` "indeterminate" when flagged); deductible-review `DataTable` (policy, deductible + `Badge` "placeholder" when `decSource==='placeholder'`, below/above counts, retained, transferred, loss ratio); re-bid pipeline `TierBoard columns={3}` (tiers watch/quote/rebid, tones info/warn/accent; items chips include 'PLACEHOLDER' when `isAnyPlaceholder`).
- `SavingsBoard`: append `buildOptimizeTier(lossReport)` as third tier when `useInsuranceLoss()` resolves (tier items = top deductible reviews by retainedUsd, impactUsd null — the tier is a review queue, not a savings claim; chips: ['PLACEHOLDER'] when placeholder). `columns={3}` when three tiers. Header comment rewritten: tier renders only when a loss/dec data source exists (placeholder or warehouse), never fabricated in-component.

- [ ] **Step 1: Failing module tests** — (a) module renders three tab pills; (b) SelfInsureView with a placeholder-sourced mocked query shows `role="status"` PlaceholderBanner and the EAL table; (c) warehouse-sourced report → no banner; (d) SavingsBoard renders 'Optimize Coverage' tier when loss report present, absent when hook errors with WarehouseUnavailableError. Mock via QueryClientProvider + `fetch` stub or module-level `vi.mock` of hooks — follow the existing insurance-module.test.tsx approach.
- [ ] **Step 2-4: fail → implement → pass** (also update any existing test pinning two tabs/tiers — the update is deliberate scope). Run `npx vitest run tests/unit/insurance-module.test.tsx tests/unit/placeholder-banner.test.tsx` + `npx tsc --noEmit`.
- [ ] **Step 5: Commit** (`feat(insurance): Self-Insure & Bids tab + Optimize Coverage tier on placeholder loss data (P4c)` + `Refute-Skip: display-only placeholder surface` + trailer).

---

### Task 7: Contract `src/contracts/tax-strategy.ts` (ARCHITECT-OWNED — declared)

**Files:**
- Create: `src/contracts/tax-strategy.ts`
- Test: `tests/unit/contracts-tax-strategy.test.ts`

**Interfaces (produces):**

```ts
import { z } from 'zod';
import { Provenance } from './common';

export const StrategyDataSource = z.enum(['warehouse', 'placeholder', 'absent']);

export const CostSegOpportunity = z.object({
  propertyId: z.string().min(1),
  propertyName: z.string().nullable(),
  depreciableBasis: z.number().nonnegative(),
  landAllocationPct: z.number().min(0).max(1),
  reclassifiablePct: z.number().min(0).max(1),
  reclassifiableBasis: z.number().nonnegative(),          // depreciableBasis × reclassifiablePct
  bonusYearPct: z.number().min(0).max(1).nullable(),      // from placeholder schedule; null when year missing
  firstYearAccelerationUsd: z.number().nonnegative().nullable(), // reclassifiableBasis × bonusYearPct — DEDUCTION acceleration, not tax dollars
  firstYearAccelerationOxfordShare: z.number().nonnegative().nullable(), // × real ownershipPct
  savingsFullAsset: z.null(),                             // v1: ALWAYS null — no marginal-rate assumption
  savingsOxfordShare: z.null(),                           // v1: ALWAYS null
  indeterminate: z.boolean(),
  basisNote: z.string(),
  prov: Provenance,
});

export const EntityStrategyItem = z.object({
  id: z.string().min(1),
  title: z.string(),
  detail: z.string(),
  kind: z.enum(['entity-structure', 'sec469', 'pipeline']),
  applicabilityNote: z.string(), // qualitative; no dollars by design
});

export const FiledReturnMeta = z.object({
  id: z.string().min(1),
  taxYear: z.number().int(),
  entity: z.string(),
  preparer: z.string().nullable(),
  status: z.enum(['filed', 'extended', 'amended']),
  storageNote: z.string(),
});

export const TaxStrategyReport = z.object({
  asOf: z.string(),
  basisDataSource: StrategyDataSource,
  filedReturnsDataSource: StrategyDataSource,
  droppedFixtureRows: z.number().int().nonnegative(),
  scheduleNote: z.string(),
  costSeg: z.array(CostSegOpportunity),
  entityStrategies: z.array(EntityStrategyItem),
  filedReturns: z.array(FiledReturnMeta),
  advisoryOnly: z.literal(true),
});
```

Header comment MUST state: (1) filed returns are metadata-only PERMANENTLY (C2 confidentiality boundary — contents never enter this system, real future data = metadata + SharePoint link-out); (2) `savings*` are hard-null in v1 (no marginal-rate invention); (3) acceleration figures are deduction timing, not tax savings.

- [ ] **Steps 1-5:** same TDD cycle as Task 3 (round-trip + rejects `savingsFullAsset: 5` + rejects `advisoryOnly: false`). Commit `feat(contracts): tax-strategy report contract (C2 placeholder buildout)` + `Refute-Skip: contract shape only` + trailer.

---

### Task 8: Engine `server/warehouse/tax-strategy.ts`

**Files:**
- Create: `server/warehouse/tax-strategy.ts`
- Test: `tests/unit/tax-strategy.test.ts`

**Interfaces:**
- Consumes: Task 2 `resolveDepreciableBasis`/`resolveFiledReturns`, Task 7 contract.
- Produces: `buildTaxStrategyReport(db: WarehouseDb, asOf: string): TaxStrategyReport` (reads `property_master` for `name`/`ownership_pct` — verify the actual column name in `property-master.ts` before writing SQL).

Math (refuted at PR): `reclassifiableBasis = depreciableBasis × reclassifiablePct`; `bonusYearPct = bonusPctByYear[String(currentYear from asOf)] ?? null`; `firstYearAccelerationUsd = reclassifiableBasis × bonusYearPct` (null when pct null → `indeterminate: true`); `firstYearAccelerationOxfordShare = firstYearAccelerationUsd × ownershipPct` (real roster value; null propagates). `savings* = null` always. Entity strategies: three static qualitative items (ids `es-entity-review`, `es-sec469-grouping`, `es-pipeline-1031`) whose `applicabilityNote` says "Qualitative placeholder — review with accountant; no dollar impact is computed by design." `prov.source = 'depreciable-basis.placeholder.json'` (or `'warehouse'` label when a future real source exists), `confidence: 'estimated'`, formula string for acceleration. **No calibration calls.** Zod-parse own output.

- [ ] **Steps 1-5:** TDD: hand-computed case (basis 1,200,000 × 0.25 × 0.4 = 120,000; Oxford share ×0.5 = 60,000 when ownershipPct 0.5 — seed property_master accordingly); missing-year schedule → nulls + indeterminate; dropped fixture rows disclosed; output parses; zero calibration rows. Commit `feat(warehouse): tax strategy engine — cost-seg acceleration + entity strategies on placeholder basis (C2)` + trailer (no Refute-Skip — refuted at PR).

---

### Task 9: `GET /api/warehouse/tax/strategy` in existing tax-api

**Files:**
- Modify: `server/warehouse/tax-api.ts` (add route to the existing factory, reusing its `withDb` guard ≈L70-83)
- Test: `tests/unit/tax-strategy-api.test.ts`

**Interfaces:** route returns `TaxStrategyReport`; 503/500 envelope identical to `GET /analysis`. **No calibration writes** (same guard comment as Task 5). No server/index.ts change (taxApi already mounted at `/api/warehouse/tax`).

- [ ] **Steps 1-5:** TDD mirroring Task 5 (request `/strategy` on the factory app; parse body with contract; calibration-verdict count 0; 503 test). Commit `feat(api): GET /api/warehouse/tax/strategy (C2) — no calibration writes on placeholder inputs` + `Refute-Skip: delivery-only route` + trailer.

---

### Task 10: Taxes UI — Filed Returns tab + Cost-Seg strategy tier

**Files:**
- Create: `src/modules/taxes/FiledReturnsTable.tsx`
- Modify: `src/modules/taxes/TaxesModule.tsx` (TABS ≈L29-33 → add `'returns'` "Filed Returns"; scope-note comment ≈L5-7 updated: tab now ships metadata-only, boundary unchanged)
- Modify: `src/modules/taxes/StrategyBoard.tsx` (third tier replaces `DeferredStrategiesCard` when strategy data present; card remains the `'absent'` fallback)
- Modify: `src/modules/taxes/hooks.ts` (new hook + helpers)
- Test: modify `tests/unit/taxes-module.test.tsx`

**Interfaces:**
- Consumes: Task 7 contract, Task 9 route, Task 1 banner.
- Produces in `hooks.ts`:

```ts
export const TAX_STRATEGY_KEY = ['warehouse', 'tax', 'strategy'] as const;
export function useTaxStrategy(): UseQueryResult<TaxStrategyReport>; // fetchParsedOrMirror('/api/warehouse/tax/strategy', TaxStrategyReport)
export function buildCostSegTier(report: TaxStrategyReport): Tier;   // key 'costseg', title 'Depreciation & Cost-Seg', tone 'accent'; impactUsd = firstYearAccelerationOxfordShare (null-safe), impactKind 'info'; detail MUST say "deduction acceleration (placeholder basis), not tax savings"; chips ['PLACEHOLDER'] when basisDataSource === 'placeholder'
export function placeholderDetailTax(report: TaxStrategyReport): string;
```

UI content:
- `FiledReturnsTable`: `PlaceholderBanner` (label "PLACEHOLDER METADATA", detail: "Synthetic filing metadata pending accountant records. Return contents never enter this system — metadata and SharePoint link-out only, by confidentiality design (cut-list C2)."); `DataTable` columns: Tax Year, Entity, Preparer, Status (`Badge` — filed→green, extended→amber, amended→blue), Storage (storageNote text). Below the table a small muted paragraph repeating the boundary sentence.
- `StrategyBoard`: accept the strategy report via prop or internal `useTaxStrategy()` (match the file's existing data-flow style — read it first; if it currently receives the analysis report as a prop from TaxesModule, thread the strategy report the same way). Three-tier board when `basisDataSource !== 'absent'` (`columns={3}`); entity strategies render as a separate Card ("Structure & Pipeline — qualitative") listing the three items; `DeferredStrategiesCard` only when `'absent'`.

- [ ] **Steps 1-5:** TDD: (a) three tab pills incl. "Filed Returns"; (b) FiledReturnsTable shows banner + a PLACEHOLDER entity row; (c) StrategyBoard with placeholder-sourced report renders 'Depreciation & Cost-Seg' tier and NOT the deferred card; (d) with `basisDataSource:'absent'` renders the deferred card and no third tier; (e) cost-seg tier detail contains "not tax savings". Update existing pins on two tabs/tiers deliberately. Run module tests + `npx tsc --noEmit`. Commit `feat(taxes): Filed Returns (metadata-only) tab + cost-seg strategy tier on placeholder basis (C2)` + `Refute-Skip: display-only placeholder surface` + trailer.

---

### Task 11: Import script — the one-command real-data swap

**Files:**
- Create: `scripts/import-insurance-data.ts`
- Modify: `package.json` (ARCHITECT-OWNED; scripts only: add `"warehouse:import-loss-runs": "tsx scripts/import-insurance-data.ts"` — declared in the claim's spirit; note it in the PR body)
- Test: `tests/unit/import-insurance-data.test.ts`

**Interfaces:**
- CLI: `npm run warehouse:import-loss-runs -- <file.json>` (loss events; shape = fixture's `events` array with an added required `source` string per row or a top-level `source`), and `npm run warehouse:import-loss-runs -- --dec-pages <file.json>` (array of `{ policyId, deductible, coverageLimit }`).
- Produces (exported for tests): `importLossRuns(db: WarehouseDb, payload: unknown): { inserted: number; ignored: number; rejected: number }` (Zod-validate rows; `INSERT OR IGNORE INTO insurance_loss_events` — idempotent via the 022 UNIQUE(property_id, loss_date, cause, gross_incurred)); `importDecPages(db, payload): { updated: number; missing: number; rejected: number }` (`UPDATE property_insurance_policies SET deductible=?, coverage_limit=? WHERE id=?`).
- CLI main guard reads `WAREHOUSE_DB` env (mirror how other scripts in `scripts/` open the db — read one, e.g. the backfill script, and copy its open pattern).

- [ ] **Steps 1-5:** TDD: double-run inserts once (`inserted:8, ignored:0` then `inserted:0, ignored:8`); malformed row rejected with count, valid rows still land; dec-page update hits existing policy, missing id counted; after import, `resolveLossEvents(db).source === 'warehouse'` (the cutover proof — this single assertion ties the whole architecture together). Commit `feat(scripts): warehouse:import-loss-runs — validated, idempotent real-data swap (P4c)` + `Refute-Skip: ingest plumbing — validation only, no financial math` + trailer.

---

### Task 12: Docs + CLAUDE.md §3 doc-drift fix (ARCHITECT-OWNED — declared)

**Files:**
- Create: `docs/placeholder-data.md`
- Modify: `CLAUDE.md` §3 "Pending" line (re-grep for `Pending:` — currently claims Phase 7 + P4c deferred)
- Modify: `CHANGELOG.md` (append section after the 2026-07-06 note, per its own guidance to start from PR #95 forward)

**Content requirements:**
- `docs/placeholder-data.md`: table of the four fixtures (file → what it stands in for → real-data swap path → discriminator field); the honesty rails (no calibration writes on placeholder; savings-null-v1; filed-returns metadata-only permanently); swap procedures: loss runs / dec pages = `npm run warehouse:import-loss-runs` (automatic cutover); depreciable basis = future migration + importer when accountant data arrives (fixture shape is the interim contract); pointer to the spec.
- `CLAUDE.md` §3 Pending line replacement (exact text): `**Pending:** Hurdle rate ratification (8% unlevered IRR governor) pending Gabriel sign-off to upgrade from advisoryOnly. Phase 7 parity sweep MERGED via PR #169 (2026-07-06 — the previous version of this line was stale). P4c (insurance self-insure/deductible) and C2 tax refinements (cost-seg/filed-returns metadata) are BUILT on clearly-marked placeholder fixtures (docs/placeholder-data.md) pending real broker/assessor data — swap via warehouse:import-loss-runs; basis data needs a future migration. Next initiative TBD.`
- CHANGELOG entry: standard style, summarizing the buildout + the no-calibration-on-placeholder rule + swap path.

- [ ] **Steps:** write docs → `npx vitest run tests/unit` quick affected re-run not needed (docs only) → commit `docs: placeholder-data doctrine + CLAUDE.md §3 drift fix (Phase 7 merged; P4c/C2 built on placeholders)` + `Refute-Skip: documentation only` + trailer.

---

### Task 13: Full verification, refute workflow, status flip, PR

**Files:** `architecture/status.json` (own entry only), PR via `gh`.

- [ ] **Step 1:** Full suite: `npm run test` (rerun once on 0xC0000005 with zero FAIL markers).
- [ ] **Step 2:** `npm run gate` (7 steps). `warehouse:verify` EPERM on tmp-cleanup in this worktree = known environment artifact → re-run that step from the MAIN checkout at the same commit to confirm, per `oxford-command-center worktree gotchas`; do not chase it here.
- [ ] **Step 3:** `npm run gate:ci` locally (catches build-only breaks per `gate vs gate:ci divergence` memory) — includes `vite build` + `check:bundle`.
- [ ] **Step 4:** Refute pass (financial-decision code): run the repo workflow `refute-financial-change` over the two engines (changeSet: `server/warehouse/insurance-loss-analysis.ts`, `server/warehouse/tax-strategy.ts`, their tests, and the placeholder resolvers feeding them). Fix anything CONFIRMED. Record `wf_<runId>`.
- [ ] **Step 5:** Amend/annotate: add `Refute-Reviewed: wf_<runId>` to the PR body (commits already carry Refute-Skip where applicable; the PR body carries the engine refute record — matches the repo's PR-level refute pattern).
- [ ] **Step 6:** Update own status.json entry: `status: "review_needed"`, `review_detail` = summary + the architect-owned files actually touched + refute run id; `last_updated` fresh. Validate JSON. Commit `docs(status): p4c-c2-placeholder-buildout ready for review`.
- [ ] **Step 7:** Push + PR (never merge):

```bash
git push -u origin feat/cc-p4c-c2-placeholders
gh pr create --base main --title "feat(insurance,taxes): P4c + C2 on placeholder fixtures — EAL/self-insure/deductible + cost-seg/filed-returns (auto-cutover to real data)" --body "<summary + architect-owned touches + honesty rails + swap path + Refute-Reviewed: wf_<runId> + test plan>

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Self-Review (completed at authoring)

- **Spec coverage:** §1 loader/fixtures → Task 2; §2 rails → enforced in Tasks 3-10 + tested (calibration-zero assertions in 5/8/9; banner tests in 6/10; savings-null in 7/8); §3.1 → Tasks 3-6, 11; §3.2 → Tasks 7-10; §3.3 → Tasks 1, 12; §4 error handling → Tasks 2 (fail-soft) & 5/9 (503); §5 testing → per-task TDD incl. cutover (Task 2, re-proven in Task 11); §6 governance → claim already committed (1c2277d), Task 13.
- **Placeholder scan (plan-quality sense):** every code step has concrete content or an explicit read-first instruction naming the exact source file to mirror; no TBDs.
- **Type consistency:** `LossEventsResolved`/`DecPagesResolved` names match between Tasks 2/4/5; `InsuranceLossReport` between 3/4/5/6; `TaxStrategyReport` between 7/8/9/10; tier keys `'optimize'`/`'costseg'` used once each.
- **Known judgment point for implementers:** Task 5's full-policy-list question (renewalCalendar completeness) has an explicit verify-then-fallback instruction (export a read-only `policyEconomics` helper).
