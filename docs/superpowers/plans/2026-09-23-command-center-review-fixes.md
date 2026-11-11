# Command Center Review Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every defect and ship every improvement from the 2026-09-23 live review of the Oxford Command Center, so that every screen shows correct, fresh, labeled data and every time-series or ranking surface has a chart.

**Architecture:** Six independent PRs (waves), each shippable alone and each leaving `npm run gate` green: (1) correctness, (2) resilience and freshness, (3) polish, (4) IA consolidation plus residence exclusion, (5) charts, (6) basis labels and guardrails. Pure functions carry the logic and are unit-tested; components stay thin. Data and ops fixes that live outside the repo are a separate **Ops Runbook** at the end. Those are not code tasks.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), React 18, Vite 6, TanStack Query, Hono, better-sqlite3, Zod v3, visx 3.12, vitest + @testing-library/react.

## Global Constraints

- Base: branch `fix/cc-review-2026-09-23` from `origin/main` @ `98d9302`, worktree `.claude/worktrees/cc-review-fixes`. Re-fetch and rebase before each PR (the repo lands multiple PRs a day).
- Every commit leaves `npm run gate` green. Never `--no-verify`. The gate intermittently crashes with 0xC0000005 on this machine. If output is otherwise correct, rerun it; don't "fix" it.
- Commit with explicit paths only (never `git add -A`). Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Refute gate:** any commit touching `server/**`, `scripts/**`, `src/analytics/**`, or the financial contracts listed in `scripts/check-refute-required.ts` needs a trailer: `Refute-Reviewed: wf_<runId>` (run the `refute-financial-change` skill) or `Refute-Skip: <reason>`. Each task states which one applies. Run `npx tsx scripts/check-refute-required.ts` before every push.
- **Architect-owned files touched by this plan:** `src/contracts/acquisition.ts`, `src/contracts/insurance-analysis.ts`, `src/analytics/engine.ts`, `server/index.ts`, `vite.config.ts`. Task 0 posts the `review_needed` claim. Do not edit these until Gabriel acknowledges.
- Governor constants (DSCR 1.25 / LTV 40% aggregate / 65% per-property) are NOT changed by any task.
- Never touch: `data/overlay.json`, `data/warehouse/finance.sqlite` (read-only queries only, no DDL), `confidential-terms.json`, anything under `C:\Users\Owner\OneDrive - Oxford Capital Partners\` (business OneDrive, read-only).
- Worktree env: follow CLAUDE.md §5 (`WAREHOUSE_DB` pointed at the worktree). Do NOT copy the real `.env` in for test runs (warehouse tests time out on OneDrive I/O). If a live-preview check needs it, delete the copy afterwards.
- Ratified in-turn by Gabriel 2026-09-23: (a) exclude the **residence only** (9510 Persimmon Tree) from investment KPIs; the solar project stays; (b) attention lists get **one home each**: Overview keeps a compact top 5 with "See all" → Brain › Insights; Brain Digest becomes a count summary; Worklist Alerts stays the action queue.
- UI copy: no internal jargon ("Spine A/B") on user surfaces. Use "Workbook", "Ledger", "Combined".

## Wave / PR map

| PR | Wave | Tasks |
|---|---|---|
| 1 | Correctness | 1–5 |
| 2 | Resilience & freshness | 6–11 |
| 3 | Polish | 12–17 |
| 4 | IA consolidation + residence | 18–20 |
| 5 | Charts | 21–28 |
| 6 | Basis labels & guardrails | 29–31 |

Waves are independent. Order within a wave matters only where a task's **Interfaces → Consumes** says so.

## File inventory

**Create:**
`src/shell/SnapshotGate.tsx` · `server/startup.ts` · `server/feed-freshness.ts` · `server/sources/html-to-text.ts` · `server/warehouse/insurance-property-map.ts` · `server/warehouse/insurance-history.ts` · `src/lib/spine-label.ts` · `src/modules/principal/digest-summary.ts` · `src/charts/ScatterChart.tsx` · `src/modules/leasing/RolloverChart.tsx` · `src/modules/insurance/PremiumHistoryCard.tsx` · `src/modules/taxes/AssessmentHistoryCard.tsx` · `src/modules/calendar/month-at-stake.ts` · `src/modules/leasing/forecast-bridge.ts` · `src/modules/market/comps-display.ts` · `src/modules/capital/cap-rate-scatter.ts` · tests listed per task.

**Modify:** listed per task.

**Must not be touched:** `data/overlay.json`, `data/warehouse/finance.sqlite`, `hooks/confidential-terms.json`, `.github/workflows/*`, `.claude/settings.json`, governor constants in `server/warehouse/capital-config.ts` / `config/*.json`, any business-OneDrive file.

---

### Task 0: Claim, review flag, baseline

**Files:**
- Modify: `architecture/status.json` (add one entry)

- [ ] **Step 1: Add the status.json entry.** Insert under the top-level object (keep existing entries byte-identical):

```json
"cc-review-fixes": {
  "agent_role": "Lead Architect (delegated)",
  "phase": "2026-09-23 command-center review fixes (6 PRs)",
  "status": "in_progress",
  "blocked_by": null,
  "review_needed": true,
  "detail": "Architect-owned touches: src/contracts/acquisition.ts (add 'hubspot-pipeline' to AcqCandidateRow.source), src/contracts/insurance-analysis.ts (PremiumHistory schema), src/analytics/engine.ts (residence exclusion in portfolioKpis — ratified by Gabriel in-turn 2026-09-23), server/index.ts (startup ordering + /api/health feeds), vite.config.ts (watch.ignored data/**). Plan: docs/superpowers/plans/2026-09-23-command-center-review-fixes.md",
  "last_updated": "2026-09-23T00:00:00Z"
}
```

- [ ] **Step 2: Allow this session's model trailer.** The commit-msg guard (PR #362) only allows the Sonnet 5 and Fable 5.1 trailers, so every commit in this plan is blocked (verified 2026-09-23). Do not sign as a different model. Add a failing assertion to the `describe('ALLOWED_AI_TRAILERS', …)` block in `tests/unit/commitmsg-trailer-guard.test.ts`:

```ts
    expect(ALLOWED_AI_TRAILERS).toContain('Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>');
```

Run `npx vitest run tests/unit/commitmsg-trailer-guard.test.ts` (expected: FAIL). Then append the exact line as a third entry of `ALLOWED_AI_TRAILERS` in `scripts/commitmsg-trailer-guard.mjs:36-39`:

```js
  'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
```

Rerun. Expected: PASS.
- [ ] **Step 3: Validate governance.** Run: `npm run governance`. Expected: PASS.
- [ ] **Step 4: Baseline.** Run: `npm run gate`. Expected: all 11 steps green (rerun once on 0xC0000005).
- [ ] **Step 5: Commit** (includes this plan file):

```bash
git add architecture/status.json scripts/commitmsg-trailer-guard.mjs tests/unit/commitmsg-trailer-guard.test.ts docs/superpowers/plans/2026-09-23-command-center-review-fixes.md
git commit -m "chore: claim cc-review-fixes, allow the Opus 5.5 co-author trailer, add the review-fixes plan" -m "Refute-Skip: commit-trailer allowlist + status/docs only; no financial code" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: STOP.** Wait for Gabriel to acknowledge `review_needed` before any task that edits an architect-owned file (Tasks 1, 7, 8, 10, 20, 24).

---

## PR 1 — Correctness

### Task 1: Acquisitions 500 — add `hubspot-pipeline` to the candidate source enum + contract-drift test

**Files:**
- Modify: `src/contracts/acquisition.ts:395`
- Create: `tests/unit/acq-source-contract-drift.test.ts`
- Modify: `tests/unit/acq-api.test.ts` (append one `describe`)

**Interfaces:**
- Produces: `AcqCandidateRow.shape.source` accepts `'hubspot-pipeline'`.

- [ ] **Step 1: Write the failing drift test.** Create `tests/unit/acq-source-contract-drift.test.ts`:

```ts
// @vitest-environment node
// Every literal the server writes into acq_candidates.source must parse against the read-side
// Zod enum — PR #203 added a 'hubspot-pipeline' writer without widening AcqCandidateRow, and one
// HubSpot row 500'd GET /acq/intel and /acq/candidates (2026-09-23 review).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AcqCandidateRow } from '@contracts/acquisition';

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return tsFiles(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

describe('acq_candidates.source contract drift', () => {
  it('every source literal the server INSERTs parses against AcqCandidateRow.source', () => {
    const literals = new Set<string>();
    const re = /INSERT(?:\s+OR\s+IGNORE)?\s+INTO\s+acq_candidates[\s\S]*?VALUES\s*\(\s*\?\s*,\s*'([a-z-]+)'/g;
    for (const f of tsFiles('server')) {
      for (const m of readFileSync(f, 'utf8').matchAll(re)) literals.add(m[1]!);
    }
    expect(literals.size).toBeGreaterThan(0);
    for (const s of literals) {
      expect(AcqCandidateRow.shape.source.safeParse(s).success, `unparseable source literal: ${s}`).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Write the failing route test.** Append to `tests/unit/acq-api.test.ts` (reuses its `freshDb`/`makeApp` helpers):

```ts
describe('GET /acq/intel + /acq/candidates with a HubSpot-sourced row', () => {
  function seedHubspotRow(db: WarehouseDb) {
    db.prepare(`
      INSERT INTO acq_candidates
        (id, source, address, county, state, market, rentable_sf, year_built, owner_name, status, content_hash)
      VALUES (?, 'hubspot-pipeline', ?, NULL, NULL, NULL, NULL, NULL, NULL, 'active', 'h1')
    `).run('hubspot:123', 'Pipeline Deal 21');
  }

  it('/acq/intel returns 200 and includes the row', async () => {
    const db = freshDb();
    seedHubspotRow(db);
    const res = await makeApp(db).request('/acq/intel');
    expect(res.status).toBe(200);
    const body = AcqIntelResponse.parse(await res.json());
    expect(body.rankedCandidates.some((c) => c.id === 'hubspot:123')).toBe(true);
  });

  it('/acq/candidates returns 200 and includes the row', async () => {
    const db = freshDb();
    seedHubspotRow(db);
    const res = await makeApp(db).request('/acq/candidates');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: Array<{ id: string; source: string }> };
    expect(body.candidates.find((c) => c.id === 'hubspot:123')?.source).toBe('hubspot-pipeline');
  });
});
```

If `rankedCandidates` items expose the id under a different key, read `AcqIntelResponse` in `src/contracts/acquisition.ts` and use that key. The assertion stays "the HubSpot row is present."

- [ ] **Step 3: Run and confirm failure.** Run: `npx vitest run tests/unit/acq-source-contract-drift.test.ts tests/unit/acq-api.test.ts`. Expected: the drift test FAILS with `unparseable source literal: hubspot-pipeline`; both route tests FAIL with status 500.
- [ ] **Step 4: Fix the enum.** In `src/contracts/acquisition.ts:395` replace the line with:

```ts
  source: z.enum(['parcel-screen', 'notion-pipeline', 'hubspot-pipeline', 'manual']),
```

- [ ] **Step 5: Typecheck for exhaustive maps.** Run: `npm run typecheck`. For any `Record<…source…, string>` label map or exhaustive `switch` that now errors, add the entry `'hubspot-pipeline': 'HubSpot'` (label maps) or a `case 'hubspot-pipeline':` sharing the `notion-pipeline` branch (switches). Expected: typecheck clean.
- [ ] **Step 6: Run tests.** Run: `npx vitest run tests/unit/acq-source-contract-drift.test.ts tests/unit/acq-api.test.ts tests/unit/acquisition-contract.test.ts`. Expected: PASS.
- [ ] **Step 7: Commit.** `src/contracts/acquisition.ts` is not in `FINANCIAL_CONTRACT_PATHS`, so no trailer is needed.

```bash
git add src/contracts/acquisition.ts tests/unit/acq-source-contract-drift.test.ts tests/unit/acq-api.test.ts
git commit -m "fix(acq): accept hubspot-pipeline candidates — unbreaks /acq/intel + /acq/candidates 500" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Warehouse routes return JSON errors (ends the false "Warehouse offline")

**Files:**
- Modify: `server/warehouse/api.ts` (after `const app = new Hono();` in `warehouseRoutes`, ~line 207)
- Modify: `src/modules/acquisitions/AcquisitionsIntel.tsx:91-93`
- Create: `tests/unit/warehouse-json-errors.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { warehouseRoutes } from '../../server/warehouse/api';
import type { WarehouseDb } from '../../server/warehouse/db';

describe('warehouse routes — uncaught handler errors', () => {
  it('surface as JSON 500, never text/plain (text/plain is misread client-side as "routes not present")', async () => {
    const throwingDb = { prepare: () => { throw new Error('boom'); } } as unknown as WarehouseDb;
    const res = await warehouseRoutes(() => throwingDb).request('/acq/intel');
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
    expect(await res.json()).toEqual({ error: 'boom' });
  });
});
```

- [ ] **Step 2: Run and confirm failure.** Run: `npx vitest run tests/unit/warehouse-json-errors.test.ts`. Expected: FAIL (content-type is text/plain).
- [ ] **Step 3: Implement.** In `server/warehouse/api.ts`, directly after `const app = new Hono();` inside `warehouseRoutes`:

```ts
  // An uncaught handler error must reach the client as JSON: fetchJson() (src/modules/intel/hooks.ts)
  // treats a non-JSON error body as "warehouse routes not present" and the UI then shows a false
  // "Warehouse offline" (2026-09-23 review — the acq enum 500 read as offline). Sub-routers mounted
  // below inherit this handler through Hono's route() wrapping.
  app.onError((err, c) => {
    console.error('[warehouse] route error:', err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  });
```

- [ ] **Step 4: Show the real error in Sourcing.** In `src/modules/acquisitions/AcquisitionsIntel.tsx` replace the "Unable to load…" paragraph with:

```tsx
      {!isLoading && error && !isWarehouseUnavailable(error) && !data && (
        <p style={{ color: 'var(--text-tertiary)', fontSize: '0.875rem' }}>
          Unable to load acquisition intel: {error instanceof Error ? error.message : 'unknown error'}
        </p>
      )}
```

- [ ] **Step 5: Run tests.** Run: `npx vitest run tests/unit/warehouse-json-errors.test.ts tests/unit/acq-api.test.ts`. Expected: PASS.
- [ ] **Step 6: Commit** (server path → trailer required; error transport only, no numbers):

```bash
git add server/warehouse/api.ts src/modules/acquisitions/AcquisitionsIntel.tsx tests/unit/warehouse-json-errors.test.ts
git commit -m "fix(warehouse): JSON error bodies for uncaught route errors; Sourcing shows the real error" -m "Refute-Skip: error transport only — no financial computation, ranking, or threshold touched" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: One alert per expiring lease (stop double-counting risk $)

**Files:**
- Modify: `src/analytics/conditions.ts` (after the Phase 3 L-1..L-5 block closes, before the next section)
- Modify: `tests/unit/conditions.test.ts` (lease describe, ~lines 251-271)

**Interfaces:**
- Produces: for a lease 0–90d from expiry with no advanced renewal stage, exactly one lease-expiry insight (`lease-expiry-<id>`). The legacy `expiring-<id>` survives only for 91–180d.

- [ ] **Step 1: Write the failing test.** Add inside `describe('evaluateConditions — leases', …)`:

```ts
  it('a lease ≤90d out with no renewal stage yields ONE expiry insight, not two', () => {
    const out = evaluateConditions(snap({ leases: [lease({ leaseEnd: iso(38), annualRent: 38000 })] }), opts);
    const expiryIds = out.filter((i) => i.entityId === 'l1' && /^(expiring|lease-expiry)-/.test(i.id)).map((i) => i.id);
    expect(expiryIds).toEqual(['lease-expiry-l1']);
  });
  it('91–180d keeps the legacy warning (L-1 does not cover it)', () => {
    const out = evaluateConditions(snap({ leases: [lease({ leaseEnd: iso(120) })] }), opts);
    expect(out.find((i) => i.id === 'expiring-l1')?.severity).toBe('warning');
    expect(out.some((i) => i.id === 'lease-expiry-l1')).toBe(false);
  });
```

Also update the existing `'expiring < 60d is critical'` test body to:

```ts
    const out = evaluateConditions(snap({ leases: [lease({ leaseEnd: iso(59) })] }), opts);
    expect(out.find((i) => i.id === 'lease-expiry-l1')?.severity).toBe('critical');
    expect(out.some((i) => i.id === 'expiring-l1')).toBe(false);
```

- [ ] **Step 2: Run and confirm failure.** Run: `npx vitest run tests/unit/conditions.test.ts`. Expected: the new "ONE expiry insight" test FAILS with `['expiring-l1','lease-expiry-l1']`.
- [ ] **Step 3: Implement.** In `src/analytics/conditions.ts`, immediately after the closing brace of the Phase 3 block (the `{ … }` that starts `const arrears = s.tenantArrears ?? {};`):

```ts
  // Dedup (2026-09-23 review): inside the 0–90d no-renewal window the legacy `expiring-<id>` insight
  // and L-1 `lease-expiry-<id>` fire on the same lease with the same annualRent impact, so
  // totalsBySpine() summed that rent twice (Example Trucking's $38K counted as $76K). L-1 carries the
  // stronger "no renewal signal" message and is always critical there — keep it, drop the legacy twin.
  {
    const l1Leases = new Set(out.filter((i) => i.id.startsWith('lease-expiry-')).map((i) => i.entityId));
    for (let i = out.length - 1; i >= 0; i--) {
      const ins = out[i]!;
      if (ins.id.startsWith('expiring-') && l1Leases.has(ins.entityId)) out.splice(i, 1);
    }
  }
```

- [ ] **Step 4: Update other suites that key on `expiring-`.** Run: `grep -rln "expiring-" tests/unit`. In each hit where the fixture lease is ≤90d out with no renewal stage, change the expected id to `lease-expiry-<id>`. Leave 91–180d expectations alone.
- [ ] **Step 5: Run the suite.** Run: `npm run test`. Expected: PASS.
- [ ] **Step 6: Refute.** Invoke the `refute-financial-change` skill on the diff (`src/analytics/conditions.ts`). Required lenses: the alert-count and risk-$ totals change, and no lease loses its only expiry signal. Record the run id.
- [ ] **Step 7: Commit.**

```bash
git add src/analytics/conditions.ts tests/unit/conditions.test.ts <other updated test files>
git commit -m "fix(alerts): one expiry insight per lease — stop double-counting risk \$ in the 0–90d window" -m "Refute-Reviewed: wf_<runId>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Holdover consistency — Calendar overdue split + Renewals holdover label

**Files:**
- Modify: `src/brain/critical-dates.ts:104-121`
- Modify: `src/modules/calendar/CalendarModule.tsx` (KPI grid)
- Modify: `src/modules/renewals/RenewalsModule.tsx:22`
- Test: `tests/unit/critical-dates.test.ts`, `tests/unit/calendar-module-horizon.test.tsx`, create `tests/unit/renewals-day-label.test.ts`

**Interfaces:**
- Produces: `CriticalDateKpis { overdue; critical; warning; thisQuarter; next12mo }`. `critical` and `thisQuarter` now count upcoming dates only (`daysToDate >= 0`). Exported `dayLabel(d: number | null): string` from RenewalsModule.

- [ ] **Step 1: Failing KPI test.** Append to `tests/unit/critical-dates.test.ts` (build events with the existing helper in that file; if none, construct `DatedEvent` literals with only `daysToDate` meaningful):

```ts
it('overdue events count as overdue, not critical', () => {
  const ev = (daysToDate: number) => ({ daysToDate } as unknown as DatedEvent);
  const k = criticalDateKpis([ev(-752), ev(-5), ev(10), ev(100), ev(300)]);
  expect(k).toEqual({ overdue: 2, critical: 1, warning: 1, thisQuarter: 1, next12mo: 5 });
});
```

- [ ] **Step 2: Failing label test.** Create `tests/unit/renewals-day-label.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { dayLabel } from '../../src/modules/renewals/RenewalsModule';

describe('renewals dayLabel', () => {
  it('labels a passed lease end as holdover, matching the Monitor insight vocabulary', () => {
    expect(dayLabel(-752)).toBe('Holdover · 752d');
    expect(dayLabel(38)).toBe('38d');
    expect(dayLabel(null)).toBe('—');
  });
});
```

- [ ] **Step 3: Run and confirm failure.** Run: `npx vitest run tests/unit/critical-dates.test.ts tests/unit/renewals-day-label.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement KPIs.** Replace `CriticalDateKpis` and `criticalDateKpis` in `src/brain/critical-dates.ts`:

```ts
export interface CriticalDateKpis {
  overdue: number; // date already passed (holdover / lapsed renewals, expired policies)
  critical: number; // 0–59d upcoming
  warning: number; // 60–179d upcoming
  thisQuarter: number; // 0–89d upcoming
  next12mo: number; // total in the horizon (incl. overdue)
}

export function criticalDateKpis(events: DatedEvent[]): CriticalDateKpis {
  let overdue = 0;
  let critical = 0;
  let warning = 0;
  let thisQuarter = 0;
  for (const e of events) {
    if (e.daysToDate < 0) { overdue += 1; continue; }
    if (e.daysToDate < ALERT_THRESHOLDS.leaseCriticalDays) critical += 1;
    else if (e.daysToDate < ALERT_THRESHOLDS.leaseWarningDays) warning += 1;
    if (e.daysToDate < 90) thisQuarter += 1;
  }
  return { overdue, critical, warning, thisQuarter, next12mo: events.length };
}
```

- [ ] **Step 5: Calendar tiles.** In `CalendarModule.tsx` change the grid to `grid grid-cols-2 gap-3 md:grid-cols-5` and replace the first KPI with two:

```tsx
        <KpiStat label="Overdue / Holdover" value={kpis.overdue} format={(n) => String(n ?? 0)} accentColor="var(--color-neg)" sublabel="date passed" />
        <KpiStat label="Critical (<60d)" value={kpis.critical} format={(n) => String(n ?? 0)} accentColor="var(--color-warn)" />
```

Keep the `Warning`, `This Quarter` and `Next 12 Months` tiles. Warning's accent stays `var(--color-warn)`.

- [ ] **Step 6: Renewals label.** In `RenewalsModule.tsx:22` replace the `dayLabel` const with:

```ts
export const dayLabel = (d: number | null) => (d === null ? '—' : d < 0 ? `Holdover · ${Math.abs(d)}d` : `${d}d`);
```

- [ ] **Step 7: Fix dependent assertions.** Run: `npx vitest run tests/unit/calendar-module-horizon.test.tsx tests/unit/critical-dates.test.ts tests/unit/renewals-day-label.test.ts tests/unit/worklist-destination.test.tsx`. Update any assertion on the old `'Critical (<60d)'` + `'incl. overdue'` sublabel to the new tiles. Expected: PASS.
- [ ] **Step 8: Commit** (no financial paths):

```bash
git add src/brain/critical-dates.ts src/modules/calendar/CalendarModule.tsx src/modules/renewals/RenewalsModule.tsx tests/unit/critical-dates.test.ts tests/unit/calendar-module-horizon.test.tsx tests/unit/renewals-day-label.test.ts
git commit -m "fix(calendar,renewals): split overdue/holdover from critical; holdover label matches Monitor insight" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Data-quality flag for stale "Active" lease rows long past their end date

**Files:**
- Modify: `server/reconcile-runtime.ts` (new exported fn + one line after `flags.push(...checkCashInvariants(s));` at ~line 150)
- Test: `tests/unit/reconcile-runtime.test.ts`

**Interfaces:**
- Produces: `checkStaleLeaseRows(s: Pick<PortfolioSnapshot, 'leases' | 'meta'>): DataQualityFlag[]`

- [ ] **Step 1: Failing test.** Append:

```ts
import { checkStaleLeaseRows } from '../../server/reconcile-runtime';

describe('checkStaleLeaseRows', () => {
  const meta = { asOf: '2026-09-23' } as PortfolioSnapshot['meta'];
  const l = (o: Partial<Lease>) => ({ id: 'x', tenantName: 'T', status: 'Active', leaseEnd: null, ...o }) as Lease;
  it('flags a non-Expired row whose leaseEnd passed > 365d ago (retired tenant still on the rent roll)', () => {
    const flags = checkStaleLeaseRows({ meta, leases: [l({ id: 'adk', tenantName: 'Tenant 038 LLC', leaseEnd: '2024-09-01' })] });
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ entity: 'reconciliation', field: 'lease.adk.leaseEnd', severity: 'warn' });
    expect(flags[0]!.issue).toContain('Tenant 038 LLC');
  });
  it('ignores recent holdovers and rows already marked Expired', () => {
    expect(checkStaleLeaseRows({ meta, leases: [
      l({ leaseEnd: '2026-06-30' }),
      l({ status: 'Expired', leaseEnd: '2023-01-01' }),
    ] })).toEqual([]);
  });
});
```

(Import `Lease` and `PortfolioSnapshot` types from `'../../src/contracts/index'` if the file does not already.)

- [ ] **Step 2: Run and confirm failure.** Run: `npx vitest run tests/unit/reconcile-runtime.test.ts`. Expected: FAIL (export missing).
- [ ] **Step 3: Implement.** Add above the runtime reconcile function in `server/reconcile-runtime.ts`:

```ts
const STALE_LEASE_ROW_DAYS = 365;

/**
 * A lease row that is not marked Expired but ended more than a year ago is almost always a tenant
 * already retired in the Notion Tenant DB whose workbook row was never cleared (2026-09-23 review:
 * Tenant 038 LLC / Tenant 059 LLC, 752d past end, still inflating Calendar + Renewals). Warn so a human
 * fixes the workbook — nothing here edits or hides the row.
 */
