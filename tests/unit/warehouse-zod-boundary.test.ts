// tests/unit/warehouse-zod-boundary.test.ts
//
// H6 fidelity tests for the warehouse → client Zod read boundary. Two guarantees:
//   1. SCHEMA FIDELITY — every analytics-engine output validates against its contract schema and
//      ROUND-TRIPS identically: Schema.parse(x) deep-equals x. The schema must mirror the CURRENT
//      engine output exactly (no field added/dropped, nothing loosened). A drift in either direction
//      fails here.
//   2. ROUTE FIDELITY — each /analytics/* route returns 200 with a body that (a) validates against
//      its envelope schema and (b) deep-equals a direct engine call (the server already .parse()s;
//      this re-checks the wire shape end-to-end).
//
// The DB-backed half reuses the proven tmpdir-sqlite pattern (a committed Rarig 2024+2025 pair);
// the fixture writer + SEED are copied locally (tests never import across test files). The pure-
// engine half runs the db-free engines over SYNTHETIC PeriodMetrics[] to exercise null/non-null
// quartiles, mixed basis, and anomaly branches a single seeded property can't reach.
import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { warehouseRoutes } from '../../server/warehouse/api';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { ingestFile } from '../../server/warehouse/ingest';
import { seedMappings } from '../../server/warehouse/mapping';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import { propertyPeriodMetrics } from '../../server/warehouse/metrics';
import type { PeriodMetrics } from '../../server/warehouse/metrics';
import { scoreProperties } from '../../server/warehouse/scores';
import { growthSeries, sinceAcquisition } from '../../server/warehouse/growth';
import { decomposeNoiChange, noiImpactByCategory } from '../../server/warehouse/drivers';
import { detectAnomalies } from '../../server/warehouse/anomalies';
import { benchmarkMetric, rankProperties, pmScorecards } from '../../server/warehouse/benchmarks';
import {
  PeriodMetricsSchema, PropertyScoreSchema, GrowthPointSchema, SinceAcquisitionSchema,
  NoiDriverSchema, NoiDecompositionSchema, AnomalyFlagSchema, MetricBenchmarkSchema,
  PropertyRankSchema, PmScorecardSchema,
  MetricsResponseSchema, GrowthResponseSchema, DriversResponseSchema, AnomaliesResponseSchema,
  BenchmarksResponseSchema, ScoresResponseSchema, PmScorecardsResponseSchema,
} from '@contracts/warehouse';
import { z } from 'zod';

// ── DB fixtures (local copies; same shape as warehouse-api.test.ts) ─────────────────────────────
async function writeFixture(path: string, year: '24' | '25', rent: number, hvac: number): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  const rows: Array<[string | null, string | null, string | null, number | null]> = [
    ['Profit & Loss', null, null, null],
    ['Property: 1100 Rarig Ave', null, null, null],
    [`01/01/${year} - 12/31/${year}  (cash basis)`, null, null, null],
    [null, 'INCOME', null, null],
    [null, null, '     5002 RENTAL INCOME', null],
    [null, null, '          5064 Rent', rent],
    [null, 'EXPENSE', null, null],
    [null, null, '     6160 REPAIR', null],
    [null, null, '          6285 HVAC Repair', hvac],
    [null, 'NON OPERATING EXPENSE', null, null],
    [null, null, '          7402 Distribution to Owner', 25000],
  ];
  for (const r of rows) ws.addRow(r);
  await wb.xlsx.writeFile(path);
}

const SEED = [
  { account: 'Rent', code: '5064', normalized_category: 'Rental Revenue', classification: 'revenue' },
  { account: 'HVAC Repair', code: '6285', normalized_category: 'Repairs & Maintenance', classification: 'opex' },
  { account: 'Distribution to Owner', code: '7402', normalized_category: 'Distributions', classification: 'excluded' },
];

