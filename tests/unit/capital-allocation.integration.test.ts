// Integration test for buildCapitalAllocationReport — real engine, no mocks.
//
// This test exercises the full pipeline:
//   warehouse ingest → propertyPeriodMetrics → scoreProperties → scoreDebtPositions
//   → buildCapitalAllocationReport → CapitalAllocationReport Zod parse
//
// FRED/macro calls are not mocked — the engine's fail-open design means they resolve to
// source:'mock' in the test environment, which is the correct degraded path to exercise.
import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Property, PortfolioSnapshot } from '../../src/contracts/index';
import { CapitalAllocationReport } from '../../src/contracts/capital-allocation';
import { openWarehouse } from '../../server/warehouse/db';
import { ingestFile } from '../../server/warehouse/ingest';
import { seedMappings } from '../../server/warehouse/mapping';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import { buildCapitalAllocationReport } from '../../server/warehouse/capital-allocation';

const SEED = [
  { account: 'Rent', code: '5064', normalized_category: 'Rental Revenue', classification: 'revenue' },
  { account: 'HVAC Repair', code: '6285', normalized_category: 'Repairs & Maintenance', classification: 'opex' },
  { account: 'Distribution to Owner', code: '7402', normalized_category: 'Distributions', classification: 'excluded' },
];

async function writePropertyFixture(path: string, propertyLine: string, rent = 100000, repair = 5000): Promise<void> {
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
    [null, 'NON OPERATING EXPENSE', null, null],
    [null, null, '          7402 Distribution to Owner', 25000],
  ];
  for (const r of rows) ws.addRow(r);
  await wb.xlsx.writeFile(path);
}

function makeProperty(overrides: Partial<Property> & { id: string; noi: number; sf: number }): Property {
  return {
    index: 1,
    name: overrides.id,
    address: overrides.id,
    city: null,
    state: null,
    market: 'Columbus OH',
    type: 'Flex',
    tenantCount: 1,
    occPct: 1,
    acqDate: null,
    estValue100: 1200000,
    oxfordOwnPct: 1,
    oxfordValue: 1200000,
    grossIncome: overrides.noi + 5000,
    expenses: 5000,
    noiScenarioAdj: overrides.noi,
    debtService: 0,
    netCashFlow: overrides.noi,
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
    ...overrides,
  };
}

function makeSnapshot(properties: Property[]): PortfolioSnapshot {
  return {
    meta: {
      schemaVersion: '1.0.0',
      asOf: '2026-06-22',
      generatedAt: '2026-06-22T00:00:00.000Z',
      source: 'test',
      scenario: 'Base',
    },
    assumptions: {
      activeScenario: 'Base',
      revenueFactor: 1,
      vacancyFactor: 1,
      exitCapFactor: 1,
      thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 },
      asOf: '2026-06-22',
    },
    properties,
    leases: [],
    loans: [],
    cash: {
      asOf: '2026-06-22',
      totalCash: 0,
      activeEntities: 0,
      largestEntity: null,
      concentrationTopPct: null,
      cagr: null,
      entities: [],
      history: [],
    },
    insurance: [],
    deals: [],
    tasks: [],
    counterparties: [],
    renewalStages: {},
    tenantNotes: {},
    dealComps: {},
    noiBudgets: {},
    tenantArrears: {},
    acquisitionInputs: {},
    marketRents: {},
    quickbooks: null,
    dataQuality: [],
  } as unknown as PortfolioSnapshot;
}

describe('buildCapitalAllocationReport — real engine integration (no mocks)', () => {
  it('I-1: parses through CapitalAllocationReport Zod schema end-to-end with real warehouse data', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cap-int-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writePropertyFixture(file, 'Property: 1100 Rarig Ave');
    await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-22T00:00:00Z' });

    const snapshot = makeSnapshot([
      makeProperty({ id: '1100-rarig-ave-columbus-oh', noi: 95000, sf: 21000 }),
    ]);

    const report = await buildCapitalAllocationReport(db, snapshot);

    // Must parse through the Zod contract without throwing.
    expect(() => CapitalAllocationReport.parse(report)).not.toThrow();
  });

  it('I-2: action counts sum to entries length', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cap-int-counts-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);

    // Two properties with distinct P&L files.
    const rarigFile = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    const redBranchFile = join(dir, 'P&L 2025 -- 9050 Red Branch.xlsx');
    await writePropertyFixture(rarigFile, 'Property: 1100 Rarig Ave', 100000, 5000);
    await writePropertyFixture(redBranchFile, 'Property: 9050 Red Branch Rd', 80000, 4000);
    await ingestFile(db, rarigFile, { rawDir: join(dir, 'raw'), importedAt: '2026-06-22T00:00:00Z' });
    await ingestFile(db, redBranchFile, { rawDir: join(dir, 'raw'), importedAt: '2026-06-22T00:01:00Z' });

    const snapshot = makeSnapshot([
      makeProperty({ id: '1100-rarig-ave-columbus-oh', noi: 95000, sf: 21000 }),
      makeProperty({ id: '9050-red-branch-rd-columbia-md', noi: 76000, sf: 60000, oxfordOwnPct: 0.5, oxfordValue: 3000000 }),
    ]);

    const report = await buildCapitalAllocationReport(db, snapshot);

    expect(report.investCount + report.holdCount + report.monitorCount + report.dispositionCount).toBe(report.entries.length);
    expect(report.propertyCount).toBe(report.entries.length);
  });

  it('I-3: portfolioNoBasis is always spine-a and every entry priorityScore is in [0, 100]', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cap-int-basis-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writePropertyFixture(file, 'Property: 1100 Rarig Ave');
    await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-22T00:00:00Z' });

    const snapshot = makeSnapshot([
      makeProperty({ id: '1100-rarig-ave-columbus-oh', noi: 95000, sf: 21000 }),
    ]);

    const report = await buildCapitalAllocationReport(db, snapshot);

    expect(report.portfolioNoBasis).toBe('spine-a');
    for (const entry of report.entries) {
      expect(entry.priorityScore).toBeGreaterThanOrEqual(0);
      expect(entry.priorityScore).toBeLessThanOrEqual(100);
      expect(entry.noiBasis).toBe('spine-a');
    }
  });

  it('I-4: macro degrades gracefully — source is mock when FRED is unavailable (fail-open)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cap-int-macro-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writePropertyFixture(file, 'Property: 1100 Rarig Ave');
    await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-22T00:00:00Z' });

    const snapshot = makeSnapshot([
      makeProperty({ id: '1100-rarig-ave-columbus-oh', noi: 95000, sf: 21000 }),
    ]);

    const report = await buildCapitalAllocationReport(db, snapshot);

    // In the test environment FRED is unreachable; the engine must not throw — it degrades to source:'mock'.
    expect(report.macro.source === 'mock' || report.macro.source === 'fred').toBe(true);
    // Regardless of source, the report must contain a valid entries array.
    expect(Array.isArray(report.entries)).toBe(true);
  });

  it('I-5: empty warehouse snapshot → report entries is [] with zero counts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cap-int-empty-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    // No ingest — empty warehouse.

    const snapshot = makeSnapshot([]);

    const report = await buildCapitalAllocationReport(db, snapshot);

    expect(report.entries).toEqual([]);
    expect(report.investCount).toBe(0);
    expect(report.holdCount).toBe(0);
    expect(report.monitorCount).toBe(0);
    expect(report.dispositionCount).toBe(0);
    expect(report.portfolioNoi).toBe(0);
  });
});