export function checkStaleLeaseRows(s: Pick<PortfolioSnapshot, 'leases' | 'meta'>): DataQualityFlag[] {
  const asOf = s.meta?.asOf;
  if (!asOf) return [];
  const asOfMs = Date.parse(asOf.slice(0, 10));
  const out: DataQualityFlag[] = [];
  for (const l of s.leases ?? []) {
    if (l.status === 'Expired' || !l.leaseEnd) continue;
    const days = Math.round((asOfMs - Date.parse(l.leaseEnd)) / 86_400_000);
    if (days > STALE_LEASE_ROW_DAYS) {
      out.push({
        entity: 'reconciliation',
        field: `lease.${l.id}.leaseEnd`,
        issue: `${l.tenantName} ended ${l.leaseEnd} (${days}d ago) but is still "${l.status}" — retire the row in the workbook or record the renewal`,
        severity: 'warn',
      });
    }
  }
  return out;
}
```

Then add `flags.push(...checkStaleLeaseRows(s));` on the line after `flags.push(...checkCashInvariants(s));`.

- [ ] **Step 4: Run tests.** Run: `npx vitest run tests/unit/reconcile-runtime.test.ts && npm run reconcile:snapshot`. Expected: PASS. `reconcile:snapshot` may now print the new warn flags; confirm it does not exit non-zero on warns (warns are non-fatal by design).
- [ ] **Step 5: Commit.**

```bash
git add server/reconcile-runtime.ts tests/unit/reconcile-runtime.test.ts
git commit -m "feat(reconcile): warn on Active lease rows >365d past end (stale workbook rows)" -m "Refute-Skip: adds a warn-only data-quality flag; no figure, threshold, or ranking changes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**PR 1 close-out:** `npm run gate` → push → PR `fix(cc): 2026-09-23 review — correctness (acq 500, alert dedup, holdover)` → adversarial merge gate (`adversarial-merge-gate` skill, since `conditions.ts` is financial) → Gabriel merges.

---

## PR 2 — Resilience & freshness

### Task 6: Loading/error state for the 8 blank-screen modules

**Files:**
- Create: `src/shell/SnapshotGate.tsx`, `tests/unit/snapshot-gate.test.tsx`
- Modify (one line each + guard): `src/modules/portfolio/PortfolioModule.tsx:13,45`, `leases/LeasesModule.tsx:60,153`, `renewals/RenewalsModule.tsx:26,42`, `tenants/TenantsModule.tsx:31,47`, `close/CloseModule.tsx:13,21`, `cash/CashModule.tsx:14,38`, `tasks/TasksModule.tsx:25,47`, `calendar/CalendarModule.tsx:72,110`

**Interfaces:**
- Produces: `useSnapshotGate(): React.ReactElement | null` returns `<ModuleLoading/>` while loading, `<ModuleError/>` on error without data, otherwise `null`.

- [ ] **Step 1: Failing tests.** Create `tests/unit/snapshot-gate.test.tsx`:

```tsx
import { readFileSync } from 'node:fs';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSnapshotGate } from '../../src/shell/SnapshotGate';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function Probe() {
  const gate = useSnapshotGate();
  return gate ?? <div>ready</div>;
}
const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

describe('useSnapshotGate', () => {
  it('renders the Brain Server error with Retry when the snapshot fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    wrap(<Probe />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Retry/)).toBeTruthy();
  });

  it.each([
    'portfolio/PortfolioModule', 'leases/LeasesModule', 'renewals/RenewalsModule', 'tenants/TenantsModule',
    'close/CloseModule', 'cash/CashModule', 'tasks/TasksModule', 'calendar/CalendarModule',
  ])('%s uses the gate (no silent blank screen)', (m) => {
    expect(readFileSync(`src/modules/${m}.tsx`, 'utf8')).toContain('useSnapshotGate()');
  });
});
```

If `fetchSnapshot` falls back to the static mirror on network failure and still errors, the first test holds. If the mirror fallback *succeeds* under a throwing fetch, it can't (fetch is stubbed globally).

- [ ] **Step 2: Run and confirm failure.** Run: `npx vitest run tests/unit/snapshot-gate.test.tsx`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement the gate.** Create `src/shell/SnapshotGate.tsx`:

```tsx
import type { ReactElement } from 'react';
import { useSnapshot } from '@/data/queries';
import { ModuleError, ModuleLoading } from './ModuleFallback';

/**
 * Loading/error gate for snapshot-backed modules. Destination's <Suspense> only covers the lazy JS
 * chunk, not the data fetch — before this, eight modules rendered a blank page whenever the Brain
 * Server was slow or down (2026-09-23 review). Call unconditionally at the top of the component.
 */
export function useSnapshotGate(): ReactElement | null {
  const q = useSnapshot();
  if (q.isLoading) return <ModuleLoading />;
  if (q.isError && !q.data) {
    return <ModuleError onRetry={() => void q.refetch()} message={q.error instanceof Error ? q.error.message : undefined} />;
  }
  return null;
}
```

- [ ] **Step 4: Apply to all 8 modules.** In each file, add `import { useSnapshotGate } from '@/shell/SnapshotGate';`, put `const gate = useSnapshotGate();` directly after the existing `const { data } = useSnapshot();` line, and replace the `if (!data …) return null;` guard with:

```tsx
  if (gate) return gate;
  if (!data /* keep the file's existing extra conditions, e.g. `|| !analytics` */) return null;
```

