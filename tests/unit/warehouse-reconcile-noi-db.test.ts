// tests/unit/warehouse-reconcile-noi-db.test.ts
//
// PFI Phase 1c — DB wrapper tests for reconcileNoiABFromDb. Verifies the full
// JOIN path: ingested warehouse ledger entries (Spine B) joined to a workbook
// PortfolioSnapshot (Spine A) by property slug, then classified.
//
// Four cases: match · large-drift · missing-from-warehouse · residence-exclusion.
// The pure-classifier path is tested exhaustively in warehouse-reconcile-noi.test.ts;
// this suite only verifies the DB join plumbing — that the right warehouse periods,
// NOIs, and financial_mode flags flow from the DB into the classifier correctly.
import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { openWarehouse } from '../../server/warehouse/db';
import { ingestFile } from '../../server/warehouse/ingest';
import { seedMappings } from '../../server/warehouse/mapping';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import { reconcileNoiABFromDb } from '../../server/warehouse/reconcile-noi';

const SEED = [
  { account: 'Rent', code: '5064', normalized_category: 'Rental Revenue', classification: 'revenue' },
  { account: 'HVAC Repair', code: '6285', normalized_category: 'Repairs & Maintenance', classification: 'opex' },
];

async function writeFixture(path: string, propertyLine: string, rent: number, repair: number): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  const rows: Array<[string | null, string | null, string | null, number | null]> = [
    ['Profit & Loss', null, null, null],
    [propertyLine, null, null, null],
    ['01/01/25 - 12/31/25  (cash basis)', null, null, null],
    [null, 'INCOME', null, null],
    [null, null, '     5002 RENTAL INCOME', null],
    [null, null, '          5064 Rent', rent],
    [null, 'EXPENSE', null, null],
    [null, null, '     6160 REPAIR', null],
    [null, null, '          6285 HVAC Repair', repair],
  ];
  for (const r of rows) ws.addRow(r);
  await wb.xlsx.writeFile(path);
}

async function buildDb() {
  const dir = mkdtempSync(join(tmpdir(), 'whr-db-'));
  const db = openWarehouse(join(dir, 'f.sqlite'));
  seedPropertyMaster(db);
  seedMappings(db, SEED);

  // Rarig: 100%-owned, NOI = 95000 (rent 100k - repair 5k).
  const rarig = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
  await writeFixture(rarig, 'Property: 1100 Rarig Ave', 100000, 5000);
  expect((await ingestFile(db, rarig, { rawDir: join(dir, 'raw'), importedAt: '2026-06-13T00:00:00Z' })).status).toBe('committed');

  // Red Branch: 50%-owned, NOI-100% = 95000 → oxfordNoi = 47500.
  const rb = join(dir, 'P&L 2025 -- 9050 Red Branch.xlsx');
  await writeFixture(rb, 'Property: 9050 Red Branch Rd', 100000, 5000);
  expect((await ingestFile(db, rb, { rawDir: join(dir, 'raw'), importedAt: '2026-06-13T00:01:00Z' })).status).toBe('committed');

  return { db, dir };
}

// Minimal snapshot: only snapshot.properties is read by buildNoiReconcileInputs.
const prop = (
  id: string,
  noi: number,
  type: 'Industrial' | 'Residence' = 'Industrial',
): PortfolioSnapshot['properties'][number] =>
  ({
    id,
    name: id,
    address: '',
    city: null,
    state: null,
    market: 'Columbus',
    type,
    sf: 20000,
    tenantCount: 1,
    occPct: 1,
    acqDate: null,
    estValue100: 1000000,
    oxfordOwnPct: 1,
    oxfordValue: 1000000,
    grossIncome: noi + 5000,
    expenses: 5000,
    noi,
    noiScenarioAdj: 0,
    debtService: 0,
    netCashFlow: noi,
    capRate: null,
    dscr: null,
    lender: null,
    loanBalance: 0,
    ltv: null,
    valuePerSf: null,
    rentPerSf: null,
    equityInvested: 0,
    cashOnCash: null,
    holdYrs: null,
    encumbered: false,
    flags: [],
    index: null,
  } as unknown as PortfolioSnapshot['properties'][number]);

const snapshot = (properties: PortfolioSnapshot['properties']): PortfolioSnapshot =>
  ({ properties } as unknown as PortfolioSnapshot);