/** Two committed Rarig imports (2024 NOI 86000 → 2025 NOI 95000) so analytics have a real pair. */
async function populatedWarehouse(): Promise<WarehouseDb> {
  const dir = mkdtempSync(join(tmpdir(), 'whzb-'));
  const db = openWarehouse(join(dir, 'f.sqlite'));
  seedPropertyMaster(db);
  seedMappings(db, SEED);
  const f24 = join(dir, 'P&L 2024 -- 1100 Rarig.xlsx');
  await writeFixture(f24, '24', 90000, 4000);
  expect((await ingestFile(db, f24, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' })).status).toBe('committed');
  const f25 = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
  await writeFixture(f25, '25', 100000, 5000);
  expect((await ingestFile(db, f25, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' })).status).toBe('committed');
  return db;
}

// ── Synthetic PeriodMetrics (db-free engine inputs) ─────────────────────────────────────────────
function mkMetrics(over: Partial<PeriodMetrics> & Pick<PeriodMetrics, 'propertyId' | 'period'>): PeriodMetrics {
  const revenue = over.revenue ?? 100000;
  const opex = over.opex ?? 40000;
  const noi = over.noi ?? revenue - opex;
  const sf = over.rentableSf === undefined ? 20000 : over.rentableSf;
  const perSf = (v: number) => (sf && sf > 0 ? v / sf : null);
  return {
    propertyId: over.propertyId,
    propertyName: over.propertyName ?? over.propertyId,
    period: over.period,
    grainHint: over.grainHint ?? 'year',
    basis: over.basis ?? 'cash',
    rentableSf: sf,
    ownershipPct: over.ownershipPct ?? 1,
    revenue, opex, noi,
    noiMargin: over.noiMargin ?? (revenue !== 0 ? noi / revenue : null),
    expenseRatio: over.expenseRatio ?? (revenue !== 0 ? opex / revenue : null),
    capex: over.capex ?? 0,
    ti: over.ti ?? 0,
    leasing: over.leasing ?? 0,
    categories: over.categories ?? { 'Repairs & Maintenance': opex, Taxes: 0, Insurance: 0 },
    revenueCategories: over.revenueCategories ?? { 'Rental Revenue': revenue },
    revenuePerSf: over.revenuePerSf ?? perSf(revenue),
    noiPerSf: over.noiPerSf ?? perSf(noi),
    expensePerSf: over.expensePerSf ?? perSf(opex),
    taxesPerSf: over.taxesPerSf ?? perSf(0),
    insurancePerSf: over.insurancePerSf ?? perSf(0),
    repairsPerSf: over.repairsPerSf ?? perSf(opex),
    oxfordNoi: over.oxfordNoi ?? noi * (over.ownershipPct ?? 1),
  };
}

/** A multi-property, multi-period, mixed-basis, mixed-SF cohort that exercises:
 *  non-null + null quartiles, mixedBasis benchmarks, a NOI decline + expense spike anomaly,
 *  a SF-less (non-operating) entity excluded from cohorts, and a YTD cross-grain pair. */
function syntheticMetrics(): PeriodMetrics[] {
  return [
    // A: healthy, cash, two full years, NOI grows.
    mkMetrics({ propertyId: 'a', period: '2024', revenue: 100000, opex: 40000, basis: 'cash', rentableSf: 20000 }),
    mkMetrics({ propertyId: 'a', period: '2025', revenue: 110000, opex: 42000, basis: 'cash', rentableSf: 20000,
      categories: { 'Repairs & Maintenance': 42000, Taxes: 0, Insurance: 0 } }),
    // B: accrual (mixed basis vs A), NOI declines hard + expense spike → anomalies.
    mkMetrics({ propertyId: 'b', period: '2024', revenue: 80000, opex: 30000, basis: 'accrual', rentableSf: 50000,
      categories: { 'Repairs & Maintenance': 20000, Taxes: 10000, Insurance: 0 } }),
    mkMetrics({ propertyId: 'b', period: '2025', revenue: 60000, opex: 45000, basis: 'accrual', rentableSf: 50000,
      categories: { 'Repairs & Maintenance': 20000, Taxes: 25000, Insurance: 0 } }),
    // C: single full year (null growth), unknown basis.
    mkMetrics({ propertyId: 'c', period: '2025', revenue: 50000, opex: 20000, basis: 'unknown', rentableSf: 15000 }),
    // D: SF-less non-operating entity (solar royalty) — excluded from per-SF + operating cohorts.
    mkMetrics({ propertyId: 'd', period: '2025', revenue: 12000, opex: 1000, basis: 'cash', rentableSf: null }),
    // A YTD partial for property A (cross-grain vs 2025 full-year — growth must null out).
    mkMetrics({ propertyId: 'a', period: '2026', grainHint: 'ytd', revenue: 50000, opex: 20000, basis: 'cash', rentableSf: 20000 }),
  ];
}

/** Assert: schema parses every element AND the parse round-trips identically (deep-equal). */
function expectArrayFidelity<S extends z.ZodTypeAny>(schema: S, items: unknown[]): void {
  const arr = z.array(schema);
  const parsed = arr.parse(items);
  expect(parsed).toEqual(items);
}

describe('H6 schema fidelity — pure engines over synthetic metrics', () => {
  const metrics = syntheticMetrics();

  it('PeriodMetricsSchema mirrors every synthetic PeriodMetrics exactly', () => {
    expectArrayFidelity(PeriodMetricsSchema, metrics);
  });

  it('GrowthPointSchema mirrors growthSeries output (incl. cross-grain null point)', () => {
    const byProp = new Map<string, PeriodMetrics[]>();
    for (const m of metrics) (byProp.get(m.propertyId) ?? byProp.set(m.propertyId, []).get(m.propertyId)!).push(m);
    const growth = [...byProp.values()].flatMap((s) => growthSeries(s));
    expect(growth.length).toBeGreaterThan(0);
    expectArrayFidelity(GrowthPointSchema, growth);
    // The cross-grain (2025 full-year → 2026 YTD) point exists and is non-comparable with null growth.
    const crossGrain = growth.find((g) => g.propertyId === 'a' && g.period === '2026')!;
    expect(crossGrain.comparable).toBe(false);
    expect(crossGrain.noiGrowth).toBeNull();
  });

  it('SinceAcquisitionSchema mirrors sinceAcquisition output', () => {
    const byProp = new Map<string, PeriodMetrics[]>();
    for (const m of metrics) (byProp.get(m.propertyId) ?? byProp.set(m.propertyId, []).get(m.propertyId)!).push(m);
    const since = [...byProp.values()].map((s) => sinceAcquisition(s));
    expectArrayFidelity(SinceAcquisitionSchema, since);
  });

  it('NoiDecomposition + NoiDriver schemas mirror decomposeNoiChange output', () => {
    const a = metrics.find((m) => m.propertyId === 'b' && m.period === '2024')!;
    const b = metrics.find((m) => m.propertyId === 'b' && m.period === '2025')!;
    const decomp = decomposeNoiChange(noiImpactByCategory(a), noiImpactByCategory(b));
    expect(NoiDecompositionSchema.parse(decomp)).toEqual(decomp);
    expectArrayFidelity(NoiDriverSchema, decomp.drivers);
  });

  it('AnomalyFlagSchema mirrors detectAnomalies output (NOI decline + tax spike fire)', () => {
    const flags = detectAnomalies(metrics);
    expect(flags.length).toBeGreaterThan(0);
    expectArrayFidelity(AnomalyFlagSchema, flags);
    expect(flags.some((f) => f.propertyId === 'b' && f.kind === 'noi-decline')).toBe(true);
  });

  it('MetricBenchmark + PropertyRank schemas mirror benchmark output (non-null quartiles + mixedBasis)', () => {
    const bench = benchmarkMetric(metrics, '2025', 'noiPerSf');
    expect(MetricBenchmarkSchema.parse(bench)).toEqual(bench);
    expect(bench.mixedBasis).toBe(true); // cash + accrual + unknown contribute to the 2025 cohort
    const ranks = rankProperties(metrics, '2025', 'noiPerSf');
    expectArrayFidelity(PropertyRankSchema, ranks);
    expect(ranks.some((r) => r.quartile !== null)).toBe(true); // multi-member cohort → real quartiles
  });
});

describe('H6 route fidelity — /analytics/* envelopes parse and match the engine', () => {
  it('every analytics route returns 200 and a body that validates + deep-equals the engine call', async () => {
    const db = await populatedWarehouse();
    const app = warehouseRoutes(() => db);
    const metrics = propertyPeriodMetrics(db);

    // metrics
    const mRes = await app.request('/analytics/metrics');
    expect(mRes.status).toBe(200);
    const mBody = await mRes.json();
    expect(MetricsResponseSchema.parse(mBody)).toEqual(mBody);
    expect((mBody as z.infer<typeof MetricsResponseSchema>).metrics).toEqual(metrics);

    // scores (db-backed engine)
    const sRes = await app.request('/analytics/scores');
    expect(sRes.status).toBe(200);
    const sBody = await sRes.json();
    expect(ScoresResponseSchema.parse(sBody)).toEqual(sBody);
    expect((sBody as z.infer<typeof ScoresResponseSchema>).scores).toEqual(scoreProperties(db, metrics));
    expectArrayFidelity(PropertyScoreSchema, (sBody as z.infer<typeof ScoresResponseSchema>).scores);

    // growth
    const gRes = await app.request('/analytics/growth');
    expect(gRes.status).toBe(200);
    const gBody = await gRes.json();
    expect(GrowthResponseSchema.parse(gBody)).toEqual(gBody);

    // drivers
    const dRes = await app.request('/analytics/drivers/1100-rarig-ave-columbus-oh');
    expect(dRes.status).toBe(200);
    const dBody = await dRes.json();
    expect(DriversResponseSchema.parse(dBody)).toEqual(dBody);

    // anomalies
    const aRes = await app.request('/analytics/anomalies');
    expect(aRes.status).toBe(200);
    const aBody = await aRes.json();
    expect(AnomaliesResponseSchema.parse(aBody)).toEqual(aBody);

    // benchmarks
    const bRes = await app.request('/analytics/benchmarks');
    expect(bRes.status).toBe(200);
    const bBody = await bRes.json();
    expect(BenchmarksResponseSchema.parse(bBody)).toEqual(bBody);

    // pm scorecards
    const pRes = await app.request('/analytics/pm');
    expect(pRes.status).toBe(200);
    const pBody = await pRes.json();
    expect(PmScorecardsResponseSchema.parse(pBody)).toEqual(pBody);
    const cards = (pBody as z.infer<typeof PmScorecardsResponseSchema>).scorecards;
    expect(cards).toEqual(pmScorecards(db, metrics));
    expectArrayFidelity(PmScorecardSchema, cards);
  });
});
