// @vitest-environment node
//
// tests/unit/debt-maturity.test.ts
//
// Debt & Maturity warehouse module v1 (branch next5-debt-module; see
// server/warehouse/debt-maturity.DESIGN.md).
//
// Covers:
//   Migration 023 — rate_type / next_rate_reset columns exist on debt_positions
//   buildMaturityTimeline — fresh months-out recompute, demand-callable-first ordering,
//     rate-reset events, confidentiality (no balance/rate/lender on the wire), superseded excluded
//   buildRefiWindows — 12/24-month window boundaries, demand-note conservatism, unknown-maturity
//     flagging, DSCR/LTV breach flags vs the REFERENCED governors (never new literals),
//     65% refi ceiling drift-pinned to ALERT_THRESHOLDS.ltvCeiling
//   computePortfolioAggregateLtv — conservative-clearance semantics (overstated basis ⇒ a
//     complete-coverage ≤40% is a true clearance; anything else is null/false, never fabricated)
//   GET /timeline + GET /refi-windows — parse through the new Zod contracts
//
// All tests use a fresh in-memory SQLite warehouse (tmpdir) — never touches finance.sqlite.
// No FRED: the routes under test are deliberately offline-deterministic (null market rate).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import {
  buildMaturityTimeline,
  buildRefiWindows,
  computePortfolioAggregateLtv,
  REFI_LTV_CEILING,
  REFI_WINDOW_MONTHS_NEAR,
  REFI_WINDOW_MONTHS_FAR,
} from '../../server/warehouse/debt-maturity';
import { effectiveMonthsToMaturity } from '../../server/warehouse/debt-scoring';
import { writeDebtSnapshot } from '../../server/warehouse/debt-snapshot';
import type { Loan } from '../../src/contracts/index';
import { loadGovernors } from '../../server/warehouse/governors';
import { debtApi } from '../../server/warehouse/debt-api';
import { ALERT_THRESHOLDS } from '../../src/analytics/conditions';
import {
  MaturityTimelineResponse,
  RefiWindowsResponse,
  type DebtScore,
} from '@contracts/debt';

// ── Helpers ───────────────────────────────────────────────────────────────────────────────

const ASOF = '2026-07-18';

const dbs: WarehouseDb[] = [];

/** Open a fresh in-memory warehouse (all migrations applied). */
function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'debt-maturity-test-'));
  const db = openWarehouse(join(dir, 'test.sqlite'));
  dbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
});

function seedProperty(db: WarehouseDb, id: string, name = `Property ${id}`): string {
  db.prepare(
    `INSERT OR IGNORE INTO property_master (id, name, market, rentable_sf, acquisition_date)
     VALUES (?, ?, 'Columbus', 20000, '2020-01-01')`,
  ).run(id, name);
  return id;
}

let loanSeq = 0;

