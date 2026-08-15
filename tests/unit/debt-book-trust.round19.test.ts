// @vitest-environment node
//
// tests/unit/debt-book-trust.round19.test.ts
//
// Round 19 (2026-07-27 financial-code integrity sweep, H1 + H2 — both reproduced end-to-end
// against HEAD 958402a before this file existed). One defect CLASS, three legs:
//
//   H2  the shrinkage guard's loss accounting is PER-WRITE, so losses arriving across several
//       writes never accumulate — a 12→1 wipe refused in one write sails through as
//       12→7→4→3→2→1, minting a Hard-Invariant-4 aggregate clearance with 11 loans off-book.
//       Root cause: `unexplainedSupersededIds` IS computed correctly on every write, then
//       DISCARDED in the clean-write-from-clean-state branch (debt-snapshot.ts, the
//       `standing === null` arm of the marker lifecycle).
//
//   H1  the degraded/refused trust marker is honored by exactly ONE consumer
//       (computePortfolioAggregateLtv). scoreDebtPositions, persistDebtScores, and the
//       capital-allocation verdict builder all read the same distrusted rows with no marker
//       awareness, so a degraded write flips a governor-blocked property to "Governors clear"
//       and appends that clearance to the permanent debt_scores trend history.
//
// The shared class: trust in the debt book is COMPUTED but neither DURABLE (H2) nor ENFORCED AT
// THE BOUNDARY (H1). These tests pin both.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { writeDebtSnapshot, readLastSnapshotRefusal } from '../../server/warehouse/debt-snapshot';
import { computePortfolioAggregateLtv } from '../../server/warehouse/debt-maturity';
import { scoreDebtPositions } from '../../server/warehouse/debt-scoring';
import { persistDebtScores } from '../../server/warehouse/debt-scores-persistence';
import type { PeriodMetrics } from '../../src/contracts/warehouse';
import type { Loan } from '../../src/contracts/index';

function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'debt-book-trust-r19-'));
  return openWarehouse(join(dir, 'test.sqlite'));
}

