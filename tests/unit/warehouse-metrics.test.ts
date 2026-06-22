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
import { noiMatrix } from '../../server/warehouse/queries';

// Local copy of the ingest-test fixture writer (tests never import across test files).
// propertyLine varies the bytes so two property files never collide on content hash.
async function writeFixture(
  path: string,
  propertyLine = 'Property: 1100 Rarig Ave',
  periodLine = '01/01/25 - 12/31/25  (cash basis)',
  rent = 100000,
  repair = 5000,
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  const rows: Array<[string | null, string | null, string | null, number | null]> = [
    ['Profit & Loss', null, null, null],
    [propertyLine, null, null, null],
    [periodLine, null, null, null],
    [null, 'INCOME', null, null],
    [null, null, '     5002 RENTAL INCOME', null],
    [null, null, '          5064 Rent', rent],
    [null, 'EXPENSE', null, null],
    [null, null, '     6160 REPAIR', null],
    [null, null, '          6285 HVAC Repair', repair],
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

async function buildWarehouse(): Promise<{ db: WarehouseDb; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'whm-'));
  const db = openWarehouse(join(dir, 'f.sqlite'));
  seedPropertyMaster(db);
  seedMappings(db, SEED);
  // Rarig: 100% owned, rentable_sf 21000.
  const rarig = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
  await writeFixture(rarig);
  expect((await ingestFile(db, rarig, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' })).status).toBe('committed');
  // Red Branch: 50% owned. Distinct property line keeps the content hash distinct.
  const redBranch = join(dir, 'P&L 2025 -- 9050 Red Branch.xlsx');
  await writeFixture(redBranch, 'Property: 9050 Red Branch Rd');
  expect((await ingestFile(db, redBranch, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:01:00Z' })).status).toBe('committed');
  return { db, dir };
}

describe('propertyPeriodMetrics', () => {
  it('computes NOI, margin, $/SF, category subtotals, revenueCategories, ownership overlay (Rarig 100%)', async () => {
    const { db } = await buildWarehouse();
    const m = propertyPeriodMetrics(db);
    const rarig = m.find((x) => x.propertyId === '1100-rarig-ave-columbus-oh' && x.period === '2025')!;
    expect(rarig.revenue).toBe(100000);
    expect(rarig.opex).toBe(5000);
    expect(rarig.noi).toBe(95000);
    expect(rarig.noiMargin).toBeCloseTo(0.95, 6);
    expect(rarig.expenseRatio).toBeCloseTo(0.05, 6);
    expect(rarig.categories['Repairs & Maintenance']).toBe(5000);
    expect(rarig.revenueCategories['Rental Revenue']).toBe(100000);
    expect(rarig.noiPerSf).toBeCloseTo(95000 / 21000, 6);
    expect(rarig.revenuePerSf).toBeCloseTo(100000 / 21000, 6);
    expect(rarig.ownershipPct).toBe(1);
    expect(rarig.oxfordNoi).toBe(95000); // 100% owned
    // distribution excluded from everything
    expect(rarig.capex).toBe(0);
  });

  it('applies ownership overlay to oxfordNoi but keeps $/SF 100%-basis (Red Branch 50%)', async () => {
    const { db } = await buildWarehouse();
    const m = propertyPeriodMetrics(db);
    const rb = m.find((x) => x.propertyId === '9050-red-branch-rd-columbia-md' && x.period === '2025')!;
    expect(rb.ownershipPct).toBe(0.5);
    expect(rb.noi).toBe(95000); // 100%-basis NOI
    expect(rb.oxfordNoi).toBeCloseTo(95000 * 0.5, 6); // ownership overlay
    // $/SF stays 100%-basis (unchanged by ownership): rentable_sf 90000
    expect(rb.noiPerSf).toBeCloseTo(95000 / 90000, 6);
    expect(rb.revenuePerSf).toBeCloseTo(100000 / 90000, 6);
  });

  it('carries the import accounting basis on each period (basis discipline — integrity risk #2)', async () => {
    // The fixture period header reads "(cash basis)"; the ledger must surface that basis up to
    // PeriodMetrics so downstream comparisons can refuse to mix cash vs accrual vs tax NOI.
    const { db } = await buildWarehouse();
    const m = propertyPeriodMetrics(db);
    const rarig = m.find((x) => x.propertyId === '1100-rarig-ave-columbus-oh' && x.period === '2025')!;
    expect(rarig.basis).toBe('cash');
  });

  it('resolves a (property, year) deterministically to the full-year batch when a same-year YTD coexists (no double-count, no arbitrary-row basis)', async () => {
    // Adversarial finding (Phase 1a review): a full-year-2026 and a YTD-2026 import have the same
    // ledger period ('2026') but different period_end, so neither supersedes the other and both stay
    // active. Grouping by (property, period) then summed BOTH batches (double-count) and picked an
    // arbitrary head row for basis/grainHint. The full year must win: metrics reflect ONE coherent
    // batch — the full year — never the sum, and the basis/grain are that batch's, deterministically.
    const dir = mkdtempSync(join(tmpdir(), 'whm-coexist-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const opts = { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' };

    // Full-year 2026: cash basis, rent 100k / repair 5k → NOI 95k.
    const fy = join(dir, 'P&L 2026 -- 1100 Rarig.xlsx');
    await writeFixture(fy, 'Property: 1100 Rarig Ave', '01/01/26 - 12/31/26  (cash basis)', 100000, 5000);
    expect((await ingestFile(db, fy, opts)).status).toBe('committed');
    // YTD 2026 (Jan–Jun): accrual basis, rent 40k / repair 2k → NOI 38k. Different period_end ⇒ both active.
    const ytd = join(dir, 'P&L 2026 YTD -- 1100 Rarig.xlsx');
    await writeFixture(ytd, 'Property: 1100 Rarig Ave', '01/01/26 - 06/30/26  (accrual basis)', 40000, 2000);
    expect((await ingestFile(db, ytd, opts)).status).toBe('committed');

    const m = propertyPeriodMetrics(db);
    const rarig2026 = m.filter((x) => x.propertyId === '1100-rarig-ave-columbus-oh' && x.period === '2026');
    // EXACTLY ONE row for (rarig, 2026) — not two, not a merged sum.
    expect(rarig2026.length).toBe(1);
    const row = rarig2026[0]!;
    expect(row.noi).toBe(95000);        // full-year NOI — NOT 95000+38000=133000
    expect(row.revenue).toBe(100000);   // full-year revenue — NOT 140000
    expect(row.grainHint).toBe('year'); // full year wins over the YTD
    expect(row.basis).toBe('cash');     // the full-year batch's basis, deterministically
  });

  it('taxesPerSf is null — not 0 — when the Taxes category is absent from the ledger (missing category is no-data, not $0/SF)', async () => {
    // The buildWarehouse fixture maps only Rent (revenue) and HVAC Repair (Repairs & Maintenance opex).
    // There is no Taxes account in the SEED, so categories['Taxes'] is undefined for every property.
    // Bug: perSf(categories['Taxes'] ?? 0, sf) = perSf(0, sf) = 0, which ranks the property as
    // best-in-cohort for tax efficiency (efficiencyScore=100) — a phantom $0/SF score.
    // Fix: emit null when the key is absent so the property self-excludes from the tax-efficiency cohort.
    const { db } = await buildWarehouse();
    const m = propertyPeriodMetrics(db);
    const rarig = m.find((x) => x.propertyId === '1100-rarig-ave-columbus-oh' && x.period === '2025')!;
    expect(rarig.taxesPerSf).toBeNull();          // absent category = no-data
    expect(rarig.insurancePerSf).toBeNull();       // also absent
    expect(rarig.repairsPerSf).not.toBeNull();     // Repairs & Maintenance IS present
  });

  it('returns [] for an empty warehouse (no active ledger rows)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whm-empty-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    // No ingest — empty ledger.
    expect(propertyPeriodMetrics(db)).toEqual([]);
  });

  it('zero-revenue period → noiMargin and expenseRatio are null (division-by-zero guard)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whm-zerorev-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeFixture(file, 'Property: 1100 Rarig Ave', '01/01/25 - 12/31/25  (cash basis)', 0, 5000);
    expect((await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' })).status).toBe('committed');
    const m = propertyPeriodMetrics(db);
    const row = m.find((x) => x.propertyId === '1100-rarig-ave-columbus-oh' && x.period === '2025')!;
    expect(row.revenue).toBe(0);
    expect(row.noiMargin).toBeNull();    // revenue === 0 → guard triggers
    expect(row.expenseRatio).toBeNull(); // revenue === 0 → guard triggers
    expect(row.noi).toBe(-5000);         // opex still subtracted from zero revenue
  });

  it('capex and TI rows are tracked separately and excluded from NOI', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whm-capex-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    const capexSeed = [
      ...SEED,
      { account: 'Roof Replacement', code: '9001', normalized_category: 'Capital Improvements', classification: 'capex' },
      { account: 'Tenant Build-Out', code: '9002', normalized_category: 'Tenant Improvements', classification: 'ti' },
    ];
    seedMappings(db, capexSeed);
    // Build a fixture that includes capex and TI rows alongside normal income/opex.
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['Profit & Loss', null, null, null]);
    ws.addRow(['Property: 1100 Rarig Ave', null, null, null]);
    ws.addRow(['01/01/25 - 12/31/25  (cash basis)', null, null, null]);
    ws.addRow([null, 'INCOME', null, null]);
    ws.addRow([null, null, '          5064 Rent', 100000]);
    ws.addRow([null, 'EXPENSE', null, null]);
    ws.addRow([null, null, '          6285 HVAC Repair', 5000]);
    ws.addRow([null, 'NON OPERATING EXPENSE', null, null]);
    ws.addRow([null, null, '          9001 Roof Replacement', 30000]);
    ws.addRow([null, null, '          9002 Tenant Build-Out', 15000]);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await wb.xlsx.writeFile(file);
    expect((await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' })).status).toBe('committed');
    const row = propertyPeriodMetrics(db).find((x) => x.propertyId === '1100-rarig-ave-columbus-oh' && x.period === '2025')!;
    expect(row.noi).toBe(95000);     // 100k revenue − 5k opex; capex/TI excluded
    expect(row.capex).toBe(30000);   // tracked separately
    expect(row.ti).toBe(15000);      // tracked separately
    expect(row.revenue).toBe(100000); // unchanged by capex/TI rows
    expect(row.opex).toBe(5000);     // unchanged by capex/TI rows
  });
});

// --- NOI codepath agreement: noiMatrix (raw GROUP BY) vs propertyPeriodMetrics (coherent-batch) ---
// The warehouse has TWO independent NOI computations: noiMatrix() in queries.ts (SQL CASE over
// classification) and propertyPeriodMetrics() in metrics.ts (a per-class accumulator). Both define
// NOI = Σ(revenue, recovery, other-income) − opex over ACTIVE rows. This suite pins the invariant
// that they agree, so a future change to either path — or to NOI_CLASSES in the contract — cannot
// silently diverge the two numbers. The fixture spans ALL THREE income classes plus opex and a
// non-NOI 'excluded' line, so dropping any income member (the precise drift this refactor guards)
// breaks the test. They legitimately differ ONLY on coexisting full-year+YTD active imports for the
// same period (covered by the coexistence test above); single-batch datasets must agree exactly.
const ALL_INCOME_SEED = [
  { account: 'Rent', code: '5064', normalized_category: 'Rental Revenue', classification: 'revenue' },
  { account: 'CAM Reimbursement', code: '5200', normalized_category: 'CAM Recovery', classification: 'recovery' },
  { account: 'Late Fee Income', code: '5300', normalized_category: 'Other Income', classification: 'other-income' },
  { account: 'HVAC Repair', code: '6285', normalized_category: 'Repairs & Maintenance', classification: 'opex' },
  { account: 'Distribution to Owner', code: '7402', normalized_category: 'Distributions', classification: 'excluded' },
];

async function writeAllIncomeClassesFixture(path: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  const rows: Array<[string | null, string | null, string | null, number | null]> = [
    ['Profit & Loss', null, null, null],
    ['Property: 1100 Rarig Ave', null, null, null],
    ['01/01/25 - 12/31/25  (cash basis)', null, null, null],
    [null, 'INCOME', null, null],
    [null, null, '     5002 RENTAL INCOME', null],
    [null, null, '          5064 Rent', 100000],
    [null, null, '     5210 CAM RECOVERY', null],
    [null, null, '          5200 CAM Reimbursement', 30000],
    [null, null, '     5310 OTHER INCOME', null],
    [null, null, '          5300 Late Fee Income', 5000],
    [null, 'EXPENSE', null, null],
    [null, null, '     6160 REPAIR', null],
    [null, null, '          6285 HVAC Repair', 5000],
    [null, 'NON OPERATING EXPENSE', null, null],
    [null, null, '          7402 Distribution to Owner', 25000],
  ];
  for (const r of rows) ws.addRow(r);
  await wb.xlsx.writeFile(path);
}

describe('NOI codepath agreement (noiMatrix vs propertyPeriodMetrics)', () => {
  it('both paths agree on NOI across every income class on a single-batch dataset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whagree-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, ALL_INCOME_SEED);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeAllIncomeClassesFixture(file);
    expect((await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' })).status).toBe('committed');

    const matrix = noiMatrix(db);
    const metrics = propertyPeriodMetrics(db);

    // Hand-computed NOI = 100000 + 30000 + 5000 − 5000 = 130000 (excluded line never in NOI).
    const EXPECTED_NOI = 130000;
    const id = '1100-rarig-ave-columbus-oh';
    const cell = matrix.find((c) => c.propertyId === id && c.period === '2025')!;
    const m = metrics.find((x) => x.propertyId === id && x.period === '2025')!;

    // Drift teeth: every income class must land in the income accumulator.
    expect(m.revenue).toBe(135000); // revenue 100000 + recovery 30000 + other-income 5000
    expect(m.opex).toBe(5000);
    // Both NOI codepaths equal the hand-computed value AND each other.
    expect(m.noi).toBe(EXPECTED_NOI);
    expect(cell.noi).toBe(EXPECTED_NOI);
    expect(cell.noi).toBeCloseTo(m.noi, 2); // noiMatrix ROUNDs to 2 decimals
  });

  it('both paths agree on NOI for every (property, period) in the two-property fixture', async () => {
    const { db } = await buildWarehouse();
    const matrix = noiMatrix(db);
    const metrics = propertyPeriodMetrics(db);
    const mByKey = new Map(metrics.map((x) => [`${x.propertyId}|${x.period}`, x]));

    expect(matrix.length).toBeGreaterThan(0);
    expect(matrix.length).toBe(metrics.length); // identical (property, period) coverage on single-batch data
    for (const c of matrix) {
      const m = mByKey.get(`${c.propertyId}|${c.period}`);
      expect(m, `metrics missing ${c.propertyId} ${c.period}`).toBeDefined();
      expect(c.noi).toBeCloseTo(m!.noi, 2);
    }
  });

  it('noiMatrix returns the COHERENT (full-year) NOI when a same-year YTD coexists — not the doubled sum (H2)', async () => {
    // Audit finding H2: noiMatrix() does a raw GROUP BY (property, period) over ALL active rows with
    // NO selectCoherentBatch. A full-year (period_end 12-31) and a same-year YTD (06-30) share ledger
    // period '2026' but differ on period_end ⇒ neither supersedes the other and BOTH stay active.
    // The raw GROUP BY then SUMS both batches ⇒ ~2x NOI overstatement. propertyPeriodMetrics already
    // resolves this via selectCoherentBatch (the full year wins); noiMatrix must agree, returning the
    // SINGLE coherent full-year figure — never the sum.
    const dir = mkdtempSync(join(tmpdir(), 'whagree-coexist-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const opts = { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' };

    // Full-year 2026: rent 100k / repair 5k → NOI 95k.
    const fy = join(dir, 'P&L 2026 -- 1100 Rarig.xlsx');
    await writeFixture(fy, 'Property: 1100 Rarig Ave', '01/01/26 - 12/31/26  (cash basis)', 100000, 5000);
    expect((await ingestFile(db, fy, opts)).status).toBe('committed');
    // YTD 2026 (Jan–Jun): rent 40k / repair 2k → NOI 38k. Different period_end ⇒ both active.
    const ytd = join(dir, 'P&L 2026 YTD -- 1100 Rarig.xlsx');
    await writeFixture(ytd, 'Property: 1100 Rarig Ave', '01/01/26 - 06/30/26  (accrual basis)', 40000, 2000);
    expect((await ingestFile(db, ytd, opts)).status).toBe('committed');

    const id = '1100-rarig-ave-columbus-oh';
    const cells2026 = noiMatrix(db).filter((c) => c.propertyId === id && c.period === '2026');
    // EXACTLY ONE coherent cell for (rarig, 2026) — not two, not a merged sum.
    expect(cells2026.length).toBe(1);
    expect(cells2026[0]!.noi).toBe(95000); // full-year NOI — NOT 95000 + 38000 = 133000 (the double-count)

    // And it must equal the coherent NOI propertyPeriodMetrics already reports (codepath agreement
    // holds even on the coexistence case once noiMatrix is coherent-batch aware).
    const m2026 = propertyPeriodMetrics(db).find((x) => x.propertyId === id && x.period === '2026')!;
    expect(cells2026[0]!.noi).toBeCloseTo(m2026.noi, 2);
  });
});
