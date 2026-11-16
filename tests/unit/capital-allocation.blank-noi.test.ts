// tests/unit/capital-allocation.blank-noi.test.ts
//
// Audit 2026-11-12 HIGH #2, refute wf_406ad3ef-7de: buildCapitalAllocationReport reads Spine A
// property.noi. A blank workbook NOI cell (flagged governorInputBlank / noi at parse) used to score
// as $0: leasing risk fell to the vacant-property branch, the implied cap rate printed 0.0%, and the
// row sank in the priority ranking written to Notion. A blank NOI is unknown, never 0. Synthetic
// fixtures only; no governor constant is read or changed here.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Lease, Property, PortfolioSnapshot } from '../../src/contracts/index';
import { CapitalAllocationReport } from '../../src/contracts/capital-allocation';
import { openWarehouse } from '../../server/warehouse/db';
import { seedMappings } from '../../server/warehouse/mapping';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import { buildCapitalAllocationReport } from '../../server/warehouse/capital-allocation';

const PINNED_REPORT_DATE = '2026-08-22';
let priorReportDate: string | undefined;
beforeAll(() => { priorReportDate = process.env.REPORT_DATE; process.env.REPORT_DATE = PINNED_REPORT_DATE; });
// No temp-dir cleanup: the warehouse keeps its SQLite handle open (EPERM on Windows); the vitest
// temp root is reclaimed by globalSetup, as in the sibling capital-allocation tests.
afterAll(() => { if (priorReportDate === undefined) delete process.env.REPORT_DATE; else process.env.REPORT_DATE = priorReportDate; });

const blankNoiFlag = (id: string) => ({ entity: id, field: 'governorInputBlank', issue: 'blank', rawValue: 'noi', severity: 'warn' as const });

function prop(id: string, noi: number, flags: Property['flags'] = []): Property {
  return {
    id, index: 1, name: `Fixture ${id}`, address: id, city: null, state: null, market: 'Columbus OH', type: 'Flex',
    sf: 20_000, tenantCount: 1, occPct: 1, acqDate: null, estValue100: 2_000_000, oxfordOwnPct: 1, oxfordValue: 2_000_000,
    grossIncome: noi, expenses: 0, noi, noiScenarioAdj: noi, debtService: 80_000, netCashFlow: 0, capRate: null, dscr: null,
    lender: 'Fixture Bank', loanBalance: 900_000, ltv: 0.45, valuePerSf: null, rentPerSf: null, equityInvested: 0,
    cashOnCash: null, holdYrs: null, encumbered: true, flags,
  };
}

function lease(propertyId: string): Lease {
  return {
    id: `L-${propertyId}`, propertyKey: propertyId, propertyId, tenantName: 'Fixture Tenant', unit: null, company: null,
    sf: 10_000, monthlyRent: 12_500, rentPerSf: 15, leaseStart: '2020-01-01', leaseEnd: '2026-12-31',
    escalationDate: null, escalationPct: null, status: 'Active', annualRent: 150_000, monthsToExpiry: 4, flags: [],
  } as Lease;
}

function snapshot(properties: Property[], leases: Lease[]): PortfolioSnapshot {
  return {
    meta: { schemaVersion: '1.0.0', asOf: '2026-08-22', generatedAt: '2026-08-22T00:00:00.000Z', source: 'test', scenario: 'Base' },
    assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: '2026-08-22' },
    properties, leases, loans: [],
    cash: { asOf: '2026-08-22', totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
    insurance: [], deals: [], tasks: [], counterparties: [], renewalStages: {}, tenantNotes: {}, dealComps: {}, noiBudgets: {},
    tenantArrears: {}, acquisitionInputs: {}, marketRents: {}, quickbooks: null, dataQuality: [],
  } as unknown as PortfolioSnapshot;
}

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'cap-blank-noi-'));
  const db = openWarehouse(join(dir, 'f.sqlite'));
  seedPropertyMaster(db);
  seedMappings(db, []);
  return db;
}

describe('buildCapitalAllocationReport — a blank workbook NOI is unknown, never $0', () => {
  it('withholds implied cap rate, gap and NOI/SF, scores leasing risk conservatively, and says why', async () => {
    const blank = prop('blank-noi', 0, [blankNoiFlag('blank-noi')]);
    const report = await buildCapitalAllocationReport(freshDb(), snapshot([prop('ok', 300_000), blank], [lease('blank-noi')]));
    const e = report.entries.find((x) => x.propertyId === 'blank-noi')!;
    expect(e.impliedCapRate).toBeNull();
    expect(e.capRateGap).toBeNull();
    expect(e.noiPerSf).toBeNull();
    // $150K of rent expiring in 4 months on an unknown NOI: scored as if fully exposed, not as vacant.
    expect(e.leasingRisk).toBe(100);
    expect(e.rationale.some((r) => /NOI blank in workbook/.test(r))).toBe(true);
    expect(report.portfolioNoiIncomplete).toEqual(['Fixture blank-noi']);
    expect(() => CapitalAllocationReport.parse(report)).not.toThrow();
  });

  it('never claims "scored conservatively" when nothing is expiring and leasing risk is 0 (refute wf_c93c6154-6b8)', async () => {
    const blank = prop('blank-quiet', 0, [blankNoiFlag('blank-quiet')]);
    const report = await buildCapitalAllocationReport(freshDb(), snapshot([prop('ok', 300_000), blank], []));
    const e = report.entries.find((x) => x.propertyId === 'blank-quiet')!;
    expect(e.leasingRisk).toBe(0);
    expect(e.rationale.some((r) => /scored conservatively/.test(r))).toBe(false);
    expect(e.rationale.some((r) => /NOI blank in workbook/.test(r))).toBe(true);
  });

  it('is unchanged for a complete snapshot (no incomplete marker)', async () => {
    const report = await buildCapitalAllocationReport(freshDb(), snapshot([prop('ok', 300_000)], []));
    expect(report.portfolioNoiIncomplete ?? []).toEqual([]);
    expect(report.entries[0]!.impliedCapRate).toBeCloseTo(0.15, 10);
  });
});