(Keep each file's original extra conditions verbatim after `!data`.)

- [ ] **Step 5: Run tests.** Run: `npx vitest run tests/unit/snapshot-gate.test.tsx && npm run test`. Expected: PASS. Module suites that mock `useSnapshot` must return `{ data, isLoading: false, isError: false, refetch }`. Add the two missing booleans to any such mock that breaks.
- [ ] **Step 6: Commit.**

```bash
git add src/shell/SnapshotGate.tsx tests/unit/snapshot-gate.test.tsx src/modules/portfolio/PortfolioModule.tsx src/modules/leases/LeasesModule.tsx src/modules/renewals/RenewalsModule.tsx src/modules/tenants/TenantsModule.tsx src/modules/close/CloseModule.tsx src/modules/cash/CashModule.tsx src/modules/tasks/TasksModule.tsx src/modules/calendar/CalendarModule.tsx
git commit -m "fix(ui): loading + Brain-Server error states for 8 snapshot modules (no more blank screens)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: Cold start — bind the port before the synchronous doc-index load

**Files:**
- Create: `server/startup.ts`, `tests/unit/server-startup.test.ts`
- Modify: `server/index.ts:599-621` (`main()`) *(architect-owned; needs Task 0 ack)*

**Interfaces:**
- Produces: `startServer(d: StartupDeps): void`, where `StartupDeps = { listen(onListening: (port: number) => void): void; refresh(): Promise<void>; warmDocs(): Promise<void>; log(msg: string): void; warn(msg: string, err: unknown): void }`.

- [ ] **Step 1: Failing test.**

```ts
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { startServer } from '../../server/startup';

describe('startServer', () => {
  it('runs no heavy startup work until the port has bound, then defers it one macrotask', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let onListening: ((port: number) => void) | null = null;
    startServer({
      listen: (cb) => { calls.push('listen'); onListening = cb; },
      refresh: async () => { calls.push('refresh'); },
      warmDocs: async () => { calls.push('warmDocs'); },
      log: () => {},
      warn: () => {},
    });
    expect(calls).toEqual(['listen']);          // nothing heavy before bind
    onListening!(8911);
    expect(calls).toEqual(['listen']);          // not in the bind callback's own tick
    await vi.runAllTimersAsync();
    expect(calls).toEqual(['listen', 'refresh', 'warmDocs']);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run and confirm failure.** Run: `npx vitest run tests/unit/server-startup.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** Create `server/startup.ts`:

```ts
export interface StartupDeps {
  listen: (onListening: (port: number) => void) => void;
  refresh: () => Promise<void>;
  warmDocs: () => Promise<void>;
  log: (msg: string) => void;
  warn: (msg: string, err: unknown) => void;
}

/**
 * Bind first, then do heavy work one macrotask later. loadDiskIndex() is a synchronous better-sqlite3
 * + sqlite-vec read of a ~179 MB file; called in the same tick as serve() it held listen() for ~7 min
 * on a cold, AV-scanned start (2026-09-23 review), defeating the old "bind first" comment.
 */
export function startServer(d: StartupDeps): void {
  d.listen((port) => {
    d.log(`◆ Oxford Brain Server — http://127.0.0.1:${port} (localhost only)`);
    setTimeout(() => {
      d.refresh().catch((err) => d.warn('⚠ Brain startup refresh failed — serving in degraded mode (snapshot 503 until workbook loads):', err));
      d.warmDocs().catch((err) => d.warn('⚠ Document index warm-up failed (non-fatal):', err));
    }, 0);
  });
}
```

- [ ] **Step 4: Wire `server/index.ts`.** Replace the body of `main()` with:

```ts
async function main() {
  startServer({
    listen: (onListening) => {
      serve({ fetch: app.fetch, port: serverPort(), hostname: '127.0.0.1' }, (info) => {
        onListening(info.port);
        console.log(`  Workbook: ${brain.getState().workbookPath}`);
      });
    },
    refresh: () => brain.refresh('startup').then(() => { brain.startWatching(); }),
    warmDocs: () => warmDocIndex(),
    log: (m) => console.log(m),
    warn: (m, err) => console.error(m, err),
  });
}
```

Add `import { startServer } from './startup';`.

- [ ] **Step 5: Verify.** Run: `npx vitest run tests/unit/server-startup.test.ts && npm run typecheck`. Expected: PASS. Then run `npm run dev:server:once` in the background and time it: run `curl -s http://127.0.0.1:8911/api/health` in a loop. Expected: the port answers within ~30 s, and the `[documents] loaded on-disk index` log line now appears **after** `◆ Oxford Brain Server`. Stop the server.
- [ ] **Step 6: Commit.**

```bash
git add server/startup.ts server/index.ts tests/unit/server-startup.test.ts
git commit -m "fix(server): bind port before the synchronous doc-index load (7-min cold start)" -m "Refute-Skip: startup ordering only — no financial computation touched" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: Vite dev — stop full-page reloads on data/ writes

**Files:**
- Modify: `vite.config.ts` `server:` block *(architect-owned)*

- [ ] **Step 1: Implement.** In the `server:` block add after `port: 5273,`:

```ts
    // data/ is written by the Brain Server + scheduled jobs (snapshot mirror, AR import); src/ never
    // imports it, but Vite's watcher still full-reloaded the page on every rewrite (2026-09-23 review).
    watch: { ignored: ['**/data/**', '**/.claude/worktrees/**'] },
```

- [ ] **Step 2: Verify manually.** Start `npm run dev:web`, open `http://localhost:5273/overview`, then run `touch data/snapshots/portfolio.json`. Expected: no `page reload data/snapshots/portfolio.json` line in the Vite log, and the page keeps its scroll position.
- [ ] **Step 3: Commit.**

```bash
git add vite.config.ts
git commit -m "chore(vite): ignore data/ and worktrees in the dev watcher" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: Macro — correct live badge and a truthful `asOf`

**Files:**
- Modify: `server/macro/fred.ts:76` (live-path `asOf`)
- Modify: `src/modules/market/MarketModule.tsx:86-87`
- Test: `tests/unit/fred-macro.test.ts`, create `tests/unit/macro-badge.test.ts`

**Interfaces:**
- Produces: `isLiveMacro(source: MacroSnapshot['source']): boolean` exported from `src/modules/market/MarketModule.tsx`.

- [ ] **Step 1: Failing tests.** Create `tests/unit/macro-badge.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isLiveMacro } from '../../src/modules/market/MarketModule';

describe('isLiveMacro', () => {
  it('treats the server’s live-fred literal (and the legacy fred alias) as live', () => {
    expect(isLiveMacro('live-fred')).toBe(true);
    expect(isLiveMacro('fred')).toBe(true);
    expect(isLiveMacro('mock')).toBe(false);
    expect(isLiveMacro('seed')).toBe(false);
  });
});
```

Append to `tests/unit/fred-macro.test.ts`:

```ts
it('live snapshot asOf is the fetch date, not the static WORKBOOK_AS_OF', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-23T15:00:00Z'));
  vi.stubEnv('FRED_API_KEY', 'test-key');
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ observations: [{ date: '2026-09-22', value: '4.10' }] }), { headers: { 'content-type': 'application/json' } })));
  const snap = await fetchFredMacro();
  expect(snap?.source).toBe('live-fred');
  expect(snap?.asOf).toBe('2026-09-23');
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
});
```

(Import `fetchFredMacro` from `'../../server/macro/fred'` and `vi` from vitest if not already imported.)

- [ ] **Step 2: Run and confirm failure.** Run: `npx vitest run tests/unit/macro-badge.test.ts tests/unit/fred-macro.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement server.** In `server/macro/fred.ts`, in the live return object replace `asOf: WORKBOOK_AS_OF,` with:

```ts
      // The fetch date — WORKBOOK_AS_OF is the workbook data-month and made live FRED data read as
      // three months stale in the UI (2026-09-23 review).
      asOf: new Date().toISOString().slice(0, 10),
```

(Remove the `WORKBOOK_AS_OF` import only if it is now unused in this file.)

- [ ] **Step 4: Implement UI.** In `MarketModule.tsx` add near the top (module scope):

```ts
export const isLiveMacro = (source: MacroSnapshot['source']) => source === 'live-fred' || source === 'fred';
```

and replace the badge with:

```tsx
        <Badge tone={isLiveMacro(macro.source) ? 'green' : 'amber'} dot>
          {isLiveMacro(macro.source) ? `FRED · live · ${fmtDate(macro.asOf)}` : 'FRED · snapshot (set FRED_API_KEY for live)'}
        </Badge>
```

Import `MacroSnapshot` from `@contracts/index` and `fmtDate` from the same module the file already uses for dates. If none, use `@/analytics/format`.

- [ ] **Step 5: Run tests.** Run: `npx vitest run tests/unit/macro-badge.test.ts tests/unit/fred-macro.test.ts`. Expected: PASS.
- [ ] **Step 6: Commit.**

```bash
git add server/macro/fred.ts src/modules/market/MarketModule.tsx tests/unit/macro-badge.test.ts tests/unit/fred-macro.test.ts
git commit -m "fix(macro): live FRED badge (live-fred literal) + fetch-date asOf" -m "Refute-Skip: asOf date label only; indicator values and the cap-rate spread math are unchanged" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: Feed-freshness collector on `/api/health` (the stale-feed monitor)

**Files:**
- Create: `server/feed-freshness.ts`, `tests/unit/feed-freshness.test.ts`
- Modify: `server/sources/documents.ts` (add `docIndexBuiltAt()` getter)
- Modify: `server/index.ts` `/api/health` handler (~line 257) *(architect-owned)*

**Interfaces:**
- Produces:
  - `type FeedStatus = 'fresh' | 'stale' | 'missing'`
  - `interface FeedFreshness { id: FeedId; label: string; lastAt: string | null; ageDays: number | null; maxAgeDays: number; status: FeedStatus; fix: string }`
  - `type FeedId = 'snapshot' | 'cashHistory' | 'ar' | 'dailyBrief' | 'leaseMarket' | 'docIndex'`
  - `assessFeeds(input: FeedInputs, now: number): FeedFreshness[]`, where `FeedInputs = Record<FeedId, string | null>`
  - `docIndexBuiltAt(): string | null`
  - `/api/health` JSON gains `feeds: FeedFreshness[]`

- [ ] **Step 1: Failing test.**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { assessFeeds, FEED_MAX_AGE_DAYS } from '../../server/feed-freshness';

const NOW = Date.parse('2026-09-23T12:00:00Z');

describe('assessFeeds', () => {
  it('grades each feed against its own max age and reports missing feeds', () => {
    const feeds = assessFeeds({
      snapshot: '2026-09-22T14:38:33Z',
      cashHistory: '2026-07-10',
      ar: '2026-07-15',
      dailyBrief: '2026-07-09T11:00:00Z',
      leaseMarket: null,
      docIndex: '2026-06-06T15:54:00Z',
    }, NOW);
    const by = Object.fromEntries(feeds.map((f) => [f.id, f]));
    expect(by.snapshot!.status).toBe('fresh');
    expect(by.cashHistory!.status).toBe('stale');
    expect(by.ar!.status).toBe('stale');
    expect(by.dailyBrief!.status).toBe('stale');
    expect(by.dailyBrief!.ageDays).toBe(76);
    expect(by.leaseMarket!.status).toBe('missing');
    expect(by.docIndex!.status).toBe('stale');
    expect(feeds.every((f) => f.fix.length > 0)).toBe(true);
    expect(FEED_MAX_AGE_DAYS.dailyBrief).toBe(2);
  });
});
```

- [ ] **Step 2: Run and confirm failure.** Run: `npx vitest run tests/unit/feed-freshness.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Create `server/feed-freshness.ts`:

```ts
export type FeedId = 'snapshot' | 'cashHistory' | 'ar' | 'dailyBrief' | 'leaseMarket' | 'docIndex';
export type FeedStatus = 'fresh' | 'stale' | 'missing';
export type FeedInputs = Record<FeedId, string | null>;

export interface FeedFreshness {
  id: FeedId;
  label: string;
  lastAt: string | null;
  ageDays: number | null;
  maxAgeDays: number;
  status: FeedStatus;
  fix: string;
}

/** Per-feed staleness budget in days (2026-09-23 review found six feeds silently stale). */
export const FEED_MAX_AGE_DAYS: Record<FeedId, number> = {
  snapshot: 2,
  cashHistory: 40, // monthly rows, 10th of the month
  ar: 35, // matches ALERT_THRESHOLDS.arStalenessMaxDays
  dailyBrief: 2,
  leaseMarket: 14,
  docIndex: 30,
};

const META: Record<FeedId, { label: string; fix: string }> = {
  snapshot: { label: 'Workbook snapshot', fix: 'Check the Brain Server workbook watcher / OneDrive sync' },
  cashHistory: { label: 'Cash history (monthly rows)', fix: 'Add the missing monthly rows to Cash Data in the Master Workbook' },
  ar: { label: 'AR aging (QuickBooks)', fix: 'Run the QuickBooks AR export + ar-import-headless' },
  dailyBrief: { label: 'Daily brief', fix: 'Check the scheduled snapshot-refresh / brief task on the CC fleet' },
  leaseMarket: { label: 'Lease market compute', fix: 'npm run lease-market:ingest && npm run lease-market:compute' },
  docIndex: { label: 'Document index (Ask)', fix: 'npm run index:docs' },
};

const DAY_MS = 86_400_000;

export function assessFeeds(input: FeedInputs, now: number): FeedFreshness[] {
  return (Object.keys(META) as FeedId[]).map((id) => {
    const lastAt = input[id];
    const t = lastAt ? Date.parse(lastAt) : NaN;
    const ageDays = Number.isFinite(t) ? Math.floor((now - t) / DAY_MS) : null;
    const maxAgeDays = FEED_MAX_AGE_DAYS[id];
    const status: FeedStatus = ageDays === null ? 'missing' : ageDays > maxAgeDays ? 'stale' : 'fresh';
    return { id, label: META[id].label, lastAt, ageDays, maxAgeDays, status, fix: META[id].fix };
  });
}
```

- [ ] **Step 4: Doc-index getter.** In `server/sources/documents.ts` add (next to `docStatus`):

```ts
/** Build time of the loaded index, WITHOUT forcing a load (safe for /api/health). */
export function docIndexBuiltAt(): string | null {
  return cache?.builtAt ?? null;
}
```

- [ ] **Step 5: Wire `/api/health`.** In `server/index.ts`, inside the `/api/health` handler before `return c.json(…)`:

```ts
  const snap = brain.getSnapshot?.() ?? null;
  const arDates = Object.values(snap?.tenantArrears ?? {})
    .map((r) => (r as { asOfDate?: string | null }).asOfDate ?? null)
    .filter((d): d is string => !!d)
    .sort();
  let leaseMarketAt: string | null = null;
  try { leaseMarketAt = lastComputedAt(getWarehouseDb()); } catch { leaseMarketAt = null; }
  const feeds = assessFeeds({
    snapshot: snap?.meta?.generatedAt ?? null,
    cashHistory: snap?.cash?.history?.at(-1)?.date ?? null,
    ar: arDates[0] ?? null, // oldest stamped record — collections gating is per-lease
    dailyBrief: briefHealth?.ranAt ?? null,
    leaseMarket: leaseMarketAt,
    docIndex: docIndexBuiltAt(),
  }, Date.now());
```

and add `feeds,` to the returned object. Imports: `assessFeeds` from `./feed-freshness`, `docIndexBuiltAt` from `./sources/documents`, `lastComputedAt` from `./warehouse/lease-market/compute`. Before writing, confirm the exact accessor names this file already uses for the current snapshot and the warehouse db handle (`grep -n "getSnapshot\|getWarehouseDb\|openWarehouse" server/index.ts`) and use those. Do not add new ones.

- [ ] **Step 6: Run tests.** Run: `npx vitest run tests/unit/feed-freshness.test.ts && npm run typecheck`. Expected: PASS. Then `curl -s http://127.0.0.1:8911/api/health` against a dev server should show a 6-item `feeds` array.
- [ ] **Step 7: Commit.**