describe('reconcileNoiABFromDb — JOIN path (Spine A workbook ↔ Spine B warehouse)', () => {
  it('match: workbook Oxford-share NOI equal to warehouse oxfordNoi → status match', async () => {
    const { db } = await buildDb();
    // Rarig: 100% owned, warehouse oxfordNoi = 95000. Workbook noi = 95000.
    // M3: Red Branch is also in the warehouse but not the snapshot → added as missing-from-workbook.
    const rows = reconcileNoiABFromDb(db, snapshot([prop('1100-rarig-ave-columbus-oh', 95000)]));
    const r = rows.find((row) => row.propertyId === '1100-rarig-ave-columbus-oh')!;
    expect(r).toBeDefined();
    expect(r.status).toBe('match');
    expect(r.severity).toBe('info');
    expect(r.warehouseOxfordNoi).toBe(95000);
    expect(r.workbookOxfordNoi).toBe(95000);
    expect(r.delta).toBe(0);
    expect(r.basis).toBe('cash');
    expect(r.period).toBe('2025');
  });

  it('large-drift: workbook NOI materially higher than warehouse → large-drift error', async () => {
    const { db } = await buildDb();
    // Rarig warehouse oxfordNoi = 95000; workbook noi = 200000 (>20% drift → large-drift).
    // M3: Red Branch also emitted as missing-from-workbook; use find() to isolate Rarig.
    const rows = reconcileNoiABFromDb(db, snapshot([prop('1100-rarig-ave-columbus-oh', 200000)]));
    const r = rows.find((row) => row.propertyId === '1100-rarig-ave-columbus-oh')!;
    expect(r).toBeDefined();
    expect(r.status).toBe('large-drift');
    expect(r.severity).toBe('error');
    expect(r.delta).toBe(200000 - 95000); // workbook − warehouse
    expect(r.reason).toMatch(/workbook.*exceeds.*warehouse/i);
  });

  it('ownership overlay: Red Branch (50%) — warehouseOxfordNoi is 47500, not 95000', async () => {
    const { db } = await buildDb();
    // Red Branch is 50% owned; warehouse computes oxfordNoi = 95000 × 0.5 = 47500.
    // Workbook noi = 47500 → match; confirms ownership overlay flows through the JOIN correctly.
    // M3: Rarig is also in the warehouse but not the snapshot → emitted as missing-from-workbook.
    const rows = reconcileNoiABFromDb(
      db,
      snapshot([prop('9050-red-branch-rd-columbia-md', 47500)]),
    );
    const r = rows.find((row) => row.propertyId === '9050-red-branch-rd-columbia-md')!;
    expect(r).toBeDefined();
    expect(r.status).toBe('match');
    expect(r.warehouseOxfordNoi).toBeCloseTo(47500, 0);
  });

  it('missing-from-warehouse: property in snapshot with no ingested P&L → missing-from-warehouse', async () => {
    const { db } = await buildDb();
    // 'mystery-prop' exists in the snapshot but was never ingested into the warehouse.
    // M3: Rarig and Red Branch are warehouse-only (not in snapshot) → emitted as missing-from-workbook.
    const rows = reconcileNoiABFromDb(
      db,
      snapshot([prop('mystery-prop-not-in-warehouse', 50000)]),
    );
    const r = rows.find((row) => row.propertyId === 'mystery-prop-not-in-warehouse')!;
    expect(r).toBeDefined();
    expect(r.status).toBe('missing-from-warehouse');
    expect(r.severity).toBe('warn');
    expect(r.warehouseOxfordNoi).toBeNull();
    // M3 additions (Rarig + Red Branch) are missing-from-workbook, not missing-from-warehouse.
    const warehouseOnly = rows.filter((row) => row.propertyId !== 'mystery-prop-not-in-warehouse');
    expect(warehouseOnly.every((row) => row.status === 'missing-from-workbook')).toBe(true);
  });

  it('residence exclusion: property typed Residence is skipped by the assembler', async () => {
    const { db } = await buildDb();
    const rows = reconcileNoiABFromDb(
      db,
      snapshot([
        prop('1100-rarig-ave-columbus-oh', 95000),
        prop('persimmon-drive-residence', 0, 'Residence'),
      ]),
    );
    // Persimmon excluded. M3 adds Red Branch (warehouse-only) → both Rarig + Red Branch appear.
    expect(rows.some((r) => r.propertyId === '1100-rarig-ave-columbus-oh')).toBe(true);
    expect(rows.every((r) => r.propertyId !== 'persimmon-drive-residence')).toBe(true);
    const rarig = rows.find((r) => r.propertyId === '1100-rarig-ave-columbus-oh')!;
    expect(rarig.status).toBe('match');
  });

  it('mixed portfolio: multiple properties classified in one pass, sorted by id', async () => {
    const { db } = await buildDb();
    const rows = reconcileNoiABFromDb(
      db,
      snapshot([
        prop('1100-rarig-ave-columbus-oh', 95000),           // match
        prop('9050-red-branch-rd-columbia-md', 47500),        // match (50%)
        prop('mystery-prop-not-in-warehouse', 50000),         // missing-from-warehouse
      ]),
    );
    expect(rows).toHaveLength(3);
    // Stable-sorted by propertyId ascending.
    const ids = rows.map((r) => r.propertyId);
    expect(ids).toEqual([...ids].sort());
    const rarig = rows.find((r) => r.propertyId === '1100-rarig-ave-columbus-oh')!;
    const rb = rows.find((r) => r.propertyId === '9050-red-branch-rd-columbia-md')!;
    const mystery = rows.find((r) => r.propertyId === 'mystery-prop-not-in-warehouse')!;
    expect(rarig.status).toBe('match');
    expect(rb.status).toBe('match');
    expect(mystery.status).toBe('missing-from-warehouse');
  });
});
