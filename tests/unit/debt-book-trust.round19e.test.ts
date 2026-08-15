// @vitest-environment node
//
// tests/unit/debt-book-trust.round19e.test.ts
//
// Round 19e — regression pins for the THIRD adversarial round, run against round 19d. Three
// independent lenses found real defects; the most severe are pinned here against real DB state
// (not mocks), because that is exactly what let them ship in the first place.
//
//   E1  TRUST-BASIS DIVERGENCE (HIGH, lens 1). /scores, /maturity, /timeline derived trust from a
//       raw COUNT(*) over debt_positions with no property_id filter; capital-allocation derived it
//       from scoreDebtPositions' OUTPUT LENGTH, which only counts ATTRIBUTED properties, and its
//       zero-score branch passed a hardcoded literal 0 instead of the real row count. An
//       unattributed loan (a documented, warn-only production state — one typo'd collateral-
//       property name) made the two surfaces disagree on identical DB state, and with partial
//       attribution capital-allocation silently ignored the unattributed loan entirely — a $9M
//       loan with a near-term balloon vanished from the allocation, reporting 'no-debt'/'trusted'.
//       Fixed by extracting ONE db-reading function (readDebtBookTrust) that every consumer calls.
//
//   E2  URGENCY FLOOR WAS A NO-OP (MEDIUM-HIGH, lens 2). `Math.max(UNKNOWN_DEBT_URGENCY,
//       measuredUrgency)` always evaluated to the constant, because measuredUrgency was computed
//       from the SAME variables (effectiveBalloonMonths, dscr) that debtUnknown had just withheld
//       to null. A 3-month balloon and a 10-year balloon scored identically once degraded, and a
//       real breach still dropped 47.5 -> 37 — the exact regression the comment claimed to fix.
//
//   E3  trustedIds/absentIds NOT DISJOINT (HIGH, lens 3). A refusal latches the WHOLE untouched
//       book into trustedIds (not only ids that ever failed an insert). If one of those ids then
//       vanishes, it lands in absentIds too — but trustedIds only discharges via
//       writtenIds.has(id), which a permanently-gone loan can never satisfy. confirmAbsent became
//       permanently unreachable for that id, leaving the blanket allowEmptySupersede amnesty as
//       the only exit — precisely the reflex confirmAbsent was built to stop training.
//
//   E4  a terminal-status restatement did not discharge a STANDING absentIds entry (LOW, lens 3).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../server/warehouse/scores', () => ({ scoreProperties: vi.fn().mockReturnValue([]) }));
// Round 19f (adversarial refute of 19e, HIGH — confirmed by a second independent lens): the
// module-level default here is `propertyPeriodMetrics -> []`, meaning NO test in this file has a
// real NOI unless it explicitly overrides this mock. The original E1 test never did, so its
// `debtScore.dscr === null` assertion held for the WRONG reason — no NOI to compute a DSCR from at
// all — rather than because the unattributed-loan withholding actually fired. It would have passed
// against the pre-round-19f defect (dscr left un-withheld) exactly as it passed against the fix.
// Real latestFullYearPeriod is kept via importOriginal below (not re-mocked to null) so a test
// that supplies real metrics gets real period selection, not an unconditional null short-circuit.
import type * as MetricsModule from '../../server/warehouse/metrics';
vi.mock('../../server/warehouse/metrics', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof MetricsModule;
  return {
    ...actual,
    propertyPeriodMetrics: vi.fn().mockReturnValue([]),
  };
});
vi.mock('../../src/analytics/lease-forecast', () => ({
  renewalSignals: vi.fn().mockReturnValue([]),
  bucketExpiry: vi.fn().mockReturnValue('12m+'),
}));
vi.mock('../../server/macro/getMacro', () => ({
  getMacro: vi.fn().mockRejectedValue(new Error('no macro in test')),
}));