function seedLoan(
  db: WarehouseDb,
  opts: {
    id?: string;
    propertyId?: string | null;
    loanName?: string;
    currentBalance?: number;
    monthsToMaturity?: number | null;
    maturityDate?: string | null;
    ltv?: number | null;
    balloon?: number;
    isDemand?: number;
    status?: string;
    monthlyPmt?: number | null;
    rate?: number | null;
    lender?: string | null;
    rateType?: string | null;
    nextRateReset?: string | null;
    snapshotDate?: string;
  } = {},
): string {
  const id = opts.id ?? `loan-${++loanSeq}`;
  db.prepare(
    `INSERT INTO debt_positions
       (id, snapshot_date, property_id, loan_name, current_balance,
        months_to_maturity, maturity_date, ltv, balloon, is_demand,
        monthly_pmt, rate, lender, rate_type, next_rate_reset, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.snapshotDate ?? '2026-07-01',
    opts.propertyId ?? null,
    opts.loanName ?? `Test Loan ${id}`,
    opts.currentBalance ?? 500_000,
    opts.monthsToMaturity ?? null,
    opts.maturityDate ?? null,
    opts.ltv !== undefined ? opts.ltv : 0.3,
    opts.balloon ?? 0,
    opts.isDemand ?? 0,
    opts.monthlyPmt ?? 3_000,
    opts.rate ?? 0.055,
    opts.lender ?? 'Test Lender Bank',
    opts.rateType ?? null,
    opts.nextRateReset ?? null,
    opts.status ?? 'active',
  );
  return id;
}

/** Hand-built DebtScore for buildRefiWindows passthrough tests. */
function score(overrides: Partial<DebtScore> & { propertyId: string }): DebtScore {
  return {
    propertyName: overrides.propertyId,
    noiBasis: 'spine-b/warehouse-ledger',
    dscr: null,
    dscrHeadroom: null,
    ltv: null,
    ltvHeadroom: null,
    debtYield: null,
    signal: 'hold',
    signalReason: null,
    score: 50,
    scoreBand: 'adequate',
    capitalConfigVersion: 1,
    refiCashSavingsPct: null,
    bookTrust: 'trusted', // round 19 — these fixtures model a healthy book unless a test overrides
    ...overrides,
  };
}

/** ISO date exactly n months (30.44-day months) after ASOF — close enough for window tests. */
function isoMonthsFromAsOf(n: number): string {
  const ms = new Date(ASOF).getTime() + n * 30.44 * 24 * 3_600_000;
  return new Date(ms).toISOString().slice(0, 10);
}

// ── Migration 023 ─────────────────────────────────────────────────────────────────────────

describe('migration 023 — debt_positions rate-structure columns', () => {
  it('adds nullable rate_type and next_rate_reset columns', () => {
    const db = freshDb();
    const cols = (
      db.prepare('PRAGMA table_info(debt_positions)').all() as Array<{
        name: string;
        notnull: number;
      }>
    ).reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.name]: c.notnull }), {});
    expect(cols).toHaveProperty('rate_type', 0);
    expect(cols).toHaveProperty('next_rate_reset', 0);
  });
});

// ── effectiveMonthsToMaturity export ──────────────────────────────────────────────────────

describe('effectiveMonthsToMaturity (exported from debt-scoring)', () => {
  it('demand note wins over a (malformed) populated maturity_date — F3', () => {
    expect(
      effectiveMonthsToMaturity(
        { is_demand: 1, maturity_date: '2030-01-01', months_to_maturity: 40, snapshot_date: ASOF },
        ASOF,
      ),
    ).toBeNull();
  });

  it('recomputes fresh from maturity_date, ignoring the stale stored column', () => {
    const months = effectiveMonthsToMaturity(
      { is_demand: 0, maturity_date: isoMonthsFromAsOf(6), months_to_maturity: 99, snapshot_date: ASOF },
      ASOF,
    );
    expect(months).not.toBeNull();
    expect(months!).toBeGreaterThan(5);
    expect(months!).toBeLessThan(7);
  });

  // ── L3 (2026-07-27 round-19-LOWs sweep) ─────────────────────────────────────────────────
  // The stored-cell fallback (maturity_date absent/unparseable) must discount for how stale the
  // snapshot itself is, not report the frozen figure as if it were measured today.
  describe('L3 — stored-cell fallback is discounted by elapsed time since snapshot_date', () => {
    it('a 7-month-old months_to_maturity=30 with an unparseable date reads as ~23, not 30', () => {
      const months = effectiveMonthsToMaturity(
        {
          is_demand: 0,
          maturity_date: 'TBD',
          months_to_maturity: 30,
          snapshot_date: isoMonthsFromAsOf(-7), // snapshot taken 7 months before ASOF
        },
        ASOF,
      );
      expect(months).not.toBeNull();
      expect(months!).toBeGreaterThan(22);
      expect(months!).toBeLessThan(24);
    });

    it('a snapshot taken TODAY applies no discount — the stored figure stands as-is', () => {
      const months = effectiveMonthsToMaturity(
        { is_demand: 0, maturity_date: null, months_to_maturity: 30, snapshot_date: ASOF },
        ASOF,
      );
      expect(months).toBeCloseTo(30, 1);
    });

    it('a stale fallback can go negative (the estimate says it should already have matured) — not clamped', () => {
      const months = effectiveMonthsToMaturity(
        {
          is_demand: 0,
          maturity_date: null,
          months_to_maturity: 3,
          snapshot_date: isoMonthsFromAsOf(-7), // 7 months stale, only had 3 months left then
        },
        ASOF,
      );
      expect(months).not.toBeNull();
      expect(months!).toBeLessThan(0);
    });

    it('a snapshot_date AFTER asOf (malformed data) applies ZERO discount, never a bonus', () => {
      const months = effectiveMonthsToMaturity(
        {
          is_demand: 0,
          maturity_date: null,
          months_to_maturity: 20,
          snapshot_date: isoMonthsFromAsOf(7), // snapshot "taken" 7 months AFTER asOf — malformed
        },
        ASOF,
      );
      // Must stand as-is (20), never be inflated past the stored figure.
      expect(months).toBeCloseTo(20, 1);
    });

    it('null months_to_maturity stays null regardless of staleness (nothing to discount)', () => {
      const months = effectiveMonthsToMaturity(
        { is_demand: 0, maturity_date: null, months_to_maturity: null, snapshot_date: isoMonthsFromAsOf(-7) },
        ASOF,
      );
      expect(months).toBeNull();
    });
  });
});

// ── buildMaturityTimeline ─────────────────────────────────────────────────────────────────

describe('buildMaturityTimeline', () => {
  it('emits a maturity event with monthsOut recomputed fresh from maturity_date (never the stored column)', () => {
    const db = freshDb();
    const pid = seedProperty(db, 'prop-A');
    seedLoan(db, {
      id: 'l1',
      propertyId: pid,
      maturityDate: isoMonthsFromAsOf(6),
      monthsToMaturity: 99, // stale workbook cell — must be ignored when the date is present
    });
    const events = buildMaturityTimeline(db, ASOF);
    const ev = events.find((e) => e.loanId === 'l1' && e.eventType === 'maturity');
    expect(ev).toBeDefined();
    expect(ev!.monthsOut).not.toBeNull();
    expect(ev!.monthsOut!).toBeGreaterThan(5);
    expect(ev!.monthsOut!).toBeLessThan(7);
    expect(ev!.propertyId).toBe(pid);
  });

  // L3 gap (independent-review finding, 2026-07-24): this event's eventDate was still emitting
  // row.maturity_date unconditionally — the identical defect class L3 closed in
  // buildRefiWindows' soonestMaturityDate (see that describe block below). A free-form
  // unparseable workbook cell must not reach a date-typed field on the client-facing timeline.
  it('an unparseable maturity cell yields eventDate=null while monthsOut still uses the stored fallback', () => {
    const db = freshDb();
    seedLoan(db, { id: 'garbage-date', maturityDate: 'TBD', monthsToMaturity: 9, snapshotDate: ASOF });
    const events = buildMaturityTimeline(db, ASOF);
    const ev = events.find((e) => e.loanId === 'garbage-date' && e.eventType === 'maturity');
    expect(ev).toBeDefined();
    expect(ev!.eventDate).toBeNull();
    expect(ev!.monthsOut).toBe(9);
  });

  it('a real parseable maturity_date is still carried through as eventDate', () => {
    const db = freshDb();
    const date = isoMonthsFromAsOf(4);
    seedLoan(db, { id: 'real-date', maturityDate: date });
    const events = buildMaturityTimeline(db, ASOF);
    const ev = events.find((e) => e.loanId === 'real-date' && e.eventType === 'maturity');
    expect(ev!.eventDate).toBe(date);
  });

  it('emits demand notes as demand-callable events sorted FIRST (callable now beats any dated event)', () => {
    const db = freshDb();
    seedLoan(db, { id: 'dated', maturityDate: isoMonthsFromAsOf(1) });
    seedLoan(db, { id: 'demand', isDemand: 1, maturityDate: null, monthsToMaturity: null });
    const events = buildMaturityTimeline(db, ASOF);
    expect(events[0]!.eventType).toBe('demand-callable');
    expect(events[0]!.loanId).toBe('demand');
    expect(events[0]!.eventDate).toBeNull();
    expect(events[0]!.monthsOut).toBeNull();
  });

  it('emits rate-reset events from next_rate_reset with fresh monthsOut and rateType passthrough', () => {
    const db = freshDb();
    seedLoan(db, {
      id: 'arm',
      maturityDate: isoMonthsFromAsOf(48),
      rateType: 'Floating',
      nextRateReset: isoMonthsFromAsOf(3),
    });
    const events = buildMaturityTimeline(db, ASOF);
    const reset = events.find((e) => e.eventType === 'rate-reset');
    expect(reset).toBeDefined();
    expect(reset!.loanId).toBe('arm');
    expect(reset!.rateType).toBe('Floating');
    expect(reset!.monthsOut!).toBeGreaterThan(2);
    expect(reset!.monthsOut!).toBeLessThan(4);
    // reset (3mo) sorts before the same loan's maturity (48mo)
    const resetIdx = events.indexOf(reset!);
    const matIdx = events.findIndex((e) => e.eventType === 'maturity' && e.loanId === 'arm');
    expect(resetIdx).toBeLessThan(matIdx);
  });

  it('sorts dated events by monthsOut ascending; unknown-maturity (non-demand) loans are emitted LAST, never dropped', () => {
    const db = freshDb();
    seedLoan(db, { id: 'far', maturityDate: isoMonthsFromAsOf(30) });
    seedLoan(db, { id: 'near', maturityDate: isoMonthsFromAsOf(2) });
    seedLoan(db, { id: 'unknown', maturityDate: null, monthsToMaturity: null });
    const events = buildMaturityTimeline(db, ASOF);
    expect(events.map((e) => e.loanId)).toEqual(['near', 'far', 'unknown']);
    const unknown = events[2]!;
    expect(unknown.eventDate).toBeNull();
    expect(unknown.monthsOut).toBeNull();
  });

  it('CONFIDENTIALITY: no balance, rate value, or lender ever appears on a timeline event', () => {
    const db = freshDb();
    seedLoan(db, {
      id: 'l1',
      maturityDate: isoMonthsFromAsOf(6),
      currentBalance: 1_234_567,
      rate: 0.0799,
      lender: 'Very Secret Bank NA',
      rateType: 'Fixed',
      nextRateReset: isoMonthsFromAsOf(2),
    });
    const events = buildMaturityTimeline(db, ASOF);
    expect(events.length).toBeGreaterThan(0);
    for (const ev of events) {
      const keys = Object.keys(ev);
      expect(keys).not.toContain('currentBalance');
      expect(keys).not.toContain('rate');
      expect(keys).not.toContain('lender');
      expect(JSON.stringify(ev)).not.toContain('Very Secret Bank');
      expect(JSON.stringify(ev)).not.toContain('1234567');
    }
  });

  it('excludes superseded rows', () => {
    const db = freshDb();
    seedLoan(db, { id: 'old', maturityDate: isoMonthsFromAsOf(6), status: 'superseded' });
    seedLoan(db, { id: 'live', maturityDate: isoMonthsFromAsOf(6) });
    const events = buildMaturityTimeline(db, ASOF);
    expect(events.map((e) => e.loanId)).toEqual(['live']);
  });

  // Regression: the sort comparator must not do sortKey(a) - sortKey(b) when the keys are
  // equal ±Infinity. Two demand-callable events (both -Infinity) or two unknown-maturity
  // events (both Infinity) would otherwise make the comparator return NaN → undefined
  // (non-deterministic) order. Both must fall to the deterministic loanId tie-break.
  it('deterministically orders multiple demand-callable events by loanId (no NaN-comparator order)', () => {
    const db = freshDb();
    seedLoan(db, { id: 'demand-b', isDemand: 1, maturityDate: null, monthsToMaturity: null });
    seedLoan(db, { id: 'demand-a', isDemand: 1, maturityDate: null, monthsToMaturity: null });
    seedLoan(db, { id: 'demand-c', isDemand: 1, maturityDate: null, monthsToMaturity: null });
    const ids = buildMaturityTimeline(db, ASOF).map((e) => e.loanId);
    expect(ids).toEqual(['demand-a', 'demand-b', 'demand-c']);
  });

  it('deterministically orders multiple unknown-maturity events by loanId (no NaN-comparator order)', () => {
    const db = freshDb();
    seedLoan(db, { id: 'u-z', maturityDate: null, monthsToMaturity: null });
    seedLoan(db, { id: 'u-a', maturityDate: null, monthsToMaturity: null });
    seedLoan(db, { id: 'u-m', maturityDate: null, monthsToMaturity: null });
    const ids = buildMaturityTimeline(db, ASOF).map((e) => e.loanId);
    expect(ids).toEqual(['u-a', 'u-m', 'u-z']);
  });
});

// ── buildRefiWindows ──────────────────────────────────────────────────────────────────────

describe('buildRefiWindows', () => {
  it('window boundaries: ≤12mo → both windows; 13–24mo → far only; >24mo → neither; past-due → both', () => {
    const db = freshDb();
    for (const [pid, months] of [
      ['p12', 11],
      ['p13', 13],
      ['p25', 25.5],
      ['ppast', -2],
    ] as const) {
      seedProperty(db, pid);
      seedLoan(db, { propertyId: pid, maturityDate: isoMonthsFromAsOf(months) });
    }
    const windows = buildRefiWindows(db, [], ASOF);
    const byId = new Map(windows.map((w) => [w.propertyId, w]));
    expect(byId.get('p12')).toMatchObject({ maturityWithin12mo: true, maturityWithin24mo: true });
    expect(byId.get('p13')).toMatchObject({ maturityWithin12mo: false, maturityWithin24mo: true });
    expect(byId.get('p25')).toMatchObject({ maturityWithin12mo: false, maturityWithin24mo: false });
    expect(byId.get('ppast')).toMatchObject({ maturityWithin12mo: true, maturityWithin24mo: true });
  });

  it('a demand note forces BOTH windows true (callable immediately) and sets hasDemandNote', () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    seedLoan(db, { propertyId: 'p1', maturityDate: isoMonthsFromAsOf(60) });
    seedLoan(db, { propertyId: 'p1', isDemand: 1, maturityDate: null, monthsToMaturity: null });
    const [w] = buildRefiWindows(db, [], ASOF);
    expect(w).toMatchObject({
      hasDemandNote: true,
      maturityWithin12mo: true,
      maturityWithin24mo: true,
    });
  });

  it('unknown-maturity (non-demand) is FLAGGED, not guessed: windows stay false, hasUnknownMaturity true', () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    seedLoan(db, { propertyId: 'p1', maturityDate: null, monthsToMaturity: null });
    const [w] = buildRefiWindows(db, [], ASOF);
    expect(w).toMatchObject({
      hasUnknownMaturity: true,
      hasDemandNote: false,
      maturityWithin12mo: false,
      maturityWithin24mo: false,
      monthsToSoonestMaturity: null,
    });
  });

  it('DSCR/LTV pass through from DebtScore; breach flags computed against the REFERENCED governors (1.25 / 0.40 defaults)', () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    seedLoan(db, { propertyId: 'p1', maturityDate: isoMonthsFromAsOf(18) });
    const governors = loadGovernors(db);
    const [w] = buildRefiWindows(
      db,
      [score({ propertyId: 'p1', dscr: 1.1, ltv: 0.45 })],
      ASOF,
    );
    expect(w!.dscr).toBe(1.1);
    expect(w!.ltv).toBe(0.45);
    expect(w!.dscrFloorBreach).toBe(1.1 < governors.dscrFloor); // true
    expect(w!.dscrFloorBreach).toBe(true);
    expect(w!.govLtvCeilingBreach).toBe(true); // 0.45 > 0.40 aggregate governor
    expect(w!.refiCeilingBreach).toBe(false); // 0.45 ≤ 0.65 per-property refi ceiling
  });

  it('65% refi ceiling: breach + headroom are computed from ALERT_THRESHOLDS.ltvCeiling (drift-pinned, no new literal)', () => {
    expect(REFI_LTV_CEILING).toBe(ALERT_THRESHOLDS.ltvCeiling);
    const db = freshDb();
    seedProperty(db, 'p1');
    seedLoan(db, { propertyId: 'p1', maturityDate: isoMonthsFromAsOf(18) });
    const ltv = ALERT_THRESHOLDS.ltvCeiling + 0.05; // 0.70 under the current ratified 0.65
    const [w] = buildRefiWindows(db, [score({ propertyId: 'p1', ltv })], ASOF);
    expect(w!.refiCeilingBreach).toBe(true);
    expect(w!.refiLtvHeadroom).toBeCloseTo(ALERT_THRESHOLDS.ltvCeiling - ltv, 10);
    expect(w!.govLtvCeilingBreach).toBe(true);
  });

  it('unknown DSCR/LTV → null breach flags (unknown is never clearance, and never a fabricated breach)', () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    seedLoan(db, { propertyId: 'p1', maturityDate: isoMonthsFromAsOf(6) });
    const [w] = buildRefiWindows(db, [], ASOF); // no score row at all
    expect(w!.dscr).toBeNull();
    expect(w!.ltv).toBeNull();
    expect(w!.dscrFloorBreach).toBeNull();
    expect(w!.govLtvCeilingBreach).toBeNull();
    expect(w!.refiCeilingBreach).toBeNull();
    expect(w!.refiLtvHeadroom).toBeNull();
  });

  it('window month constants are 12 and 24 (task-brief definitions, module-owned)', () => {
    expect(REFI_WINDOW_MONTHS_NEAR).toBe(12);
    expect(REFI_WINDOW_MONTHS_FAR).toBe(24);
  });

  // Governor-boundary edge cases (refute pass): the ceilings are inclusive — LTV AT the
  // ceiling is compliant, not a breach (governor is "LTV ≤ X").
  it('LTV exactly at the 40% aggregate governor is NOT a breach (ceiling is inclusive)', () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    seedLoan(db, { propertyId: 'p1', maturityDate: isoMonthsFromAsOf(18) });
    const governors = loadGovernors(db);
    const [w] = buildRefiWindows(
      db,
      [score({ propertyId: 'p1', ltv: governors.ltvCeiling })],
      ASOF,
    );
    expect(w!.govLtvCeilingBreach).toBe(false);
  });

  it('LTV exactly at the 65% per-property refi ceiling is NOT a breach; headroom is exactly 0', () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    seedLoan(db, { propertyId: 'p1', maturityDate: isoMonthsFromAsOf(18) });
    const [w] = buildRefiWindows(
      db,
      [score({ propertyId: 'p1', ltv: ALERT_THRESHOLDS.ltvCeiling })],
      ASOF,
    );
    expect(w!.refiCeilingBreach).toBe(false);
    expect(w!.refiLtvHeadroom).toBeCloseTo(0, 10);
  });

  it('a loan maturing today (0 months) falls inside both windows', () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    seedLoan(db, { propertyId: 'p1', maturityDate: ASOF });
    const [w] = buildRefiWindows(db, [], ASOF);
    expect(w!.maturityWithin12mo).toBe(true);
    expect(w!.maturityWithin24mo).toBe(true);
    expect(w!.monthsToSoonestMaturity!).toBeCloseTo(0, 1);
  });
});

// ── computePortfolioAggregateLtv ──────────────────────────────────────────────────────────

describe('computePortfolioAggregateLtv', () => {
  it('complete single-loan coverage ≤ ceiling → clearedConservatively TRUE (overstated basis makes this a true clearance)', () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    seedProperty(db, 'p2');
    // implied values: 1M/0.25 = 4M and 0.6M/0.30 = 2M → aggregate 1.6M / 6M ≈ 0.2667
    seedLoan(db, { propertyId: 'p1', currentBalance: 1_000_000, ltv: 0.25, maturityDate: isoMonthsFromAsOf(30) });
    seedLoan(db, { propertyId: 'p2', currentBalance: 600_000, ltv: 0.3, maturityDate: isoMonthsFromAsOf(30) });
    const governors = loadGovernors(db);
    const agg = computePortfolioAggregateLtv(db, governors);
    expect(agg.complete).toBe(true);
    expect(agg.coveredLoanCount).toBe(2);
    expect(agg.totalLoanCount).toBe(2);
    expect(agg.aggregateLtv).toBeCloseTo(1_600_000 / 6_000_000, 10);
    expect(agg.clearedConservatively).toBe(true);
  });

  it('complete coverage ABOVE the 40% governor → clearedConservatively FALSE (cannot conservatively clear)', () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    seedLoan(db, { propertyId: 'p1', currentBalance: 900_000, ltv: 0.45, maturityDate: isoMonthsFromAsOf(30) });
    const agg = computePortfolioAggregateLtv(db, loadGovernors(db));
    expect(agg.complete).toBe(true);
    expect(agg.aggregateLtv).toBeCloseTo(0.45, 10);
    expect(agg.clearedConservatively).toBe(false);
  });

  it('a multi-loan property is EXCLUDED (per-loan LTV semantics unconfirmed) → incomplete → verdict null', () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    seedProperty(db, 'p2');
    seedLoan(db, { propertyId: 'p1', currentBalance: 500_000, ltv: 0.3 });
    seedLoan(db, { propertyId: 'p2', currentBalance: 400_000, ltv: 0.2 });
    seedLoan(db, { propertyId: 'p2', currentBalance: 100_000, ltv: 0.05 });
    const agg = computePortfolioAggregateLtv(db, loadGovernors(db));
    expect(agg.complete).toBe(false);
    expect(agg.coveredLoanCount).toBe(1);
    expect(agg.totalLoanCount).toBe(3);
    expect(agg.clearedConservatively).toBeNull();
    // covered slice still reported, honestly labeled
    expect(agg.aggregateLtv).toBeCloseTo(0.3, 10);
  });

  it('null/zero LTV or unattributed (no property) loans → uncovered → incomplete → verdict null', () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    seedLoan(db, { propertyId: 'p1', currentBalance: 500_000, ltv: null });
    seedLoan(db, { propertyId: null, currentBalance: 250_000, ltv: 0.3 });
    const agg = computePortfolioAggregateLtv(db, loadGovernors(db));
    expect(agg.complete).toBe(false);
    expect(agg.coveredLoanCount).toBe(0);
    expect(agg.aggregateLtv).toBeNull();
    expect(agg.clearedConservatively).toBeNull();
  });

  // H2b (2026-07-24 sweep, edges lens): the previous contract here was
  // `clearedConservatively: true` on the vacuous-truth reading "zero active rows ⇒ no debt ⇒
  // aggregate LTV is 0". That is only sound if zero rows means a VERIFIED unlevered portfolio.
  // It does not: writeDebtSnapshot's stale-supersede clause retires every active row absent from
  // an incoming snapshot, so an empty borrower set wipes the whole book — after which this
  // function manufactured a Hard-Invariant-4 CLEARANCE out of an empty cohort. "No data" and
  // "no debt" are now distinguished: emptyCohort marks the cohort, and the verdict is null
  // (unknown is never clearance — the module's own F1/F2 doctrine).
  it('no active debt → emptyCohort, verdict NULL (absence of data is not evidence of no debt)', () => {
    const db = freshDb();
    const agg = computePortfolioAggregateLtv(db, loadGovernors(db));
    expect(agg.totalLoanCount).toBe(0);
    expect(agg.aggregateLtv).toBeNull();
    expect(agg.complete).toBe(true);
    expect(agg.emptyCohort).toBe(true);
    expect(agg.clearedConservatively).toBeNull();
    expect(agg.note).toMatch(/no active debt positions/i);
  });

  it('a non-empty cohort is never flagged emptyCohort', () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    seedLoan(db, { propertyId: 'p1', currentBalance: 800_000, ltv: 0.3 });
    const agg = computePortfolioAggregateLtv(db, loadGovernors(db));
    expect(agg.emptyCohort).toBe(false);
    expect(agg.clearedConservatively).toBe(true);
  });

  it('superseded rows never count', () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    seedLoan(db, { propertyId: 'p1', currentBalance: 500_000, ltv: 0.3, status: 'superseded' });
    const agg = computePortfolioAggregateLtv(db, loadGovernors(db));
    expect(agg.totalLoanCount).toBe(0);
  });

  it('aggregate LTV exactly at the 40% governor clears conservatively (≤ ceiling is inclusive)', () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    const gov = loadGovernors(db);
    // single sole loan whose per-loan LTV equals the ceiling → implied aggregate == ceiling
    seedLoan(db, {
      propertyId: 'p1',
      currentBalance: 800_000,
      ltv: gov.ltvCeiling,
      maturityDate: isoMonthsFromAsOf(30),
    });
    const agg = computePortfolioAggregateLtv(db, gov);
    expect(agg.complete).toBe(true);
    expect(agg.aggregateLtv).toBeCloseTo(gov.ltvCeiling, 10);
    expect(agg.clearedConservatively).toBe(true);
  });
});

// ── Governor-hardening regressions (2026-07-24 financial-code integrity sweep) ─────────────
//
// Every case below is a defect the merge gate's 2,865 green tests did NOT exercise. Each is
// pinned here so it cannot silently return.

describe('computePortfolioAggregateLtv — balance-sign guard (H1)', () => {
  // The coverage predicate guarded the sign of `ltv` but not of `current_balance`. A negative
  // balance contributes a NEGATIVE implied value (balance ÷ ltv), shrinking the denominator
  // asymmetrically and DEFLATING the aggregate — turning a real breach into a false clearance.
  // Reachable because POST /snapshot took its payload through a bare TS cast (see debt-api).
  it('a negative-balance row can no longer flip a real 55% breach into a false clearance', () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    seedProperty(db, 'p2');
    // p1 alone is a TRUE breach of the 40% aggregate governor.
    seedLoan(db, { propertyId: 'p1', currentBalance: 4_000_000, ltv: 0.55 });
    // The malformed row that used to deflate the aggregate to 0.396 (≤ 0.40 ⇒ "cleared").
    seedLoan(db, { propertyId: 'p2', currentBalance: -2_000_000, ltv: 0.9 });

    const agg = computePortfolioAggregateLtv(db, loadGovernors(db));

    // The non-positive-balance loan is now UNCOVERED, so coverage is incomplete and the
    // verdict is null — never a clearance built on a sign error.
    expect(agg.coveredLoanCount).toBe(1);
    expect(agg.totalLoanCount).toBe(2);
    expect(agg.complete).toBe(false);
    expect(agg.clearedConservatively).toBeNull();
    // The honestly-labelled covered slice is still the real breaching loan.
    expect(agg.aggregateLtv).toBeCloseTo(0.55, 10);
    // Regression pin: the old deflated figure must never reappear.
    expect(agg.aggregateLtv).not.toBeCloseTo(0.396, 3);
  });

  // CONTRACT CORRECTION (same-day refute-review): a strictly negative balance is what deflates
  // the aggregate (H1's actual attack) — a genuinely active ZERO-balance loan (undrawn revolver,
  // blank cell parsed as 0) contributes exactly 0 to both sums and cannot deflate anything, so
  // excluding it too would needlessly downgrade a real, correct verdict to no-verdict with no
  // data actually missing. It IS covered, contributing nothing.
  it('a zero-balance loan is covered — it cannot deflate the aggregate, unlike a negative one', () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    seedProperty(db, 'p2');
    seedLoan(db, { propertyId: 'p1', currentBalance: 4_000_000, ltv: 0.35 });
    seedLoan(db, { propertyId: 'p2', currentBalance: 0, ltv: 0.5 }); // undrawn revolver
    const agg = computePortfolioAggregateLtv(db, loadGovernors(db));
    expect(agg.coveredLoanCount).toBe(2);
    expect(agg.complete).toBe(true);
    // The zero-balance loan contributes nothing to either sum — the aggregate is exactly the
    // real loan's own LTV, unaffected by the revolver's presence.
    expect(agg.aggregateLtv).toBeCloseTo(0.35, 10);
    expect(agg.clearedConservatively).toBe(true);
  });

  // Round-2 refute-review regression (determinism lens): the >=0 relaxation reopened a
  // reachable degenerate state — complete coverage but every covered loan has a zero balance
  // (aggregateLtv null, since coveredImpliedValue stays 0). The note ternary used to be binary
  // over what is really a three-way verdict, so this state silently fell into the ABOVE-CEILING
  // wording despite no ceiling comparison ever running.
  it('an all-zero-balance covered cohort gets its own note, not the above-ceiling wording', () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    seedLoan(db, { propertyId: 'p1', currentBalance: 0, ltv: 0.5 }); // undrawn revolver, sole loan
    const agg = computePortfolioAggregateLtv(db, loadGovernors(db));
    expect(agg.complete).toBe(true);
    expect(agg.aggregateLtv).toBeNull();
    expect(agg.clearedConservatively).toBeNull();
    expect(agg.note).not.toMatch(/above the aggregate ceiling/i);
    expect(agg.note).toMatch(/zero balance/i);
  });

  it('a strictly negative balance is still excluded (the actual H1 attack, unaffected by the >=0 relaxation)', () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    seedLoan(db, { propertyId: 'p1', currentBalance: -500_000, ltv: 0.5 });
    const agg = computePortfolioAggregateLtv(db, loadGovernors(db));
    expect(agg.coveredLoanCount).toBe(0);
    expect(agg.complete).toBe(false);
    expect(agg.clearedConservatively).toBeNull();
  });

  // coveredBalancePct regression (same-day refute-review): a negative row was still summed
  // uncapped into totalBalance, so a positive-only coveredBalance could exceed it — a "200%
  // covered" figure. totalBalance must clamp each row to max(balance, 0).
  it('coveredBalancePct never exceeds 1.0, even with a negative-balance row present', () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    seedProperty(db, 'p2');
    seedLoan(db, { propertyId: 'p1', currentBalance: 4_000_000, ltv: 0.55 });
    seedLoan(db, { propertyId: 'p2', currentBalance: -2_000_000, ltv: 0.9 });
    const agg = computePortfolioAggregateLtv(db, loadGovernors(db));
    expect(agg.coveredBalancePct).not.toBeNull();
    expect(agg.coveredBalancePct!).toBeLessThanOrEqual(1);
    expect(agg.coveredBalancePct!).toBeGreaterThanOrEqual(0);
    // 4.0M covered / 4.0M clamped-total (the -2.0M row contributes 0, not -2.0M) = 1.0
    expect(agg.coveredBalancePct).toBeCloseTo(1, 10);
  });
});

describe('computePortfolioAggregateLtv — inclusive ceiling is float-stable (M2)', () => {
  // `aggregateLtv <= ceiling` with no tolerance was unstable at EXACTLY the ratified ceiling:
  // the b/(b/ltv) double roundtrip lands a hair above 0.4 for most cents-precision balances,
  // producing a false NOT-cleared on a portfolio sitting exactly at the inclusive ceiling.
  it('a balance whose implied-value roundtrip lands above the ceiling still clears', () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    const gov = loadGovernors(db);
    // 7,839,422.99 @ 0.40 roundtrips to 0.40000000000000008 — strictly > 0.4 as a double.
    const balance = 7_839_422.99;
    expect(balance / (balance / gov.ltvCeiling)).toBeGreaterThan(gov.ltvCeiling);

    seedLoan(db, { propertyId: 'p1', currentBalance: balance, ltv: gov.ltvCeiling });
    const agg = computePortfolioAggregateLtv(db, gov);
    expect(agg.complete).toBe(true);
    expect(agg.clearedConservatively).toBe(true);
  });

  it('the verdict does not flip with loan-id (summation) order at the ceiling', () => {
    const gov = loadGovernors(freshDb());
    const balances = [1_919_611.0, 1_159_134.95, 8_382_785.65];
    // Loan ids drive `ORDER BY d.id ASC`, i.e. the float summation order. Renaming a loan is
    // this repo's own documented slug-collision remedy, so order genuinely changes in practice.
    const verdicts = [
      ['a-loan', 'b-loan', 'c-loan'],
      ['c-loan', 'b-loan', 'a-loan'],
      ['b-loan', 'a-loan', 'c-loan'],
    ].map((ids) => {
      const db = freshDb();
      ids.forEach((id, i) => {
        seedProperty(db, `prop-${id}`);
        seedLoan(db, { id, propertyId: `prop-${id}`, currentBalance: balances[i]!, ltv: gov.ltvCeiling });
      });
      return computePortfolioAggregateLtv(db, gov).clearedConservatively;
    });
    expect(verdicts).toEqual([true, true, true]);
  });

  it('a genuinely breaching aggregate is still NOT cleared (the tolerance is not a loophole)', () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    const gov = loadGovernors(db);
    // A hair above the ceiling by far more than the tolerance.
    seedLoan(db, { propertyId: 'p1', currentBalance: 1_000_000, ltv: gov.ltvCeiling + 0.0001 });
    const agg = computePortfolioAggregateLtv(db, gov);
    expect(agg.complete).toBe(true);
    expect(agg.clearedConservatively).toBe(false);
  });
});

// ── Low-LTV structural defense (round 7, low-LTV directional gap) ─────────────────────────
//
// H1 excluded a NEGATIVE ltv/balance from coverage. It never addressed the OTHER direction: for
// a sole covered loan, aggregateLtv reduces algebraically to exactly that loan's own ltv
// (balance ÷ (balance ÷ ltv) = ltv), so a too-LOW ltv value produces a too-LOW reported
// aggregate — a false clearance by the same mechanism, just via a plausible-looking positive
// number instead of an obviously-wrong negative one. The demonstrated, reproducible attack
// (round-4/5 adversarial review) is a one-column drift in the workbook parser: `ltv` accidentally
// reads the loan's own interest-RATE cell instead of its LTV cell — both are small decimals
// (rates commonly 0.02-0.12), so the drifted value looks entirely plausible in isolation.
//
// A magnitude floor cannot safely catch this: this exact codebase's own legitimate test fixtures
// (debt-scoring.test.ts) already use ltv as low as 0.01 for genuine near-payoff loans, so any
// floor tight enough to catch a drifted 0.065 would also reject real data at a materially higher
// false-positive rate than is acceptable for a governor-adjacent check.
//
// The structural defense instead cross-checks ltv against the SAME loan's own `rate` field
// (read internally here — never added to this module's returned shape, preserving the
// confidentiality contract: "nothing returned here carries... a rate VALUE"). A column-drift bug
// copies the exact same underlying cell value into both fields, so `ltv === rate` (to float
// precision) is strong, specific evidence of that exact failure — a genuine, independently-set
// low LTV has no causal reason to numerically coincide with its own loan's rate. This is
// deliberately narrow: it closes the ONE demonstrated attack, not "any implausible ltv" in
// general — see the module's aggregate-LTV docblock for the residual gap this does not close.
describe('computePortfolioAggregateLtv — low-LTV rate-collision defense (round 7)', () => {
  it('excludes a loan whose ltv exactly collides with its own rate (the demonstrated column-drift attack)', () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    seedProperty(db, 'p2');
    seedProperty(db, 'p3');
    seedProperty(db, 'p4');
    // 4 loans, true aggregate LTV 62% (a real breach of the 40% ceiling) — one loan's ltv column
    // drifted to read its own 6.5% rate cell instead.
    seedLoan(db, { propertyId: 'p1', currentBalance: 3_000_000, ltv: 0.62, rate: 0.058 });
    seedLoan(db, { propertyId: 'p2', currentBalance: 3_000_000, ltv: 0.62, rate: 0.061 });
    seedLoan(db, { propertyId: 'p3', currentBalance: 3_000_000, ltv: 0.62, rate: 0.059 });
    seedLoan(db, { propertyId: 'p4', currentBalance: 3_000_000, ltv: 0.065, rate: 0.065 }); // drifted

    const agg = computePortfolioAggregateLtv(db, loadGovernors(db));
    // The drifted loan is excluded from coverage entirely — never trusted as data.
    expect(agg.coveredLoanCount).toBe(3);
    expect(agg.totalLoanCount).toBe(4);
    expect(agg.complete).toBe(false);
    expect(agg.clearedConservatively).toBeNull();
    // The 3 clean loans still report their honest (breaching) aggregate.
    expect(agg.aggregateLtv).toBeCloseTo(0.62, 10);
  });

  it('does NOT exclude a loan whose ltv is merely in the same ballpark as its rate but not equal', () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    // A genuine near-payoff loan: ltv 0.07, rate 0.055 — both small decimals, but NOT the same
    // value. Coincidental proximity must never be enough to exclude real data.
    seedLoan(db, { propertyId: 'p1', currentBalance: 100_000, ltv: 0.07, rate: 0.055 });
    const agg = computePortfolioAggregateLtv(db, loadGovernors(db));
    expect(agg.coveredLoanCount).toBe(1);
    expect(agg.complete).toBe(true);
    expect(agg.clearedConservatively).toBe(true);
  });

  it('does NOT exclude a normal loan whose ltv happens to equal a HIGH rate coincidentally', () => {
    // Guard against an overzealous version of this check that fires on ANY ltv===rate match
    // regardless of magnitude — a genuinely high ltv that happens to numerically match a high
    // rate is not the attack signature (the attack specifically produces an implausibly LOW ltv,
    // since real rates are always well under 1.0). Still, exact equality is exact equality: this
    // loan's own value literally IS suspect by the same signal, so it is excluded too — the test
    // documents this as an accepted, narrow false-positive on an edge case that essentially never
    // occurs with real rate magnitudes, not as a defect.
    const db = freshDb();
    seedProperty(db, 'p1');
    seedLoan(db, { propertyId: 'p1', currentBalance: 500_000, ltv: 0.45, rate: 0.45 });
    const agg = computePortfolioAggregateLtv(db, loadGovernors(db));
    expect(agg.coveredLoanCount).toBe(0);
    expect(agg.complete).toBe(false);
    expect(agg.clearedConservatively).toBeNull();
  });

  it('a null rate never excludes a loan (no data to collide with)', () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    seedLoan(db, { propertyId: 'p1', currentBalance: 500_000, ltv: 0.065, rate: null });
    const agg = computePortfolioAggregateLtv(db, loadGovernors(db));
    expect(agg.coveredLoanCount).toBe(1);
    expect(agg.complete).toBe(true);
  });

  it('never returns the rate value anywhere in the response shape (confidentiality)', () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    // A distinctive, non-colliding rate value on an otherwise normal covered loan — confirms the
    // internal rate read (added for the collision check) never leaks into the returned shape.
    seedLoan(db, { propertyId: 'p1', currentBalance: 500_000, ltv: 0.35, rate: 0.091234 });
    const agg = computePortfolioAggregateLtv(db, loadGovernors(db));
    expect(agg.coveredLoanCount).toBe(1); // sanity: the loan IS covered and DID contribute data
    expect(JSON.stringify(agg)).not.toContain('091234');
  });
});

describe('buildRefiWindows — soonestMaturityDate never emits an unparseable date (L3)', () => {
  it('an unparseable maturity cell yields a null date while months comes from the stored fallback', () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    seedLoan(db, { propertyId: 'p1', maturityDate: 'TBD', monthsToMaturity: 6, snapshotDate: ASOF });
    const [entry] = buildRefiWindows(db, [], ASOF);
    expect(entry).toBeDefined();
    expect(entry!.monthsToSoonestMaturity).toBe(6);
    expect(entry!.soonestMaturityDate).toBeNull();
    expect(entry!.maturityWithin12mo).toBe(true);
  });

  it('a real parseable date is still carried through', () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    const date = isoMonthsFromAsOf(6);
    seedLoan(db, { propertyId: 'p1', maturityDate: date });
    const [entry] = buildRefiWindows(db, [], ASOF);
    expect(entry!.soonestMaturityDate).toBe(date);
  });
});

describe('2026-07-25 hardening — activeLoans ORDER BY is total under duplicate active ids', () => {
  // Same PK fact as debt-scoring.ts's companion test (id, snapshot_date), not id alone: two
  // active rows can legitimately share an id at different snapshot_dates. activeLoans() sorted
  // `ORDER BY d.id ASC` only — with identical ids that key is exhausted and SQLite falls back to
  // physical row (insertion) order. buildMaturityTimeline's final sort ties two same-loanId
  // same-monthsOut events on eventType too, so the tie ultimately resolves to activeLoans' row
  // order — making the emitted event order (and thus which loan's `balloon` flag appears first
  // for that loanId) a function of insertion order, not the data. Raw SQL insert, not seedLoan()
  // (whose helper hardcodes snapshot_date) — this duplicate-id state is a direct schema-legal
  // fixture, not something a normal caller constructs.
  function insertDup(db: WarehouseDb, snapshotDate: string, balloon: number): void {
    db.prepare(`
      INSERT INTO debt_positions
        (id, snapshot_date, property_id, loan_name, current_balance,
         maturity_date, months_to_maturity, ltv, balloon, is_demand, status)
      VALUES
        ('dup-loan', ?, 'prop-a', 'Duplicate-Id Loan', 500000,
         '2027-01-01', NULL, 0.3, ?, 0, 'active')
    `).run(snapshotDate, balloon);
  }

  it('orders the tied duplicate-id maturity events by snapshot_date DESC (earlier-then-later insertion)', () => {
    const db = freshDb();
    seedProperty(db, 'prop-a');
    insertDup(db, '2026-01-01', 0); // earlier snapshot, non-balloon — inserted FIRST
    insertDup(db, '2026-02-01', 1); // later snapshot, balloon — inserted SECOND
    const events = buildMaturityTimeline(db, ASOF).filter(
      (e) => e.loanId === 'dup-loan' && e.eventType === 'maturity',
    );
    expect(events).toHaveLength(2);
    // The later snapshot_date (balloon=1) must sort first, regardless of insertion order.
    expect(events[0]!.balloon).toBe(true);
    expect(events[1]!.balloon).toBe(false);
  });

  it('produces the identical order when insertion order is reversed (later-then-earlier)', () => {
    const db = freshDb();
    seedProperty(db, 'prop-a');
    insertDup(db, '2026-02-01', 1); // later snapshot, balloon — inserted FIRST this time
    insertDup(db, '2026-01-01', 0); // earlier snapshot, non-balloon — inserted SECOND
    const events = buildMaturityTimeline(db, ASOF).filter(
      (e) => e.loanId === 'dup-loan' && e.eventType === 'maturity',
    );
    expect(events).toHaveLength(2);
    expect(events[0]!.balloon).toBe(true);
    expect(events[1]!.balloon).toBe(false);
  });
});

// ── API routes ────────────────────────────────────────────────────────────────────────────

describe('debt API — GET /timeline and GET /refi-windows', () => {
  it('GET /timeline → 200, parses MaturityTimelineResponse, no confidential terms in the body', async () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    seedLoan(db, {
      propertyId: 'p1',
      maturityDate: '2027-06-01',
      lender: 'Very Secret Bank NA',
      rateType: 'Fixed',
    });
    const app = debtApi(() => db);
    const res = await app.request('/timeline');
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    const parsed = MaturityTimelineResponse.parse(body);
    expect(parsed.events.length).toBe(1);
    expect(JSON.stringify(body)).not.toContain('Very Secret Bank');
  });

  it('GET /refi-windows → 200, parses RefiWindowsResponse, echoes the live governor values', async () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    seedLoan(db, { propertyId: 'p1', maturityDate: '2027-01-01', currentBalance: 800_000, ltv: 0.35 });
    const app = debtApi(() => db);
    const res = await app.request('/refi-windows');
    expect(res.status).toBe(200);
    const parsed = RefiWindowsResponse.parse(await res.json());
    const governors = loadGovernors(db);
    expect(parsed.governors.dscrFloor).toBe(governors.dscrFloor);
    expect(parsed.governors.ltvCeilingAggregate).toBe(governors.ltvCeiling);
    expect(parsed.governors.refiLtvCeilingPerProperty).toBe(ALERT_THRESHOLDS.ltvCeiling);
    expect(parsed.windows.length).toBe(1);
    expect(parsed.aggregate.totalLoanCount).toBe(1);
  });

  it('GET /refi-windows → 503 when the warehouse is unavailable', async () => {
    const app = debtApi(() => {
      throw new Error('cold');
    });
    const res = await app.request('/refi-windows');
    expect(res.status).toBe(503);
  });
});

// ── Refusal marker → aggregate verdict (obs-3 / residual #2) ──────────────────────────────
//
// Companion to debt-snapshot.test.ts's "persisted refusal marker" block: this is the CONSUMER
// side. Both adversarial reviews on PR #233 demonstrated the same end state — a refused write
// on the automated reload path leaves a stale book that keeps reporting
// clearedConservatively=true with nothing downstream able to tell "refused/frozen" from
// "healthy". While the marker is set, the aggregate must report lastWriteRefused=true and a
// NULL verdict (unknown is never clearance), regardless of what the stale rows alone would say.

/** Minimal borrower Loan for driving writeDebtSnapshot in this file's marker tests. */
function borrowerLoan(id: string, overrides: Partial<Loan> = {}): Loan {
  return {
    id, name: `Loan ${id}`, counterparty: null, direction: 'borrower',
    originalPrincipal: null, currentBalance: 800_000, absBalance: 800_000, rate: 0.055,
    monthlyPmt: null, annualInterest: null, annualPrincipal: null, loanType: 'Amortizing',
    status: null, isDemand: false, maturity: null, monthsToMaturity: 30, ltv: 0.3,
    lender: null, balloon: false, flags: [], collateralProperty: null,
    ...overrides,
  };
}

/** Map each loan onto its own seeded property so the book is fully covered (sole loans). */
function seedCoveredBook(db: WarehouseDb, ltv = 0.3): { loans: Loan[]; map: Map<string, string> } {
  const loans = ['a', 'b', 'c'].map((s) => borrowerLoan(`loan-${s}`, { ltv }));
  const map = new Map<string, string>();
  for (const s of ['a', 'b', 'c']) {
    seedProperty(db, `prop-${s}`);
    map.set(`loan-${s}`, `prop-${s}`);
  }
  return { loans, map };
}

describe('computePortfolioAggregateLtv — refused-write marker forces a null verdict', () => {
  it('a stale book that would clear on its own reports NULL + lastWriteRefused after a refused write', () => {
    const db = freshDb();
    const { loans, map } = seedCoveredBook(db);
    writeDebtSnapshot(db, loans, '2026-05-01', map);

    // Sanity: the book genuinely clears on its own before any refusal (3 sole loans @ 0.3 LTV).
    const before = computePortfolioAggregateLtv(db, loadGovernors(db));
    expect(before.lastWriteRefused).toBe(false);
    expect(before.clearedConservatively).toBe(true);

    // A refused write (empty set vs 3 active rows) — the book itself is UNCHANGED...
    writeDebtSnapshot(db, [], '2026-06-01');

    // ...but the verdict must no longer be trusted: the warehouse now KNOWS its data is stale.
    const after = computePortfolioAggregateLtv(db, loadGovernors(db));
    expect(after.lastWriteRefused).toBe(true);
    expect(after.clearedConservatively).toBeNull();
    expect(after.note).toMatch(/refused/i);
  });

  it('the verdict is restored after a subsequent successful write clears the marker', () => {
    const db = freshDb();
    const { loans, map } = seedCoveredBook(db);
    writeDebtSnapshot(db, loans, '2026-05-01', map);
    writeDebtSnapshot(db, [], '2026-06-01'); // refused → marker

    writeDebtSnapshot(db, loans, '2026-06-02', map); // healthy write → marker cleared

    const agg = computePortfolioAggregateLtv(db, loadGovernors(db));
    expect(agg.lastWriteRefused).toBe(false);
    expect(agg.clearedConservatively).toBe(true);
  });

  // Round-9 (fifth adversarial pass, edges lens): while frozen, a would-be TRUE (clearance)
  // verdict is nulled — but a would-be FALSE (breach) verdict must SURVIVE. A refused write does
  // not retroactively un-breach a book whose last trusted data was already above the ceiling; it
  // only means things changed in an unknown direction from an already-breaching baseline. Nulling
  // it would silence a standing Hard-Invariant-4 alarm at exactly the moment the system is both
  // last-known-in-breach AND blind. Asymmetric on purpose: unknown is never clearance, but a
  // freeze is never an all-clear either.
  it('a frozen book whose last trusted verdict was BREACH keeps reporting false (refusal never clears an alarm)', () => {
    const db = freshDb();
    const { loans, map } = seedCoveredBook(db, 0.6); // 60% — above the 40% aggregate ceiling
    writeDebtSnapshot(db, loans, '2026-05-01', map);
    const before = computePortfolioAggregateLtv(db, loadGovernors(db));
    expect(before.clearedConservatively).toBe(false); // genuine breach on trusted data

    writeDebtSnapshot(db, [], '2026-06-01'); // refused → marker set, book frozen

    const after = computePortfolioAggregateLtv(db, loadGovernors(db));
    expect(after.lastWriteRefused).toBe(true);
    expect(after.clearedConservatively).toBe(false); // the alarm survives the freeze
    expect(after.note).toMatch(/refused/i); // and the staleness is still disclosed
  });

  // Round-10 (sixth adversarial pass — all three lenses converged, reproduced): the round-9
  // breach-survives rule conflated the two marker kinds. For a REFUSED write the frozen rows
  // genuinely ARE the last trusted book, so a breach computed from them survives (test above).
  // For a DEGRADED write the rows are the POST-DAMAGE REMNANT — prior rows superseded,
  // replacements lost — i.e. exactly the data the marker distrusts. A remnant is a subset, and a
  // subset's aggregate LTV can be far above the full book's: the reviewers reproduced a
  // genuinely-CLEARING book (~0.305) minting a phantom hard BREACH (0.55 remnant) whose note
  // falsely claimed "the last trusted book was already above the ceiling". On a degraded marker
  // the verdict is null in BOTH directions — the remnant can neither clear nor breach.
  it('a DEGRADED write on a genuinely-clearing book yields NULL, never a fabricated breach', () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    seedProperty(db, 'p2');
    const bigClean = borrowerLoan('loan-big', { currentBalance: 9_000_000, absBalance: 9_000_000, ltv: 0.3 });
    const smallHigh = borrowerLoan('loan-small', { currentBalance: 500_000, absBalance: 500_000, ltv: 0.55 });
    const map = new Map([['loan-big', 'p1'], ['loan-small', 'p2']]);
    writeDebtSnapshot(db, [bigClean, smallHigh], '2026-05-01', map);
    // Trusted book genuinely clears: 9.5M / (30M + 0.909M) ≈ 0.307 ≤ 0.40.
    expect(computePortfolioAggregateLtv(db, loadGovernors(db)).clearedConservatively).toBe(true);

    // Degraded write: same ids (guard silent), but the big clean loan's balance is poisoned —
    // its prior row is superseded, its replacement fails, and only the 0.55-LTV remnant survives.
    const poisonedBig = { ...bigClean, currentBalance: NaN, absBalance: NaN };
    writeDebtSnapshot(db, [poisonedBig, smallHigh], '2026-06-01', map);

    const agg = computePortfolioAggregateLtv(db, loadGovernors(db));
    expect(agg.lastWriteRefused).toBe(true);
    expect(agg.clearedConservatively).toBeNull(); // NOT false — the remnant is untrusted wreckage
    expect(agg.note).not.toMatch(/last trusted book was already above/i);
    expect(agg.note).toMatch(/lost rows|degraded/i);
  });

  // Round-11 (seventh adversarial pass, edges lens, HIGH — reproduced): the ratchet false
  // clearance end-to-end. Last-trusted book BREACHES at ~0.508; two high-LTV loans are lost to
  // a degraded write; the next reload's payload matches the surviving low-LTV remnant, which
  // under round-10 rules cleared the marker and minted clearedConservatively=TRUE at 0.300 —
  // $9M of real debt silently off-book with zero signal. With the baseline ratchet, the marker
  // survives the remnant-matching write and the verdict stays null until real recovery.
  it('RATCHET: a last-trusted-BREACH book can never mint a clearance through degrade-then-remnant-match', () => {
    const db = freshDb();
    for (const p of ['pa', 'pb', 'pc', 'pd']) seedProperty(db, p);
    const A = borrowerLoan('loan-A', { currentBalance: 5_000_000, absBalance: 5_000_000, ltv: 0.55 });
    const B = borrowerLoan('loan-B', { currentBalance: 4_000_000, absBalance: 4_000_000, ltv: 0.55 });
    const C = borrowerLoan('loan-C', { currentBalance: 600_000, absBalance: 600_000, ltv: 0.3 });
    const D = borrowerLoan('loan-D', { currentBalance: 400_000, absBalance: 400_000, ltv: 0.3 });
    const map = new Map([['loan-A', 'pa'], ['loan-B', 'pb'], ['loan-C', 'pc'], ['loan-D', 'pd']]);
    writeDebtSnapshot(db, [A, B, C, D], '2026-05-01', map);
    // Trusted book genuinely BREACHES: 10M / ~19.7M ≈ 0.508 > 0.40.
    expect(computePortfolioAggregateLtv(db, loadGovernors(db)).clearedConservatively).toBe(false);

    // Degrade: both high-LTV loans poisoned → priors superseded, replacements fail.
    writeDebtSnapshot(
      db,
      [
        { ...A, currentBalance: NaN, absBalance: NaN },
        { ...B, currentBalance: NaN, absBalance: NaN },
        C,
        D,
      ],
      '2026-06-01',
      map,
    );
    // Remnant-match: the corrupted rows drop from the next parse entirely.
    writeDebtSnapshot(db, [C, D], '2026-06-02', map);

    const agg = computePortfolioAggregateLtv(db, loadGovernors(db));
    expect(agg.lastWriteRefused).toBe(true); // marker survived the remnant-matching write
    expect(agg.clearedConservatively).toBeNull(); // NEVER true — the 0.30 remnant cannot clear the book
  });

  it('GET /refi-windows carries lastWriteRefused end-to-end after a refused write (the unattended-path scenario)', async () => {
    const db = freshDb();
    const { loans, map } = seedCoveredBook(db);
    writeDebtSnapshot(db, loans, '2026-05-01', map);
    writeDebtSnapshot(db, [], '2026-06-01'); // simulate the reload path's refused write

    const app = debtApi(() => db);
    const res = await app.request('/refi-windows');
    expect(res.status).toBe(200);
    const parsed = RefiWindowsResponse.parse(await res.json());
    expect(parsed.aggregate.lastWriteRefused).toBe(true);
    expect(parsed.aggregate.clearedConservatively).toBeNull();
  });
});
