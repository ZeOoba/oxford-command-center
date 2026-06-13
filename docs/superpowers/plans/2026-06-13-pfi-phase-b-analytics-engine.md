# PFI Phase B — Analytics & Intelligence Engine + API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A deterministic analytics & intelligence layer over the Phase A warehouse — per-property-period metrics, growth/CAGR/since-acquisition, ΔNOI driver decomposition, anomaly detection, health/attention scores, capital-allocation recommendations, benchmarking, and PM scorecards — exposed via `/api/warehouse/analytics/*`. Pure functions, single threshold/weight config, no LLM. UI consumption is Phase B.2 (separate plan).

**Architecture:** New pure-function modules in `server/warehouse/` reading ACTIVE ledger rows + `property_master`. One config (`intel-config.ts` → `INTEL_CONFIG`) holds every threshold/weight/band cutoff — the single source of truth, mirroring `src/analytics/conditions.ts`'s `ALERT_THRESHOLDS`. Scores depend on benchmarks (portfolio context), so the dependency order is metrics → growth → drivers/anomalies → benchmarks → scores. API endpoints added to the existing `server/warehouse/api.ts`.

**Tech Stack:** existing only — better-sqlite3, Zod, Hono 4, vitest. No new deps.

**Conventions:** strict TS (`noUncheckedIndexedAccess`, `verbatimModuleSyntax` → `import type`), ESLint `--max-warnings 0`. Tests in `tests/unit/`, fixture warehouses via `mkdtempSync` + seed + ingest (mirror `tests/unit/warehouse-actions.test.ts`'s `writeFixture`/SEED — copy locally, never import across test files). Gate: `npm run gate`. Commit per task with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

**Canon (do not re-decide):** NOI = revenue + recovery + other-income − opex (active rows only). Ledger opex amounts are positive-cost magnitudes (sign-normalized at ingest). `$/SF` uses `property_master.rentable_sf` (null/0 → null metric, never divide-by-zero). 100%-basis figures are primary; ownership overlay is `ownershipPct` × dollar totals (Red Branch/Broadway 0.5, 1851 Solar 0.25) — `$/SF` efficiency metrics stay 100%-basis. Anomaly thresholds (expense growth >15%, revenue/NOI/NOI-PSF decline >5%) are ratified from the original spec. **Health/attention weights in INTEL_CONFIG are PROPOSED DEFAULTS for Gabriel's calibration — document them as tunable; they are not governors.**

---

### Task 1: Intel config (`server/warehouse/intel-config.ts`)

**Files:** Create `server/warehouse/intel-config.ts` · Test `tests/unit/intel-config.test.ts`

- [ ] **Step 1 — failing test:**

```typescript
import { INTEL_CONFIG, type AnomalySeverity } from '../../server/warehouse/intel-config';
import { describe, expect, it } from 'vitest';
describe('intel-config', () => {
  it('exposes ratified anomaly thresholds', () => {
    expect(INTEL_CONFIG.anomaly.expenseGrowthPct).toBe(0.15);
    expect(INTEL_CONFIG.anomaly.revenueDeclinePct).toBe(0.05);
    expect(INTEL_CONFIG.anomaly.noiDeclinePct).toBe(0.05);
    expect(INTEL_CONFIG.anomaly.noiPerSfDeclinePct).toBe(0.05);
  });
  it('health weights sum to 1.0', () => {
    const sum = Object.values(INTEL_CONFIG.healthWeights).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 6);
  });
  it('health bands are ordered', () => {
    const b = INTEL_CONFIG.healthBands;
    expect(b.excellent).toBeGreaterThan(b.good);
    expect(b.good).toBeGreaterThan(b.watch);
  });
});
```

- [ ] **Step 2 — fail; Step 3 — implement.**

```typescript
// server/warehouse/intel-config.ts
// SINGLE SOURCE OF TRUTH for analytics thresholds, score weights, and band cutoffs.
// Mirrors src/analytics/conditions.ts ALERT_THRESHOLDS. Anomaly thresholds are ratified
// (original PFI spec). Health/attention WEIGHTS are proposed defaults pending Gabriel's
// calibration — tunable here without touching engine code.
export type AnomalySeverity = 'low' | 'moderate' | 'high' | 'critical';
export type HealthBand = 'excellent' | 'good' | 'watch' | 'concern';
export type AttentionBand = 'green' | 'yellow' | 'orange' | 'red';
export type CapitalAction = 'invest' | 'hold' | 'monitor' | 'disposition-candidate';

export const INTEL_CONFIG = {
  anomaly: {
    expenseGrowthPct: 0.15,      // ratified
    revenueDeclinePct: 0.05,     // ratified
    noiDeclinePct: 0.05,         // ratified
    noiPerSfDeclinePct: 0.05,    // ratified
    categorySpikePct: 0.25,      // tax/insurance/repair/utility spike (proposed)
    // severity scales by how far PAST the threshold the move is (multiple of threshold):
    severityMultiples: { moderate: 1.5, high: 2.5, critical: 4 } as const,
  },
  // Health sub-scores are each 0..100; weights sum to 1.0 (PROPOSED — calibrate with Gabriel).
  healthWeights: {
    revenueGrowth: 0.12,
    revenuePerSfGrowth: 0.10,
    noiGrowth: 0.18,
    noiPerSfGrowth: 0.15,
    expenseEfficiency: 0.10,   // vs portfolio median expense ratio
    taxEfficiency: 0.06,
    insuranceEfficiency: 0.06,
    repairEfficiency: 0.06,
    marginStability: 0.07,
    benchmarkPosition: 0.10,   // NOI/SF quartile rank
  },
  healthBands: { excellent: 80, good: 65, watch: 50 } as const, // <watch ⇒ concern
  // Growth that maps a factor to its 0..100 sub-score: linear clamp on [-cap, +cap].
  growthScoreCapPct: 0.20,    // ±20% growth ⇒ 0..100
} as const;
```

- [ ] **Step 4 — green; Step 5 — commit** `feat(intel): INTEL_CONFIG single-source thresholds/weights/bands`.

---

### Task 2: Period metrics (`server/warehouse/metrics.ts`)

**Files:** Create `server/warehouse/metrics.ts` · Test `tests/unit/warehouse-metrics.test.ts`

`propertyPeriodMetrics(db)` returns one row per (property, period) over ACTIVE ledger rows, joined to `property_master` for SF + ownership. Category subtotals come from `normalized_category` within `opex`.

- [ ] **Step 1 — failing test** (build a temp warehouse, ingest the QB fixture for 1100 Rarig 2025 with the full SEED so Rent→revenue 100000, HVAC Repair→opex 5000 [Repairs & Maintenance], Distribution→excluded; property_master.rentable_sf for Rarig = 21000):

```typescript
import { propertyPeriodMetrics } from '../../server/warehouse/metrics';
// after ingest:
const m = propertyPeriodMetrics(db);
const rarig = m.find((x) => x.propertyId === '1100-rarig-ave-columbus-oh' && x.period === '2025')!;
expect(rarig.revenue).toBe(100000);
expect(rarig.opex).toBe(5000);
expect(rarig.noi).toBe(95000);
expect(rarig.noiMargin).toBeCloseTo(0.95, 6);
expect(rarig.expenseRatio).toBeCloseTo(0.05, 6);
expect(rarig.categories['Repairs & Maintenance']).toBe(5000);
expect(rarig.noiPerSf).toBeCloseTo(95000 / 21000, 6);
expect(rarig.revenuePerSf).toBeCloseTo(100000 / 21000, 6);
expect(rarig.ownershipPct).toBe(1);
expect(rarig.oxfordNoi).toBe(95000); // 100% owned
// distribution excluded from everything
expect(rarig.capex).toBe(0);
```

Add a second assertion using a 50%-owned property fixture (write a fixture for `9050 Red Branch`: Property line `Property: 9050 Red Branch Rd`) → `ownershipPct` 0.5, `oxfordNoi` = noi × 0.5, but `noiPerSf` is 100%-basis (unchanged by ownership).

- [ ] **Step 3 — implement.**

```typescript
// server/warehouse/metrics.ts
import type { WarehouseDb } from './db';

export interface PeriodMetrics {
  propertyId: string;
  propertyName: string | null;
  period: string;            // 'YYYY'
  grainHint: string | null;  // from the import (year|ytd) — for comparability
  rentableSf: number | null;
  ownershipPct: number;
  revenue: number;           // revenue + recovery + other-income (gross income, 100%-basis)
  opex: number;              // operating expenses (positive magnitude)
  noi: number;
  noiMargin: number | null;  // noi / revenue
  expenseRatio: number | null; // opex / revenue
  capex: number; ti: number; leasing: number; // tracked, NOT in NOI
  categories: Record<string, number>; // opex by normalized_category
  // $/SF (100%-basis; null when rentableSf missing/0)
  revenuePerSf: number | null; noiPerSf: number | null; expensePerSf: number | null;
  taxesPerSf: number | null; insurancePerSf: number | null; repairsPerSf: number | null;
  // ownership overlay
  oxfordNoi: number;         // noi × ownershipPct
}

interface Row { propertyId: string; propertyName: string | null; period: string;
  classification: string; normalizedCategory: string; amount: number;
  rentableSf: number | null; ownershipPct: number; grainHint: string | null; }

export function propertyPeriodMetrics(db: WarehouseDb): PeriodMetrics[] {
  const rows = db.prepare(`
    SELECT l.property_id AS propertyId, p.name AS propertyName, l.period,
           l.classification, l.normalized_category AS normalizedCategory, l.amount,
           p.rentable_sf AS rentableSf, COALESCE(p.ownership_pct, 1) AS ownershipPct,
           (SELECT b.period_grain FROM import_batches b WHERE b.id = l.import_id) AS grainHint
    FROM ledger_entries l LEFT JOIN property_master p ON p.id = l.property_id
    WHERE l.is_active = 1
    ORDER BY l.property_id, l.period
  `).all() as Row[];

  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.propertyId}|${r.period}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const perSf = (v: number, sf: number | null) => (sf && sf > 0 ? v / sf : null);
  const out: PeriodMetrics[] = [];
  for (const g of groups.values()) {
    const head = g[0]!;
    let revenue = 0, opex = 0, capex = 0, ti = 0, leasing = 0;
    const categories: Record<string, number> = {};
    for (const r of g) {
      switch (r.classification) {
        case 'revenue': case 'recovery': case 'other-income': revenue += r.amount; break;
        case 'opex': opex += r.amount; categories[r.normalizedCategory] = (categories[r.normalizedCategory] ?? 0) + r.amount; break;
        case 'capex': capex += r.amount; break;
        case 'ti': ti += r.amount; break;
        case 'leasing': leasing += r.amount; break;
        default: break; // excluded / debt-service
      }
    }
    const noi = revenue - opex;
    const sf = head.rentableSf;
    out.push({
      propertyId: head.propertyId, propertyName: head.propertyName, period: head.period,
      grainHint: head.grainHint, rentableSf: sf, ownershipPct: head.ownershipPct,
      revenue, opex, noi,
      noiMargin: revenue !== 0 ? noi / revenue : null,
      expenseRatio: revenue !== 0 ? opex / revenue : null,
      capex, ti, leasing, categories,
      revenuePerSf: perSf(revenue, sf), noiPerSf: perSf(noi, sf), expensePerSf: perSf(opex, sf),
      taxesPerSf: perSf(categories['Taxes'] ?? 0, sf),
      insurancePerSf: perSf(categories['Insurance'] ?? 0, sf),
      repairsPerSf: perSf(categories['Repairs & Maintenance'] ?? 0, sf),
      oxfordNoi: noi * head.ownershipPct,
    });
  }
  return out.sort((a, b) => a.propertyId.localeCompare(b.propertyId) || a.period.localeCompare(b.period));
}
```

- [ ] **Step 4 green; Step 5 commit** `feat(intel): per-property-period metrics (NOI, margin, $/SF, category subtotals, ownership overlay)`.

---

### Task 3: Growth, CAGR, since-acquisition (`server/warehouse/growth.ts`)

**Files:** Create `server/warehouse/growth.ts` · Test `tests/unit/warehouse-growth.test.ts`

Operates on `PeriodMetrics[]` (pass them in — pure, db-free). Compares only same-property periods, ascending. Growth is null when the prior base is ≤ 0 (can't take a % off zero/negative) — flag, never fabricate.

- [ ] **Step 1 — failing test** (construct PeriodMetrics literals — no db needed):

```typescript
import { growthSeries, cagr, sinceAcquisition } from '../../server/warehouse/growth';
const M = (period: string, revenue: number, noi: number, noiPerSf: number | null) =>
  ({ propertyId: 'p', period, revenue, noi, noiPerSf } as any);
const series = [M('2024', 100, 50, 5), M('2025', 110, 60, 6), M('2026', 99, 54, 5.4)];
it('period-over-period growth', () => {
  const g = growthSeries(series);
  expect(g[1]!.revenueGrowth).toBeCloseTo(0.10, 6);
  expect(g[1]!.noiGrowth).toBeCloseTo(0.20, 6);
  expect(g[2]!.revenueGrowth).toBeCloseTo(-0.10, 6);   // 110→99
  expect(g[0]!.revenueGrowth).toBeNull();              // no prior
});
it('cagr over the span (annual)', () => {
  expect(cagr(100, 121, 2)).toBeCloseTo(0.10, 6);       // 100→121 over 2 yrs = 10%
  expect(cagr(0, 121, 2)).toBeNull();                    // undefined off zero
  expect(cagr(100, -50, 2)).toBeNull();                  // sign flip
});
it('since-acquisition anchors on earliest available period', () => {
  const sa = sinceAcquisition(series);
  expect(sa.anchorPeriod).toBe('2024');
  expect(sa.latestPeriod).toBe('2026');
  expect(sa.noiGrowth).toBeCloseTo((54 - 50) / 50, 6);
  expect(sa.noiPerSfGrowth).toBeCloseTo((5.4 - 5) / 5, 6);
});
```

- [ ] **Step 3 — implement.** `pctChange(prev, cur)`: `prev > 0 ? (cur - prev)/prev : null`. `growthSeries(metrics)`: sort by period asc, for each emit `{propertyId, period, revenueGrowth, expenseGrowth, noiGrowth, noiPerSfGrowth}` vs the immediately prior period (null on the first). `cagr(first, last, years)`: `first > 0 && last > 0 && years > 0 ? (last/first)**(1/years) - 1 : null`. `sinceAcquisition(metrics)`: anchor = earliest period present (data begins at ownership per canon), latest = max period; return `{anchorPeriod, latestPeriod, revenueGrowth, noiGrowth, noiPerSfGrowth, taxesGrowth, insuranceGrowth, revenuePerSfGrowth}` using `pctChange(anchor, latest)`; plus `noiCagr = cagr(anchorNoi, latestNoi, yearsBetween)` where years = (latestYear − anchorYear). All null-safe.

- [ ] **Step 5 commit** `feat(intel): growth series, CAGR, since-acquisition (null-safe off zero/negative)`.

---

### Task 4: Driver decomposition (`server/warehouse/drivers.ts`)

**Files:** Create `server/warehouse/drivers.ts` · Test `tests/unit/warehouse-drivers.test.ts`

ΔNOI between two periods decomposed by normalized category. Each category's NOI impact: revenue-side `+amount`, opex `−amount`, else 0. The deltas sum EXACTLY to ΔNOI (assert it). Contribution% = delta / ΔNOI (null when ΔNOI≈0). Ranked by |delta| desc.

- [ ] **Step 1 — failing test** (two PeriodMetrics-like inputs with `categories` + revenue/opex breakdown — pass the raw per-category NOI-impact maps). Design the input as `{period, impactByCategory: Record<string, number>}` where impact is already NOI-signed, computed by a helper `noiImpactByCategory(metrics)` you also export and test:

```typescript
import { noiImpactByCategory, decomposeNoiChange } from '../../server/warehouse/drivers';
// noiImpactByCategory: revenue cats positive, opex cats negative
const A = { 'Rental Revenue': 100000, 'Insurance': -10000, 'Taxes': -20000 };
const B = { 'Rental Revenue': 105000, 'Insurance': -12200, 'Taxes': -20000 };
it('decomposes ΔNOI and contributions sum to 100%', () => {
  const d = decomposeNoiChange(A, B);
  expect(d.totalDelta).toBeCloseTo(2800, 6);            // (105000-12200-20000) - (100000-10000-20000) = 72800-70000
  const ins = d.drivers.find((x) => x.category === 'Insurance')!;
  expect(ins.delta).toBeCloseTo(-2200, 6);
  expect(ins.contributionPct).toBeCloseTo(-2200 / 2800, 6);
  const rev = d.drivers.find((x) => x.category === 'Rental Revenue')!;
  expect(rev.delta).toBeCloseTo(5000, 6);
  expect(d.drivers.reduce((s, x) => s + x.delta, 0)).toBeCloseTo(d.totalDelta, 6);
  expect(d.drivers[0]!.category).toBe('Rental Revenue'); // ranked by |delta|
});
it('null contributions when ΔNOI≈0', () => {
  const d = decomposeNoiChange({ A: 100 }, { A: 100 });
  expect(d.totalDelta).toBeCloseTo(0, 6);
  expect(d.drivers.every((x) => x.contributionPct === null)).toBe(true);
});
```

- [ ] **Step 3 — implement** `noiImpactByCategory(metrics: PeriodMetrics)` (build the signed map from revenue total under a synthetic 'Revenue' bucket — actually decompose revenue into its categories too if available; for this engine, revenue is aggregated, so emit `{'<revenue categories...>': +, '<opex categories>': -}` — to get per-category revenue you need category subtotals on the revenue side; EXTEND metrics.ts in Task 2 to also expose `revenueCategories: Record<string, number>` if not already — if you find revenue isn't broken out, add it). `decomposeNoiChange(a, b)`: union of keys, `delta = (b[k]??0) - (a[k]??0)`, `totalDelta = Σ delta`, `contributionPct = |totalDelta|>0.005 ? delta/totalDelta : null`, sort by |delta| desc.

NOTE for the implementer: Task 2's `PeriodMetrics` aggregates revenue into one number. For driver decomposition to attribute revenue moves, add `revenueCategories: Record<string, number>` to `PeriodMetrics` in metrics.ts (revenue/recovery/other-income by normalized_category) and a helper `noiImpactByCategory` that merges `revenueCategories` (positive) with `categories` (negative). Update Task 2's test if you extend its type. Keep capex/ti/leasing/excluded OUT of NOI impact.

- [ ] **Step 5 commit** `feat(intel): ΔNOI driver decomposition (category contributions, exact-sum invariant)`.

---

### Task 5: Anomaly engine (`server/warehouse/anomalies.ts`)

**Files:** Create `server/warehouse/anomalies.ts` · Test `tests/unit/warehouse-anomalies.test.ts`

Per property, between consecutive periods, flag the ratified conditions using `INTEL_CONFIG`. Severity by `severityMultiples`.

- [ ] **Step 1 — failing test** (feed PeriodMetrics + growth):

```typescript
import { detectAnomalies } from '../../server/warehouse/anomalies';
// fixture: a property whose expenses jump 30% and NOI drops 8% from 2024→2025
it('flags expense spike + NOI decline with severity', () => {
  const flags = detectAnomalies(metrics); // metrics: PeriodMetrics[]
  const exp = flags.find((f) => f.kind === 'expense-growth' && f.period === '2025')!;
  expect(exp.severity).toBe('moderate'); // 30% is 2× the 15% threshold → moderate(≥1.5×)
  expect(flags.some((f) => f.kind === 'noi-decline' && f.period === '2025')).toBe(true);
});
it('flags a new expense category appearing', () => { /* category in B not in A */ });
```

- [ ] **Step 3 — implement** `detectAnomalies(metrics)`: group by property, walk consecutive periods, compute growth via Task 3 helpers, emit `{propertyId, period, kind, severity, detail, metricValue}` for: `expense-growth` (>expenseGrowthPct), `revenue-decline`, `noi-decline`, `noi-per-sf-decline`, `new-category` (opex category in B absent in A), `category-spike` (per Taxes/Insurance/Repairs & Maintenance/Utilities >categorySpikePct). Severity: `m = move/threshold`; ≥critical mult → critical, ≥high → high, ≥moderate → moderate, else low.

- [ ] **Step 5 commit** `feat(intel): anomaly detection (ratified thresholds, severity scaling)`.

---

### Task 6: Benchmarks + PM scorecards (`server/warehouse/benchmarks.ts`)

**Files:** Create `server/warehouse/benchmarks.ts` · Test `tests/unit/warehouse-benchmarks.test.ts`

- [ ] **Step 1 — failing test:**

```typescript
import { quantile, benchmarkMetric, rankProperties, pmScorecards } from '../../server/warehouse/benchmarks';
it('quantile (linear interpolation, sorted)', () => {
  expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 6);
  expect(quantile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75, 6);
  expect(quantile([], 0.5)).toBeNull();
});
it('benchmarkMetric returns avg/median/p25/p75 for a period', () => {
  const b = benchmarkMetric(metrics, '2025', 'noiPerSf');
  expect(b.median).not.toBeNull();
});
it('rankProperties sorts desc with ties stable', () => { /* rank by noiPerSf */ });
it('pmScorecards groups by manager with property counts + small-n flag', () => {
  const cards = pmScorecards(db, metrics);
  const krg = cards.find((c) => c.propertyManager === 'Kohr Royer Griffith')!;
  expect(krg.propertyCount).toBeGreaterThanOrEqual(1);
  expect(typeof krg.smallSample).toBe('boolean');
});
```

- [ ] **Step 3 — implement.** `quantile(sorted-or-unsorted number[], q)`: copy+sort, linear interpolation, null on empty. `benchmarkMetric(metrics, period, key)`: collect non-null metric values for that period, return `{period, metric, avg, median, p25, p75, n}`. `rankProperties(metrics, period, key)`: `[{propertyId, value, rank, quartile}]` desc (quartile 1=top). `pmScorecards(db, metrics)`: read `property_master.property_manager`, group properties, aggregate latest-period avg NOI/SF, avg NOI growth, avg expense growth across the PM's properties; `propertyCount`, `smallSample = propertyCount < 3` (small-n caveat). Null-safe throughout.

- [ ] **Step 5 commit** `feat(intel): benchmarking (quantiles, rankings) + PM scorecards (small-n flagged)`.

---

### Task 7: Scores + capital allocation (`server/warehouse/scores.ts`)

**Files:** Create `server/warehouse/scores.ts` · Test `tests/unit/warehouse-scores.test.ts`

Consumes metrics + growth + benchmarks + anomalies. Produces per-property (latest period): health 0-100 + band, attention band, capital action + reasons.

- [ ] **Step 1 — failing test** (assert determinism + bands + monotonic sanity: a top-quartile, high-growth, low-anomaly property scores Excellent & Invest; a bottom-quartile, declining, high-anomaly property scores Concern & Disposition-candidate):

```typescript
import { scoreProperties } from '../../server/warehouse/scores';
it('scores deterministically and bands correctly', () => {
  const s = scoreProperties(db, metrics); // computes growth/benchmarks/anomalies internally
  const strong = s.find((x) => x.propertyId === 'strong')!;
  expect(strong.health).toBeGreaterThanOrEqual(80);
  expect(strong.healthBand).toBe('excellent');
  expect(strong.attentionBand).toBe('green');
  expect(strong.capitalAction).toBe('invest');
  expect(strong.reasons.length).toBeGreaterThan(0);
  const weak = s.find((x) => x.propertyId === 'weak')!;
  expect(weak.healthBand).toBe('concern');
  expect(['orange', 'red']).toContain(weak.attentionBand);
  expect(weak.capitalAction).toBe('disposition-candidate');
  // determinism
  expect(scoreProperties(db, metrics)).toEqual(s);
});
```

Build the fixture with two synthetic properties (seed property_master + ingest two-period files) so 'strong' and 'weak' have clear profiles.

- [ ] **Step 3 — implement.** Sub-score helper `growthScore(pct)`: linear clamp `((pct + cap)/(2*cap))*100` over `±growthScoreCapPct`, null→50 (neutral). Efficiency sub-scores: percentile rank vs portfolio (lower expense ratio ⇒ higher score) → `100*(1 - percentileRank)`. `marginStability`: `100 - clamp(stddev(noiMargin over periods)*scale)`. `benchmarkPosition`: NOI/SF quartile → {1:100,2:75,3:50,4:25}. Health = Σ weight×subScore (INTEL_CONFIG.healthWeights). Band from healthBands. **Attention** rule cascade (first match): red if noiGrowth ≤ −0.10 OR ≥1 critical anomaly OR ≥2 high; orange if noiGrowth ≤ −0.05 OR ≥1 high anomaly OR health<watch; yellow if noiGrowth<0 OR ≥1 moderate anomaly OR health<good; else green. **Capital**: invest if healthBand∈{excellent,good} AND noiPerSf quartile≤2 AND attention∈{green,yellow}; disposition-candidate if healthBand==concern AND quartile==4 AND attention∈{orange,red}; monitor if attention∈{orange,red} OR healthBand∈{watch,concern}; else hold. Each with human reason strings. Document the weights/rules reference INTEL_CONFIG.

- [ ] **Step 5 commit** `feat(intel): health + attention scores, capital-allocation recommendations`.

---

### Task 8: Analytics API endpoints (extend `server/warehouse/api.ts`)

**Files:** Modify `server/warehouse/api.ts` · Test extend `tests/unit/warehouse-api.test.ts`

Add GET routes (read-only, behind the same 503 guard): `/analytics/metrics` → `{metrics}`, `/analytics/growth` → `{growth, sinceAcquisition: per-property}`, `/analytics/drivers/:propertyId?from=YYYY&to=YYYY` → decomposition (404 if property absent), `/analytics/anomalies` → `{anomalies}`, `/analytics/benchmarks?period=YYYY` → `{rankings, byMetric}`, `/analytics/scores` → `{scores}`, `/analytics/pm` → `{scorecards}`. Each calls the pure functions on the injected db. Mirror the existing route style + Zod query parsing. Add ~7 `app.request()` tests asserting 200 + shape on a populated fixture and the `/drivers/:unknown` 404.

- [ ] **Step 5 commit** `feat(warehouse): /api/warehouse/analytics/* endpoints (metrics, growth, drivers, anomalies, benchmarks, scores, pm)`.

---

### Task 9: Gate + changelog

- [ ] `npm run gate` green (incl. reconcile + warehouse:verify). Live sanity: `npm run warehouse:backfill` then a throwaway `tsx` snippet that prints `scoreProperties` + `pmScorecards` for the real 14 units — eyeball that NOI/SF, health bands, and PM groupings are plausible (report the table; do NOT commit the snippet).
- [ ] CHANGELOG entry "PFI Phase B — Analytics & Intelligence Engine". Commit `docs: changelog for PFI Phase B analytics engine`.

## Out of scope (Phase B.2 — separate plan)
Per-property intelligence UI pages, ownership intelligence center, charts (trend/waterfall/ranking), executive AI briefings, PDF exports, market benchmarking, lease-run pro formas.

## Self-review
- Determinism: every function pure given (db snapshot | metrics); scores test asserts `toEqual` on re-run.
- NOI integrity: metrics reuse the canon formula; drivers assert exact-sum to ΔNOI; nothing mixes capex/ti/leasing/excluded into NOI.
- Null-safety: $/SF, growth, CAGR, quantile, margins all guard zero/empty/negative — no NaN/Infinity into scores.
- Config: all thresholds/weights in INTEL_CONFIG; weights flagged as proposed/tunable, not governors.
- Phase A pipeline (ingest/parser/verify/queries/actions) is read-only consumed, never modified — except metrics-driven additive `revenueCategories` is NEW (Task 2/4), touching only metrics.ts.
