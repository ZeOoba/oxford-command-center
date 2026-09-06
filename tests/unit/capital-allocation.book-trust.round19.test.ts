// @vitest-environment node
//
// tests/unit/capital-allocation.book-trust.round19.test.ts
//
// Round 19 (2026-07-27 integrity sweep, H1 — third leg). buildVerdict defaulted a MISSING
// DebtScore to signal 'no-debt' / band 'adequate'. Under a trusted book that is correct: no
// active debt rows means a verified unlevered property. Under a DISTRUSTED book it is a false
// clearance of a different shape — a property whose loan rows were DESTROYED by the damaged write
// produces no DebtScore either, so a leveraged, possibly governor-breaching property was allocated
// as unlevered, erasing its governor-block and unblocking further capital deployment into it.
//
// scoreDebtPositions is mocked to return [] (the destroyed-rows state), so the trust level comes
// from the snapshot refusal marker in warehouse_meta — exactly the production fallback path.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../server/warehouse/scores', () => ({
  scoreProperties: vi.fn().mockReturnValue([]),
}));
// Round 19g: see capital-allocation-metrics-callcount.test.ts's note — capital-allocation.ts now
// calls scoreDebtPositionsWithTrust (one atomic read), and the mock must supply it too. This
// file's own tests (C4/C5/confidence) deliberately combine an empty scoreDebtPositions mock with
// a REAL marker via setDegradedMarker(db), so the empty-scores fallback MUST consult the real
// readDebtBookTrust rather than defaulting to 'trusted' — that shortcut is the exact bug class
// rounds 19e/19f closed in production; the mock must not resurrect it in tests.
import type { WarehouseDb as WarehouseDbForMock } from '../../server/warehouse/db';
vi.mock('../../server/warehouse/debt-scoring', async () => {
  const { readDebtBookTrust } = await import('../../server/warehouse/debt-trust');
  const scoreDebtPositions = vi.fn().mockReturnValue([]);
  return {
    scoreDebtPositions,
    scoreDebtPositionsWithTrust: vi.fn((db: unknown, ...rest: unknown[]) => {
      const scores = scoreDebtPositions(db, ...rest);
      return { scores, bookTrust: scores[0]?.bookTrust ?? readDebtBookTrust(db as WarehouseDbForMock) };
    }),
    noDebtScore: vi.fn(),
  };
});
vi.mock('../../server/warehouse/metrics', () => ({
  propertyPeriodMetrics: vi.fn().mockReturnValue([]),
  latestFullYearPeriod: vi.fn().mockReturnValue(null),
}));
vi.mock('../../src/analytics/lease-forecast', () => ({
  renewalSignals: vi.fn().mockReturnValue([]),
  bucketExpiry: vi.fn().mockReturnValue('12m+'),
}));
vi.mock('../../server/macro/getMacro', () => ({
  getMacro: vi.fn().mockRejectedValue(new Error('no macro in test')),
}));

import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import {
  buildPortfolioAllocation,
  buildCapitalAllocationReport,
} from '../../server/warehouse/capital-allocation';
import { scoreProperties } from '../../server/warehouse/scores';
import { scoreDebtPositions } from '../../server/warehouse/debt-scoring';
import type { PropertyScore } from '../../src/contracts/warehouse';
import type { DebtScore } from '../../src/contracts/debt';
import type { PortfolioSnapshot } from '../../src/contracts/index';

function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'cap-alloc-trust-r19-'));
  return openWarehouse(join(dir, 'finance.sqlite'));
}

/**
 * Seed one real, ATTRIBUTED active loan on an UNRELATED property so readDebtBookTrust(db) returns
 * 'trusted' for the whole book. Needed because a bare freshDb() has ZERO active debt_positions
 * rows, which readDebtBookTrust correctly reports as 'unknown' (H2b — "no debt" and "no data" are
 * not distinguishable) rather than 'trusted'; a control meant to isolate "genuinely trusted" from
 * "the floor's contribution" must not itself be untrusted for an unrelated reason.
 */