function seedProperty(db: WarehouseDb, id: string, name: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO property_master
       (id, name, market, financial_mode, rentable_sf, acquisition_date, ownership_pct, ownership_status)
     VALUES (?, ?, 'Test Market', 'pnl', 10000, '2020-01-01', 1, 'active')`,
  ).run(id, name);
}

function makeBorrowerLoan(overrides: Partial<Loan> = {}): Loan {
  return {
    id: 'loan-001',
    name: 'First Mortgage',
    counterparty: 'First National Bank',
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
    ltv: 0.62,
    lender: 'First National Bank',
    balloon: false,
    flags: [],
    collateralProperty: null,
    ...overrides,
  };
}

function makePeriodMetrics(
  overrides: Partial<PeriodMetrics> & { propertyId: string; noi: number },
): PeriodMetrics {
  return {
    propertyId: overrides.propertyId,
    propertyName: overrides.propertyName ?? null,
    period: overrides.period ?? '2025',
    grainHint: overrides.grainHint ?? 'year',
    basis: overrides.basis ?? 'cash',
    rentableSf: overrides.rentableSf ?? 10_000,
    ownershipPct: overrides.ownershipPct ?? 1,
    revenue: overrides.revenue ?? overrides.noi,
    opex: overrides.opex ?? 0,
    noi: overrides.noi,
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
    oxfordNoi: overrides.noi,
  };
}

/**
 * A 12-property book. loan-01 is a LOW-LTV survivor (0.35, comfortably inside the 0.40
 * Hard-Invariant-4 ceiling); loans 02-12 are HIGH-LTV (0.55). The complete book aggregates to
 * ~0.525 — a genuine breach. Reduced to loan-01 alone it aggregates to exactly 0.35 — a
 * clearance. That gap is the false clearance H2 mints.
 */
const BOOK_IDS = Array.from({ length: 12 }, (_, i) => `loan-${String(i + 1).padStart(2, '0')}`);

function buildBook(db: WarehouseDb): { loans: Loan[]; map: Map<string, string> } {
  const loans: Loan[] = [];
  const map = new Map<string, string>();
  BOOK_IDS.forEach((id, i) => {
    const propId = `prop-${String(i + 1).padStart(2, '0')}`;
    seedProperty(db, propId, `Property ${i + 1}`);
    loans.push(makeBorrowerLoan({ id, ltv: i === 0 ? 0.35 : 0.55, absBalance: 1_000_000 }));
    map.set(id, propId);
  });
  return { loans, map };
}

describe('H2 — shrinkage guard must accumulate loss across writes, not only within one', () => {
  it('CONTROL: the same 12→1 collapse in a SINGLE write is refused (guard works one-shot)', () => {
    const db = freshDb();
    const { loans, map } = buildBook(db);
    expect(writeDebtSnapshot(db, loans, '2026-07-01', map).written).toBe(12);

    const res = writeDebtSnapshot(db, loans.slice(0, 1), '2026-07-02', map);
    expect(res.refusedEmptySupersede).toBe(true);
    expect(readLastSnapshotRefusal(db)).not.toBeNull();
  });

  it('SEQUENCED 12→7→4→3→2→1 must not leave the book silently trusted', () => {
    const db = freshDb();
    const { loans, map } = buildBook(db);
    expect(writeDebtSnapshot(db, loans, '2026-07-01', map).written).toBe(12);

    // Each step is individually under the guard's thresholds:
    //   12→7 netLoss 5 (5/12 = 41.7% < 50%)   7→4 netLoss 3 (3/7 = 42.9% < 50%)
    //   4→3, 3→2, 2→1 each netLoss 1 (< the 2-row MIN_SUPERSEDED_ROWS floor)
    const steps = [7, 4, 3, 2, 1];
    steps.forEach((n, i) => {
      const res = writeDebtSnapshot(db, loans.slice(0, n), `2026-07-1${i}`, map);
      expect(res.refusedEmptySupersede).toBe(false); // no single step trips the per-write guard
    });

    const active = db
      .prepare("SELECT id FROM debt_positions WHERE status = 'active'")
      .all() as Array<{ id: string }>;
    expect(active).toHaveLength(1); // 11 of 12 loans' debt is now off-book

    // The book lost 11 loans with no explanation. It must NOT be presented as trusted.
    expect(readLastSnapshotRefusal(db)).not.toBeNull();
  });

  it('SEQUENCED wipe must not mint a Hard-Invariant-4 aggregate clearance', () => {
    const db = freshDb();
    const { loans, map } = buildBook(db);
    writeDebtSnapshot(db, loans, '2026-07-01', map);

    // Sanity: the COMPLETE book is a genuine breach (~0.525 > 0.40 ceiling).
    const whole = computePortfolioAggregateLtv(db);
    expect(whole.aggregateLtv).toBeGreaterThan(0.4);
    expect(whole.clearedConservatively).toBe(false);

    [7, 4, 3, 2, 1].forEach((n, i) => {
      writeDebtSnapshot(db, loans.slice(0, n), `2026-07-1${i}`, map);
    });

    // The surviving loan-01 alone aggregates to 0.35 — inside the ceiling. Reporting that as a
    // clearance is the defect: 11 loans of real debt are simply missing.
    const after = computePortfolioAggregateLtv(db);
    expect(after.clearedConservatively).not.toBe(true);
  });

  it('an explained payoff (terminal status) still clears — the guard must not latch on real churn', () => {
    const db = freshDb();
    const { loans, map } = buildBook(db);
    writeDebtSnapshot(db, loans, '2026-07-01', map);

    // loan-12 is genuinely paid off: present in the payload, classified terminal.
    const next = loans.map((l) =>
      l.id === 'loan-12' ? makeBorrowerLoan({ ...l, status: 'Paid in Full' }) : l,
    );
    const res = writeDebtSnapshot(db, next, '2026-07-02', map);
    expect(res.refusedEmptySupersede).toBe(false);
    expect(readLastSnapshotRefusal(db)).toBeNull(); // documented churn is not a silent vanish
  });
});

describe('H1 — the trust marker must bind every per-property consumer, not only the aggregate', () => {
  /**
   * Produce a REAL degraded book via the repo's own reproduced primitive: a NaN balance binds to
   * SQL NULL and fails the NOT NULL constraint AFTER the loan's prior row was superseded, so the
   * row is lost and the marker latches 'degraded'. Property P keeps loan-A and loses loan-B.
   */
  function degradeBook(db: WarehouseDb): void {
    seedProperty(db, 'prop-p', 'Property P');
    const map = new Map([
      ['loan-a', 'prop-p'],
      ['loan-b', 'prop-p'],
    ]);
    const loanA = makeBorrowerLoan({
      id: 'loan-a',
      absBalance: 1_000_000,
      ltv: 0.3,
      annualInterest: 45_000,
      annualPrincipal: 15_000,
      monthlyPmt: 5_000,
    });
    const loanB = makeBorrowerLoan({
      id: 'loan-b',
      absBalance: 2_000_000,
      ltv: 0.55,
      annualInterest: 60_000,
      annualPrincipal: 20_000,
      monthlyPmt: 6_667,
    });
    expect(writeDebtSnapshot(db, [loanA, loanB], '2026-07-01', map).written).toBe(2);

    const poisoned = makeBorrowerLoan({ ...loanB, absBalance: NaN });
    const res = writeDebtSnapshot(db, [loanA, poisoned], '2026-07-02', map);
    expect(res.degradedRows).toBe(1);
    expect(readLastSnapshotRefusal(db)!.kind).toBe('degraded');
  }

  it('scoreDebtPositions must not report a governor clearance off a degraded remnant', () => {
    const db = freshDb();
    degradeBook(db);

    // True combined debt service is 140k against 100k NOI → DSCR 0.71x, a real governor block.
    // With loan-B destroyed, the remnant alone shows 60k service → DSCR 1.67x "Governors clear".
    const metrics = [makePeriodMetrics({ propertyId: 'prop-p', noi: 100_000 })];
    const score = scoreDebtPositions(db, metrics, 0.045).find((s) => s.propertyId === 'prop-p')!;

    expect(score).toBeDefined();
    expect(score.signal).not.toBe('cash-out');
    expect(score.signal).not.toBe('refi');
    expect(score.signalReason ?? '').not.toMatch(/Governors clear/i);
    // A DSCR computed off half the property's debt service is fabricated, not merely stale.
    expect(score.dscr).toBeNull();
  });

  it('persistDebtScores must not append remnant-derived scores to the permanent trend history', () => {
    const db = freshDb();
    degradeBook(db);

    const metrics = [makePeriodMetrics({ propertyId: 'prop-p', noi: 100_000 })];
    const scores = scoreDebtPositions(db, metrics, null);
    const result = persistDebtScores(db, scores, metrics, '2026-07-02', 150);

    expect(result.written).toBe(0);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM debt_scores').get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('a TRUSTED book still scores and persists normally (the guard must not block healthy runs)', () => {
    const db = freshDb();
    seedProperty(db, 'prop-p', 'Property P');
    const map = new Map([['loan-a', 'prop-p']]);
    const loanA = makeBorrowerLoan({
      id: 'loan-a',
      absBalance: 1_000_000,
      ltv: 0.3,
      annualInterest: 45_000,
      annualPrincipal: 15_000,
    });
    expect(writeDebtSnapshot(db, [loanA], '2026-07-01', map).written).toBe(1);
    expect(readLastSnapshotRefusal(db)).toBeNull();

    const metrics = [makePeriodMetrics({ propertyId: 'prop-p', noi: 200_000 })];
    const scores = scoreDebtPositions(db, metrics, null);
    const p = scores.find((s) => s.propertyId === 'prop-p')!;
    expect(p.dscr).not.toBeNull();

    const result = persistDebtScores(db, scores, metrics, '2026-07-01', 150);
    expect(result.written).toBeGreaterThan(0);
  });
});
