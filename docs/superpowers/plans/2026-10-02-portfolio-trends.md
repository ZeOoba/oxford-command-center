# Portfolio Trends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Trends" tab inside Portfolio showing monthly rent (with increase/decrease bridge), vacancy and — in Wave 3 — expenses, for the whole portfolio and per property, as charts with MoM deltas and "what changed" callouts.

**Architecture:** Spine A only for Wave 1: a pure analytics module reconstructs month-by-month in-place rent and vacancy from the 138 snapshot leases (`leaseStart/leaseEnd/monthlyRent/escalationDate/escalationPct`) and the 14 properties' SF. No DB, no migration, no architect-owned file touched. Wave 2 persists true month-end snapshots (history that accumulates). Wave 3 adds monthly expenses from monthly P&L exports into a NEW table (never the annual `ledger_entries`).

**Tech Stack:** TypeScript strict, React, visx charts (`AreaChart`, `BarChart`, `Waterfall`), Vitest (`tests/unit/**`, aliases `@`, `@contracts`, `@analytics`).

## Global Constraints

- Investment assets only: use `isInvestmentProperty` (`src/analytics/property-basis.ts`); the residence is excluded (ruling 2026-09-24).
- Never mix basis: reconstructed/forecast months must be visibly labelled; never compare to `Property.noi` or the warehouse ledger without basis-matching.
- House tab cap: max 5 tabs per destination (`MAX_TABS_PER_DESTINATION`).
- Do NOT touch: `data/overlay.json`, `data/warehouse/finance.sqlite`, `data/snapshots/portfolio.json` (Gabriel's dirty file), `confidential-terms.json`, CORS config, the gate.
- Architect-owned (needs `architecture/status.json` claim + `review_needed: true` BEFORE editing): `src/contracts/`, `server/index.ts`, `server/warehouse/migrations/`, `package.json`, `scripts/governance-check.ts`. Wave 1 touches none of these.
- Commit with explicit paths only (never `git add -A`). `npm run gate` must be green (the `reconcile` step is known-red on main — see memory `reconcile-cash-history-drift-main`; prove later steps manually and say so). `npm test` can exit 0xC0000005 intermittently — rerun.
- Work in an isolated worktree (2+ sessions share this checkout): `git worktree add .claude/worktrees/portfolio-trends -b feat/portfolio-trends`; claim it in `architecture/status.json`.
- Decisions ratified by Gabriel 2026-10-02: monthly expenses come from **monthly P&L exports** (Wave 3); Trends lives as a **tab inside Portfolio**.

## Data reality (why the waves are ordered this way)

| Metric | Source today | Wave |
|---|---|---|
| Rent by month | Reconstructable from leases (forward exact; history approximate — leases already off the roll are missing, and past escalations are not back-cast) | 1 (then true history in 2) |
| Vacancy by month | Same lease reconstruction; `property_occupancy` has only 21 irregular snapshot dates since 2026-06-14 | 1 (then 2) |
| Expenses by month | NOT AVAILABLE — all 32 P&L batches are annual/YTD single-total (`period_grain` year/ytd) | 3 |

---

# WAVE 1 — Rent & vacancy trends from the snapshot (no migration)

## File structure

- Create `src/analytics/portfolio-trends.ts` — pure engine (month math, rent, vacancy, bridge).
- Create `tests/unit/portfolio-trends.test.ts` — engine tests.
- Create `src/modules/portfolio/trends-chart-data.ts` — maps engine output to chart props (repo pattern: `*-chart-data.ts`).
- Create `tests/unit/portfolio-trends-chart-data.test.ts`.
- Create `src/modules/portfolio/TrendsView.tsx` — the Trends tab body.
- Create `src/modules/portfolio/tabs.ts` — `PORTFOLIO_TABS` (React-free metadata, repo pattern).
- Create `src/modules/portfolio/PortfolioDestination.tsx` — Destination composing Properties + Trends (leaves `PortfolioModule` untouched so `tests/unit/portfolio-module-other-holdings.test.tsx` keeps passing).
- Modify `src/shell/modules.tsx` — point the `portfolio` entry at `PortfolioDestination` with `tabs: PORTFOLIO_TABS` (import lines ~17-22 and entry line ~66).
- Modify `src/analytics/index.ts` — re-export the engine.

### Task 1: Month math + lease rent/activity (engine core)

**Files:**
- Create: `src/analytics/portfolio-trends.ts`
- Test: `tests/unit/portfolio-trends.test.ts`

**Interfaces:**
- Produces: `type MonthKey = string` (`'YYYY-MM'`); `monthOf(iso: string): MonthKey`; `addMonths(m: MonthKey, n: number): MonthKey`; `monthRange(from: MonthKey, to: MonthKey): MonthKey[]`; `leaseActive(l: Lease, m: MonthKey): boolean`; `leaseRent(l: Lease, m: MonthKey, asOfMonth: MonthKey): number`.
- Semantics: month-granular (a lease counts for a whole month if active any day in it). Open `leaseEnd` = ongoing. `escalationDate` is the NEXT escalation; `escalationPct` is a fraction (0.03 = 3%). Months ≤ asOf use `monthlyRent` flat (no back-cast). A stale `escalationDate` ≤ asOf rolls forward in 12-month steps without applying.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/portfolio-trends.test.ts
import { describe, expect, it } from 'vitest';
import type { Lease, Property } from '@contracts/index';
import { addMonths, monthRange, leaseActive, leaseRent } from '@analytics/portfolio-trends';

const lease = (o: Partial<Lease>): Lease =>
  ({
    id: 'l', propertyKey: 'P', propertyId: 'p1', tenantName: 't', unit: 'A', company: 'c',
    sf: 1000, monthlyRent: 1000, rentPerSf: 12, leaseStart: '2026-01-01', leaseEnd: '2026-12-31',
    escalationDate: null, escalationPct: null, status: 'Active', annualRent: 12000,
    monthsToExpiry: 6, flags: [], ...o,
  }) as Lease;

describe('month math', () => {
  it('addMonths wraps years in both directions', () => {
    expect(addMonths('2026-11', 3)).toBe('2027-02');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
  });
  it('monthRange is inclusive', () => {
    expect(monthRange('2026-11', '2027-01')).toEqual(['2026-11', '2026-12', '2027-01']);
  });
});

describe('leaseActive', () => {
  it('is active for every month touched by [start,end]', () => {
    const l = lease({ leaseStart: '2026-05-15', leaseEnd: '2026-08-31' });
    expect(leaseActive(l, '2026-04')).toBe(false);
    expect(leaseActive(l, '2026-05')).toBe(true);
    expect(leaseActive(l, '2026-08')).toBe(true);
    expect(leaseActive(l, '2026-09')).toBe(false);
  });
  it('treats a null end as ongoing and a null start as inactive', () => {
    expect(leaseActive(lease({ leaseEnd: null }), '2035-01')).toBe(true);
    expect(leaseActive(lease({ leaseStart: null }), '2026-06')).toBe(false);
  });
});

describe('leaseRent', () => {
  const l = lease({ monthlyRent: 1000, escalationDate: '2026-11-01', escalationPct: 0.03 });
  it('is flat through asOf and until the next escalation', () => {
    expect(leaseRent(l, '2026-10', '2026-10')).toBe(1000);
    expect(leaseRent(l, '2026-10', '2026-09')).toBe(1000);
  });
  it('steps up at the escalation month and compounds annually', () => {
    expect(leaseRent(l, '2026-11', '2026-10')).toBeCloseTo(1030, 6);
    expect(leaseRent(l, '2027-10', '2026-10')).toBeCloseTo(1030, 6);
    expect(leaseRent(l, '2027-11', '2026-10')).toBeCloseTo(1060.9, 6);
  });
  it('rolls a stale (already-passed) escalation date forward without applying it', () => {
    const stale = lease({ monthlyRent: 1000, escalationDate: '2026-05-01', escalationPct: 0.03 });
    expect(leaseRent(stale, '2026-12', '2026-10')).toBe(1000);
    expect(leaseRent(stale, '2027-05', '2026-10')).toBeCloseTo(1030, 6);
  });
  it('ignores a null/zero escalation pct', () => {
    expect(leaseRent(lease({ escalationDate: '2026-11-01', escalationPct: null }), '2027-06', '2026-10')).toBe(1000);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/portfolio-trends.test.ts`
Expected: FAIL — cannot resolve `@analytics/portfolio-trends`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/analytics/portfolio-trends.ts — monthly rent / vacancy reconstruction. Pure functions over
// PortfolioSnapshot rows (Spine A). No DB, no I/O, no Date.now (asOf is always passed in).
import type { Lease, Property } from '@contracts/index';
import { isInvestmentProperty } from './property-basis';

/** 'YYYY-MM' — lexicographic order == chronological order. */
export type MonthKey = string;

export const monthOf = (iso: string): MonthKey => iso.slice(0, 7);

const monthIndex = (m: MonthKey): number => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return y * 12 + (mo - 1);
};

export function addMonths(m: MonthKey, n: number): MonthKey {
  const idx = monthIndex(m) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

export function monthRange(from: MonthKey, to: MonthKey): MonthKey[] {
  const out: MonthKey[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

/** Month-granular: counts a month if the lease is in effect on any day of it. */
export function leaseActive(l: Lease, m: MonthKey): boolean {
  if (!l.leaseStart) return false;
  if (monthOf(l.leaseStart) > m) return false;
  return l.leaseEnd === null || monthOf(l.leaseEnd) >= m;
}

/**
 * Monthly rent of one lease in month `m`. Months <= asOf use the current monthlyRent flat (history
 * is NOT back-cast — past escalations are unknown). Future months apply the next escalation and
 * compound it every 12 months. escalationDate is the NEXT escalation; stale dates roll forward.
 */
export function leaseRent(l: Lease, m: MonthKey, asOfMonth: MonthKey): number {
  const pct = l.escalationPct;
  if (m <= asOfMonth || !l.escalationDate || !pct) return l.monthlyRent;
  let next = monthOf(l.escalationDate);
  while (next <= asOfMonth) next = addMonths(next, 12);
  if (m < next) return l.monthlyRent;
  const steps = 1 + Math.floor((monthIndex(m) - monthIndex(next)) / 12);
  return l.monthlyRent * Math.pow(1 + pct, steps);
}
```

(`Property` and `isInvestmentProperty` imports are used in Task 2; add them then if lint flags unused imports now — remove the two unused imports in this step and re-add in Task 2.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/portfolio-trends.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add src/analytics/portfolio-trends.ts tests/unit/portfolio-trends.test.ts
git commit -m "feat(trends): month math + lease activity/rent reconstruction engine core"
```

### Task 2: Portfolio / per-property series and the rent bridge

**Files:**
- Modify: `src/analytics/portfolio-trends.ts` (append)
- Modify: `tests/unit/portfolio-trends.test.ts` (append)
- Modify: `src/analytics/index.ts` (add `export * from './portfolio-trends';` — read the file first and match its export style)

**Interfaces:**
- Consumes: Task 1 exports.
- Produces:
  - `interface MonthPoint { month: MonthKey; isForecast: boolean; inPlaceRent: number; leasedSf: number; totalSf: number; vacantSf: number; vacancyPct: number; leaseCount: number }` (`vacancyPct` is a 0..1 fraction)
  - `interface RentBridgeStep { month: MonthKey; isForecast: boolean; opening: number; escalations: number; newLeases: number; expirations: number; closing: number }` (`expirations` is negative or 0)
  - `interface TrendOptions { asOf: string; monthsBack?: number; monthsForward?: number }` (defaults 12 / 18)
  - `interface TrendResult { asOfMonth: MonthKey; months: MonthKey[]; portfolio: MonthPoint[]; byProperty: Record<string, MonthPoint[]>; bridge: RentBridgeStep[] }`
  - `buildPortfolioTrend(leases: Lease[], properties: Property[], opts: TrendOptions): TrendResult`
  - `rentBridge(leases: Lease[], months: MonthKey[], asOfMonth: MonthKey): RentBridgeStep[]` (one step per month after the first)

- [ ] **Step 1: Write the failing tests** (append; reuse the `lease` helper, add a `prop` helper)

```ts
import { buildPortfolioTrend, rentBridge } from '@analytics/portfolio-trends';

const prop = (o: Partial<Property>): Property => ({ id: 'p1', type: 'Flex', sf: 10000, ...o }) as Property;

describe('buildPortfolioTrend', () => {
  const A = lease({ id: 'A', sf: 6000, monthlyRent: 1000, leaseStart: '2026-01-01', leaseEnd: '2026-12-31' });
  const B = lease({ id: 'B', sf: 2000, monthlyRent: 500, leaseStart: '2026-06-01', leaseEnd: '2027-12-31' });
  const opts = { asOf: '2026-09-30', monthsBack: 6, monthsForward: 6 };
  const t = buildPortfolioTrend([A, B], [prop({})], opts);
  const at = (m: string) => t.portfolio.find((p) => p.month === m)!;

  it('spans asOf-monthsBack .. asOf+monthsForward and flags forecast months', () => {
    expect(t.months[0]).toBe('2026-03');
    expect(t.months.at(-1)).toBe('2027-03');
    expect(at('2026-09').isForecast).toBe(false);
    expect(at('2026-10').isForecast).toBe(true);
  });
  it('computes leased/vacant SF, vacancy and rent per month', () => {
    expect(at('2026-03')).toMatchObject({ leasedSf: 6000, vacantSf: 4000, vacancyPct: 0.4, inPlaceRent: 1000, leaseCount: 1 });
    expect(at('2026-06')).toMatchObject({ leasedSf: 8000, vacantSf: 2000, vacancyPct: 0.2, inPlaceRent: 1500, leaseCount: 2 });
    expect(at('2027-01')).toMatchObject({ leasedSf: 2000, vacantSf: 8000, vacancyPct: 0.8, inPlaceRent: 500 });
  });
  it('exposes the same series per property', () => {
    expect(t.byProperty['p1']!.map((p) => p.vacancyPct)).toEqual(t.portfolio.map((p) => p.vacancyPct));
  });
  it('excludes residences and leases with a null or unknown propertyId', () => {
    const res = buildPortfolioTrend(
      [A, lease({ id: 'X', propertyId: null }), lease({ id: 'Y', propertyId: 'ghost' }), lease({ id: 'R', propertyId: 'home' })],
      [prop({}), prop({ id: 'home', type: 'Residence', sf: 5000 })],
      opts,
    );
    expect(Object.keys(res.byProperty)).toEqual(['p1']);
    expect(res.portfolio.find((p) => p.month === '2026-03')).toMatchObject({ totalSf: 10000, leaseCount: 1 });
  });
  it('never divides by zero for a property with no SF', () => {
    const z = buildPortfolioTrend([], [prop({ sf: 0 })], opts);
    expect(z.portfolio.every((p) => p.vacancyPct === 0)).toBe(true);
  });
});

describe('rentBridge', () => {
  it('books new leases and expirations and closes to the series', () => {
    const A = lease({ id: 'A', monthlyRent: 1000, leaseStart: '2026-01-01', leaseEnd: '2026-12-31' });
    const B = lease({ id: 'B', monthlyRent: 500, leaseStart: '2026-06-01', leaseEnd: '2027-12-31' });
    const t = buildPortfolioTrend([A, B], [prop({})], { asOf: '2026-09-30', monthsBack: 6, monthsForward: 6 });
    const step = (m: string) => t.bridge.find((s) => s.month === m)!;
    expect(step('2026-06')).toMatchObject({ opening: 1000, newLeases: 500, expirations: 0, escalations: 0, closing: 1500 });
    expect(step('2027-01')).toMatchObject({ opening: 1500, newLeases: 0, expirations: -1000, closing: 500 });
    for (const s of t.bridge) {
      expect(s.closing).toBeCloseTo(s.opening + s.escalations + s.newLeases + s.expirations, 6);
      expect(s.closing).toBeCloseTo(t.portfolio.find((p) => p.month === s.month)!.inPlaceRent, 6);
    }
  });
  it('books a scheduled escalation as an increase', () => {
    const E = lease({ monthlyRent: 1000, leaseStart: '2025-01-01', leaseEnd: '2028-12-31', escalationDate: '2026-11-01', escalationPct: 0.03 });
    const steps = rentBridge([E], ['2026-10', '2026-11'], '2026-09');
    expect(steps).toHaveLength(1);
    expect(steps[0]!.escalations).toBeCloseTo(30, 6);
    expect(steps[0]!.closing).toBeCloseTo(1030, 6);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/portfolio-trends.test.ts`
Expected: FAIL — `buildPortfolioTrend` / `rentBridge` not exported.

- [ ] **Step 3: Implement** (append to `portfolio-trends.ts`; restore the `Property`/`isInvestmentProperty` imports at the top)

```ts
export interface MonthPoint {
  month: MonthKey;
  isForecast: boolean;
  inPlaceRent: number;
  leasedSf: number;
  totalSf: number;
  vacantSf: number;
  /** 0..1 fraction. */
  vacancyPct: number;
  leaseCount: number;
}

export interface RentBridgeStep {
  month: MonthKey;
  isForecast: boolean;
  opening: number;
  escalations: number;
  newLeases: number;
  /** Negative or zero. */
  expirations: number;
  closing: number;
}

export interface TrendOptions {
  asOf: string;
  monthsBack?: number;
  monthsForward?: number;
}

export interface TrendResult {
  asOfMonth: MonthKey;
  months: MonthKey[];
  portfolio: MonthPoint[];
  byProperty: Record<string, MonthPoint[]>;
  bridge: RentBridgeStep[];
}

function pointsFor(leases: Lease[], totalSf: number, months: MonthKey[], asOfMonth: MonthKey): MonthPoint[] {
  return months.map((month) => {
    const active = leases.filter((l) => leaseActive(l, month));
    const leasedSf = active.reduce((s, l) => s + l.sf, 0);
    const vacantSf = Math.max(0, totalSf - leasedSf);
    return {
      month,
      isForecast: month > asOfMonth,
      inPlaceRent: active.reduce((s, l) => s + leaseRent(l, month, asOfMonth), 0),
      leasedSf,
      totalSf,
      vacantSf,
      vacancyPct: totalSf > 0 ? vacantSf / totalSf : 0,
      leaseCount: active.length,
    };
  });
}

export function rentBridge(leases: Lease[], months: MonthKey[], asOfMonth: MonthKey): RentBridgeStep[] {
  const steps: RentBridgeStep[] = [];
  for (let i = 1; i < months.length; i++) {
    const prev = months[i - 1]!;
    const cur = months[i]!;
    let opening = 0, escalations = 0, newLeases = 0, expirations = 0, closing = 0;
    for (const l of leases) {
      const wasActive = leaseActive(l, prev);
      const isActive = leaseActive(l, cur);
      const before = wasActive ? leaseRent(l, prev, asOfMonth) : 0;
      const after = isActive ? leaseRent(l, cur, asOfMonth) : 0;
      opening += before;
      closing += after;
      if (wasActive && isActive) escalations += after - before;
      else if (isActive) newLeases += after;
      else if (wasActive) expirations -= before;
    }
    steps.push({ month: cur, isForecast: cur > asOfMonth, opening, escalations, newLeases, expirations, closing });
  }
  return steps;
}

export function buildPortfolioTrend(leases: Lease[], properties: Property[], opts: TrendOptions): TrendResult {
  const asOfMonth = monthOf(opts.asOf);
  const months = monthRange(addMonths(asOfMonth, -(opts.monthsBack ?? 12)), addMonths(asOfMonth, opts.monthsForward ?? 18));
  const props = properties.filter(isInvestmentProperty);
  const ids = new Set(props.map((p) => p.id));
  const inScope = leases.filter((l) => l.propertyId !== null && ids.has(l.propertyId));

  const byProperty: Record<string, MonthPoint[]> = {};
  for (const p of props) {
    byProperty[p.id] = pointsFor(inScope.filter((l) => l.propertyId === p.id), p.sf, months, asOfMonth);
  }
  const totalSf = props.reduce((s, p) => s + p.sf, 0);
  return {
    asOfMonth,
    months,
    portfolio: pointsFor(inScope, totalSf, months, asOfMonth),
    byProperty,
    bridge: rentBridge(inScope, months, asOfMonth),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/portfolio-trends.test.ts && npm run typecheck && npm run lint`
Expected: tests PASS; typecheck and lint clean (use the exact script names in `package.json` if they differ).

- [ ] **Step 5: Commit**

```bash
git add src/analytics/portfolio-trends.ts src/analytics/index.ts tests/unit/portfolio-trends.test.ts
git commit -m "feat(trends): portfolio/per-property monthly series + rent bridge"
```

### Task 3: Chart-data mappers and KPI deltas

**Files:**
- Create: `src/modules/portfolio/trends-chart-data.ts`
- Test: `tests/unit/portfolio-trends-chart-data.test.ts`

**Interfaces:**
- Consumes: `MonthPoint`, `RentBridgeStep`, `MonthKey` from Task 2; `TimePoint` from `@/charts/AreaChart`; `BarDatum` from `@/charts/BarChart`.
- Produces: `rentSeries(points): TimePoint[]` (date = `YYYY-MM-01`, value = $/mo); `vacancySeries(points): TimePoint[]` (value = percent 0..100); `rentChangeBars(steps): BarDatum[]` (label = month, value = closing − opening); `kpiAt(points, asOfMonth): { rent: number; vacancyPct: number; vacantSf: number; rentMoM: number | null; rentYoY: number | null; vacancyMoMPts: number | null }` (`rentMoM`/`rentYoY` are fractions to match `KpiStat.delta`; `vacancyMoMPts` is percentage points).

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/portfolio-trends-chart-data.test.ts
import { describe, expect, it } from 'vitest';
import type { MonthPoint, RentBridgeStep } from '@analytics/portfolio-trends';
import { kpiAt, rentChangeBars, rentSeries, vacancySeries } from '@/modules/portfolio/trends-chart-data';

const pt = (month: string, inPlaceRent: number, vacancyPct: number): MonthPoint => ({
  month, isForecast: false, inPlaceRent, leasedSf: 0, totalSf: 100, vacantSf: vacancyPct * 100, vacancyPct, leaseCount: 1,
});

describe('trends chart data', () => {
  const pts = [pt('2025-09', 800, 0.1), pt('2026-08', 900, 0.05), pt('2026-09', 1000, 0.08)];
  it('maps to chart series', () => {
    expect(rentSeries(pts)[2]).toEqual({ date: '2026-09-01', value: 1000 });
    expect(vacancySeries(pts)[2]!.value).toBeCloseTo(8, 6);
  });
  it('maps bridge steps to net-change bars', () => {
    const s: RentBridgeStep = { month: '2026-11', isForecast: true, opening: 1000, escalations: 30, newLeases: 0, expirations: 0, closing: 1030 };
    expect(rentChangeBars([s])).toEqual([{ label: '2026-11', value: 30 }]);
  });
  it('computes KPI deltas as fractions / percentage points, null when the comparison month is absent', () => {
    const k = kpiAt(pts, '2026-09');
    expect(k.rent).toBe(1000);
    expect(k.rentMoM).toBeCloseTo(1000 / 900 - 1, 6);
    expect(k.rentYoY).toBeCloseTo(1000 / 800 - 1, 6);
    expect(k.vacancyMoMPts).toBeCloseTo(3, 6);
    expect(kpiAt([pt('2026-09', 1000, 0.08)], '2026-09').rentMoM).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/portfolio-trends-chart-data.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/modules/portfolio/trends-chart-data.ts
import type { TimePoint } from '@/charts/AreaChart';
import type { BarDatum } from '@/charts/BarChart';
import { addMonths, type MonthKey, type MonthPoint, type RentBridgeStep } from '@analytics/portfolio-trends';

export const rentSeries = (pts: MonthPoint[]): TimePoint[] => pts.map((p) => ({ date: `${p.month}-01`, value: p.inPlaceRent }));
export const vacancySeries = (pts: MonthPoint[]): TimePoint[] => pts.map((p) => ({ date: `${p.month}-01`, value: p.vacancyPct * 100 }));
export const rentChangeBars = (steps: RentBridgeStep[]): BarDatum[] => steps.map((s) => ({ label: s.month, value: s.closing - s.opening }));

export function kpiAt(pts: MonthPoint[], asOfMonth: MonthKey) {
  const find = (m: MonthKey) => pts.find((p) => p.month === m);
  const cur = find(asOfMonth);
  const prev = find(addMonths(asOfMonth, -1));
  const yoy = find(addMonths(asOfMonth, -12));
  const ratio = (a: number | undefined, b: number | undefined) => (a === undefined || b === undefined || b === 0 ? null : a / b - 1);
  return {
    rent: cur?.inPlaceRent ?? 0,
    vacancyPct: cur?.vacancyPct ?? 0,
    vacantSf: cur?.vacantSf ?? 0,
    rentMoM: ratio(cur?.inPlaceRent, prev?.inPlaceRent),
    rentYoY: ratio(cur?.inPlaceRent, yoy?.inPlaceRent),
    vacancyMoMPts: cur && prev ? (cur.vacancyPct - prev.vacancyPct) * 100 : null,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/portfolio-trends-chart-data.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/portfolio/trends-chart-data.ts tests/unit/portfolio-trends-chart-data.test.ts
git commit -m "feat(trends): chart-data mappers and KPI deltas"
```

### Task 4: Trends tab UI + Portfolio destination

**Files:**
- Create: `src/modules/portfolio/TrendsView.tsx`, `src/modules/portfolio/tabs.ts`, `src/modules/portfolio/PortfolioDestination.tsx`
- Modify: `src/shell/modules.tsx` (imports ~17-22; `portfolio` entry ~66)
- Test: `tests/unit/portfolio-trends-view.test.tsx`

**Interfaces:**
- Consumes: Tasks 2-3; `useSnapshot`, `useSnapshotGate`, `Card`/`CardHeader`, `KpiStat` (props: `label,value,format,sublabel,delta,deltaLabel,spark,accentColor`; `delta` is a fraction), `AreaChart`, `BarChart`, `Badge`, `fmtUsdCompact`, `fmtPct`, `fmtSf` from `@analytics/index`.
- Produces: `PORTFOLIO_TABS: readonly ModuleTabDef[]` (`properties`, `trends`); `PortfolioDestination`; `TrendsView`.

- [ ] **Step 1: Write the failing test** — model it on `tests/unit/portfolio-module-other-holdings.test.tsx` (read it first and reuse its snapshot-mocking approach verbatim). Assert: (a) with a snapshot of one property and two leases, `TrendsView` renders the "In-place rent" and "Vacancy" KPI labels and the "Reconstructed from current leases" badge; (b) a property selector lists the property name; (c) selecting it swaps the vacancy series to that property's.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/portfolio-trends-view.test.tsx`
Expected: FAIL — `TrendsView` not found.

- [ ] **Step 3: Implement**

```ts
// src/modules/portfolio/tabs.ts
import type { ModuleTabDef } from '@/shell/tab-types';

export type PortfolioTab = 'properties' | 'trends';

export const PORTFOLIO_TABS: readonly ModuleTabDef[] = [
  { id: 'properties', label: 'Properties' },
  { id: 'trends', label: 'Trends' },
];
```

```tsx
// src/modules/portfolio/PortfolioDestination.tsx
import { lazy, type ComponentType } from 'react';
import { Destination } from '@/shell/Destination';
import type { ModuleTabDef } from '@/shell/tab-types';
import { PORTFOLIO_TABS, type PortfolioTab } from './tabs';

const PANELS: Record<PortfolioTab, ComponentType> = {
  properties: lazy(() => import('./PortfolioModule').then((m) => ({ default: m.PortfolioModule }))),
  trends: lazy(() => import('./TrendsView').then((m) => ({ default: m.TrendsView }))),
};

const TABS: readonly ModuleTabDef[] = PORTFOLIO_TABS.map((t) => ({ ...t, Component: PANELS[t.id as PortfolioTab] }));

export function PortfolioDestination() {
  return <Destination id="portfolio" label="Portfolio" tabs={TABS} />;
}
```

```tsx
// src/modules/portfolio/TrendsView.tsx
import { useMemo, useState } from 'react';
import { useSnapshot } from '@/data/queries';
import { useSnapshotGate } from '@/shell/SnapshotGate';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { Badge } from '@/primitives/Badge';
import { AreaChart } from '@/charts/AreaChart';
import { BarChart } from '@/charts/BarChart';
import { fmtUsdCompact, fmtPct, fmtSf } from '@analytics/index';
import { buildPortfolioTrend } from '@analytics/portfolio-trends';
import { kpiAt, rentSeries, vacancySeries, rentChangeBars } from './trends-chart-data';

const ALL = '__portfolio__';

export function TrendsView() {
  const { data } = useSnapshot();
  const gate = useSnapshotGate();
  const [scope, setScope] = useState<string>(ALL);

  const trend = useMemo(
    () => (data ? buildPortfolioTrend(data.snapshot.leases, data.snapshot.properties, { asOf: data.snapshot.meta.asOf }) : null),
    [data],
  );
  if (gate) return gate;
  if (!data || !trend) return null;

  const points = scope === ALL ? trend.portfolio : (trend.byProperty[scope] ?? trend.portfolio);
  const k = kpiAt(points, trend.asOfMonth);
  const names = data.snapshot.properties.filter((p) => trend.byProperty[p.id]);
  const bridge = scope === ALL ? trend.bridge : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <select aria-label="Scope" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value={ALL}>Entire portfolio</option>
          {names.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <Badge tone="neutral">Reconstructed from current leases</Badge>
        <span className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          History omits leases already off the roll; months after {trend.asOfMonth} are forecast.
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiStat label="In-place rent / mo" value={k.rent} format={fmtUsdCompact} delta={k.rentMoM} deltaLabel="MoM" spark={points.map((p) => p.inPlaceRent)} />
        <KpiStat label="In-place rent YoY" value={k.rentYoY === null ? null : k.rentYoY * 100} format={(n) => (n === null ? '—' : `${n.toFixed(1)}%`)} />
        <KpiStat label="Vacancy" value={k.vacancyPct * 100} format={(n) => (n === null ? '—' : `${n.toFixed(1)}%`)} sublabel={k.vacancyMoMPts === null ? undefined : `${k.vacancyMoMPts >= 0 ? '+' : ''}${k.vacancyMoMPts.toFixed(1)} pts MoM`} spark={points.map((p) => p.vacancyPct)} />
        <KpiStat label="Vacant SF" value={k.vacantSf} format={fmtSf} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Monthly in-place rent" />
          <div className="p-3"><AreaChart data={rentSeries(points)} valueFormat={fmtUsdCompact} /></div>
        </Card>
        <Card>
          <CardHeader title="Vacancy %" />
          <div className="p-3"><AreaChart data={vacancySeries(points)} color="var(--color-neg)" valueFormat={(n) => fmtPct(n / 100)} /></div>
        </Card>
      </div>

      {bridge.length > 0 && (
        <Card>
          <CardHeader title="Month-over-month rent change (escalations + new leases − expirations)" />
          <div className="p-3"><BarChart data={rentChangeBars(bridge)} valueFormat={fmtUsdCompact} ariaLabel="Monthly rent change" /></div>
        </Card>
      )}
    </div>
  );
}
```

In `src/shell/modules.tsx`: add `import { PORTFOLIO_TABS } from '@/modules/portfolio/tabs';`; change the lazy import at line ~32 to load `PortfolioDestination` from `@/modules/portfolio/PortfolioDestination`; change the entry to `{ id: 'portfolio', …, Component: PortfolioDestination, tabs: PORTFOLIO_TABS }`. Check whether `src/brain/routing.ts` or the palette index enumerates module tabs and whether a registry test (e.g. a modules/tabs test under `tests/unit`) needs the new tab — run `npx vitest run -t tabs` to find out.

If a token like `--color-neg` does not exist, use the token the other charts use (grep `src/charts/theme.ts`).

- [ ] **Step 4: Run to verify** — `npx vitest run tests/unit/portfolio-trends-view.test.tsx tests/unit/portfolio-module-other-holdings.test.tsx`, then `npm run typecheck && npm run lint`. Then visually verify: `preview_start`, open Portfolio → Trends, check portfolio and one property, desktop + mobile width, no console errors.
Expected: tests PASS; the Properties tab is unchanged; both charts render; the property selector switches the series.

- [ ] **Step 5: Commit**

```bash
git add src/modules/portfolio/TrendsView.tsx src/modules/portfolio/tabs.ts src/modules/portfolio/PortfolioDestination.tsx src/shell/modules.tsx tests/unit/portfolio-trends-view.test.tsx
git commit -m "feat(trends): Portfolio > Trends tab (rent, vacancy, MoM rent change)"
```

---

# WAVE 2 — True month-end history (Architect claims required)

Detailed plan to be written when Wave 1 ships (the schema depends on what Wave 1 shows is missing). Scope, so it is not lost:

1. **Migration 033** `portfolio_month_snapshot (property_id, month, leased_sf, vacant_sf, in_place_rent, lease_count, source CHECK in ('captured','reconstructed'), UNIQUE(property_id, month))` — next free number is 033 (the doc's "026" is stale; 032 exists). Claim `server/warehouse/migrations/`, `architecture/database-schema.md` in `status.json` first.
2. **Capture hook** beside `captureOccupancy` in `server/index.ts` (~line 155): same guarded, idempotent same-month upsert; freeze at month-end; mirror the roster-drift orphan guard in `recordOccupancyBatch`.
3. **API** `GET /api/warehouse/analytics/trends` (route-prefix duplicate scan in governance applies) + Zod contract in `src/contracts/`; `TrendsView` prefers `captured` rows and falls back to Task 2 reconstruction, labelling the source per point.
4. **Reconcile**: current-month captured rent must tie to `workbookTotals.rent`.

# WAVE 3 — Monthly expenses (Architect claims + data pull)

1. **Data pull (Gabriel/ops, blocks the rest):** re-export each property's P&L by month (one column per month) from QuickBooks / Yardi / AppFolio — 32 files. Confirm each system's monthly format on one file per system first.
2. **Migration 034** `ledger_monthly` (NEW table — never alter `ledger_entries`; YTD and full-year batches coexist by contract) + monthly parser under `server/warehouse/parse/` reusing `mapping.ts` classification so categories match the annual data; record `basis` per batch.
3. **Reconcile script**: monthly sums must equal the annual ledger total at $0 tolerance (wiring it into the gate needs architect + Gabriel approval).
4. **UI**: stacked monthly expense bars by category with prior-year overlay (new `StackedBarChart`), property × month variance heatmap (new `Heatmap`), property small-multiples, "top 5 movers" callouts, then alert rules (vacancy up 2 consecutive months; opex > trailing-12 avg by a configured margin; rent down MoM) via `server/alerts/` — coordinate with the Intelligence Agent; thresholds in config, never governor constants.

---

## Self-review

- **Coverage:** rent by month ✔ (T1-T2, T4), rent increases/decreases ✔ (bridge, T2/T4), vacancy by month ✔, portfolio + per-property ✔ (selector; small-multiples in W3), expenses → W3 (data does not exist yet), graphs ✔. Health alerts → W3.
- **Placeholders:** Task 4 Step 1 describes the test instead of showing code because it must reuse the exact mocking idiom of `portfolio-module-other-holdings.test.tsx`, which must be read first — the executor should write it from that file.
- **Type consistency:** `MonthPoint`, `RentBridgeStep`, `TrendResult`, `MonthKey`, `kpiAt`, `rentSeries`, `vacancySeries`, `rentChangeBars` names are identical across tasks.
- **Known limitation, by design:** history is reconstructed, not recorded, until Wave 2; the UI says so.
