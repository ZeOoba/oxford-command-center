// @vitest-environment node
//
// Ratified 2026-09-24 (Gabriel): the residence is excluded from capital-allocation verdicts and — because
// POST /capital-allocation/sync-notion writes exactly report.entries — from the Notion Property Register
// sync (its existing Notion row is left untouched). Mock scaffolding mirrors
// capital-allocation.balloon-fresh.test.ts: every engine input is stubbed so the report's property loop
// is the only thing under test.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as DebtScoringModule from '../../server/warehouse/debt-scoring';
import type { WarehouseDb as WarehouseDbForMock } from '../../server/warehouse/db';

vi.mock('../../server/warehouse/scores', () => ({ scoreProperties: vi.fn().mockReturnValue([]) }));
vi.mock('../../server/warehouse/debt-scoring', async (importOriginal) => {
  const actual = await importOriginal<typeof DebtScoringModule>();
  const { readDebtBookTrust } = await import('../../server/warehouse/debt-trust');
  return {
    ...actual,
    scoreDebtPositions: vi.fn().mockReturnValue([]),
    scoreDebtPositionsWithTrust: vi.fn((db: unknown) => ({ scores: [], bookTrust: readDebtBookTrust(db as WarehouseDbForMock) })),
  };
});
vi.mock('../../server/warehouse/metrics', () => ({ propertyPeriodMetrics: vi.fn().mockReturnValue([]) }));
vi.mock('../../src/analytics/lease-forecast', () => ({ renewalSignals: vi.fn().mockReturnValue([]), bucketExpiry: vi.fn().mockReturnValue('24m+') }));
vi.mock('../../server/macro/getMacro', () => ({ getMacro: vi.fn().mockRejectedValue(new Error('no macro in test')) }));
vi.mock('../../server/macro/market-benchmarks', () => ({ getMacroMarketBenchmarks: vi.fn().mockRejectedValue(new Error('no benchmarks in test')) }));
vi.mock('../../server/macro/regional-macro', () => ({ getRegionalMacro: vi.fn().mockRejectedValue(new Error('no regional in test')) }));

import { openWarehouse } from '../../server/warehouse/db';
import { buildCapitalAllocationReport } from '../../server/warehouse/capital-allocation';
import type { PortfolioSnapshot } from '../../src/contracts/index';

const ASOF = '2026-09-24';
let priorReportDate: string | undefined;
beforeAll(() => { priorReportDate = process.env.REPORT_DATE; process.env.REPORT_DATE = ASOF; });
afterAll(() => { if (priorReportDate === undefined) delete process.env.REPORT_DATE; else process.env.REPORT_DATE = priorReportDate; });

const row = (id: string, type: string, noi: number) => ({
  index: 1, id, name: id, address: id, city: null, state: null, market: 'Columbus OH', type, tenantCount: 1, occPct: 1,
  acqDate: null, estValue100: 1_200_000, oxfordOwnPct: 1, oxfordValue: 1_200_000, noi, noiScenarioAdj: noi,
  grossIncome: noi, expenses: 0, debtService: 0, netCashFlow: noi, sf: 5_000, capRate: null, dscr: null, lender: null,
  loanBalance: 0, ltv: null, valuePerSf: null, rentPerSf: null, equityInvested: 0, cashOnCash: null, holdYrs: null,
  encumbered: false, flags: [],
});

function snapshot(): PortfolioSnapshot {
  return {
    meta: { schemaVersion: '1.0.0', asOf: ASOF, generatedAt: `${ASOF}T00:00:00.000Z`, source: 'test', scenario: 'Base' },
    assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: ASOF },
    properties: [row('inv-a', 'Flex', 80_000), row('inv-b', 'Retail', 40_000), row('9510-persimmon-tree-rd-potomac-md', 'Residence', 0)],
    leases: [], loans: [],
    cash: { asOf: ASOF, totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
    insurance: [], deals: [], tasks: [], counterparties: [], renewalStages: {}, tenantNotes: {},
    dealComps: {}, acquisitionInputs: {}, noiBudgets: {}, tenantArrears: {}, quickbooks: null,
    marketRents: {}, dataQuality: [],
  } as unknown as PortfolioSnapshot;
}

// Same property_master seeding as capital-allocation.balloon-fresh.test.ts freshDb() — the residence has
// NO property_master row in production (it has no P&L files — server/warehouse/reconcile-noi.ts:418).
function freshDb(prefix: string) {
  const db = openWarehouse(join(mkdtempSync(join(tmpdir(), prefix)), 'test.sqlite'));
  const ins = db.prepare(`
    INSERT OR IGNORE INTO property_master
      (id, name, market, financial_mode, rentable_sf, acquisition_date, ownership_pct, ownership_status)
    VALUES (?, ?, 'Test Market', 'pnl', 5000, '2020-01-01', 1, 'active')
  `);
  ins.run('inv-a', 'inv-a');
  ins.run('inv-b', 'inv-b');
  return db;
}

describe('buildCapitalAllocationReport — residence excluded (ratified 2026-09-24)', () => {
  it('entries, propertyCount and portfolioNoi cover investment properties only', async () => {
    const db = freshDb('ca-residence-');
    const report = await buildCapitalAllocationReport(db, snapshot());
    expect(report.entries.map((e) => e.propertyId).sort()).toEqual(['inv-a', 'inv-b']);
    expect(report.propertyCount).toBe(2);
    expect(report.portfolioNoi).toBe(120_000);
  });
  it('the sync-notion payload built from report.entries (api.ts:975-981) never names the residence', async () => {
    const db = freshDb('ca-residence-sync-');
    const report = await buildCapitalAllocationReport(db, snapshot());
    const payload = report.entries.map((e) => ({ propertyName: e.propertyName, capitalAction: e.capitalAction, priorityScore: e.priorityScore }));
    expect(payload.some((x) => x.propertyName === '9510-persimmon-tree-rd-potomac-md')).toBe(false);
    expect(payload).toHaveLength(2);
  });
});
