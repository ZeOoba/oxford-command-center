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
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Property, PortfolioSnapshot } from '../../src/contracts/index';
import { CapitalAllocationReport } from '../../src/contracts/capital-allocation';
import { openWarehouse } from '../../server/warehouse/db';
import { ingestFile } from '../../server/warehouse/ingest';
import { seedMappings } from '../../server/warehouse/mapping';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import { buildCapitalAllocationReport } from '../../server/warehouse/capital-allocation';

// buildCapitalAllocationReport now derives lease-expiry buckets off the RUN date (referenceDate(),
// portfolio-wide run-date basis). Pin REPORT_DATE to a fixed date DELIBERATELY ≠ the fixture's
// meta.asOf (2026-06-22) so these route-level tests LOCK the run-date wiring: with refDate ===
// meta.asOf a silent revert of the cap-alloc refDate plumbing back to meta.asOf would still pass.
// 2026-08-22 is two months after the data date, so the I-6 "expired-since-run-date" lease (leaseEnd
// 2026-07-15) is excluded from nearTermExpiryRent under the run date but WOULD be counted under
// meta.asOf — making the === 50_000 assertion fail on a revert. Fixed date → deterministic across
// wall-clock dates; production still uses the true run date.
const PINNED_REPORT_DATE = '2026-08-22';
let priorReportDate: string | undefined;
beforeAll(() => { priorReportDate = process.env.REPORT_DATE; process.env.REPORT_DATE = PINNED_REPORT_DATE; });
afterAll(() => { if (priorReportDate === undefined) delete process.env.REPORT_DATE; else process.env.REPORT_DATE = priorReportDate; });

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

  // ── H2: nearTermExpiryRent must be Oxford-share basis (scaled by oxfordOwnPct) ──────────
  //
  // Bug: The accumulation loop summed lease.annualRent at 100%-basis. For fractional-ownership
  // properties, this overstates the numerator relative to property.noi (Oxford-share), making
  // leasingRisk = (nearTermExpiryRent / noi) inflated by 1/ownershipPct.
  //
  // Fix: scale lease.annualRent by the property's oxfordOwnPct before accumulating.
  //
  // Affected properties: Red Branch Rd Columbia MD (50%), N Broadway (50%), Solar (25%).
  //
  // This test must FAIL before the fix and PASS after.
  it('I-6 (H2): nearTermExpiryRent is Oxford-share (scaled by oxfordOwnPct), not 100%-basis', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cap-int-h2-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);

    // 50%-owned property (e.g., Red Branch Rd Columbia MD). Oxford-share NOI = 95_000 (Spine A).
    // Three leases below exercise: (L-H2-1) the H2 Oxford-share scaling fix on its own, (L-H2-2)
    // a freshly-lapsed material tenant still counting toward nearTermExpiryRent, and (L-H2-3) a
    // genuinely-stale-expired lease that must NOT count. See the assertions below for the totals.
    const snapshot: ReturnType<typeof makeSnapshot> = {
      ...makeSnapshot([
        makeProperty({
          id: '9050-red-branch-rd-columbia-md',
          noi: 95_000,
          sf: 25_000,
          oxfordOwnPct: 0.50,   // 50% fractional ownership
          oxfordValue: 1_900_000,
        }),
      ]),
      // L-H2-3 gets an 'Executed' renewal stage purely to keep it out of renewalSignals'
      // 'lapsing' band (which fires on ANY past leaseEnd with no stage recorded, regardless of
      // lease status) — that classification is a separate, pre-existing mechanism this test isn't
      // exercising; without it, L-H2-3 would also add +10 to atRiskLikelihoodCount and the
      // priorityScore assertion below would need to account for two unrelated concerns at once.
      renewalStages: { 'L-H2-3-STALE-EXPIRED': 'Executed' },
      leases: [
        {
          id: 'L-H2-1',
          propertyId: '9050-red-branch-rd-columbia-md',
          // ABATED lease: year-1 cash annualRent is NET of 1.2 abated months (90_000) while the contract rate is
          // monthlyRent x 12 = 100_000. nearTermExpiryRent is rent lost at expiry = CONTRACT basis, so every
          // expectation below stays 100_000 x 0.50 = 50_000; reverting capital-allocation.ts to annualRent
          // would read 45_000 and fail this test.
          annualRent: 90_000,   // 100%-basis year-1 cash rent, net of abatement
          monthlyRent: 100_000 / 12,
          sf: 12_000,
          monthsToExpiry: 3,    // ≤12m — '0-6m' bucket (leaseEnd 2026-09-30 > run date 2026-08-22)
          leaseEnd: '2026-09-30',
          leaseStart: '2022-09-30',
          status: 'Active' as const,
          company: 'Fractional Tenant LLC',
          tenantName: 'Fractional Tenant LLC',
          monthToMonth: false,
          leaseType: 'NNN' as const,
          escalation: null,
          escalationPct: null,
          escalationFlat: null,
          options: [],
          flags: [],
        } as unknown as PortfolioSnapshot['leases'][number],
        {
          // FRESHLY-LAPSED LOCK (Gabriel-ratified 2026-07-12): this lease ENDED 2026-07-15 — after
          // the fixture data date (meta.asOf 2026-06-22) but BEFORE the pinned run date
          // (2026-08-22). It buckets 'expired' against the run date, but because leaseEnd >= asOf
          // (it was still current as of the workbook snapshot), it keeps contributing to
          // nearTermExpiryRent — a freshly-lapsed material tenant must not silently drop out of the
          // dollar-weighted leasingRisk term. Adds 40_000 × 0.50 = 20_000.
          id: 'L-H2-2-FRESHLY-LAPSED',
          propertyId: '9050-red-branch-rd-columbia-md',
          annualRent: 40_000,
          monthlyRent: 40_000 / 12,
          sf: 5_000,
          monthsToExpiry: 0,
          leaseEnd: '2026-07-15',
          leaseStart: '2021-07-15',
          status: 'Active' as const,
          company: 'Lapsed Tenant LLC',
          tenantName: 'Lapsed Tenant LLC',
          monthToMonth: false,
          leaseType: 'NNN' as const,
          escalation: null,
          escalationPct: null,
          escalationFlat: null,
          options: [],
          flags: [],
        } as unknown as PortfolioSnapshot['leases'][number],
        {
          // GENUINELY-STALE EXCLUSION LOCK: this lease ended 2026-01-15 — BEFORE the fixture data
          // date itself (meta.asOf 2026-06-22), not in the workbook-to-run-date gap. It is NOT a
          // "freshly lapsed" tenant — it was already expired as of the workbook's own snapshot, so
          // it stays excluded from nearTermExpiryRent exactly as it always has (this is not a case
          // the frozen-dateline fix or this follow-up created). status:'Expired' + a long tenure
          // also keeps it out of atRiskLikelihoodCount's 'lapsing' band so it can't perturb the
          // leasingRisk assertion below either way — this lease should have ZERO effect on the
          // report, proving the freshly-lapsed inclusion has a real boundary, not "any expired
          // lease counts forever."
          id: 'L-H2-3-STALE-EXPIRED',
          propertyId: '9050-red-branch-rd-columbia-md',
          annualRent: 30_000,
          monthlyRent: 30_000 / 12,
          sf: 4_000,
          monthsToExpiry: -5,
          leaseEnd: '2026-01-15',
          leaseStart: '2015-01-01',
          status: 'Expired' as const,
          company: 'Stale Expired LLC',
          tenantName: 'Stale Expired LLC',
          monthToMonth: false,
          leaseType: 'NNN' as const,
          escalation: null,
          escalationPct: null,
          escalationFlat: null,
          options: [],
          flags: [],
        } as unknown as PortfolioSnapshot['leases'][number],
      ],
    };

    const report = await buildCapitalAllocationReport(db, snapshot);

    expect(report.entries).toHaveLength(1);
    const entry = report.entries[0]!;

    // Core assertion: nearTermExpiryRent = L-H2-1 (100_000 × 0.50 = 50_000, unaffected — still in
    // the '0-6m' bucket relative to the run date) + L-H2-2 (40_000 × 0.50 = 20_000, freshly lapsed,
    // now included) = 70_000. NOT 100%-basis (140_000), and NOT 85_000 — L-H2-3 (stale-expired,
    // 30_000 × 0.50 = 15_000) must NOT be added; it was already expired as of the workbook's own
    // data date, not a lapse created by the run-date basis.
    expect(entry.nearTermExpiryRent).toBe(70_000);

    // Secondary: leasingRisk = min(100, (nearTermExpiryRent/noi)*100 + atRiskLikelihoodCount*10)
    //   = min(100, (70_000/95_000)*100 + 1*10) = min(100, 73.684 + 10) = 83.684
    // (atRiskLikelihoodCount = 1: only L-H2-2 classifies 'lapsing' in renewalSignals — leaseEndInPast
    // relative to the run date and status !== 'Expired'; L-H2-1 is far out and L-H2-3's
    // status:'Expired' + long tenure keep it out of every at-risk/lapsing band.)
    // priorityScore = (100-healthVal)*0.35 + attentionScore*0.30 + leasingRisk*0.20 + debtUrgency*0.15
    //   healthVal/attentionScore default to 50 (unscored property).
    //
    // ROUND 19b: debtUrgency is now UNKNOWN_DEBT_URGENCY (30), not 0. This fixture seeds no
    // debt_positions rows at all, and an adversarial refuter reproduced that state being reported
    // as a VERIFIED unlevered portfolio — every property allocated as debt-free with band
    // 'adequate' on a warehouse where the debt backfill had simply never run. debt-maturity.ts's
    // ratified H2b doctrine already refuses that inference for the portfolio aggregate ("the
    // warehouse cannot distinguish 'no debt' from 'no data', so it must not guess"); capital
    // allocation now agrees, and an empty book scores as unknown-debt rather than no-debt.
    //   = (100-50)*0.35 + 50*0.30 + 83.684*0.20 + 30*0.15
    //   = 17.5 + 15 + 16.7368 + 4.5 ≈ 53.7368
    // The subject of THIS test — nearTermExpiryRent Oxford-share scaling, the 83.684 leasingRisk
    // term — is unchanged; the whole delta is the new debt term.
    expect(entry.priorityScore).toBeCloseTo(53.7368, 3);
  });
});