import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { writeDebtSnapshot, readLastSnapshotRefusal } from '../../server/warehouse/debt-snapshot';
import { readDebtBookTrust, deriveDebtBookTrust } from '../../server/warehouse/debt-trust';
import { scoreDebtPositions } from '../../server/warehouse/debt-scoring';
import { buildCapitalAllocationReport } from '../../server/warehouse/capital-allocation';
import { scoreProperties } from '../../server/warehouse/scores';
import { propertyPeriodMetrics } from '../../server/warehouse/metrics';
import type { PropertyScore, PeriodMetrics } from '../../src/contracts/warehouse';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import type { Loan } from '../../src/contracts/index';

function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'debt-trust-r19e-'));
  return openWarehouse(join(dir, 'test.sqlite'));
}

function seedProperty(db: WarehouseDb, id: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO property_master
       (id, name, market, financial_mode, rentable_sf, acquisition_date, ownership_pct, ownership_status)
     VALUES (?, ?, 'Test Market', 'pnl', 10000, '2020-01-01', 1, 'active')`,
  ).run(id, id);
}

function loan(overrides: Partial<Loan> & { id: string }): Loan {
  return {
    name: `Loan ${overrides.id}`,
    counterparty: 'Bank',
    direction: 'borrower',
    originalPrincipal: 1_000_000,
    currentBalance: 1_000_000,
    absBalance: 1_000_000,
    rate: 0.065,
    monthlyPmt: 5_700,
    annualInterest: 55_250,
    annualPrincipal: 13_150,
    loanType: 'Amortizing',
    status: 'Amortizing',
    isDemand: false,
    maturity: '2030-06-01',
    monthsToMaturity: 48,
    ltv: 0.35,
    lender: 'Bank',
    balloon: false,
    flags: [],
    collateralProperty: null,
    ...overrides,
  };
}

describe('E1 — trust basis must be identical across every consumer', () => {
  it('a real ALL-unattributed active loan is degraded, not trusted (no property_id filter gap)', () => {
    const db = freshDb();
    // Empty crosswalk map -> writeDebtSnapshot writes property_id = NULL, exactly as
    // buildLoanPropertyMap does for an unresolved collateralProperty in production.
    writeDebtSnapshot(db, [loan({ id: 'l1', absBalance: 9_000_000 })], '2026-07-01', new Map());
    const rows = db.prepare("SELECT property_id FROM debt_positions WHERE status='active'").all();
    expect(rows).toEqual([{ property_id: null }]);

    expect(readDebtBookTrust(db)).toBe('degraded');
  });

  it('pure function: unattributedActiveCount > 0 forces non-trusted even with attributed rows present', () => {
    expect(deriveDebtBookTrust(null, 5, 0)).toBe('trusted');
    expect(deriveDebtBookTrust(null, 5, 1)).toBe('degraded'); // partial attribution
    expect(deriveDebtBookTrust(null, 0, 0)).toBe('unknown');
    // Round 19h: unattributed rows now win over a 'refused' marker -- a refusal touches zero
    // rows and must never upgrade trust past what the unattributed count alone would report.
    expect(deriveDebtBookTrust({ kind: 'refused' }, 5, 1)).toBe('degraded');
    expect(deriveDebtBookTrust({ kind: 'refused' }, 5, 0)).toBe('refused'); // marker still wins absent unattributed rows
    expect(deriveDebtBookTrust({ kind: 'degraded' }, 5, 0)).toBe('degraded'); // degraded marker always wins
  });

  function metricsFor(propertyId: string, noi = 200_000): PeriodMetrics[] {
    return [
      {
        propertyId,
        propertyName: null,
        period: '2025',
        grainHint: 'year',
        basis: 'cash',
        rentableSf: 10_000,
        ownershipPct: 1,
        revenue: noi,
        opex: 0,
        noi,
        noiMargin: null,
        expenseRatio: null,
        capex: 0,
        ti: 0,
        leasing: 0,
        categories: {},
        revenueCategories: {},
        revenuePerSf: null,
        noiPerSf: null,
        expensePerSf: null,
        taxesPerSf: null,
        insurancePerSf: null,
        repairsPerSf: null,
        oxfordNoi: noi,
      },
    ];
  }

  it('scoreDebtPositions itself must withhold dscr for an unattributed-loan book — not just the report layer', () => {
    // Round 19f (adversarial refute of 19e, CRITICAL — reproduced by two independent lenses): the
    // envelope's bookTrust ('degraded', via readDebtBookTrust) and the per-score bookTrust
    // (previously derived from the marker ALONE, via applyBookTrust) could disagree on the exact
    // same response — 'degraded' on the envelope, 'trusted' on every score, full DSCR/LTV
    // published, and a clearance-direction 'cash-out'/'refinance' signal. This is the ROOT-CAUSE
    // level test: it does not go through capital-allocation at all, so it cannot pass by accident
    // via a missing/mocked NOI the way the report-level test below originally did.
    const db = freshDb();
    seedProperty(db, 'p1');
    const map = new Map([['attributed', 'p1']]);
    writeDebtSnapshot(
      db,
      [
        loan({ id: 'attributed', absBalance: 500_000, ltv: 0.3 }),
        loan({ id: 'unattributed', absBalance: 9_000_000, ltv: 0.9 }),
      ],
      '2026-07-01',
      map,
    );
    expect(readDebtBookTrust(db)).toBe('degraded');

    const scores = scoreDebtPositions(db, metricsFor('p1'), null, '2026-07-27');
    const p1 = scores.find((s) => s.propertyId === 'p1')!;

    expect(p1.bookTrust).toBe('degraded'); // must match the envelope, not merely the marker
    expect(p1.dscr).toBeNull();
    expect(p1.ltv).toBeNull();
    expect(p1.signal).not.toBe('cash-out');
    expect(p1.signal).not.toBe('refi');
  });

  it('capital allocation must NOT ignore an unattributed loan via the debtScores.length shortcut', async () => {
    vi.mocked(scoreProperties).mockReturnValue([makePropertyScore('p1')]);
    vi.mocked(propertyPeriodMetrics).mockReturnValue(metricsFor('p1'));
    const db = freshDb();
    seedProperty(db, 'p1');
    const map = new Map([['attributed', 'p1']]);
    // One attributed loan (scoreDebtPositions WILL emit a score for p1) plus one unattributed
    // $9M loan with a 3-month balloon that the crosswalk could not resolve at all.
    writeDebtSnapshot(
      db,
      [
        loan({ id: 'attributed', absBalance: 500_000, ltv: 0.3 }),
        loan({
          id: 'unattributed',
          absBalance: 9_000_000,
          ltv: 0.9,
          balloon: true,
          maturity: '2026-10-27',
          monthsToMaturity: 3,
        }),
      ],
      '2026-07-01',
      map,
    );
    const active = db
      .prepare("SELECT id, property_id FROM debt_positions WHERE status='active' ORDER BY id")
      .all();
    expect(active).toEqual([
      { id: 'attributed', property_id: 'p1' },
      { id: 'unattributed', property_id: null },
    ]);

    const snapshot = makeSnapshot('p1');
    const report = await buildCapitalAllocationReport(db, snapshot, '2026-07-27');
    const entry = report.entries.find((e) => e.propertyId === 'p1')!;

    // Round 19d fixed this exact shape for the DESTROYED-rows case (debtScore undefined). Round
    // 19e closes the sibling case: a debtScore IS present (for the attributed loan), so the old
    // `debtScores.length > 0 -> 'trusted'` shortcut would have hidden the unattributed $9M loan
    // completely. With REAL NOI present (unlike the original version of this test, which passed
    // for the wrong reason on an empty NOI mock — see the file-header note), the property must be
    // flagged and its figures withheld, not reported as a clean 'trusted' book with a real DSCR.
    expect(entry.rationale.some((r) => /not trusted|withheld/i.test(r))).toBe(true);
    expect(entry.dscr).toBeNull();
    expect(entry.debtScore).toBeNull();
  });
});

describe('E2 — the unknown-debt urgency floor must be a genuine floor, not a disguised replacement', () => {
  it('a real surviving near-term balloon under a degraded book scores AT LEAST its measured urgency', async () => {
    vi.mocked(scoreProperties).mockReturnValue([makePropertyScore('p1')]);
    const db = freshDb();
    seedProperty(db, 'p1');
    const map = new Map([
      ['survivor', 'p1'],
      ['poisoned', 'p1'],
    ]);
    // Two loans on p1: one with a genuine 3-month balloon that will SURVIVE; one that will be
    // destroyed by a failed insert (the repo's own reproduced degraded-write primitive), latching
    // the marker to 'degraded' without touching the survivor's row.
    const survivor = loan({
      id: 'survivor',
      absBalance: 1_000_000,
      balloon: true,
      maturity: '2026-10-27', // ~3 months from the 2026-07-27 asOf below
      monthsToMaturity: 3,
    });
    writeDebtSnapshot(db, [survivor, loan({ id: 'poisoned', absBalance: 500_000 })], '2026-07-01', map);
    const damaged = writeDebtSnapshot(
      db,
      [survivor, loan({ id: 'poisoned', absBalance: NaN })],
      '2026-07-02',
      map,
    );
    expect(damaged.degradedRows).toBe(1);
    expect(readDebtBookTrust(db)).toBe('degraded');

    const snapshot = makeSnapshot('p1');
    const reportDegraded = await buildCapitalAllocationReport(db, snapshot, '2026-07-27');
    const degradedEntry = reportDegraded.entries.find((e) => e.propertyId === 'p1')!;

    // A property with NO balloon data at all, same degraded state, for comparison — this is what
    // the flat constant alone produces.
    const db2 = freshDb();
    seedProperty(db2, 'p2');
    vi.mocked(scoreProperties).mockReturnValue([makePropertyScore('p2')]);
    const map2 = new Map([['poisoned2', 'p2']]);
    writeDebtSnapshot(db2, [loan({ id: 'poisoned2', absBalance: 500_000 })], '2026-07-01', map2);
    writeDebtSnapshot(db2, [loan({ id: 'poisoned2', absBalance: NaN })], '2026-07-02', map2);
    const reportFlat = await buildCapitalAllocationReport(db2, makeSnapshot('p2'), '2026-07-27');
    const flatEntry = reportFlat.entries.find((e) => e.propertyId === 'p2')!;

    // The near-term-balloon property must score AT LEAST as urgent as the no-signal property —
    // a genuine floor never lets a real measured signal be discarded in favor of the constant.
    expect(degradedEntry.priorityScore).toBeGreaterThanOrEqual(flatEntry.priorityScore);
    // And DISPLAY must still be withheld — the fix is internal-only, not a new leak.
    expect(degradedEntry.balloonMonths).toBeNull();
    expect(degradedEntry.dscr).toBeNull();
  });
});

describe('E3 — confirmAbsent must remain reachable after a refusal (trustedIds/absentIds disjoint)', () => {
  it('refusal (whole book -> trustedIds) -> payoff-by-row-deletion -> confirmAbsent clears', () => {
    const db = freshDb();
    const map = new Map<string, string>();
    const loans: Loan[] = [];
    for (let i = 1; i <= 6; i++) {
      const id = `l${i}`;
      seedProperty(db, `p${i}`);
      map.set(id, `p${i}`);
      loans.push(loan({ id, absBalance: 1_000_000 }));
    }
    writeDebtSnapshot(db, loans, '2026-07-01', map);

    // Parser regression drops 4 of 6 -> shrinkage guard REFUSES. Marker latches the WHOLE
    // untouched book into trustedIds (this is what makes the id land in both lists later).
    const refused = writeDebtSnapshot(db, loans.slice(0, 2), '2026-07-02', map);
    expect(refused.refusedEmptySupersede).toBe(true);
    expect(readLastSnapshotRefusal(db)!.trustedIds).toEqual(
      expect.arrayContaining(['l1', 'l2', 'l3', 'l4', 'l5', 'l6']),
    );

    // Parser fixed; l6 was genuinely paid off and its row deleted (round-14's exact scenario).
    const vanished = writeDebtSnapshot(db, loans.slice(0, 5), '2026-07-03', map);
    expect(vanished.vanishedIds).toEqual(['l6']);

    // l6 must be reachable via confirmAbsent — not stuck because it is ALSO still sitting in
    // trustedIds from the refusal, which only writtenIds.has() can discharge and a permanently
    // gone loan can never satisfy.
    for (let attempt = 0; attempt < 5; attempt++) {
      writeDebtSnapshot(db, loans.slice(0, 5), `2026-07-1${attempt}`, map, { confirmAbsent: ['l6'] });
    }
    expect(readLastSnapshotRefusal(db)).toBeNull();
  });

  it('one insert failure (not a refusal) still latches the whole intended book — the same trap, no refusal needed', () => {
    const db = freshDb();
    const map = new Map<string, string>();
    const loans: Loan[] = [];
    for (let i = 1; i <= 3; i++) {
      const id = `l${i}`;
      seedProperty(db, `p${i}`);
      map.set(id, `p${i}`);
      loans.push(loan({ id, absBalance: 1_000_000 }));
    }
    writeDebtSnapshot(db, loans, '2026-07-01', map);

    // l1 fails to insert (unrelated to l3); damageStartsNow latches the WHOLE intended book,
    // successes included, into trustedIds — including l3, which never failed anything.
    const damaged = writeDebtSnapshot(
      db,
      [loan({ id: 'l1', absBalance: NaN }), loans[1]!, loans[2]!],
      '2026-07-02',
      map,
    );
    expect(damaged.degradedRows).toBe(1);
    expect(readLastSnapshotRefusal(db)!.trustedIds).toEqual(expect.arrayContaining(['l3']));

    // Two writes later, l3 is genuinely paid off and its row deleted.
    writeDebtSnapshot(db, [loans[0]!, loans[1]!], '2026-07-03', map);

    for (let attempt = 0; attempt < 3; attempt++) {
      writeDebtSnapshot(db, [loans[0]!, loans[1]!], `2026-07-1${attempt}`, map, {
        confirmAbsent: ['l3'],
      });
    }
    // l1's real damage must still be independently trackable/held if unresolved — but l3 specifically
    // must not be an unrecoverable trustedIds entry once confirmed absent.
    const marker = readLastSnapshotRefusal(db);
    if (marker !== null) {
      expect(marker.trustedIds ?? []).not.toContain('l3');
    }
  });
});

describe('E4 — a terminal restatement discharges a STANDING absentIds entry, not just prevents a new one', () => {
  it('restoring a vanished loan with status Paid in Full clears its absentIds obligation', () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    seedProperty(db, 'p2');
    const map = new Map([
      ['l1', 'p1'],
      ['l2', 'p2'],
    ]);
    writeDebtSnapshot(db, [loan({ id: 'l1' }), loan({ id: 'l2' })], '2026-07-01', map);

    // l2's row is deleted -> latches absentIds:['l2'].
    writeDebtSnapshot(db, [loan({ id: 'l1' })], '2026-07-02', map);
    expect(readLastSnapshotRefusal(db)!.absentIds).toEqual(['l2']);

    // The operator restores it the honest, self-documenting way instead of confirmAbsent.
    writeDebtSnapshot(
      db,
      [loan({ id: 'l1' }), loan({ id: 'l2', status: 'Paid in Full' })],
      '2026-07-03',
      map,
    );
    expect(readLastSnapshotRefusal(db)).toBeNull();
  });
});

// ── shared fixtures ─────────────────────────────────────────────────────────────────────────

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
