// tests/unit/capital-allocation.residence.test.ts
//
// Ratified 2026-09-23 (Gabriel): the residence (type === 'Residence', 9510 Persimmon Tree) is not an
// investment property — it is reported as "other holdings" and never alerts, scores or gets a capital
// verdict (src/analytics/property-basis.ts isInvestmentProperty). buildCapitalAllocationReport looped
// every snapshot property with no such filter, so the residence surfaced as a 0.0% "hold" in the
// Capital cap-rate table, in the verdict counts and in the Notion Property Register writeback, and its
// NOI/count leaked into the portfolio totals.
import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Property, PortfolioSnapshot } from '../../src/contracts/index';
import { CapitalAllocationReport } from '../../src/contracts/capital-allocation';
import { openWarehouse } from '../../server/warehouse/db';
import { ingestFile } from '../../server/warehouse/ingest';
import { seedMappings } from '../../server/warehouse/mapping';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import { buildCapitalAllocationReport, buildPortfolioAllocation } from '../../server/warehouse/capital-allocation';

const PINNED_REPORT_DATE = '2026-08-22';
let priorReportDate: string | undefined;
beforeAll(() => { priorReportDate = process.env.REPORT_DATE; process.env.REPORT_DATE = PINNED_REPORT_DATE; });
afterAll(() => { if (priorReportDate === undefined) delete process.env.REPORT_DATE; else process.env.REPORT_DATE = priorReportDate; });

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
    meta: { schemaVersion: '1.0.0', asOf: '2026-06-22', generatedAt: '2026-06-22T00:00:00.000Z', source: 'test', scenario: 'Base' },
    assumptions: {
      activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1,
      thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 },
      asOf: '2026-06-22',
    },
    properties,
    leases: [],
    loans: [],
    cash: { asOf: '2026-06-22', totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
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

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'cap-res-'));
  const db = openWarehouse(join(dir, 'f.sqlite'));
  seedPropertyMaster(db);
  seedMappings(db, []);
  return db;
}

const RARIG = { id: '1100-rarig-ave-columbus-oh', noi: 95_000, sf: 21_000 };
// Non-zero NOI on purpose: a residence with a stray figure must still not reach the portfolio total.
const BROADWAY_ID = '1900-n-broadway-baltimore-md';
const NORTHWOOD_ID = '2203-2207-northwood-dr-salisbury-md';
const HOME = { id: '9510-persimmon-tree-rd-potomac-md', noi: 12_000, sf: 6_000, type: 'Residence' as const, market: 'Mid-Atlantic' as const };