```bash
git add server/feed-freshness.ts server/sources/documents.ts server/index.ts tests/unit/feed-freshness.test.ts
git commit -m "feat(health): per-feed freshness on /api/health (snapshot, cash history, AR, brief, lease market, doc index)" -m "Refute-Skip: read-only freshness reporting; no financial figure or threshold changed" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: System Health — Data Feeds card + brief staleness badge

**Files:**
- Modify: `src/modules/health/HealthModule.tsx` (`HealthResponse` type at :17, Daily Brief card at ~:124-130, new card)
- Modify: `src/lib/freshness.ts` (add `isBriefStale`)
- Create: `tests/unit/brief-staleness.test.ts`

**Interfaces:**
- Consumes: `FeedFreshness` shape from Task 10 (redeclared client-side as a type, since `/api/health` has no Zod contract).
- Produces: `isBriefStale(ranAt: string, now?: number): boolean` (stale beyond 36 h).

- [ ] **Step 1: Failing test.**

```ts
import { describe, expect, it } from 'vitest';
import { isBriefStale, BRIEF_STALE_HOURS } from '../../src/lib/freshness';

describe('isBriefStale', () => {
  const now = Date.parse('2026-09-23T12:00:00Z');
  it('a brief that last ran 76 days ago is stale, even with zero failures', () => {
    expect(isBriefStale('2026-07-09T11:00:00Z', now)).toBe(true);
  });
  it('this morning’s brief is fresh', () => {
    expect(isBriefStale('2026-09-23T10:45:00Z', now)).toBe(false);
    expect(BRIEF_STALE_HOURS).toBe(36);
  });
});
```

- [ ] **Step 2: Run and confirm failure.** Run: `npx vitest run tests/unit/brief-staleness.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement helper.** Append to `src/lib/freshness.ts`:

```ts
/** The daily brief is due every morning; beyond 36h a "no failures" record is not "OK". */
export const BRIEF_STALE_HOURS = 36;
export function isBriefStale(ranAt: string, now = Date.now()): boolean {
  const t = Date.parse(ranAt);
  return !Number.isFinite(t) || now - t > BRIEF_STALE_HOURS * 3_600_000;
}
```

- [ ] **Step 4: Badge.** In `HealthModule.tsx` replace the two `briefBadge*` consts with:

```tsx
              const stale = b != null && isBriefStale(b.ranAt);
              const briefBadgeTone: 'green' | 'red' | 'amber' | 'neutral' =
                b == null ? 'neutral' : b.failures.length > 0 ? 'red' : stale ? 'amber' : 'green';
              const briefBadgeLabel = b == null ? 'Not yet run' : b.failures.length > 0 ? 'Failures' : stale ? 'Stale' : 'OK';
```

- [ ] **Step 5: Feeds card.** Extend the local type and add a card after the Daily Brief card:

```tsx
interface FeedFreshness { id: string; label: string; lastAt: string | null; ageDays: number | null; maxAgeDays: number; status: 'fresh' | 'stale' | 'missing'; fix: string }
interface HealthResponse {
  ai?: { configured: boolean; model: string };
  brief?: BriefHealth | null;
  feeds?: FeedFreshness[];
}
```

```tsx
        {!healthErr && health?.feeds && (
          <Card>
            <CardHeader
              title="Data Feeds"
              trailing={<Badge tone={health.feeds.some((f) => f.status !== 'fresh') ? 'amber' : 'green'}>
                {health.feeds.filter((f) => f.status !== 'fresh').length} need attention
              </Badge>}
            />
            <ul className="flex flex-col">
              {health.feeds.map((f) => (
                <Row
                  key={f.id}
                  tone={f.status === 'fresh' ? 'ok' : f.status === 'missing' ? 'error' : 'warn'}
                  label={f.label}
                  value={f.status === 'fresh'
                    ? `${f.ageDays}d old`
                    : f.status === 'missing' ? `never — ${f.fix}` : `${f.ageDays}d old (max ${f.maxAgeDays}d) — ${f.fix}`}
                />
              ))}
            </ul>
          </Card>
        )}
```

Import `isBriefStale` from `@/lib/freshness`.

- [ ] **Step 6: Run tests.** Run: `npx vitest run tests/unit/brief-staleness.test.ts tests/unit/health-signal.test.tsx`. Expected: PASS.
- [ ] **Step 7: Verify in browser** (dev server): the System Health page shows the Daily Brief badge as "Stale" and the Data Feeds card with 6 rows. Take a screenshot as evidence.
- [ ] **Step 8: Commit.**

```bash
git add src/lib/freshness.ts src/modules/health/HealthModule.tsx tests/unit/brief-staleness.test.ts
git commit -m "feat(health): Data Feeds card + Daily Brief 'Stale' badge beyond 36h" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**PR 2 close-out:** gate → push → PR `fix(cc): 2026-09-23 review — resilience & freshness` → review (reviewer ≥ implementer) → Gabriel merges.

---

## PR 3 — Polish

### Task 12: Renewals tenure — human format

**Files:**
- Modify: `src/analytics/format.ts` (add `fmtTenure`)
- Modify: `src/modules/renewals/RenewalsModule.tsx:114-117`
- Create: `tests/unit/format-tenure.test.ts`

- [ ] **Step 1: Failing test.**

```ts
import { describe, expect, it } from 'vitest';
import { fmtTenure } from '../../src/analytics/format';

describe('fmtTenure', () => {
  it('rounds months and switches to years at 24 mo', () => {
    expect(fmtTenure(13.73305954825462)).toBe('14 mo tenure');
    expect(fmtTenure(28.747433264887064)).toBe('2.4 yr tenure');
    expect(fmtTenure(393.72484599589325)).toBe('32.8 yr tenure');
    expect(fmtTenure(0.2)).toBe('<1 mo tenure');
  });
});
```

- [ ] **Step 2: Run and confirm failure.** Run: `npx vitest run tests/unit/format-tenure.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Append to `src/analytics/format.ts`:

```ts
/** Tenant tenure for renewal cards — the raw float leaked as "393.72484599589325 mo" (2026-09-23 review). */
export function fmtTenure(months: number): string {
  if (months < 1) return '<1 mo tenure';
  if (months < 24) return `${Math.round(months)} mo tenure`;
  return `${(months / 12).toFixed(1)} yr tenure`;
}
```

In `RenewalsModule.tsx` replace `{signal.tenureMonths} mo tenure` with `{fmtTenure(signal.tenureMonths)}` and import `fmtTenure`.

- [ ] **Step 4: Run tests.** Run: `npx vitest run tests/unit/format-tenure.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** (`src/analytics/**` is financial by path; formatting only):

```bash
git add src/analytics/format.ts src/modules/renewals/RenewalsModule.tsx tests/unit/format-tenure.test.ts
git commit -m "fix(renewals): format tenure (was raw float months)" -m "Refute-Skip: display formatter only" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 13: M365 tasks — real HTML→text and skip Flagged Emails

**Files:**
- Create: `server/sources/html-to-text.ts`, `tests/unit/html-to-text.test.ts`
- Modify: `server/sources/m365-tasks.ts:40` and list loop `:146-168`
- Modify: `tests/unit/m365-tasks.test.ts`

**Interfaces:**
- Produces: `htmlToText(html: string): string`, `isTaskList(list: { wellknownListName?: string }): boolean`

- [ ] **Step 1: Failing tests.** Create `tests/unit/html-to-text.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { htmlToText } from '../../server/sources/html-to-text';

describe('htmlToText', () => {
  it('drops <style>/<script> bodies, strips tags, decodes entities, collapses whitespace', () => {
    const html = '<style>td {padding-top:37px!important} .view-all-section a {font-size:20px}</style>'
      + '<p>Any update on these guys?&nbsp; Thanks.&nbsp;Regards,&nbsp;Eric &amp; team &lt;x&gt; &#39;ok&#39;</p><script>alert(1)</script>';
    expect(htmlToText(html)).toBe("Any update on these guys? Thanks. Regards, Eric & team <x> 'ok'");
  });
});
```

Append to `tests/unit/m365-tasks.test.ts`:

```ts
import { isTaskList } from '../../server/sources/m365-tasks';
it('skips Outlook’s Flagged Emails list (marketing blasts surfaced as tasks)', () => {
  expect(isTaskList({ wellknownListName: 'flaggedEmails' })).toBe(false);
  expect(isTaskList({ wellknownListName: 'defaultList' })).toBe(true);
  expect(isTaskList({})).toBe(true);
});
```

- [ ] **Step 2: Run and confirm failure.** Run: `npx vitest run tests/unit/html-to-text.test.ts tests/unit/m365-tasks.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Create `server/sources/html-to-text.ts`:

```ts
const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

/** Plain text from an Outlook/Graph HTML body. The old tag-only regex kept <style> CSS and &nbsp;. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      const k = e.toLowerCase();
      if (k in ENTITIES) return ENTITIES[k]!;
      if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
      if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10));
      return m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}
```

In `m365-tasks.ts`: line 40 becomes `const note = htmlToText(t.body?.content ?? '') || null;` (import it). Add:

```ts
/** Outlook's "Flagged Emails" To-Do list mirrors flagged mail (incl. marketing) — not real tasks. */
export function isTaskList(list: { wellknownListName?: string }): boolean {
  return list.wellknownListName !== 'flaggedEmails';
}
```

Widen the lists `graphGet` generic to `Array<{ id?: string; displayName?: string; wellknownListName?: string }>`, and in the loop add `if (!isTaskList(list)) continue;` after `if (!list.id) continue;`.

- [ ] **Step 4: Run tests.** Run: `npx vitest run tests/unit/html-to-text.test.ts tests/unit/m365-tasks.test.ts`. Expected: PASS. The existing `'Get the updated certificate'` assertion must still pass.
- [ ] **Step 5: Commit.**

```bash
git add server/sources/html-to-text.ts server/sources/m365-tasks.ts tests/unit/html-to-text.test.ts tests/unit/m365-tasks.test.ts
git commit -m "fix(tasks): clean M365 task notes (style/entities) and skip the Flagged Emails list" -m "Refute-Skip: task-feed text cleanup; no financial data" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 14: Insurance — resolve policy-line keys to property names

**Files:**
- Create: `server/warehouse/insurance-property-map.ts`, `tests/unit/insurance-property-map.test.ts`
- Modify: `server/warehouse/insurance-analysis.ts:433-436`

**Interfaces:**
- Produces: `resolveInsuranceProperty(policyKey: string, masterNames: ReadonlyMap<string, string>): { propertyId: string | null; name: string }`

- [ ] **Step 1: Failing test.**

```ts
import { describe, expect, it } from 'vitest';
import { resolveInsuranceProperty } from '../../server/warehouse/insurance-property-map';

const master = new Map([
  ['9620-e-state-route-350-raytown-mo', '9620 E State Route 350, Raytown MO'],
  ['sepich-portfolio-columbus-oh-8-props', 'FVC — Fairground Village Center / Sepich Portfolio (8 props)'],
  ['3875-3883-e-livingston-ave-columbus-oh', '3875-3883 E Livingston Ave, Columbus OH'],
]);

describe('resolveInsuranceProperty', () => {
  it('maps a policy-line key (stem + line suffix) to the property master name', () => {
    expect(resolveInsuranceProperty('ins-9620state350-prop-hfd', master)).toEqual({
      propertyId: '9620-e-state-route-350-raytown-mo', name: '9620 E State Route 350, Raytown MO' });
    expect(resolveInsuranceProperty('ins-fvc-bcl', master).propertyId).toBe('sepich-portfolio-columbus-oh-8-props');
    expect(resolveInsuranceProperty('ins-3883livingston-pckg', master).name).toBe('3875-3883 E Livingston Ave, Columbus OH');
  });
  it('label-only stems with no master row still read as an address', () => {
    expect(resolveInsuranceProperty('ins-etcpoa-pckg', master)).toEqual({ propertyId: null, name: 'Airport Road, Easton MD (ETC POA)' });
  });
  it('unknown keys fall back to the raw key', () => {
    expect(resolveInsuranceProperty('ins-unknown-gl', master)).toEqual({ propertyId: null, name: 'ins-unknown-gl' });
  });
});
```

- [ ] **Step 2: Run and confirm failure.** Run: `npx vitest run tests/unit/insurance-property-map.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Create `server/warehouse/insurance-property-map.ts`:

```ts
/**
 * Insurance rows are keyed by policy line ('ins-<stem>-<line>'), not property_master.id, so the
 * LEFT JOIN in buildInsuranceAnalysis never matched and the UI showed raw keys (2026-09-23 review).
 * Explicit stem table — deterministic, reviewable; add a row when a new insured location appears.
 */
const STEM_TO_MASTER: Record<string, string> = {
  '1100rarig': '1100-rarig-ave-columbus-oh',
  '1851southclub': '1851-s-club-solar',
  '1900broadway': '1900-n-broadway-baltimore-md',
  '2203northwood': '2203-2207-northwood-dr-salisbury-md',
  '29000info': '29000-information-lane-easton-md',
  '3034westerville': '3034-westerville-rd-columbus-oh',
  '3540fifth': '3540-e-5th-ave-columbus-oh',
  '3883livingston': '3875-3883-e-livingston-ave-columbus-oh',
  '401sunburst': '401-sunburst-hwy-cambridge-md',
  '55newplant': '55-new-plant-ct-owings-mills-md',
  '7658fishel': '7658-fishel-dr-n-dublin-oh',
  '9050redbranch': '9050-red-branch-rd-columbia-md',
  '9620state350': '9620-e-state-route-350-raytown-mo',
  fvc: 'sepich-portfolio-columbus-oh-8-props',
};
/** Insured locations with no property_master row (label only). */
const STEM_LABEL_ONLY: Record<string, string> = {
  etcpoa: 'Airport Road, Easton MD (ETC POA)',
};

export function resolveInsuranceProperty(
  policyKey: string,
  masterNames: ReadonlyMap<string, string>,
): { propertyId: string | null; name: string } {
  const stem = /^ins-([a-z0-9]+)-/.exec(policyKey)?.[1];
  if (stem) {
    const id = STEM_TO_MASTER[stem];
    const name = id ? masterNames.get(id) : undefined;
    if (id && name) return { propertyId: id, name };
    const label = STEM_LABEL_ONLY[stem];
    if (label) return { propertyId: null, name: label };
  }
  return { propertyId: null, name: policyKey };
}
```

- [ ] **Step 4: Wire.** In `buildInsuranceAnalysis` (`insurance-analysis.ts`), before the `drafts` map, load `const masterNames = new Map((db.prepare('SELECT id, name FROM property_master').all() as Array<{ id: string; name: string }>).map((r) => [r.id, r.name]));`. At :433-436 replace the `property`/`propertyId` lines with:

```ts
      property: r.property_name ?? resolveInsuranceProperty(r.property_id, masterNames).name,
      propertyId: r.property_name ? r.property_id : (resolveInsuranceProperty(r.property_id, masterNames).propertyId ?? r.property_id),
```

- [ ] **Step 5: Run tests.** Run: `npx vitest run tests/unit/insurance-property-map.test.ts tests/unit/insurance-module.test.tsx tests/unit/contracts-insurance-analysis.test.ts` plus any `insurance-analysis*.test.ts`. Expected: PASS. If a test pinned `property: 'ins-…'`, update it to the resolved name.
- [ ] **Step 6: Commit.**

```bash
git add server/warehouse/insurance-property-map.ts server/warehouse/insurance-analysis.ts tests/unit/insurance-property-map.test.ts
git commit -m "fix(insurance): show property names instead of policy-line keys" -m "Refute-Skip: display-name resolution only; premiums, cohorts, and benchmark math unchanged" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 15: Comps — readable deal titles and an honest source count

**Files:**
- Create: `src/modules/market/comps-display.ts`, `tests/unit/comps-display.test.ts`
- Modify: `src/modules/market/CompsView.tsx:86` and `:174`

