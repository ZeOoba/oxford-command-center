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
    '2026-07-01',
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
        { is_demand: 1, maturity_date: '2030-01-01', months_to_maturity: 40 },
        ASOF,
      ),
    ).toBeNull();
  });

  it('recomputes fresh from maturity_date, ignoring the stale stored column', () => {
    const months = effectiveMonthsToMaturity(
      { is_demand: 0, maturity_date: isoMonthsFromAsOf(6), months_to_maturity: 99 },
      ASOF,
    );
    expect(months).not.toBeNull();
    expect(months!).toBeGreaterThan(5);
    expect(months!).toBeLessThan(7);
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

  it('no active debt → trivially cleared (true aggregate LTV is 0)', () => {
    const db = freshDb();
    const agg = computePortfolioAggregateLtv(db, loadGovernors(db));
    expect(agg.totalLoanCount).toBe(0);
    expect(agg.aggregateLtv).toBeNull();
    expect(agg.complete).toBe(true);
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