// The ledger-verdict engine (Capital page cards, IC memo, action counts) builds one verdict per Spine B
// score. The residence is absent from seedPropertyMaster, but nothing in the engine said so: a residence
// row added to property_master with ledger P&L (property-onboarding can do this) produced a verdict.
describe('buildPortfolioAllocation — residence is not an investment property', () => {
  async function dbWithResidenceLedger(withResidence = true) {
    const dir = mkdtempSync(join(tmpdir(), 'cap-res-pa-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, [
      { account: 'Rent', code: '5064', normalized_category: 'Rental Revenue', classification: 'revenue' },
      { account: 'HVAC Repair', code: '6285', normalized_category: 'Repairs & Maintenance', classification: 'opex' },
    ]);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    for (const r of [
      ['Profit & Loss', null, null, null],
      ['Property: 1100 Rarig Ave', null, null, null],
      ['01/01/25 - 12/31/25  (cash basis)', null, null, null],
      [null, 'INCOME', null, null],
      [null, null, '     5002 RENTAL INCOME', null],
      [null, null, '          5064 Rent', 100000],
      [null, 'EXPENSE', null, null],
      [null, null, '     6160 REPAIR', null],
      [null, null, '          6285 HVAC Repair', 5000],
    ]) ws.addRow(r);
    await wb.xlsx.writeFile(file);
    await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-22T00:00:00Z' });
    // Peers for the cohort test: two more investment properties at different NOI/SF.
    for (const [id, factor] of [[BROADWAY_ID, 1.5], [NORTHWOOD_ID, 0.6]] as const) {
      db.prepare(`INSERT INTO ledger_entries (import_id, property_id, period, raw_account, gl_code, amount, normalized_category, classification, mapping_id, is_active)
                  SELECT import_id, ?, period, raw_account, gl_code, amount * ?, normalized_category, classification, mapping_id, is_active
                  FROM ledger_entries WHERE property_id = ?`).run(id, factor, RARIG.id);
    }
    if (!withResidence) return db;
    // Give the residence a P&L (4x Rarig's: a high NOI/SF outlier) under its own id.
    db.prepare(`INSERT INTO property_master (id, name, market, rentable_sf) VALUES (?, '9510 Persimmon Tree', 'Mid-Atlantic', 6000)`).run(HOME.id);
    db.prepare(`INSERT INTO ledger_entries (import_id, property_id, period, raw_account, gl_code, amount, normalized_category, classification, mapping_id, is_active)
                SELECT import_id, ?, period, raw_account, gl_code, amount * 4, normalized_category, classification, mapping_id, is_active
                FROM ledger_entries WHERE property_id = ?`).run(HOME.id, RARIG.id);
    return db;
  }

  it('emits no verdict for the residence and keeps it out of the action counts', async () => {
    const db = await dbWithResidenceLedger();
    const snap = makeSnapshot([makeProperty(RARIG), makeProperty(HOME)]);
    const out = await buildPortfolioAllocation(db, '2026-08-22', undefined, snap);
    expect(out.verdicts.map((v) => v.propertyId)).toEqual([BROADWAY_ID, NORTHWOOD_ID, RARIG.id].sort());
    const counted = Object.values(out.actionCounts).reduce((a, b) => a + b, 0);
    expect(counted).toBe(out.verdicts.length);
  });

  it('does not let the residence shift investment properties (peer cohorts, medians)', async () => {
    const props = [makeProperty(RARIG), makeProperty({ id: BROADWAY_ID, noi: 1, sf: 1 }), makeProperty({ id: NORTHWOOD_ID, noi: 1, sf: 1 })];
    const without = await buildPortfolioAllocation(await dbWithResidenceLedger(false), '2026-08-22', undefined, makeSnapshot(props));
    const withHome = await buildPortfolioAllocation(await dbWithResidenceLedger(true), '2026-08-22', undefined, makeSnapshot([...props, makeProperty(HOME)]));
    expect(withHome.verdicts).toEqual(without.verdicts);
  });

  it('keeps the residence out of buildCapitalAllocationReport peer cohorts too', async () => {
    const props = [makeProperty(RARIG), makeProperty({ id: BROADWAY_ID, noi: 1, sf: 1 }), makeProperty({ id: NORTHWOOD_ID, noi: 1, sf: 1 })];
    const without = await buildCapitalAllocationReport(await dbWithResidenceLedger(false), makeSnapshot(props));
    const withHome = await buildCapitalAllocationReport(await dbWithResidenceLedger(true), makeSnapshot([...props, makeProperty(HOME)]));
    expect(withHome.entries).toEqual(without.entries);
  });

  it('still scores the residence when no snapshot is supplied (no type information to filter on)', async () => {
    const db = await dbWithResidenceLedger();
    const out = await buildPortfolioAllocation(db, '2026-08-22');
    expect(out.verdicts.map((v) => v.propertyId)).toContain(HOME.id);
  });
});

describe('buildCapitalAllocationReport — residence is not an investment property', () => {
  it('emits no entry for the residence', async () => {
    const report = await buildCapitalAllocationReport(freshDb(), makeSnapshot([makeProperty(RARIG), makeProperty(HOME)]));
    expect(report.entries.map((e) => e.propertyId)).toEqual([RARIG.id]);
  });

  it('keeps the residence out of propertyCount, portfolioNoi and the action counts', async () => {
    const report = await buildCapitalAllocationReport(freshDb(), makeSnapshot([makeProperty(RARIG), makeProperty(HOME)]));
    expect(report.propertyCount).toBe(1);
    expect(report.portfolioNoi).toBe(RARIG.noi);
    expect(report.investCount + report.holdCount + report.monitorCount + report.dispositionCount).toBe(report.entries.length);
    expect(() => CapitalAllocationReport.parse(report)).not.toThrow();
  });

  it('treats a snapshot of only investment properties exactly as before', async () => {
    const report = await buildCapitalAllocationReport(freshDb(), makeSnapshot([makeProperty(RARIG)]));
    expect(report.propertyCount).toBe(1);
    expect(report.portfolioNoi).toBe(RARIG.noi);
    expect(report.entries).toHaveLength(1);
  });

  it('an untyped property is still an investment row (matches isInvestmentProperty)', async () => {
    const untyped = { ...makeProperty(RARIG), type: undefined } as unknown as Property;
    const report = await buildCapitalAllocationReport(freshDb(), makeSnapshot([untyped]));
    expect(report.entries).toHaveLength(1);
  });
});