**Interfaces:**
- Produces: `humanizeDealId(id: string): string`; `compSourceCount(set: { sources: unknown[]; saleComps: { source: string }[]; rentComps: { source: string }[] }): number`

- [ ] **Step 1: Failing test.**

```ts
import { describe, expect, it } from 'vitest';
import { compSourceCount, humanizeDealId } from '../../src/modules/market/comps-display';

describe('comps display helpers', () => {
  it('humanizes an orphan Notion deal slug', () => {
    expect(humanizeDealId('notion-maple-grove-park-springfield-oh-45501')).toBe('Maple Grove Park Springfield OH 45501');
  });
  it('counts distinct comp sources when the set-level sources list is empty', () => {
    expect(compSourceCount({ sources: [], saleComps: [{ source: 'a' }, { source: 'b' }, { source: 'a' }], rentComps: [{ source: 'c' }] })).toBe(3);
    expect(compSourceCount({ sources: ['x', 'y'], saleComps: [], rentComps: [] })).toBe(2);
  });
});
```

- [ ] **Step 2: Run and confirm failure.** Run: `npx vitest run tests/unit/comps-display.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**

```ts
const UPPER = new Set(['oh', 'md', 'in', 'wi', 'mo', 'ks', 'tn', 'ia', 'mi', 'ky', 'de']);