function seedTrustedLoan(db: WarehouseDb): void {
  db.prepare(
    `INSERT OR IGNORE INTO property_master
       (id, name, market, financial_mode, rentable_sf, acquisition_date, ownership_pct, ownership_status)
     VALUES ('prop-other', 'Other Property', 'Test Market', 'pnl', 10000, '2020-01-01', 1, 'active')`,
  ).run();
  db.prepare(
    `INSERT INTO debt_positions
       (id, snapshot_date, property_id, loan_name, lender, original_principal, current_balance,
        rate, loan_type, monthly_pmt, annual_interest, annual_principal, is_demand,
        maturity_date, months_to_maturity, ltv, balloon, status)
     VALUES ('loan-other', '2026-07-27', 'prop-other', 'Other Loan', 'Bank', 500000, 500000,
             0.06, 'Amortizing', 3000, null, null, 0, '2030-01-01', 48, 0.3, 0, 'active')`,
  ).run();
}

/** Write a real degraded marker in the exact shape readLastSnapshotRefusal parses. */
function setDegradedMarker(db: WarehouseDb): void {
  db.prepare(
    `INSERT INTO warehouse_meta (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(
    'debt_snapshot.last_write_refused',
    JSON.stringify({
      kind: 'degraded',
      reason: 'DEGRADED: test-injected damaged book',
      baselineCount: 1,
      originalReason: 'DEGRADED: test-injected damaged book',
      latchedAt: '2026-07-27T00:00:00.000Z',
      trustedIds: ['loan-destroyed'],
    }),
  );
}

function makeDebtScore(overrides: Partial<DebtScore> = {}): DebtScore {
  return {
    propertyId: 'prop-x',
    propertyName: 'Property X',
    noiBasis: 'spine-b/warehouse-ledger',
    dscr: null,
    dscrHeadroom: null,
    ltv: null,
    ltvHeadroom: null,
    debtYield: null,
    signal: 'hold',
    signalReason: null,
    score: 50,
    scoreBand: 'watch',
    capitalConfigVersion: 1,
    refiCashSavingsPct: null,
    bookTrust: 'degraded',
    ...overrides,
  };
}

/** Minimal PortfolioSnapshot for buildCapitalAllocationReport (the priorityScore/debtUrgency engine). */
function makeSnapshot(id: string, noi = 100_000): PortfolioSnapshot {
  const property = {
    index: 1,
    id,
    name: id,
    address: id,
    city: null,
    state: null,
    market: 'Columbus OH',
    type: 'Flex',
    tenantCount: 1,
    occPct: 1,
    acqDate: null,
    estValue100: 1_200_000,
    oxfordOwnPct: 1,
    oxfordValue: 1_200_000,
    noi,
    noiScenarioAdj: noi,
    grossIncome: noi + 5_000,
    expenses: 5_000,
    debtService: 0,
    netCashFlow: noi,
    sf: 5_000,
    tier: 'T2',
    leaseCount: 1,
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
  };
  return {
    meta: {
      schemaVersion: '1.0.0',
      asOf: '2026-07-27',
      generatedAt: '2026-07-27T00:00:00.000Z',
      source: 'test',
      scenario: 'Base',
    },
    assumptions: {
      activeScenario: 'Base',
      revenueFactor: 1,
      vacancyFactor: 1,
      exitCapFactor: 1,
      thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 },
      asOf: '2026-07-27',
    },
    properties: [property as unknown as PortfolioSnapshot['properties'][number]],
    leases: [],
    loans: [],
  } as unknown as PortfolioSnapshot;
}

function makePropertyScore(propertyId: string): PropertyScore {
  return {
    propertyId,
    propertyName: propertyId,
    score: 70,
    band: 'adequate',
    subScores: { noiPerSf: 70 },
    reasons: [],
    basis: 'cash',
    period: '2025',
  } as unknown as PropertyScore;
}

// The `scoreDebtPositions` mock is created ONCE by the vi.mock factory above and shared by every
// test in this file, and the repo sets no global clearMocks/resetMocks (see vitest.config.ts) — so
// a `mockReturnValue` set inside one test persists into every test that runs after it. The tests
// that rely on the factory's own `[]` default (the two H2b-parity cases below) therefore inherited
// whatever the last test to set it left behind: under shuffled order the round-8 governor-block
// case ran first and its injected DebtScore made `debtSignal` read 'governor-block' instead of
// 'hold' (reproduced deterministically with `npm run test:shuffle -- --sequence.seed=1788712019600`,
// which is what .github/workflows/order-fragility.yml runs). Re-establish the default before EVERY
// test so no test can depend on a predecessor. Note this cannot be solved with vitest's `mockReset`
// option: mockReset drops the factory's `mockReturnValue([])` too, leaving the mock returning
// undefined. The describes' own `scoreProperties` resets already follow this pattern.
beforeEach(() => {
  vi.mocked(scoreDebtPositions).mockReturnValue([]);
});

describe('capital allocation — a missing DebtScore under a distrusted book is UNKNOWN, not no-debt', () => {
  beforeEach(() => {
    vi.mocked(scoreProperties).mockReturnValue([makePropertyScore('prop-x')]);
  });

  // ROUND 19b CORRECTION. This test previously asserted that an EMPTY debt book with no marker is
  // reported as verified no-debt. An adversarial refuter reproduced that as its own false
  // clearance: on a warehouse where the debt backfill had never run, every property was allocated
  // as verified unlevered with band 'adequate'. debt-maturity.ts's ratified H2b doctrine already
  // refuses exactly this inference for the portfolio aggregate — "the warehouse cannot distinguish
  // 'no debt' from 'no data', so it must not guess" — so the two surfaces now agree.
  it('empty book with no marker is UNKNOWN debt, not verified no-debt (H2b parity)', async () => {
    const db = freshDb();
    const report = await buildPortfolioAllocation(db, '2026-07-27');
    const v = report.verdicts.find((x) => x.propertyId === 'prop-x');
    expect(v).toBeDefined();
    expect(v!.inputs.debtSignal).not.toBe('no-debt');
    expect(v!.inputs.debtSignal).toBe('hold');
  });

  it('degraded book: the same absence must NOT be presented as no-debt', async () => {
    const db = freshDb();
    setDegradedMarker(db);
    const report = await buildPortfolioAllocation(db, '2026-07-27');
    const v = report.verdicts.find((x) => x.propertyId === 'prop-x');
    expect(v).toBeDefined();
    // The property's loans may simply have been destroyed by the damaged write. Reporting
    // 'no-debt' asserts a verified unlevered property — a claim this data cannot support.
    expect(v!.inputs.debtSignal).not.toBe('no-debt');
    expect(v!.inputs.debtSignal).toBe('hold');
    // And it must be less confident than a verified no-debt property (0.45 base), not more.
    expect(v!.confidence01).toBeLessThan(0.45);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ROUND 19d — regression pins for the SECOND adversarial round (run against round 19b/19c).
// C4: unknown-debt urgency must FLOOR the measured value, never replace it.
// C5: a 'refused' marker must not make the report LESS conservative than no marker at all.
// Plus: the IC memo disclosure gap (dataQuality/reasons) and the confidence inversion.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('capital allocation — round 19d corrections', () => {
  beforeEach(() => {
    vi.mocked(scoreProperties).mockReturnValue([makePropertyScore('prop-x')]);
  });

  it('C4: unknown-debt urgency must FLOOR the measured value, never REPLACE a higher one', async () => {
    // 19b replaced the whole debtUrgency expression with the flat UNKNOWN_DEBT_URGENCY constant.
    // balloonTerm exceeds that constant for any balloon inside ~84 months, so a property whose
    // SURVIVING loan carries a near-term balloon would have its measured urgency (high) discarded
    // in favor of the flat constant (lower) — the fix meant to stop a property dropping in the
    // ranking made it drop. Pin the floor property directly: with no debt at all (measuredUrgency
    // 0), unknown debt must still score exactly the constant, and with debt data present it must
    // never score BELOW what the same figures would produce on a trusted book.
    vi.mocked(scoreDebtPositions).mockReturnValue([]);
    const db = freshDb();
    setDegradedMarker(db);
    const report = await buildCapitalAllocationReport(db, makeSnapshot('prop-x'), '2026-07-27');
    const entry = report.entries.find((e) => e.propertyId === 'prop-x')!;
    // debtScore undefined (destroyed rows) -> hasDebt=false -> measuredUrgency=0 -> the floor is
    // exactly UNKNOWN_DEBT_URGENCY=30, contributing 30*0.15=4.5 to priorityScore over the
    // healthVal/attentionScore/leasingRisk baseline (0 NOI + no leases here -> baseline ~32.5).
    // rationale is CapitalAllocationEntry's top-3-by-impact array of plain strings (not the
    // internal {text,impact} shape reasons[] uses before the slice/map at the source's tail).
    expect(entry.rationale.some((r) => /not trusted|withheld/i.test(r))).toBe(true);
    // Round 19g (adversarial refute, LOW — a real gap in this exact assertion): >=32.5 is the
    // no-urgency baseline ITSELF, so if a future edit ever collapsed debtUnknown back to false
    // (silently removing the floor's contribution), this assertion would still pass at exactly
    // 32.5. Compare against a TRUSTED control on the identical book-empty state instead — the
    // floor's whole contract is "no worse than 0 measured urgency," so degraded must be >= the
    // trusted-and-empty baseline, not merely >= some independently-recomputed number.
    const dbTrusted = freshDb();
    seedTrustedLoan(dbTrusted);
    const trustedReport = await buildCapitalAllocationReport(dbTrusted, makeSnapshot('prop-x'), '2026-07-27');
    const trustedEntry = trustedReport.entries.find((e) => e.propertyId === 'prop-x')!;
    expect(entry.priorityScore).toBeGreaterThan(trustedEntry.priorityScore);
    expect(entry.priorityScore).toBeCloseTo(trustedEntry.priorityScore + 4.5, 5);
  });

  it("C5: a 'refused' marker must not make the report LESS conservative than NO marker", async () => {
    vi.mocked(scoreDebtPositions).mockReturnValue([]);

    const dbNoMarker = freshDb();
    const reportNoMarker = await buildCapitalAllocationReport(
      dbNoMarker,
      makeSnapshot('prop-x'),
      '2026-07-27',
    );
    const eNoMarker = reportNoMarker.entries.find((e) => e.propertyId === 'prop-x')!;

    const dbRefused = freshDb();
    db_setRefusedMarker(dbRefused);
    const reportRefused = await buildCapitalAllocationReport(
      dbRefused,
      makeSnapshot('prop-x'),
      '2026-07-27',
    );
    const eRefused = reportRefused.entries.find((e) => e.propertyId === 'prop-x')!;

    // 19b required `reportBookTrust === 'degraded'` for BOTH conjuncts of debtUnknown, so a
    // standing 'refused' marker (empty score list) got NO unknown-debt treatment at all —
    // priorityScore 32.5, empty rationale — while the SAME warehouse with no marker got the debt
    // dimension floored to the constant and an explicit rationale line. Adding evidence that
    // something went wrong must never make the report read as MORE settled than having no
    // evidence at all.
    expect(eRefused.priorityScore).toBeGreaterThanOrEqual(eNoMarker.priorityScore);
    expect(eRefused.rationale.length).toBeGreaterThan(0);
  });

  it('confidence must be capped under a degraded book even when a DebtScore object is present', async () => {
    // 19b gated the low-confidence branch on `ds === null`, so a SURVIVING score whose figures
    // applyBookTrust had already emptied (dscr/ltv null, bookTrust 'degraded') kept the full 0.6
    // "scored" confidence — HIGHER than a property with no score row at all (0.3). Confidence was
    // highest exactly where the data had been deliberately withheld.
    vi.mocked(scoreDebtPositions).mockReturnValue([
      makeDebtScore({ bookTrust: 'degraded', dscr: null, ltv: null }),
    ]);
    const db = freshDb();
    // Round 19e: book-level trust is now derived independently from the real marker + real
    // debt_positions counts (readDebtBookTrust), not from the mocked score's own bookTrust field
    // — that decoupling is exactly the D1 fix (an unattributed loan could make the two disagree).
    // The marker must be set to match what this test is exercising.
    setDegradedMarker(db);
    const report = await buildPortfolioAllocation(db, '2026-07-27');
    const v = report.verdicts.find((x) => x.propertyId === 'prop-x')!;
    // baseConf 0.3 + subScore boost (min(0.05, subScoreKeys*0.01); 1 key in the fixture -> 0.01).
    // The regression this pins is 19a's bug value: baseConf 0.6 (+ boost) for a SURVIVING score
    // whose figures were already emptied by applyBookTrust — i.e. confidence HIGHEST exactly
    // where the data had been deliberately withheld. 0.31 is nowhere near that; 0.6+ would be.
    expect(v.confidence01).toBeLessThanOrEqual(0.35);
    expect(v.confidence01).toBeLessThan(0.6);
  });

  it('the IC-memo-bound verdict discloses debt-book distrust via dataQuality, not only a nulled number', async () => {
    vi.mocked(scoreDebtPositions).mockReturnValue([]);
    const db = freshDb();
    setDegradedMarker(db);
    const report = await buildPortfolioAllocation(db, '2026-07-27');
    const v = report.verdicts.find((x) => x.propertyId === 'prop-x')!;
    expect(v.dataQuality.some((f) => f.field === 'debtBook')).toBe(true);
    expect(v.inputs.bookTrust).toBe('degraded');
  });
});

/** PropertyScore fixture carrying an explicit healthBand — makePropertyScore above omits it
 * (ps.healthBand ends up undefined), which is invisible to these existing tests since none of
 * them assert on riskBand, but round 8's combinedRiskBand fix needs a real value to combine. */
function makeHealthScoredPropertyScore(propertyId: string, healthBand: 'excellent' | 'good' | 'watch' | 'concern'): PropertyScore {
  return {
    propertyId,
    propertyName: propertyId,
    score: 90,
    band: 'strong',
    healthBand,
    attentionBand: 'green',
    capitalAction: 'hold',
    subScores: { noiPerSf: 90 },
    reasons: [`Health 90/100 (${healthBand}).`],
    basis: 'cash',
    period: '2025',
  } as unknown as PropertyScore;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ROUND 8 fresh-sweep (adversarial refute, HIGH — reproduced with byte-identical rendered DOM on
// the Capital module UI). riskBand in the 'hold' branches used to come from healthBandToRisk(
// ps.healthBand) alone, ignoring debtScoreBand entirely. combinedRiskBand() now takes the more
// severe of the two — fixing both a pre-existing bug (a real governor-block/critical debt breach
// hidden by good operating health, independent of book trust) and the book-trust false-comfort
// case (an untrusted book can no longer read safer than 'elevated' purely because health is good).
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('capital allocation — round 8: riskBand must not be masked by good operating health', () => {
  it('a measured governor-block breach on a TRUSTED book renders riskBand "high", not "low"', async () => {
    vi.mocked(scoreProperties).mockReturnValue([makeHealthScoredPropertyScore('prop-x', 'excellent')]);
    vi.mocked(scoreDebtPositions).mockReturnValue([
      makeDebtScore({
        bookTrust: 'trusted',
        signal: 'governor-block',
        scoreBand: 'critical',
        dscr: 0.71,
      }),
    ]);
    const db = freshDb();
    seedTrustedLoan(db);
    const report = await buildPortfolioAllocation(db, '2026-07-27');
    const v = report.verdicts.find((x) => x.propertyId === 'prop-x')!;
    expect(v.inputs.bookTrust).toBe('trusted');
    expect(v.inputs.debtSignal).toBe('governor-block');
    expect(v.riskBand).toBe('high');
  });

  it('a DISTRUSTED book with no surviving DebtScore must not render riskBand "low" from health alone', async () => {
    vi.mocked(scoreProperties).mockReturnValue([makeHealthScoredPropertyScore('prop-x', 'excellent')]);
    vi.mocked(scoreDebtPositions).mockReturnValue([]);
    const db = freshDb();
    setDegradedMarker(db);
    const report = await buildPortfolioAllocation(db, '2026-07-27');
    const v = report.verdicts.find((x) => x.propertyId === 'prop-x')!;
    expect(v.inputs.bookTrust).toBe('degraded');
    expect(v.riskBand).not.toBe('low');
    expect(v.riskBand).toBe('elevated');
  });
});

/** A standing 'refused' marker in the exact shape readLastSnapshotRefusal parses. */
function db_setRefusedMarker(db: WarehouseDb): void {
  db.prepare(
    `INSERT INTO warehouse_meta (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(
    'debt_snapshot.last_write_refused',
    JSON.stringify({
      kind: 'refused',
      reason: 'REFUSED: test-injected shrinkage refusal',
      baselineCount: 1,
      originalReason: 'REFUSED: test-injected shrinkage refusal',
      latchedAt: '2026-07-27T00:00:00.000Z',
      trustedIds: ['loan-untouched'],
    }),
  );
}
