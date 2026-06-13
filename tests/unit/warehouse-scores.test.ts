import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { ingestFile } from '../../server/warehouse/ingest';
import { seedMappings } from '../../server/warehouse/mapping';
import { propertyPeriodMetrics } from '../../server/warehouse/metrics';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import { scoreProperties } from '../../server/warehouse/scores';

// Local fixture writer (tests never import across test files). Amounts/property/period
// lines vary the bytes so files never collide on content hash and each property/period
// carries a distinct financial profile.
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

const STRONG = '1100-rarig-ave-columbus-oh';   // 21000 SF — strong profile
const WEAK = '3034-westerville-rd-columbus-oh'; // 18000 SF — weak profile

// Two synthetic profiles over 2024→2025:
//  STRONG: revenue +30%, NOI +~32%, low expense ratio, top NOI/SF — excellent/green/invest.
//  WEAK:   revenue −25%, NOI −57%, expenses +200%, bottom NOI/SF — concern/red/disposition.
async function buildWarehouse(): Promise<{ db: WarehouseDb; metrics: ReturnType<typeof propertyPeriodMetrics> }> {
  const dir = mkdtempSync(join(tmpdir(), 'whs-'));
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
  await ingest(join(dir, 'P&L 2025 -- 1100 Rarig.xlsx'), { propertyLine: 'Property: 1100 Rarig Ave', periodLine: '01/01/25 - 12/31/25  (cash basis)', rent: 130000, repair: 5000 });
  await ingest(join(dir, 'P&L 2024 -- 3034 Westerville.xlsx'), { propertyLine: 'Property: 3034 Westerville Rd', periodLine: '01/01/24 - 12/31/24  (cash basis)', rent: 80000, repair: 10000 });
  await ingest(join(dir, 'P&L 2025 -- 3034 Westerville.xlsx'), { propertyLine: 'Property: 3034 Westerville Rd', periodLine: '01/01/25 - 12/31/25  (cash basis)', rent: 60000, repair: 30000 });
  const metrics = propertyPeriodMetrics(db);
  return { db, metrics };
}

// Same two properties PLUS a trailing 2026 YTD (≈half-year) pull for each. The YTD level is
// genuinely ~half the full-year figure; grain-awareness must keep growth/attention anchored on
// the real 2024→2025 (year-vs-year) transition, so the YTD does NOT flip STRONG to concern.
async function buildWarehouseWithYtd(): Promise<{ db: WarehouseDb; metrics: ReturnType<typeof propertyPeriodMetrics> }> {
  const dir = mkdtempSync(join(tmpdir(), 'whs-'));
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
  await ingest(join(dir, 'P&L 2025 -- 1100 Rarig.xlsx'), { propertyLine: 'Property: 1100 Rarig Ave', periodLine: '01/01/25 - 12/31/25  (cash basis)', rent: 130000, repair: 5000 });
  await ingest(join(dir, 'P&L 2026 YTD -- 1100 Rarig.xlsx'), { propertyLine: 'Property: 1100 Rarig Ave', periodLine: '01/01/26 - 06/30/26  (cash basis)', rent: 65000, repair: 2500 });
  await ingest(join(dir, 'P&L 2024 -- 3034 Westerville.xlsx'), { propertyLine: 'Property: 3034 Westerville Rd', periodLine: '01/01/24 - 12/31/24  (cash basis)', rent: 80000, repair: 10000 });
  await ingest(join(dir, 'P&L 2025 -- 3034 Westerville.xlsx'), { propertyLine: 'Property: 3034 Westerville Rd', periodLine: '01/01/25 - 12/31/25  (cash basis)', rent: 60000, repair: 30000 });
  await ingest(join(dir, 'P&L 2026 YTD -- 3034 Westerville.xlsx'), { propertyLine: 'Property: 3034 Westerville Rd', periodLine: '01/01/26 - 06/30/26  (cash basis)', rent: 30000, repair: 15000 });
  const metrics = propertyPeriodMetrics(db);
  return { db, metrics };
}

describe('scoreProperties', () => {
  it('scores deterministically and bands correctly', async () => {
    const { db, metrics } = await buildWarehouse();
    const s = scoreProperties(db, metrics); // computes growth/benchmarks/anomalies internally

    const strong = s.find((x) => x.propertyId === STRONG)!;
    expect(strong).toBeDefined();
    expect(strong.health).toBeGreaterThanOrEqual(80);
    expect(strong.healthBand).toBe('excellent');
    expect(strong.attentionBand).toBe('green');
    expect(strong.capitalAction).toBe('invest');
    expect(strong.reasons.length).toBeGreaterThan(0);

    const weak = s.find((x) => x.propertyId === WEAK)!;
    expect(weak).toBeDefined();
    expect(weak.healthBand).toBe('concern');
    expect(['orange', 'red']).toContain(weak.attentionBand);
    expect(weak.capitalAction).toBe('disposition-candidate');
    expect(weak.reasons.length).toBeGreaterThan(0);

    // determinism — same db + metrics ⇒ deep-equal result on re-run
    expect(scoreProperties(db, metrics)).toEqual(s);
  });

  it('every score is on the latest period with a 0..100 health and named band/attention/action', async () => {
    const { db, metrics } = await buildWarehouse();
    const s = scoreProperties(db, metrics);
    for (const row of s) {
      expect(row.period).toBe('2025'); // latest available period per property
      expect(row.health).toBeGreaterThanOrEqual(0);
      expect(row.health).toBeLessThanOrEqual(100);
      expect(['excellent', 'good', 'watch', 'concern']).toContain(row.healthBand);
      expect(['green', 'yellow', 'orange', 'red']).toContain(row.attentionBand);
      expect(['invest', 'hold', 'monitor', 'disposition-candidate']).toContain(row.capitalAction);
    }
  });

  it('a trailing YTD period does NOT flip a strong property to concern (grain-aware, spec §9)', async () => {
    const { db, metrics } = await buildWarehouseWithYtd();
    const s = scoreProperties(db, metrics);

    const strong = s.find((x) => x.propertyId === STRONG)!;
    expect(strong).toBeDefined();
    // Growth-driven verdict must reflect the real 2024→2025 trajectory, not the YTD partial.
    expect(strong.healthBand).toBe('excellent');
    expect(strong.attentionBand).toBe('green');
    expect(strong.capitalAction).toBe('invest');
    expect(strong.health).toBeGreaterThanOrEqual(80);

    // WEAK was already declining 2024→2025 — that verdict stands (grain-awareness doesn't rescue it).
    const weak = s.find((x) => x.propertyId === WEAK)!;
    expect(weak.healthBand).toBe('concern');
    expect(['orange', 'red']).toContain(weak.attentionBand);

    // determinism — same db + metrics ⇒ deep-equal result on re-run (with the YTD present).
    expect(scoreProperties(db, metrics)).toEqual(s);
  });
});