/** Title for a comp set whose deal record is missing — never the raw 'notion-…' slug. */
export function humanizeDealId(id: string): string {
  return id
    .replace(/^notion-/i, '')
    .split('-')
    .filter(Boolean)
    .map((w) => (UPPER.has(w.toLowerCase()) ? w.toUpperCase() : /^\d/.test(w) ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ');
}

/** Set-level sources can be empty while every comp row carries its own source. */
export function compSourceCount(set: { sources: unknown[]; saleComps: { source: string }[]; rentComps: { source: string }[] }): number {
  if (set.sources.length > 0) return set.sources.length;
  return new Set([...set.saleComps, ...set.rentComps].map((c) => c.source)).size;
}
```

In `CompsView.tsx:86` use `dealName: nameById.get(dealId) ?? humanizeDealId(dealId),`. At :174 replace the badge body with `{compSourceCount(compSet)} source{compSourceCount(compSet) === 1 ? '' : 's'}`.

- [ ] **Step 4: Run tests.** Run: `npx vitest run tests/unit/comps-display.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add src/modules/market/comps-display.ts src/modules/market/CompsView.tsx tests/unit/comps-display.test.ts
git commit -m "fix(comps): readable deal titles and a real source count" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 16: Replace "Spine A/B" jargon on user surfaces

**Files:**
- Create: `src/lib/spine-label.ts`, `tests/unit/spine-label.test.ts`
- Modify: `src/modules/insights/insights.logic.ts:244-245`, `src/modules/alerts/AlertsModule.tsx:63`, `src/modules/overview/widgets.tsx:207`, `src/modules/leasing/LeaseForecastModule.tsx:367`, `src/modules/insights/InsightsModule.tsx:160,172`, `src/modules/debt/ScorecardView.tsx:117`, `src/modules/taxes/TaxesModule.tsx:65`

**Interfaces:**
- Produces: `spineLabel(spine: 'A' | 'B' | 'cross'): string` → `'Workbook' | 'Ledger' | 'Combined'`

- [ ] **Step 1: Failing test.**

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { spineLabel } from '../../src/lib/spine-label';
import { totalsBySpine } from '../../src/modules/insights/insights.logic';

describe('spine labels', () => {
  it('maps internal spines to plain basis names', () => {
    expect([spineLabel('A'), spineLabel('B'), spineLabel('cross')]).toEqual(['Workbook', 'Ledger', 'Combined']);
    expect(totalsBySpine([]).map((t) => t.label)).toEqual(['Workbook basis', 'Ledger & combined basis']);
  });
  it.each([
    'src/modules/alerts/AlertsModule.tsx', 'src/modules/overview/widgets.tsx', 'src/modules/leasing/LeaseForecastModule.tsx',
    'src/modules/insights/InsightsModule.tsx', 'src/modules/debt/ScorecardView.tsx', 'src/modules/taxes/TaxesModule.tsx',
  ])('%s renders no "Spine A/B" copy', (f) => {
    expect(readFileSync(f, 'utf8')).not.toMatch(/['"`>][^'"`<]*Spine [AB]\b/);
  });
});
```

- [ ] **Step 2: Run and confirm failure.** Run: `npx vitest run tests/unit/spine-label.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Create `src/lib/spine-label.ts`:

```ts
/** User-facing basis names. "Spine A/B" is internal architecture vocabulary (CLAUDE.md §1). */
export function spineLabel(spine: 'A' | 'B' | 'cross'): string {
  return spine === 'A' ? 'Workbook' : spine === 'B' ? 'Ledger' : 'Combined';
}
```

Edits:
- `insights.logic.ts:244-245`: labels become `'Workbook basis'` and `'Ledger & combined basis'`.
- `AlertsModule.tsx:63`: `chips: [spineLabel(insight.spine)],`.
- `widgets.tsx:207`: `chips: [spineLabel(m.spine === 'A' ? 'A' : m.spine === 'B' ? 'B' : 'cross')],`.
- `LeaseForecastModule.tsx:367`: `Workbook basis`.
- `InsightsModule.tsx:160`: `…showing workbook-based insights only.`; `:172`: `{supersededCount} workbook insight{…} superseded by a richer ledger…`.
- `ScorecardView.tsx:117` and `TaxesModule.tsx:65`: replace `Spine A` with `workbook`.
- Import `spineLabel` where used. Leave code comments alone.

- [ ] **Step 4: Update pinned assertions.** Run: `grep -rn "Spine A\|Spine B" tests/unit`. Update rendered-text expectations to the new labels (do not touch tests asserting the `spine: 'A'` data field). Run `npm run test`. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add src/lib/spine-label.ts tests/unit/spine-label.test.ts src/modules/insights/insights.logic.ts src/modules/alerts/AlertsModule.tsx src/modules/overview/widgets.tsx src/modules/leasing/LeaseForecastModule.tsx src/modules/insights/InsightsModule.tsx src/modules/debt/ScorecardView.tsx src/modules/taxes/TaxesModule.tsx <updated test files>
git commit -m "fix(copy): Workbook/Ledger basis labels replace 'Spine A/B' jargon" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 17: TopBar title — stop truncating "Command Overview" at desktop widths

**Files:**
- Modify: `src/shell/TopBar.tsx:48-51`
- Test: create `tests/unit/topbar-title.test.tsx`

- [ ] **Step 1: Failing test.**

```tsx
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('TopBar title', () => {
  it('title never truncates; the as-of dateline yields first', () => {
    const src = readFileSync('src/shell/TopBar.tsx', 'utf8');
    const h1 = /<h1 className="([^"]+)"/.exec(src)?.[1] ?? '';
    expect(h1).not.toContain('truncate');
    expect(h1).toContain('shrink-0');
    expect(h1).toContain('whitespace-nowrap');
  });
});
```

- [ ] **Step 2: Run and confirm failure.** Run: `npx vitest run tests/unit/topbar-title.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** Change the `<h1>` className to `"display shrink-0 whitespace-nowrap text-lg leading-none"`. Add `min-w-0 truncate` to the `As of` span's className, so it shrinks instead of the title.
- [ ] **Step 4: Verify in browser** at 1280×800 and 1440×900 (resize_window): the title reads in full ("Command Overview", "Acquisitions Pipeline", "Capital & Treasury"). At 375 px the mobile layout still fits without horizontal scroll. Screenshot each.
- [ ] **Step 5: Commit.**

```bash
git add src/shell/TopBar.tsx tests/unit/topbar-title.test.tsx
git commit -m "fix(shell): TopBar title no longer truncates at desktop widths" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**PR 3 close-out:** gate → push → PR `fix(cc): 2026-09-23 review — polish` → review → Gabriel merges.

---

## PR 4 — IA consolidation + residence exclusion

### Task 18: Overview — compact top 5 with "See all", full tier board off by default

**Files:**
- Modify: `src/modules/overview/widgets.tsx` (`WidgetDef`, `PRIORITY_ACTIONS_LIMIT` :186, `PriorityActionsWidget` return, registry :261-272)
- Create: `tests/unit/overview-default-layout.test.ts`

- [ ] **Step 1: Failing test.**

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_WIDGET_ORDER, OVERVIEW_WIDGETS } from '../../src/modules/overview/widgets';

describe('Overview default layout (one home per attention list)', () => {
  it('shows Priority Actions by default; the full Insights tier board lives in Brain › Insights', () => {
    expect(DEFAULT_WIDGET_ORDER).toContain('priority-actions');
    expect(DEFAULT_WIDGET_ORDER).not.toContain('insights');
    expect(OVERVIEW_WIDGETS.some((w) => w.id === 'insights')).toBe(true); // still addable via Edit layout
  });
});
```

- [ ] **Step 2: Run and confirm failure.** Run: `npx vitest run tests/unit/overview-default-layout.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Add `defaultOn?: boolean;` to the `WidgetDef` interface (in this file, or wherever `WidgetDef` is declared; follow its import).
  - Registry entry: `{ id: 'insights', title: 'Insights & Alerts', span: 'full', Component: InsightsWidget, defaultOn: false },`
  - `export const DEFAULT_WIDGET_ORDER = OVERVIEW_WIDGETS.filter((w) => w.defaultOn !== false).map((w) => w.id);`
  - `const PRIORITY_ACTIONS_LIMIT = 5;`
  - Make `PriorityActionsWidget`'s final return:

```tsx
  return (
    <div className="flex flex-col gap-2">
      <TierBoard tiers={[tier]} columns={1} />
      <Link to="/command-brain?tab=insights" className="self-end text-2xs font-semibold" style={{ color: 'var(--accent)' }}>
        See all {merged.length} insights →
      </Link>
    </div>
  );
```

  (`import { Link } from 'react-router-dom';`)
- [ ] **Step 4: Run tests.** Run: `npx vitest run tests/unit/overview-default-layout.test.ts` and any `overview*.test.tsx`. Expected: PASS. Saved per-user layouts that include `insights` keep it. That's intended; "Reset layout" returns to the new default.
- [ ] **Step 5: Commit.**

```bash
git add src/modules/overview/widgets.tsx tests/unit/overview-default-layout.test.ts
git commit -m "feat(overview): top-5 priority actions with See all → Brain Insights; tier board off by default" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 19: Brain Digest — count summary instead of re-listing

**Files:**
- Create: `src/modules/principal/digest-summary.ts`, `tests/unit/digest-summary.test.ts`
- Modify: `src/modules/principal/PrincipalModule.tsx:36-52`

**Interfaces:**
- Consumes: `DigestItem` from `src/brain/principal-digest.ts` (`{ id; kind: 'insight' | 'deal' | …; rank: number; title; detail }`).
- Produces: `digestSummary(items: DigestItem[]): { critical: number; review: number; deals: number; top: DigestItem[] }`, with `top` = up to 3 critical items.

- [ ] **Step 1: Failing test.**

```ts
import { describe, expect, it } from 'vitest';
import { digestSummary } from '../../src/modules/principal/digest-summary';
import type { DigestItem } from '../../src/brain/principal-digest';

const it_ = (id: string, rank: number, kind: DigestItem['kind'] = 'insight') => ({ id, kind, rank, title: id, detail: '' }) as DigestItem;

describe('digestSummary', () => {
  it('counts by class and keeps the top 3 critical items', () => {
    const s = digestSummary([it_('a', 0), it_('b', 0), it_('c', 1), it_('d', 0), it_('e', 0), it_('f', 2, 'deal')]);
    expect(s).toMatchObject({ critical: 4, review: 1, deals: 1 });
    expect(s.top.map((x) => x.id)).toEqual(['a', 'b', 'd']);
  });
});
```

- [ ] **Step 2: Run and confirm failure.** Run: `npx vitest run tests/unit/digest-summary.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**

```ts
import type { DigestItem } from '@/brain/principal-digest';

export function digestSummary(items: DigestItem[]) {
  const critical = items.filter((i) => i.kind === 'insight' && i.rank === 0);
  return {
    critical: critical.length,
    review: items.filter((i) => i.kind === 'insight' && i.rank !== 0).length,
    deals: items.filter((i) => i.kind === 'deal').length,
    top: critical.slice(0, 3),
  };
}
```

In `PrincipalModule.tsx`, replace the "Needs your attention" `<Card>` body. Keep the header and badge; render three count tiles (`Critical`, `Review`, `Deals`) using the existing `KpiStat` with `value={s.critical}` etc. Under them, render the `s.top` items in the existing `<li>` markup, then add `<Link to="/command-brain?tab=insights">Open Insights →</Link>`. Keep the empty state ("Nothing needs a decision right now.") when `digest.length === 0`.
- [ ] **Step 4: Run tests.** Run: `npx vitest run tests/unit/digest-summary.test.ts tests/unit/command-brain-module.test.tsx`. Expected: PASS. Update any assertion that counted digest `<li>` rows.
- [ ] **Step 5: Commit.**

```bash
git add src/modules/principal/digest-summary.ts src/modules/principal/PrincipalModule.tsx tests/unit/digest-summary.test.ts
git commit -m "feat(brain): Digest shows counts + top 3 critical, links to Insights (no duplicate list)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 20: Exclude the residence from investment KPIs (ratified 2026-09-23)

**Files:**
- Modify: `src/analytics/engine.ts:68-100` (`portfolioKpis`) *(architect-owned)*
- Modify: `src/analytics/types.ts:36-49` (`PortfolioKpis` adds two cells)
- Modify: `src/modules/overview/widgets.tsx:36` (Portfolio Value sublabel)
- Create: `tests/unit/portfolio-kpis-residence.test.ts`

**Interfaces:**
- Produces: `PortfolioKpis.otherHoldingsValue: Cell`, `PortfolioKpis.otherHoldingsCount: Cell`. The `value`, `noi`, `totalSf`, `occupancy`, `ltv`, `weightedCapRate`, `propertyCount`, `tenantCount`, `totalDebt` and `equityInvested` cells now cover investment properties only (`type !== 'Residence'`).

- [ ] **Step 1: Failing test.**

```ts
import { describe, expect, it } from 'vitest';
import { portfolioKpis } from '../../src/analytics/engine';
import type { PortfolioSnapshot, Property } from '../../src/contracts/index';

const p = (o: Partial<Property>) => ({ id: 'x', name: 'x', sf: 0, occPct: 1, noi: 0, oxfordValue: 0, loanBalance: 0, equityInvested: 0, tenantCount: 0, type: 'Flex', ...o }) as Property;

describe('portfolioKpis — residence excluded from investment metrics', () => {
  const s = {
    properties: [
      p({ id: 'a', sf: 10000, noi: 680_000, oxfordValue: 10_000_000, loanBalance: 2_000_000, tenantCount: 3 }),
      p({ id: 'res', type: 'Residence', sf: 6700, noi: 0, oxfordValue: 2_000_000 }),
    ],
    leases: [], cash: { totalCash: 0, history: [] }, meta: { asOf: '2026-09-23' },
  } as unknown as PortfolioSnapshot;

  it('value, cap rate, LTV and count exclude the residence; other holdings carry it', () => {
    const k = portfolioKpis(s);
    expect(k.value.value).toBe(10_000_000);
    expect(k.weightedCapRate.value).toBeCloseTo(0.068);
    expect(k.ltv.value).toBeCloseTo(0.2);
    expect(k.propertyCount.value).toBe(1);
    expect(k.totalSf.value).toBe(10000);
    expect(k.otherHoldingsValue.value).toBe(2_000_000);
    expect(k.otherHoldingsCount.value).toBe(1);
  });
});
```

- [ ] **Step 2: Run and confirm failure.** Run: `npx vitest run tests/unit/portfolio-kpis-residence.test.ts`. Expected: FAIL (value 12,000,000).
- [ ] **Step 3: Implement.** In `types.ts` add to `PortfolioKpis`:

```ts
  /** Non-investment holdings (the residence) — shown alongside, never inside, investment metrics. */
  otherHoldingsValue: Cell;
  otherHoldingsCount: Cell;
```

In `engine.ts` `portfolioKpis`, replace `const p = s.properties;` with:

```ts
  // Ratified 2026-09-23 (Gabriel): the residence is not an investment asset — it diluted weighted cap
  // (~24 bps) and occupancy. Solar stays in (income-producing). Residence is reported as "other holdings".
  const p = s.properties.filter((x) => x.type !== 'Residence');
  const other = s.properties.filter((x) => x.type === 'Residence');
```

and add to the returned object:

```ts
    otherHoldingsValue: cell(sum(other.map((x) => x.oxfordValue)), 'Property NOI · Σ Oxford value (Residence)', 'confirmed'),
    otherHoldingsCount: cell(other.length, 'Property NOI · Residence row count', 'confirmed'),
```

In `widgets.tsx:36` change the Portfolio Value sublabel to:

```tsx
sublabel={`${fmtNum(k.propertyCount.value)} investment properties${k.otherHoldingsCount.value ? ` · +${fmtUsdCompact(k.otherHoldingsValue.value)} other` : ''}`}
```

- [ ] **Step 4: Run the suite and reconcile.** Run: `npm run test && npm run reconcile && npm run reconcile:snapshot`. Expected: PASS. `scripts/reconcile.ts` reads the snapshot, not `portfolioKpis`. Fix any other suite that pinned the 14-property totals by asserting the investment-only figure, and name the reason in the test.
- [ ] **Step 5: Refute.** Invoke `refute-financial-change` on `engine.ts` + `types.ts`. Required lenses: aggregate LTV moves up (conservative; governor constant unchanged), and every downstream consumer (AI tools, brief, Portfolio module, capital allocation) reads the new basis consistently. Record the run id.
- [ ] **Step 6: Commit.**

```bash
git add src/analytics/engine.ts src/analytics/types.ts src/modules/overview/widgets.tsx tests/unit/portfolio-kpis-residence.test.ts <updated tests>
git commit -m "feat(kpis): exclude the residence from investment KPIs; report it as other holdings (ratified 2026-09-23)" -m "Refute-Reviewed: wf_<runId>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**PR 4 close-out:** gate → push → PR → adversarial merge gate (financial) → Gabriel merges.

---

## PR 5 — Charts

Deferred with reason (no task):
- **Leasing velocity trend:** `lease_events` has 0 rows and the contract carries per-property aggregates only. A chart would plot nothing. It unblocks via Ops Runbook R8.
- **Brain accuracy over time:** already implemented (`TrackRecordPanel` Sparkline segments). It plots automatically once ≥5 scoreable verdicts exist in a month.

### Task 21: Lease rollover chart on Leasing › Rollover (shared with Overview)

**Files:**
- Create: `src/modules/leasing/RolloverChart.tsx`, `tests/unit/rollover-chart.test.ts`
- Modify: `src/modules/overview/widgets.tsx:90-100` (`LeaseRolloverWidget` uses it), `src/modules/leasing/LeaseForecastModule.tsx` (render above the Leasing Velocity card in the `rollover` TabPanel)

**Interfaces:**
- Produces: `rolloverChartData(buckets: RolloverBucket[]): BarDatum[]`, `<RolloverChart />` (reads `useAnalytics()`; renders `null` when no analytics).

- [ ] **Step 1: Failing test.**

```ts
import { describe, expect, it } from 'vitest';
import { rolloverChartData } from '../../src/modules/leasing/RolloverChart';

describe('rolloverChartData', () => {
  it('maps buckets to period/expiring-rent bars, dropping empty periods', () => {
    expect(rolloverChartData([
      { period: '2026 H2', count: 18, expiringSf: 45130, expiringRent: 482000 },
      { period: '2027', count: 0, expiringSf: 0, expiringRent: 0 },
      { period: '2028', count: 43, expiringSf: 148206, expiringRent: 1760000 },
    ])).toEqual([{ label: '2026 H2', value: 482000 }, { label: '2028', value: 1760000 }]);
  });
});
```

- [ ] **Step 2: Run and confirm failure.** Expected: FAIL.
- [ ] **Step 3: Implement.**

```tsx
import { BarChart, type BarDatum } from '@/charts/BarChart';
import { useAnalytics } from '@/data/queries';
import { fmtUsdCompact } from '@/analytics/format';
import type { RolloverBucket } from '@/analytics/types';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';

export function rolloverChartData(buckets: RolloverBucket[]): BarDatum[] {
  return buckets.filter((b) => b.expiringRent > 0).map((b) => ({ label: b.period, value: b.expiringRent }));
}

export function RolloverChart({ height = 230 }: { height?: number }) {
  const { analytics } = useAnalytics();
  if (!analytics) return null;
  return (
    <Card>
      <CardHeader title="Lease Rollover" trailing={<Badge tone="neutral">rent expiring by period</Badge>} />
      <div className="px-3 pb-2 pt-3">
        <BarChart data={rolloverChartData(analytics.rollover)} valueFormat={fmtUsdCompact} height={height} color="var(--color-info)" />
      </div>
    </Card>
  );
}
```

Replace `LeaseRolloverWidget`'s body with `return <RolloverChart />;`. In `LeaseForecastModule.tsx`, inside `<TabPanel id="rollover">` and before the velocity `Card`, render `<RolloverChart height={260} />` (wrap both in a `flex flex-col gap-4` div).
- [ ] **Step 4: Run tests.** Run: `npx vitest run tests/unit/rollover-chart.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add src/modules/leasing/RolloverChart.tsx src/modules/overview/widgets.tsx src/modules/leasing/LeaseForecastModule.tsx tests/unit/rollover-chart.test.ts
git commit -m "feat(leasing): rollover chart on the Rollover tab (shared with Overview)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 22: ScatterChart primitive

**Files:**
- Create: `src/charts/ScatterChart.tsx`, `tests/unit/scatter-chart.test.tsx`

**Interfaces:**
- Produces: `interface ScatterPoint { id: string; x: number; y: number; label: string; tone?: 'pos' | 'neg' | 'neutral' }`, `scatterDomain(points: ScatterPoint[], pad?: number): { x: [number, number]; y: [number, number] }`, `<ScatterChart points xLabel yLabel xFormat yFormat height? yRef? />` (`yRef` draws a dashed horizontal reference line).

- [ ] **Step 1: Failing test.**

```tsx
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ScatterChart, scatterDomain } from '../../src/charts/ScatterChart';

const pts = [
  { id: 'a', x: 70, y: 0.07, label: 'A' },
  { id: 'b', x: 120, y: 0.055, label: 'B' },
];

describe('ScatterChart', () => {
  it('pads the domain by 10% of the range on each side', () => {
    const d = scatterDomain(pts);
    expect(d.x[0]).toBeCloseTo(65);
    expect(d.x[1]).toBeCloseTo(125);
    expect(d.y[0]).toBeCloseTo(0.0535);
  });
  it('renders one circle per point with an accessible title', () => {
    const { container } = render(<ScatterChart points={pts} xLabel="$/SF" yLabel="Cap" xFormat={String} yFormat={String} />);
    expect(container.querySelectorAll('circle')).toHaveLength(2);
    expect(container.querySelector('circle title')?.textContent).toContain('A');
  });
});
```

- [ ] **Step 2: Run and confirm failure.** Expected: FAIL.
- [ ] **Step 3: Implement.** Follow the visx pattern of `RentCurve.tsx`. Use a fixed viewBox scaled to 100% width (no ParentSize).

```tsx
import { scaleLinear } from '@visx/scale';
import { AxisBottom, AxisLeft } from '@visx/axis';
import { Group } from '@visx/group';

export interface ScatterPoint { id: string; x: number; y: number; label: string; tone?: 'pos' | 'neg' | 'neutral' }

export function scatterDomain(points: ScatterPoint[], pad = 0.1): { x: [number, number]; y: [number, number] } {
  const span = (vals: number[]): [number, number] => {
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const r = hi - lo || Math.abs(hi) || 1;
    return [lo - r * pad, hi + r * pad];
  };
  return { x: span(points.map((p) => p.x)), y: span(points.map((p) => p.y)) };
}

const TONE = { pos: 'var(--color-pos)', neg: 'var(--color-neg)', neutral: 'var(--accent)' } as const;
const W = 640;
const M = { top: 12, right: 16, bottom: 36, left: 56 };

export function ScatterChart({ points, xLabel, yLabel, xFormat, yFormat, height = 280, yRef }: {
  points: ScatterPoint[]; xLabel: string; yLabel: string;
  xFormat: (n: number) => string; yFormat: (n: number) => string; height?: number; yRef?: number;
}) {
  if (points.length === 0) return null;
  const d = scatterDomain(points);
  const x = scaleLinear({ domain: d.x, range: [M.left, W - M.right] });
  const y = scaleLinear({ domain: d.y, range: [height - M.bottom, M.top] });
  return (
    <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="img" aria-label={`${yLabel} vs ${xLabel}`}>
      <Group>
        {yRef !== undefined && (
          <line x1={M.left} x2={W - M.right} y1={y(yRef)} y2={y(yRef)} stroke="var(--text-tertiary)" strokeDasharray="4 4" />
        )}
        {points.map((p) => (
          <circle key={p.id} cx={x(p.x)} cy={y(p.y)} r={5} fill={TONE[p.tone ?? 'neutral']} fillOpacity={0.8}>
            <title>{`${p.label} — ${xLabel} ${xFormat(p.x)}, ${yLabel} ${yFormat(p.y)}`}</title>
          </circle>
        ))}
        <AxisBottom top={height - M.bottom} scale={x} tickFormat={(v) => xFormat(Number(v))} numTicks={5} label={xLabel}
          stroke="var(--border-subtle)" tickStroke="var(--border-subtle)" tickLabelProps={{ fill: 'var(--text-tertiary)', fontSize: 10 }} />
        <AxisLeft left={M.left} scale={y} tickFormat={(v) => yFormat(Number(v))} numTicks={5} label={yLabel}
          stroke="var(--border-subtle)" tickStroke="var(--border-subtle)" tickLabelProps={{ fill: 'var(--text-tertiary)', fontSize: 10 }} />
      </Group>
    </svg>
  );
}
```

- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add src/charts/ScatterChart.tsx tests/unit/scatter-chart.test.tsx
git commit -m "feat(charts): ScatterChart primitive (visx)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 23: Cap-rate scatter — Market › Comps and Capital › Allocation

**Files:**
- Create: `src/modules/capital/cap-rate-scatter.ts`, `tests/unit/cap-rate-scatter.test.ts`
- Modify: `src/modules/market/CompsView.tsx` (inside `DealComps`, above the sale-comps table), `src/modules/capital/CapitalModule.tsx` (above the table using `CAP_RATE_COLS`)

**Interfaces:**
- Consumes: `ScatterPoint`, `ScatterChart` (Task 22); `SaleComp` (`src/contracts/comps.ts`); `CapitalAllocationEntry` (fields `propertyId`, `propertyName`, `impliedCapRate`, `capRateGap`).
- Produces: `saleCompPoints(comps: SaleComp[]): ScatterPoint[]` (x = $/SF, y = cap; drops nulls), `allocationCapPoints(rows: CapitalAllocationEntry[]): ScatterPoint[]` (x = implied cap, y = gap vs market; tone pos when gap > 0).

- [ ] **Step 1: Failing test.**

```ts
import { describe, expect, it } from 'vitest';
import { allocationCapPoints, saleCompPoints } from '../../src/modules/capital/cap-rate-scatter';

describe('cap-rate scatter builders', () => {
  it('sale comps: $/SF vs cap, skipping rows missing either', () => {
    expect(saleCompPoints([
      { address: 'A', market: null, sf: 1, price: 1, pricePerSf: 74, capRate: 0.07, date: null, source: 's' },
      { address: 'B', market: null, sf: 1, price: 1, pricePerSf: 71, capRate: null, date: null, source: 's' },
    ])).toEqual([{ id: 'A-0', x: 74, y: 0.07, label: 'A' }]);
  });
  it('allocation: implied cap vs gap, tone by sign', () => {
    const pts = allocationCapPoints([
      { propertyId: 'p1', propertyName: 'Fishel', impliedCapRate: 0.055, capRateGap: -0.0275 },
      { propertyId: 'p2', propertyName: null, impliedCapRate: 0.08, capRateGap: 0.01 },
      { propertyId: 'p3', propertyName: 'X', impliedCapRate: null, capRateGap: null },
    ] as never);
    expect(pts).toEqual([
      { id: 'p1', x: 0.055, y: -0.0275, label: 'Fishel', tone: 'neg' },
      { id: 'p2', x: 0.08, y: 0.01, label: 'p2', tone: 'pos' },
    ]);
  });
});
```

- [ ] **Step 2: Run and confirm failure.** Expected: FAIL.
- [ ] **Step 3: Implement.**

```ts
import type { ScatterPoint } from '@/charts/ScatterChart';
import type { SaleComp } from '@contracts/comps';
import type { CapitalAllocationEntry } from '@contracts/capital-allocation';

export function saleCompPoints(comps: SaleComp[]): ScatterPoint[] {
  return comps.flatMap((c, i) =>
    c.pricePerSf !== null && c.capRate !== null ? [{ id: `${c.address}-${i}`, x: c.pricePerSf, y: c.capRate, label: c.address }] : []);
}

export function allocationCapPoints(rows: CapitalAllocationEntry[]): ScatterPoint[] {
  return rows.flatMap((r) =>
    r.impliedCapRate !== null && r.capRateGap !== null
      ? [{ id: r.propertyId, x: r.impliedCapRate, y: r.capRateGap, label: r.propertyName ?? r.propertyId, tone: r.capRateGap >= 0 ? 'pos' as const : 'neg' as const }]
      : []);
}
```

(If `CapitalAllocationEntry` lives in a different contract file, import it from the path `CapitalModule.tsx` already uses.)

UI: in `DealComps`, when `saleCompPoints(compSet.saleComps).length >= 2`, render
`<ScatterChart points={…} xLabel="$/SF" yLabel="Cap rate" xFormat={(n) => `$${Math.round(n)}`} yFormat={(n) => `${(n * 100).toFixed(1)}%`} />`.
In `CapitalModule`, above the cap-rate table, render
`<ScatterChart points={allocationCapPoints(rows)} xLabel="Implied cap" yLabel="vs market" xFormat={(n) => `${(n * 100).toFixed(1)}%`} yFormat={(n) => `${Math.round(n * 10000)} bps`} yRef={0} />`
inside a `Card` titled "Cap-rate positioning".
- [ ] **Step 4: Run tests.** Expected: PASS. Verify in browser on Market › Comps and Capital › Allocation; screenshot both.
- [ ] **Step 5: Commit.**

```bash
git add src/modules/capital/cap-rate-scatter.ts src/modules/market/CompsView.tsx src/modules/capital/CapitalModule.tsx tests/unit/cap-rate-scatter.test.ts
git commit -m "feat(charts): cap-rate scatter on Comps and Capital Allocation" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 24: Insurance premium history — server builder + route

**Files:**
- Create: `server/warehouse/insurance-history.ts`, `tests/unit/insurance-history.test.ts`
- Modify: `src/contracts/insurance-analysis.ts` (add `PremiumHistoryReport`) *(architect-owned)*
- Modify: `server/warehouse/insurance-analysis-api.ts` (add `GET /history`)

**Interfaces:**
- Consumes: `resolveInsuranceProperty` (Task 14).
- Produces:
  - Zod `PremiumHistoryReport = { byYear: Array<{ year: number; premium: number; lines: number }>; lines: Array<{ lineKey: string; property: string; policyType: string; terms: Array<{ effectiveDate: string; premium: number }> }> }`
  - `buildPremiumHistory(rows: Array<{ property_id: string; policy_type: string; effective_date: string | null; premium_annual: number | null }>, masterNames: ReadonlyMap<string, string>): PremiumHistoryReport`
  - Route `GET /api/warehouse/insurance/analysis/history`

- [ ] **Step 1: Failing test.**

```ts
import { describe, expect, it } from 'vitest';
import { buildPremiumHistory } from '../../server/warehouse/insurance-history';
import { PremiumHistoryReport } from '@contracts/insurance-analysis';

const master = new Map([['3034-westerville-rd-columbus-oh', '3034 Westerville Rd, Columbus OH']]);

describe('buildPremiumHistory', () => {
  it('groups terms per policy line, drops duplicate terms within 300d at the same premium, sums by policy year', () => {
    const r = buildPremiumHistory([
      { property_id: 'ins-3034westerville-pckg', policy_type: 'Package (PCKG)', effective_date: '2024-09-24', premium_annual: 7838 },
      { property_id: 'ins-3034westerville-pckg', policy_type: 'Package (PCKG)', effective_date: '2025-09-18', premium_annual: 7838 }, // DQ duplicate
      { property_id: 'ins-3034westerville-pckg', policy_type: 'Package (PCKG)', effective_date: '2025-07-05', premium_annual: 7831 },
      { property_id: 'ins-3034westerville-pckg', policy_type: 'Package (PCKG)', effective_date: '2026-07-05', premium_annual: 7522 },
      { property_id: 'ins-x-gl', policy_type: 'GL', effective_date: null, premium_annual: 100 },
    ], master);
    expect(() => PremiumHistoryReport.parse(r)).not.toThrow();
    expect(r.lines[0]!.property).toBe('3034 Westerville Rd, Columbus OH');
    expect(r.lines[0]!.terms.map((t) => t.premium)).toEqual([7838, 7831, 7522]);
    expect(r.byYear).toEqual([
      { year: 2024, premium: 7838, lines: 1 },
      { year: 2025, premium: 7831, lines: 1 },
      { year: 2026, premium: 7522, lines: 1 },
    ]);
  });
});
```

- [ ] **Step 2: Run and confirm failure.** Expected: FAIL.
- [ ] **Step 3: Contract.** Append to `src/contracts/insurance-analysis.ts`:

```ts
export const PremiumHistoryReport = z.object({
  byYear: z.array(z.object({ year: z.number().int(), premium: z.number().nonnegative(), lines: z.number().int().nonnegative() })),
  lines: z.array(z.object({
    lineKey: z.string(),
    property: z.string(),
    policyType: z.string(),
    terms: z.array(z.object({ effectiveDate: z.string(), premium: z.number().nonnegative() })),
  })),
});
export type PremiumHistoryReport = z.infer<typeof PremiumHistoryReport>;
```

- [ ] **Step 4: Builder.** Create `server/warehouse/insurance-history.ts`:

```ts
import type { PremiumHistoryReport } from '../../src/contracts/insurance-analysis';
import { resolveInsuranceProperty } from './insurance-property-map';

interface Row { property_id: string; policy_type: string; effective_date: string | null; premium_annual: number | null }
const DUP_WINDOW_DAYS = 300;

/** Per-line premium terms + policy-year totals. Skips undated/unpriced rows; collapses a same-premium
 *  term re-keyed within 300d (the 3034 Westerville $7,838 duplicate in data_quality_issues). */
export function buildPremiumHistory(rows: Row[], masterNames: ReadonlyMap<string, string>): PremiumHistoryReport {
  const byLine = new Map<string, { policyType: string; terms: Array<{ effectiveDate: string; premium: number }> }>();
  for (const r of rows) {
    if (!r.effective_date || r.premium_annual === null || r.premium_annual < 0) continue;
    const e = byLine.get(r.property_id) ?? { policyType: r.policy_type, terms: [] };
    e.terms.push({ effectiveDate: r.effective_date.slice(0, 10), premium: r.premium_annual });
    byLine.set(r.property_id, e);
  }
  const lines: PremiumHistoryReport['lines'] = [];
  for (const [lineKey, e] of byLine) {
    const sorted = e.terms.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
    const terms = sorted.filter((t, i) => !sorted.slice(0, i).some((p) =>
      p.premium === t.premium && (Date.parse(t.effectiveDate) - Date.parse(p.effectiveDate)) / 86_400_000 < DUP_WINDOW_DAYS));
    lines.push({ lineKey, property: resolveInsuranceProperty(lineKey, masterNames).name, policyType: e.policyType, terms });
  }
  const years = new Map<number, { premium: number; lines: number }>();
  for (const l of lines) for (const t of l.terms) {
    const y = Number(t.effectiveDate.slice(0, 4));
    const cur = years.get(y) ?? { premium: 0, lines: 0 };
    years.set(y, { premium: cur.premium + t.premium, lines: cur.lines + 1 });
  }
  return {
    byYear: [...years.entries()].sort((a, b) => a[0] - b[0]).map(([year, v]) => ({ year, ...v })),
    lines: lines.sort((a, b) => a.property.localeCompare(b.property)),
  };
}
```

- [ ] **Step 5: Route.** In `insurance-analysis-api.ts`, alongside the existing `app.get('/', …)`, and using the same `withDb`/guard pattern that file already uses:

```ts
  app.get('/history', (c) =>
    withDb((db) => {
      const rows = db.prepare(
        `SELECT property_id, policy_type, effective_date, premium_annual FROM property_insurance_policies`,
      ).all() as Array<{ property_id: string; policy_type: string; effective_date: string | null; premium_annual: number | null }>;
      const masterNames = new Map((db.prepare('SELECT id, name FROM property_master').all() as Array<{ id: string; name: string }>).map((r) => [r.id, r.name]));
      return c.json(buildPremiumHistory(rows, masterNames));
    }),
  );
```

- [ ] **Step 6: Run tests.** Run: `npx vitest run tests/unit/insurance-history.test.ts tests/unit/contracts-insurance-analysis.test.ts`. Expected: PASS.
- [ ] **Step 7: Commit.**

```bash
git add src/contracts/insurance-analysis.ts server/warehouse/insurance-history.ts server/warehouse/insurance-analysis-api.ts tests/unit/insurance-history.test.ts
git commit -m "feat(insurance): premium history endpoint (per-line terms + policy-year totals)" -m "Refute-Skip: read-only historical aggregation for display; no scoring/benchmark path consumes it" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 25: Insurance premium history — UI card

**Files:**
- Create: `src/modules/insurance/PremiumHistoryCard.tsx`, `tests/unit/premium-history-card.test.tsx`
- Modify: `src/modules/insurance/InsuranceModule.tsx` (render in the Policy Register view, above `Policy Tracker`)

**Interfaces:**
- Consumes: `PremiumHistoryReport` (Task 24), `BarChart`, `Sparkline`, `fetchJson` from `src/modules/intel/hooks.ts`.

- [ ] **Step 1: Failing test** (seed the query cache, like `insurance-module.test.tsx`):

```tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PremiumHistoryCard, PREMIUM_HISTORY_KEY } from '../../src/modules/insurance/PremiumHistoryCard';

afterEach(cleanup);

describe('PremiumHistoryCard', () => {
  it('renders the policy-year chart and a sparkline for each multi-term line only', () => {
    const qc = new QueryClient();
    qc.setQueryData(PREMIUM_HISTORY_KEY, {
      byYear: [{ year: 2025, premium: 190000, lines: 30 }, { year: 2026, premium: 193014, lines: 30 }],
      lines: [
        { lineKey: 'a', property: '3034 Westerville Rd', policyType: 'PCKG', terms: [{ effectiveDate: '2025-07-05', premium: 7831 }, { effectiveDate: '2026-07-05', premium: 7522 }] },
        { lineKey: 'b', property: '1100 Rarig', policyType: 'BCL', terms: [{ effectiveDate: '2026-03-19', premium: 595 }] },
      ],
    });
    render(<QueryClientProvider client={qc}><PremiumHistoryCard /></QueryClientProvider>);
    expect(screen.getByText('Premium History')).toBeTruthy();
    expect(screen.getByText(/3034 Westerville Rd/)).toBeTruthy();
    expect(screen.queryByText(/1100 Rarig/)).toBeNull();
    expect(screen.getByText('-3.9%')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run and confirm failure.** Expected: FAIL.
- [ ] **Step 3: Implement.**

```tsx
import { useQuery } from '@tanstack/react-query';
import { BarChart } from '@/charts/BarChart';
import { Sparkline } from '@/charts/Sparkline';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { fmtUsdCompact } from '@/analytics/format';
import { fetchJson } from '@/modules/intel/hooks';
import type { PremiumHistoryReport } from '@contracts/insurance-analysis';

export const PREMIUM_HISTORY_KEY = ['insurance', 'premium-history'] as const;

export function PremiumHistoryCard() {
  const { data } = useQuery({
    queryKey: PREMIUM_HISTORY_KEY,
    queryFn: () => fetchJson<PremiumHistoryReport>('/api/warehouse/insurance/analysis/history'),
  });
  if (!data || data.byYear.length === 0) return null;
  const multi = data.lines.filter((l) => l.terms.length >= 2);
  return (
    <Card>
      <CardHeader title="Premium History" trailing={<Badge tone="neutral">{multi.length} lines with renewal history</Badge>} />
      <div className="px-3 pb-2 pt-3">
        <BarChart data={data.byYear.map((y) => ({ label: String(y.year), value: y.premium }))} valueFormat={fmtUsdCompact} height={200} />
      </div>
      <ul className="grid grid-cols-1 gap-2 px-4 pb-4 md:grid-cols-2">
        {multi.map((l) => {
          const first = l.terms[0]!.premium;
          const last = l.terms.at(-1)!.premium;
          const chg = first ? (last - first) / first : 0;
          return (
            <li key={l.lineKey} className="flex items-center justify-between gap-3 text-2xs">
              <span style={{ color: 'var(--text-secondary)' }}>{l.property} · {l.policyType}</span>
              <span className="flex items-center gap-2">
                <Sparkline data={l.terms.map((t) => t.premium)} width={64} height={20} />
                <span className="num" style={{ color: chg > 0 ? 'var(--text-neg)' : 'var(--text-pos)' }}>
                  {`${chg >= 0 ? '+' : ''}${(chg * 100).toFixed(1)}%`}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
```

In `InsuranceModule.tsx`, inside the Policy Register view (the component that renders `Policy Tracker`), wrap its return in a `flex flex-col gap-4` div with `<PremiumHistoryCard />` first.
- [ ] **Step 4: Run tests.** Run: `npx vitest run tests/unit/premium-history-card.test.tsx tests/unit/insurance-module.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add src/modules/insurance/PremiumHistoryCard.tsx src/modules/insurance/InsuranceModule.tsx tests/unit/premium-history-card.test.tsx
git commit -m "feat(insurance): Premium History card (policy-year bars + per-line renewal sparklines)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 26: Tax assessment history chart

**Files:**
- Create: `src/modules/taxes/AssessmentHistoryCard.tsx`, `tests/unit/assessment-history.test.tsx`
- Modify: `src/modules/taxes/TaxesModule.tsx` (render above `AssessmentsTable` in the Assessments & Appeals view)

**Interfaces:**
- Consumes: `TaxAssessment[]` (`src/contracts/tax.ts`) from the report the module already loads.
- Produces: `taxByYear(a: TaxAssessment[]): Array<{ label: string; value: number }>` (Σ `annualTaxBilled` per `taxYear`, nulls skipped, ascending); `assessedSeries(a: TaxAssessment[]): Array<{ propertyId: string; values: number[] }>` (assessed value by year, per property, ≥2 points only).

- [ ] **Step 1: Failing test.**

```tsx
import { describe, expect, it } from 'vitest';
import { assessedSeries, taxByYear } from '../../src/modules/taxes/AssessmentHistoryCard';

const a = (propertyId: string, taxYear: number, assessedValue: number | null, annualTaxBilled: number | null) =>
  ({ propertyId, taxYear, jurisdiction: null, assessedValue, assessmentRatio: null, millageRate: null, annualTaxBilled, source: 's', asOf: null });

describe('tax history builders', () => {
  it('sums billed tax by year, skipping nulls', () => {
    expect(taxByYear([a('p', 2025, 1, 100), a('q', 2025, 1, 50), a('p', 2026, 1, null), a('p', 2024, 1, 90)]))
      .toEqual([{ label: '2024', value: 90 }, { label: '2025', value: 150 }]);
  });
  it('assessed-value series per property, only where ≥2 years exist', () => {
    expect(assessedSeries([a('p', 2025, 200, null), a('p', 2024, 180, null), a('q', 2025, 5, null)]))
      .toEqual([{ propertyId: 'p', values: [180, 200] }]);
  });
});
```

- [ ] **Step 2: Run and confirm failure.** Expected: FAIL.
- [ ] **Step 3: Implement.**

```tsx
import { BarChart } from '@/charts/BarChart';
import { Sparkline } from '@/charts/Sparkline';
import { Card, CardHeader } from '@/primitives/Card';
import { fmtUsdCompact } from '@/analytics/format';
import type { TaxAssessment } from '@contracts/tax';

export function taxByYear(a: TaxAssessment[]): Array<{ label: string; value: number }> {
  const m = new Map<number, number>();
  for (const r of a) if (r.annualTaxBilled !== null) m.set(r.taxYear, (m.get(r.taxYear) ?? 0) + r.annualTaxBilled);
  return [...m.entries()].sort((x, y) => x[0] - y[0]).map(([y, v]) => ({ label: String(y), value: v }));
}

export function assessedSeries(a: TaxAssessment[]): Array<{ propertyId: string; values: number[] }> {
  const m = new Map<string, Array<[number, number]>>();
  for (const r of a) if (r.assessedValue !== null) m.set(r.propertyId, [...(m.get(r.propertyId) ?? []), [r.taxYear, r.assessedValue]]);
  return [...m.entries()]
    .filter(([, pts]) => pts.length >= 2)
    .map(([propertyId, pts]) => ({ propertyId, values: pts.sort((x, y) => x[0] - y[0]).map((p) => p[1]) }));
}

export function AssessmentHistoryCard({ assessments, nameFor }: { assessments: TaxAssessment[]; nameFor: (id: string) => string }) {
  const bars = taxByYear(assessments);
  if (bars.length === 0) return null;
  return (
    <Card>
      <CardHeader title="Property Tax History" />
      <div className="px-3 pb-2 pt-3">
        <BarChart data={bars} valueFormat={fmtUsdCompact} height={200} color="var(--color-warn)" />
      </div>
      <ul className="grid grid-cols-1 gap-2 px-4 pb-4 md:grid-cols-2">
        {assessedSeries(assessments).map((s) => (
          <li key={s.propertyId} className="flex items-center justify-between gap-3 text-2xs">
            <span style={{ color: 'var(--text-secondary)' }}>{nameFor(s.propertyId)} · assessed</span>
            <Sparkline data={s.values} width={72} height={20} />
          </li>
        ))}
      </ul>
    </Card>
  );
}
```

In `TaxesModule.tsx`, above `AssessmentsTable`, render `<AssessmentHistoryCard assessments={report.assessments} nameFor={…} />`. Use the property-name lookup the table already uses (or `(id) => id` if none exists).
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add src/modules/taxes/AssessmentHistoryCard.tsx src/modules/taxes/TaxesModule.tsx tests/unit/assessment-history.test.tsx
git commit -m "feat(taxes): property tax history chart + assessed-value sparklines" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 27: Leasing forecast — rent bridge waterfall

**Files:**
- Create: `src/modules/leasing/forecast-bridge.ts`, `tests/unit/forecast-bridge.test.ts`
- Modify: `src/modules/leasing/LeaseForecastModule.tsx` (after the KPI row at ~:412-459)

**Interfaces:**
- Consumes: `RentForecastResult` (`inPlaceAnnualRent`, `projectedAnnualRent`, `deltaUsd`, `expiringRentInHorizon`); `Waterfall` props `{ startValue, drivers: { category; delta }[], endValue, startLabel?, endLabel? }`.
- Produces: `forecastBridge(r: RentForecastResult): { startValue: number; drivers: Array<{ category: string; delta: number }>; endValue: number }`

- [ ] **Step 1: Failing test.**

```ts
import { describe, expect, it } from 'vitest';
import { forecastBridge } from '../../src/modules/leasing/forecast-bridge';

describe('forecastBridge', () => {
  it('in-place − rent rolling off + re-leased rent = projected (closes exactly)', () => {
    const b = forecastBridge({ inPlaceAnnualRent: 5_000_000, projectedAnnualRent: 5_120_000, deltaUsd: 120_000, expiringRentInHorizon: 1_130_000 } as never);
    expect(b.drivers).toEqual([
      { category: 'Rent rolling off', delta: -1_130_000 },
      { category: 'Re-leased / renewed', delta: 1_250_000 },
    ]);
    expect(b.startValue + b.drivers.reduce((s, d) => s + d.delta, 0)).toBe(b.endValue);
  });
});
```

- [ ] **Step 2: Run and confirm failure.** Expected: FAIL.
- [ ] **Step 3: Implement.**

```ts
import type { RentForecastResult } from '@contracts/lease-forecast';

/** Two-driver rent bridge: expiring rent leaves, the scenario's re-lease value returns. */
export function forecastBridge(r: RentForecastResult) {
  return {
    startValue: r.inPlaceAnnualRent,
    drivers: [
      { category: 'Rent rolling off', delta: -r.expiringRentInHorizon },
      { category: 'Re-leased / renewed', delta: r.expiringRentInHorizon + r.deltaUsd },
    ],
    endValue: r.projectedAnnualRent,
  };
}
```

Below the forecast KPI row in `LeaseForecastModule.tsx`:

```tsx
                {(() => { const b = forecastBridge(forecast); return (
                  <Waterfall startValue={b.startValue} drivers={b.drivers} endValue={b.endValue} startLabel="In-place" endLabel="Projected" height={220} />
                ); })()}
```

(`import { Waterfall } from '@/charts/Waterfall';` and `forecastBridge`). If `WaterfallDriver` requires more fields than `{ category, delta }`, read `src/charts/Waterfall.tsx` and map accordingly.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add src/modules/leasing/forecast-bridge.ts src/modules/leasing/LeaseForecastModule.tsx tests/unit/forecast-bridge.test.ts
git commit -m "feat(leasing): rent bridge waterfall under the forecast result" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 28: Calendar — dollars at stake by month

**Files:**
- Create: `src/modules/calendar/month-at-stake.ts`, `tests/unit/month-at-stake.test.ts`
- Modify: `src/modules/calendar/CalendarModule.tsx` (between the KPI grid and the Critical Dates card)

**Interfaces:**
- Consumes: `DatedEvent` (`monthKey`, `amount: number | null`, `daysToDate`).
- Produces: `monthlyAtStake(events: DatedEvent[]): BarDatum[]` (upcoming only, `daysToDate >= 0`; Σ amount per `monthKey`; ascending; label `'Oct 26'` style).

- [ ] **Step 1: Failing test.**

```ts
import { describe, expect, it } from 'vitest';
import { monthlyAtStake } from '../../src/modules/calendar/month-at-stake';

const e = (monthKey: string, amount: number | null, daysToDate: number) => ({ monthKey, amount, daysToDate }) as never;

describe('monthlyAtStake', () => {
  it('sums upcoming $ by month, excludes overdue, ascending', () => {
    expect(monthlyAtStake([e('2026-11', 12000, 38), e('2026-10', 38000, 8), e('2026-11', null, 40), e('2024-09', 10000, -752)]))
      .toEqual([{ label: 'Oct 26', value: 38000 }, { label: 'Nov 26', value: 12000 }]);
  });
});
```

- [ ] **Step 2: Run and confirm failure.** Expected: FAIL.
- [ ] **Step 3: Implement.**

```ts
import type { BarDatum } from '@/charts/BarChart';
import type { DatedEvent } from '@/brain/critical-dates';

export function monthlyAtStake(events: DatedEvent[]): BarDatum[] {
  const m = new Map<string, number>();
  for (const e of events) {
    if (e.daysToDate < 0) continue;
    m.set(e.monthKey, (m.get(e.monthKey) ?? 0) + (e.amount ?? 0));
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => ({
    label: new Date(`${k}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }).replace(' ', ' '),
    value: v,
  }));
}
```

(Check `toLocaleDateString` output in the test environment. If it yields `"Oct 26"` directly, drop the `.replace`. The test is the authority.)

In `CalendarModule.tsx`, between the KPI grid and the card, render:

```tsx
      <Card>
        <CardHeader title="At Stake by Month" trailing={<Badge tone="neutral">upcoming · {horizon}</Badge>} />
        <div className="px-3 pb-2 pt-3">
          <BarChart data={monthlyAtStake(filtered)} valueFormat={fmtUsdCompact} height={180} color="var(--accent)" />
        </div>
      </Card>
```

- [ ] **Step 4: Run tests.** Run: `npx vitest run tests/unit/month-at-stake.test.ts tests/unit/calendar-module-horizon.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add src/modules/calendar/month-at-stake.ts src/modules/calendar/CalendarModule.tsx tests/unit/month-at-stake.test.ts
git commit -m "feat(calendar): dollars-at-stake-by-month chart above the critical-dates list" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**PR 5 close-out:** gate → browser verification of every new chart in light and dark mode (screenshots attached to the PR) → push → PR → review → Gabriel merges.

---

## PR 6 — Basis labels & guardrails

### Task 29: Debt basis reconciliation flag

**Files:**
- Modify: `server/reconcile-runtime.ts` (new exported fn + push after `checkStaleLeaseRows`)
- Test: `tests/unit/reconcile-runtime.test.ts`

**Interfaces:**
- Produces: `checkDebtBasis(s: Pick<PortfolioSnapshot, 'properties' | 'loans'>): DataQualityFlag[]`. Warns when |Σ property `loanBalance` − Σ borrower-loan `absBalance`| > $1,000.

- [ ] **Step 1: Failing test.**

```ts
import { checkDebtBasis } from '../../server/reconcile-runtime';

describe('checkDebtBasis', () => {
  it('flags when Overview total debt (Σ property loan balances) ≠ Capital external debt (Σ borrower loans)', () => {
    const flags = checkDebtBasis({
      properties: [{ loanBalance: 11_300_000 }] as never,
      loans: [{ direction: 'borrower', absBalance: 10_600_000 }, { direction: 'internal', absBalance: 2_610_000 }] as never,
    });
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ field: 'debt.basis', severity: 'warn' });
    expect(flags[0]!.issue).toContain('700');
  });
  it('silent within $1,000', () => {
    expect(checkDebtBasis({ properties: [{ loanBalance: 100_500 }] as never, loans: [{ direction: 'borrower', absBalance: 100_000 }] as never })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and confirm failure.** Expected: FAIL.
- [ ] **Step 3: Implement.**

```ts
/**
 * Overview "Total Debt" sums property loanBalance (workbook property rows); Capital › Debt "External
 * Debt" sums borrower loans (loan schedule). They disagreed by ~$0.7M with no explanation on screen
 * (2026-09-23 review). Surface the gap; do not pick a winner here.
 */
export function checkDebtBasis(s: Pick<PortfolioSnapshot, 'properties' | 'loans'>): DataQualityFlag[] {
  const propertyDebt = sum((s.properties ?? []).map((p) => p.loanBalance ?? 0));
  const external = sum((s.loans ?? []).filter((l) => l.direction === 'borrower').map((l) => l.absBalance ?? 0));
  const gap = propertyDebt - external;
  if (Math.abs(gap) <= 1000) return [];
  return [{
    entity: 'reconciliation',
    field: 'debt.basis',
    issue: `Σ property loan balances ${Math.round(propertyDebt).toLocaleString()} vs Σ external loans ${Math.round(external).toLocaleString()} — gap ${Math.round(Math.abs(gap) / 1000).toLocaleString()}K (share basis or a loan missing from one source)`,
    severity: 'warn',
  }];
}
```

Push it with `flags.push(...checkDebtBasis(s));`. (`sum` is already used in this file; if not exported locally, reuse its import.)
- [ ] **Step 4: Run tests.** Run: `npx vitest run tests/unit/reconcile-runtime.test.ts && npm run reconcile:snapshot`. Expected: PASS.
- [ ] **Step 5: Refute.** Invoke `refute-financial-change` (reconciliation path; confirm it is warn-only and never alters totals). Record the id.
- [ ] **Step 6: Commit.**

```bash
git add server/reconcile-runtime.ts tests/unit/reconcile-runtime.test.ts
git commit -m "feat(reconcile): flag Overview-vs-Capital debt basis gap" -m "Refute-Reviewed: wf_<runId>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 30: Basis labels on NOI and debt figures

**Files:**
- Modify: `src/modules/overview/widgets.tsx:37,41` (NOI and Total Debt sublabels)
- Modify: `src/modules/intel/OwnershipView.tsx` (Morning Briefing header line)
- Modify: `src/modules/debt/DebtModule.tsx:151` (External Debt sublabel)
- Create: `tests/unit/basis-labels.test.ts`

- [ ] **Step 1: Failing test** (static copy guard):

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('basis labels', () => {
  it('Overview NOI and debt tiles state their basis', () => {
    const w = readFileSync('src/modules/overview/widgets.tsx', 'utf8');
    expect(w).toContain('Oxford share · workbook');
    expect(w).toContain('property loan balances');
  });
  it('Financials briefing states full-asset ledger basis', () => {
    expect(readFileSync('src/modules/intel/OwnershipView.tsx', 'utf8')).toContain('full-asset P&L ledger');
  });
  it('Capital external debt states loan-schedule basis', () => {
    expect(readFileSync('src/modules/debt/DebtModule.tsx', 'utf8')).toContain('loan schedule');
  });
});
```

- [ ] **Step 2: Run and confirm failure.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `widgets.tsx:37` NOI sublabel: `` `${fmtPct(k.weightedCapRate.value)} wtd cap · Oxford share · workbook` ``.
  - `widgets.tsx:41` Total Debt sublabel: `` `${fmtPct(k.ltv.value)} LTV · property loan balances` ``.
  - `OwnershipView.tsx`: append ` · full-asset P&L ledger` to the line that renders "portfolio NOI across N properties" (find it with `grep -n "portfolio NOI" src/modules/intel/OwnershipView.tsx`).
  - `DebtModule.tsx:151` KpiStat: add or extend `sublabel` with `loan schedule · borrower loans`.
- [ ] **Step 4: Run tests.** Run: `npx vitest run tests/unit/basis-labels.test.ts` plus any overview/debt/intel suites pinning the old sublabels. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add src/modules/overview/widgets.tsx src/modules/intel/OwnershipView.tsx src/modules/debt/DebtModule.tsx tests/unit/basis-labels.test.ts
git commit -m "fix(copy): state the basis on NOI and debt figures (workbook vs ledger vs loan schedule)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 31: LTV governor insight wording

**Files:**
- Modify: `src/analytics/conditions.ts` (`ltv-governor-${p.id}` block, ~:377-386)
- Test: `tests/unit/conditions.test.ts`

- [ ] **Step 1: Failing test.**

```ts
it('per-property LTV above the 40% aggregate governor is worded as informational, not a breach', () => {
  const out = evaluateConditions(snap({ properties: [prop({ id: 'p1', name: '1100 Rarig', ltv: 0.457 })] }), opts);
  const i = out.find((x) => x.id === 'ltv-governor-p1')!;
  expect(i.severity).toBe('info');
  expect(i.title).toBe('Property LTV above aggregate target — 1100 Rarig');
  expect(i.detail).toContain('governor applies to the portfolio aggregate');
});
```

- [ ] **Step 2: Run and confirm failure.** Expected: FAIL.
- [ ] **Step 3: Implement.** Replace `title` and `detail` in that block:

```ts
        title: `Property LTV above aggregate target — ${p.name}`,
        detail: `Loan-to-value is ${fmtPct(p.ltv)}. The ${fmtPct(gov.ltvCeiling)} governor applies to the portfolio aggregate; this property is within the ${fmtPct(T.ltvCeiling)} per-property ceiling. Informational.`,
```

- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add src/analytics/conditions.ts tests/unit/conditions.test.ts
git commit -m "fix(alerts): per-property LTV insight no longer reads as an aggregate-governor breach" -m "Refute-Skip: insight copy only; severity, trigger, and governor constants unchanged" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**PR 6 close-out:** gate → push → PR → review → Gabriel merges. Then flip the `cc-review-fixes` entry in `architecture/status.json` to `"status": "merged"` and remove the worktree (remove any `node_modules` junction first, per memory `node-modules-junction-footgun`).

---

## Ops Runbook (not code — Gabriel or a supervised session; the Data Feeds card from Task 11 tracks each)

| # | Item | Action | Owner / guardrail |
|---|---|---|---|
| R1 | Cash history missing 2026-08-10 and 09-10 rows | Add the rows to Cash Data in the Master Workbook | Gabriel (business OneDrive — Invariant 5) |
| R2 | AR aging 70 days old | Run the QB AR export, then `npx tsx scripts/ar-import-headless.ts`. Check why the Monday 08:20 import stopped (fleet check) | `automation-health-monitor` → `fleet-advisory-remediation` |
| R3 | Daily brief last ran 2026-07-09 | The brief runs via `scripts/bake-mirror.ts` from the snapshot-refresh scheduled task. The live CC fleet shows 1 recurring task, so confirm whether it was paused or retired | `register-scheduled-task` (supervised; never splice registry JSON) |
| R4 | Lease Market never computed | `npm run lease-market:ingest` (CoStar exports), then `npm run lease-market:compute`; schedule weekly | `register-scheduled-task` |
| R5 | Document index from 2026-06-06 | `npm run index:docs` (reads OneDrive read-only); schedule monthly | `register-scheduled-task` |
| R6 | Insurance: 8 policy lines show expired (1100 Rarig, ETC POA, 1851 S Club, 9050 Red Branch, 3034 Westerville); TIV null on all 30 | Confirm renewals were bound; import new terms + TIV from dec pages (`scripts/import-insurance-data.ts`). TIV unblocks rate benchmarking and re-bid/self-insure | Gabriel supplies dec pages; `insurance-declaration-checker` agent verifies |
| R7 | Workbook rows: Example Consulting $0 rent "Active"; Tenant 038 LLC / Tenant 059 LLC ended 2024-09-01 | Fix in the Master Workbook (Task 5 surfaces these as flags) | Gabriel |
| R8 | Leasing velocity has no data (`lease_events` = 0 rows) | Spec an importer that derives vacate/commence events from historical rent rolls or the Notion Tenant DB history, then add the velocity trend chart | New spec (brainstorming → /plan) |

## Verification before calling this done

- Each PR: `npm run gate` green; `npx tsx scripts/check-refute-required.ts` passes; browser verification with screenshots for every UI task (light + dark, 1440 px and 375 px).
- After all six merge: re-run the 2026-09-23 walk-through (47 tabs). Expected:
  - Sourcing loads.
  - Risk Impact no longer double-counts expiring leases.
  - No raw ids, floats, CSS, or "Spine" copy anywhere.
  - Health shows the feed status.
  - Every destination except Data and Worklist › Today has at least one chart.
