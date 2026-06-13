import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { benchmarkMetric, pmScorecards, quantile, rankProperties } from '../../server/warehouse/benchmarks';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { ingestFile } from '../../server/warehouse/ingest';
import { seedMappings } from '../../server/warehouse/mapping';
import { propertyPeriodMetrics } from '../../server/warehouse/metrics';
import type { PeriodMetrics } from '../../server/warehouse/metrics';
import { seedPropertyMaster } from '../../server/warehouse/property-master';

// Local copy of the ingest-test fixture writer (tests never import across test files).
// rentAmount/repairAmount/propertyLine/periodLine vary the bytes so files never collide
// on content hash and let each property/period carry a distinct financial profile.
async function writeFixture(
  path: string,
  opts: { propertyLine: string; periodLine: string; rent: number; repair: number },
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  const rows: Array<[string | null, string | null, string | null, number | null]> = [
    ['Profit & Loss', null, null, null],
    [opts.propertyLine, null, null, null],
    [opts.periodLine, null, null, null],
    [null, 'INCOME', null, null],
    [null, null, '     5002 RENTAL INCOME', null],
    [null, null, '          5064 Rent', opts.rent],
    [null, 'EXPENSE', null, null],
    [null, null, '     6160 REPAIR', null],
    [null, null, '          6285 HVAC Repair', opts.repair],
  ];
  for (const r of rows) ws.addRow(r);
  await wb.xlsx.writeFile(path);
}

const SEED = [
  { account: 'Rent', code: '5064', normalized_category: 'Rental Revenue', classification: 'revenue' },
  { account: 'HVAC Repair', code: '6285', normalized_category: 'Repairs & Maintenance', classification: 'opex' },
];

// Two KRG properties (Rarig 21000 SF, Westerville 18000 SF) over 2024/2025, plus
// Raytown (Peak REP) so a second PM exists for the scorecard.
async function buildWarehouse(): Promise<{ db: WarehouseDb }> {
  const dir = mkdtempSync(join(tmpdir(), 'whb-'));
  const db = openWarehouse(join(dir, 'f.sqlite'));
  seedPropertyMaster(db);
  seedMappings(db, SEED);
  const raw = join(dir, 'raw');
  let t = 0;
  const ingest = async (file: string, o: Parameters<typeof writeFixture>[1]): Promise<void> => {
    await writeFixture(file, o);
    const r = await ingestFile(db, file, { rawDir: raw, importedAt: `2026-06-12T00:00:${String(t++).padStart(2, '0')}Z` });
    expect(r.status).toBe('committed');
  };
  await ingest(join(dir, 'P&L 2024 -- 1100 Rarig.xlsx'), { propertyLine: 'Property: 1100 Rarig Ave', periodLine: '01/01/24 - 12/31/24  (cash basis)', rent: 100000, repair: 5000 });
  await ingest(join(dir, 'P&L 2025 -- 1100 Rarig.xlsx'), { propertyLine: 'Property: 1100 Rarig Ave', periodLine: '01/01/25 - 12/31/25  (cash basis)', rent: 120000, repair: 5000 });
  await ingest(join(dir, 'P&L 2024 -- 3034 Westerville.xlsx'), { propertyLine: 'Property: 3034 Westerville Rd', periodLine: '01/01/24 - 12/31/24  (cash basis)', rent: 60000, repair: 20000 });
  await ingest(join(dir, 'P&L 2025 -- 3034 Westerville.xlsx'), { propertyLine: 'Property: 3034 Westerville Rd', periodLine: '01/01/25 - 12/31/25  (cash basis)', rent: 60000, repair: 24000 });
  await ingest(join(dir, 'P&L 2025 -- 9620 State 350.xlsx'), { propertyLine: 'Property: 9620 E State Route 350', periodLine: '01/01/25 - 12/31/25  (cash basis)', rent: 80000, repair: 8000 });
  return { db };
}

describe('benchmarks', () => {
  it('quantile (linear interpolation, sorted, null on empty)', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 6);
    expect(quantile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75, 6);
    expect(quantile([1, 2, 3, 4], 0.75)).toBeCloseTo(3.25, 6);
    expect(quantile([4, 2, 1, 3], 0.5)).toBeCloseTo(2.5, 6); // unsorted input
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([42], 0.5)).toBeCloseTo(42, 6); // single element
  });

  it('benchmarkMetric returns avg/median/p25/p75/n for a period', async () => {
    const { db } = await buildWarehouse();
    const metrics = propertyPeriodMetrics(db);
    const b = benchmarkMetric(metrics, '2025', 'noiPerSf');
    expect(b.period).toBe('2025');
    expect(b.metric).toBe('noiPerSf');
    expect(b.n).toBe(3); // Rarig, Westerville, Raytown all have 2025 NOI/SF
    expect(b.median).not.toBeNull();
    expect(b.avg).not.toBeNull();
    expect(b.p25).not.toBeNull();
    expect(b.p75).not.toBeNull();
    // Rarig 2025 NOI/SF = 115000/21000 ≈ 5.476; Westerville = 36000/18000 = 2.0; Raytown = 72000/34560 = 2.083.
    // Median of {2.0, 2.083, 5.476} is the middle value = Raytown's 72000/34560.
    expect(b.median).toBeCloseTo(72000 / 34560, 3);
  });

  it('benchmarkMetric is null-safe when no property reports the metric', async () => {
    const { db } = await buildWarehouse();
    const metrics = propertyPeriodMetrics(db);
    const b = benchmarkMetric(metrics, '1999', 'noiPerSf');
    expect(b.n).toBe(0);
    expect(b.avg).toBeNull();
    expect(b.median).toBeNull();
    expect(b.p25).toBeNull();
    expect(b.p75).toBeNull();
  });

  it('rankProperties sorts desc with quartile (1=top)', async () => {
    const { db } = await buildWarehouse();
    const metrics = propertyPeriodMetrics(db);
    const ranked = rankProperties(metrics, '2025', 'noiPerSf');
    expect(ranked.length).toBe(3);
    // descending by value
    expect(ranked[0]!.value).toBeGreaterThanOrEqual(ranked[1]!.value);
    expect(ranked[1]!.value).toBeGreaterThanOrEqual(ranked[2]!.value);
    // Rarig is the clear top performer on NOI/SF
    expect(ranked[0]!.propertyId).toBe('1100-rarig-ave-columbus-oh');
    expect(ranked[0]!.rank).toBe(1);
    expect(ranked[0]!.quartile).toBe(1);
    expect(ranked[2]!.rank).toBe(3);
  });

  it('rankProperties handles a literal series and ties (stable)', () => {
    const M = (propertyId: string, value: number): PeriodMetrics =>
      ({ propertyId, period: '2025', noiPerSf: value } as unknown as PeriodMetrics);
    const ranked = rankProperties([M('a', 5), M('b', 5), M('c', 1)], '2025', 'noiPerSf');
    expect(ranked.map((r) => r.propertyId)).toEqual(['a', 'b', 'c']);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it('pmScorecards groups by manager with property counts + small-n flag', async () => {
    const { db } = await buildWarehouse();
    const metrics = propertyPeriodMetrics(db);
    const cards = pmScorecards(db, metrics);
    const krg = cards.find((c) => c.propertyManager === 'Kohr Royer Griffith')!;
    expect(krg).toBeDefined();
    // KRG manages Rarig + Westerville among the ingested set (others have no ledger rows)
    expect(krg.propertyCount).toBeGreaterThanOrEqual(2);
    expect(typeof krg.smallSample).toBe('boolean');
    expect(krg.smallSample).toBe(true); // < 3
    expect(krg.avgNoiPerSf).not.toBeNull();
    expect(krg.avgNoiGrowth).not.toBeNull();
    expect(krg.avgExpenseGrowth).not.toBeNull();
    // a second PM (Peak REP) exists with one property
    const peak = cards.find((c) => c.propertyManager === 'Peak Real Estate Partners')!;
    expect(peak).toBeDefined();
    expect(peak.propertyCount).toBe(1);
    expect(peak.smallSample).toBe(true);
  });
});
