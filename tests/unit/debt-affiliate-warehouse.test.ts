// @vitest-environment node
//
// tests/unit/debt-affiliate-warehouse.test.ts
//
// Task 7b (ratified 2026-09-26): the warehouse debt path excludes affiliate (Oxford-to-Oxford)
// borrower notes from the LTV governor basis — D1 LTV in debt-scoring and the aggregate LTV
// governor in debt-maturity — via the ONE predicate in src/analytics/debt-basis.ts. Position
// views (maturity ladder, timeline) still LIST the affiliate row, labeled affiliate. DSCR /
// debt-service treatment is an OPEN ruling and is deliberately unchanged here.
//
// Fixture strings mirror what the live warehouse actually stores (read-only query 2026-09-26):
//   lender = 'LAST Non / Oxford Capital — Oxford 50% share'   (the '3883 from Oxford (50%)' note)
//   lender = 'Oxford / Symetra Life Insurance (Loan #10258)'  (third-party — NOT affiliate)
//   lender = '3540 Fifth Ave, LLC (Park National Bank)'        (third-party)
// debt_positions has NO counterparty column — only lender + loan_name are persisted.
//
// All tests use a fresh SQLite warehouse in tmpdir — never touches finance.sqlite.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach, vi } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { scoreDebtPositions } from '../../server/warehouse/debt-scoring';
import {
  buildMaturityTimeline,
  computePortfolioAggregateLtv,
} from '../../server/warehouse/debt-maturity';
import { debtApi } from '../../server/warehouse/debt-api';
import { loadGovernors } from '../../server/warehouse/governors';
import { MaturityLadderResponse } from '@contracts/debt';
import { AFFILIATE_POSITION_LABEL, isAffiliateDebtPosition } from '../../src/analytics/debt-basis';
import type { PeriodMetrics } from '../../src/contracts/warehouse';

vi.mock('../../server/macro/getMacro', () => ({ getMacro: vi.fn(async () => null) }));

const LIVE_AFFILIATE_LENDER = 'LAST Non / Oxford Capital — Oxford 50% share';
const LIVE_AFFILIATE_LOAN_NAME = '3883 from Oxford (50%)';
const LIVE_SYMETRA_LENDER = 'Oxford / Symetra Life Insurance (Loan #10258)';
const LIVE_PARK_NATIONAL_LENDER = '3540 Fifth Ave, LLC (Park National Bank)';
const FIRM_STYLING_LENDER = 'Oxford Capital Partners (Park National Bank)';

const ASOF = '2026-07-18';
const dbs: WarehouseDb[] = [];

function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'debt-affiliate-wh-test-'));
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

function seedProperty(db: WarehouseDb, id: string): string {
  db.prepare(
    `INSERT OR IGNORE INTO property_master
       (id, name, market, financial_mode, rentable_sf, acquisition_date, ownership_pct, ownership_status)
     VALUES (?, ?, 'Columbus', 'pnl', 20000, '2020-01-01', 1, 'active')`,
  ).run(id, `Property ${id}`);
  return id;
}

let seq = 0;
function seedLoan(
  db: WarehouseDb,
  opts: {
    propertyId: string;
    lender: string;
    loanName?: string;
    balance?: number;
    ltv?: number | null;
    rate?: number | null;
    monthlyPmt?: number | null;
    maturityDate?: string | null;
  },
): string {
  const id = `loan-${++seq}`;
  db.prepare(
    `INSERT INTO debt_positions
       (id, snapshot_date, property_id, loan_name, lender, current_balance, ltv, rate,
        monthly_pmt, maturity_date, balloon, is_demand, status)
     VALUES (?, '2026-07-01', ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'active')`,
  ).run(
    id,
    opts.propertyId,
    opts.loanName ?? `Loan ${id}`,
    opts.lender,
    opts.balance ?? 500_000,
    opts.ltv === undefined ? 0.3 : opts.ltv,
    opts.rate === undefined ? 0.055 : opts.rate,
    opts.monthlyPmt === undefined ? 3_000 : opts.monthlyPmt,
    opts.maturityDate === undefined ? '2031-01-01' : opts.maturityDate,
  );
  return id;
}

function yearMetric(propertyId: string, noi: number): PeriodMetrics {
  return {
    propertyId,
    period: '2025',
    grainHint: 'year',
    revenue: noi * 2,
    opex: noi,
    noi,
    oxfordNoi: noi,
    ownershipPct: 1,
    noiMargin: 0.5,
    noiPerSf: noi / 20000,
    revenuePerSf: (noi * 2) / 20000,
    opexPerSf: noi / 20000,
    sourceFile: 'test',
  } as unknown as PeriodMetrics;
}

// ── Predicate ─────────────────────────────────────────────────────────────────────────────

describe('isAffiliateDebtPosition — the one warehouse predicate, matched against live stored strings', () => {
  it('matches the live "3883 from Oxford (50%)" row by its stored lender string', () => {
    expect(
      isAffiliateDebtPosition({ lender: LIVE_AFFILIATE_LENDER, loan_name: LIVE_AFFILIATE_LOAN_NAME }),
    ).toBe(true);
  });

  it('does NOT match "Oxford / Symetra…" or "…(Park National Bank)" third-party rows', () => {
    expect(isAffiliateDebtPosition({ lender: LIVE_SYMETRA_LENDER, loan_name: '29000 Information Lane' })).toBe(false);
    expect(isAffiliateDebtPosition({ lender: LIVE_PARK_NATIONAL_LENDER, loan_name: '3540 E. Fifth Ave' })).toBe(false);
  });

  it('does NOT match the firm\'s own styling "Oxford Capital Partners (Park National Bank)"', () => {
    expect(isAffiliateDebtPosition({ lender: FIRM_STYLING_LENDER, loan_name: 'Firm line' })).toBe(false);
  });

  it('falls back to loan_name ONLY when no lender is stored (whitespace-normalized)', () => {
    expect(isAffiliateDebtPosition({ lender: null, loan_name: 'Note payable —  Oxford Capital' })).toBe(true);
    expect(isAffiliateDebtPosition({ lender: '  ', loan_name: 'Oxford Capital note' })).toBe(true);
    expect(isAffiliateDebtPosition({ lender: null, loan_name: 'Plain note' })).toBe(false);
  });

  it('a third-party lender row whose loan_name merely mentions an affiliate stays third-party', () => {
    // Mirrors isAffiliateBorrowerLoan: the lender field decides; free-text names never widen it.
    expect(
      isAffiliateDebtPosition({ lender: LIVE_PARK_NATIONAL_LENDER, loan_name: 'Refi of Oxford Capital note' }),
    ).toBe(false);
  });
});

// ── Aggregate LTV governor basis ──────────────────────────────────────────────────────────

describe('computePortfolioAggregateLtv — affiliate notes out of the aggregate governor basis', () => {
  it('excludes the affiliate balance; verdict matches third-party-only', () => {
    const db = freshDb();
    const a = seedProperty(db, 'prop-a');
    const b = seedProperty(db, 'prop-b');
    // Third-party: $2.0M @ 0.35 → implied value $5.714M
    seedLoan(db, { propertyId: a, lender: LIVE_PARK_NATIONAL_LENDER, balance: 2_000_000, ltv: 0.35 });
    // Affiliate: $385K @ 0.90 — would drag the aggregate above the ceiling if counted
    seedLoan(db, {
      propertyId: b,
      lender: LIVE_AFFILIATE_LENDER,
      loanName: LIVE_AFFILIATE_LOAN_NAME,
      balance: 385_000,
      ltv: 0.9,
    });

    const agg = computePortfolioAggregateLtv(db);
    expect(agg.aggregateLtv).toBeCloseTo(0.35, 6);
    expect(agg.coveredLoanCount).toBe(1);
    expect(agg.totalLoanCount).toBe(1);
    expect(agg.complete).toBe(true);
    expect(agg.clearedConservatively).toBe(true);
    expect(agg.note).toMatch(/1 affiliate note/i);

    // Same verdict as a book that never had the affiliate row.
    const db2 = freshDb();
    seedLoan(db2, { propertyId: seedProperty(db2, 'prop-a'), lender: LIVE_PARK_NATIONAL_LENDER, balance: 2_000_000, ltv: 0.35 });
    const ref = computePortfolioAggregateLtv(db2);
    expect(agg.aggregateLtv).toBe(ref.aggregateLtv);
    expect(agg.clearedConservatively).toBe(ref.clearedConservatively);
    expect(agg.coveredLoanCount).toBe(ref.coveredLoanCount);
  });

  it('an affiliate note beside a third-party loan on the SAME property does not make it multi-loan', () => {
    const db = freshDb();
    const a = seedProperty(db, 'prop-a');
    seedLoan(db, { propertyId: a, lender: LIVE_PARK_NATIONAL_LENDER, balance: 1_000_000, ltv: 0.3 });
    seedLoan(db, { propertyId: a, lender: LIVE_AFFILIATE_LENDER, balance: 200_000, ltv: 0.5 });
    const agg = computePortfolioAggregateLtv(db);
    expect(agg.complete).toBe(true);
    expect(agg.coveredLoanCount).toBe(1);
    expect(agg.aggregateLtv).toBeCloseTo(0.3, 6);
  });

  it('a book whose ONLY active row is affiliate issues no verdict (not a clearance)', () => {
    const db = freshDb();
    seedLoan(db, { propertyId: seedProperty(db, 'prop-b'), lender: LIVE_AFFILIATE_LENDER, balance: 385_000, ltv: 0.9 });
    const agg = computePortfolioAggregateLtv(db);
    expect(agg.clearedConservatively).toBeNull();
    expect(agg.aggregateLtv).toBeNull();
    expect(agg.emptyCohort).toBe(true);
    expect(agg.note).toMatch(/affiliate/i);
  });

  it('a colliding AFFILIATE row is snapshot evidence: complete=false, verdict null', () => {
    const db = freshDb();
    const a = seedProperty(db, 'prop-a');
    const b = seedProperty(db, 'prop-b');
    seedLoan(db, { propertyId: a, lender: LIVE_PARK_NATIONAL_LENDER, balance: 2_000_000, rate: null, ltv: 0.3 });
    seedLoan(db, { propertyId: b, lender: LIVE_AFFILIATE_LENDER, balance: 200_000, rate: 0.0625, ltv: 0.0625 });
    const agg = computePortfolioAggregateLtv(db);
    expect(agg.complete).toBe(false);
    expect(agg.clearedConservatively).toBeNull();
    expect(agg.note).toMatch(/collides/i);
    expect(agg.note).toMatch(/affiliate/i);
  });

  it('"Oxford / Symetra…" and "Oxford Capital Partners (Park National Bank)" stay in the basis', () => {
    const db = freshDb();
    seedLoan(db, { propertyId: seedProperty(db, 'prop-a'), lender: LIVE_SYMETRA_LENDER, balance: 1_000_000, ltv: 0.4 });
    seedLoan(db, { propertyId: seedProperty(db, 'prop-b'), lender: FIRM_STYLING_LENDER, balance: 1_000_000, ltv: 0.4 });
    const agg = computePortfolioAggregateLtv(db);
    expect(agg.totalLoanCount).toBe(2);
    expect(agg.coveredLoanCount).toBe(2);
    expect(agg.note).not.toMatch(/affiliate/i);
  });
});

// ── D1 LTV in debt-scoring ────────────────────────────────────────────────────────────────

describe('scoreDebtPositions — D1 LTV ignores affiliate rows; DSCR unchanged (open ruling)', () => {
  it('a property whose only active position is affiliate carries no LTV signal', () => {
    const db = freshDb();
    const b = seedProperty(db, 'prop-b');
    seedLoan(db, {
      propertyId: b,
      lender: LIVE_AFFILIATE_LENDER,
      loanName: LIVE_AFFILIATE_LOAN_NAME,
      balance: 385_000,
      ltv: 0.9, // would be a governor-block if counted
      monthlyPmt: 3_000,
    });
    const scores = scoreDebtPositions(db, [yearMetric(b, 100_000)], null, ASOF);
    const s = scores.find((x) => x.propertyId === b);
    expect(s).toBeDefined();
    expect(s!.ltv).toBeNull();
    expect(s!.ltvHeadroom).toBeNull();
    expect(s!.signal).not.toBe('governor-block');
    // DSCR deliberately still counts the affiliate note's debt service (open ruling).
    expect(s!.dscr).toBeCloseTo(100_000 / 36_000, 6);
    expect(s!.signal).toBe('hold');
    // Fix round (refute wf_3f479f7e-1eb): NOT the "populate the workbook LTV column" errand —
    // there is no third-party leverage to test, so the reason says so.
    expect(s!.signalReason).toBe(
      'LTV governor not applicable — only Oxford-affiliate debt on this property (excluded from the LTV basis, ratified 2026-09-26); DSCR still evaluated',
    );
    expect(s!.signalReason).not.toMatch(/LTV unknown|populat/i);
  });

  it('affiliate-only property with no warehouse NOI: dedicated reason, DSCR flagged unknown', () => {
    const db = freshDb();
    const b = seedProperty(db, 'prop-b');
    seedLoan(db, { propertyId: b, lender: LIVE_AFFILIATE_LENDER, ltv: 0.9 });
    const s = scoreDebtPositions(db, [], null, ASOF).find((x) => x.propertyId === b);
    expect(s!.signal).toBe('hold');
    expect(s!.signalReason).toBe(
      'LTV governor not applicable — only Oxford-affiliate debt on this property (excluded from the LTV basis, ratified 2026-09-26); DSCR unknown (no warehouse NOI for this property)',
    );
  });

  it('collision evidence on an AFFILIATE row still poisons the property D1 pick (snapshot column-drift)', () => {
    const db = freshDb();
    const p = seedProperty(db, 'prop-a');
    seedLoan(db, { propertyId: p, lender: LIVE_PARK_NATIONAL_LENDER, balance: 800_000, rate: null, ltv: 0.3 });
    seedLoan(db, { propertyId: p, lender: LIVE_AFFILIATE_LENDER, balance: 200_000, rate: 0.0625, ltv: 0.0625 });
    const s = scoreDebtPositions(db, [yearMetric(p, 200_000)], null, ASOF).find((x) => x.propertyId === p);
    expect(s!.ltv).toBeNull();
    expect(s!.signal).toBe('hold');
    expect(s!.signalReason).toBe(
      "Governor check incomplete — LTV rejected — ltv exactly collides with its own loan's rate (workbook column-drift signature); fix the workbook ltv column mapping, then re-run snapshot",
    );
  });

  it('a colliding affiliate row still lets a measured third-party BREACH through (one-directional poisoning)', () => {
    const db = freshDb();
    const p = seedProperty(db, 'prop-a');
    seedLoan(db, { propertyId: p, lender: LIVE_PARK_NATIONAL_LENDER, balance: 800_000, rate: null, ltv: 0.55 });
    seedLoan(db, { propertyId: p, lender: LIVE_AFFILIATE_LENDER, balance: 200_000, rate: 0.0625, ltv: 0.0625 });
    const s = scoreDebtPositions(db, [yearMetric(p, 200_000)], null, ASOF).find((x) => x.propertyId === p);
    expect(s!.ltv).toBeCloseTo(0.55, 6);
    expect(s!.signal).toBe('governor-block');
  });

  it('a property with a third-party loan scores exactly as before', () => {
    const db = freshDb();
    const a = seedProperty(db, 'prop-a');
    seedLoan(db, { propertyId: a, lender: LIVE_PARK_NATIONAL_LENDER, balance: 800_000, ltv: 0.3 });
    const g = loadGovernors(db);
    const s = scoreDebtPositions(db, [yearMetric(a, 100_000)], null, ASOF).find((x) => x.propertyId === a);
    expect(s!.ltv).toBeCloseTo(0.3, 6);
    expect(s!.ltvHeadroom).toBeCloseTo(g.ltvCeiling - 0.3, 6);
  });

  it('D1 picks the highest-balance THIRD-PARTY loan even when the affiliate note is larger', () => {
    const db = freshDb();
    const a = seedProperty(db, 'prop-a');
    seedLoan(db, { propertyId: a, lender: LIVE_PARK_NATIONAL_LENDER, balance: 500_000, ltv: 0.3 });
    seedLoan(db, { propertyId: a, lender: LIVE_AFFILIATE_LENDER, balance: 900_000, ltv: 0.7 });
    const s = scoreDebtPositions(db, [yearMetric(a, 200_000)], null, ASOF).find((x) => x.propertyId === a);
    expect(s!.ltv).toBeCloseTo(0.3, 6);
  });

  it('"Oxford / Symetra…" and "Oxford Capital Partners (…)" lenders still drive D1 LTV', () => {
    const db = freshDb();
    const a = seedProperty(db, 'prop-a');
    const b = seedProperty(db, 'prop-b');
    seedLoan(db, { propertyId: a, lender: LIVE_SYMETRA_LENDER, balance: 800_000, ltv: 0.5 });
    seedLoan(db, { propertyId: b, lender: FIRM_STYLING_LENDER, balance: 800_000, ltv: 0.5 });
    const scores = scoreDebtPositions(db, [], null, ASOF);
    expect(scores.find((x) => x.propertyId === a)!.ltv).toBeCloseTo(0.5, 6);
    expect(scores.find((x) => x.propertyId === b)!.ltv).toBeCloseTo(0.5, 6);
  });
});

// ── Position views keep listing the affiliate row, labeled ────────────────────────────────

describe('position views still list the affiliate position, labeled affiliate', () => {
  it('GET /maturity ladder lists the affiliate row with the affiliate label and no LTV governor hint', async () => {
    const db = freshDb();
    const a = seedProperty(db, 'prop-a');
    const b = seedProperty(db, 'prop-b');
    seedLoan(db, { propertyId: a, lender: LIVE_PARK_NATIONAL_LENDER, loanName: '3540 E. Fifth Ave', ltv: 0.3 });
    seedLoan(db, {
      propertyId: b,
      lender: LIVE_AFFILIATE_LENDER,
      loanName: LIVE_AFFILIATE_LOAN_NAME,
      balance: 385_000,
      ltv: 0.9,
    });
    const res = await debtApi(() => db).request('/maturity');
    expect(res.status).toBe(200);
    const body = MaturityLadderResponse.parse(await res.json());
    expect(body.ladder).toHaveLength(2);
    const aff = body.ladder.find((e) => e.propertyId === b);
    expect(aff).toBeDefined();
    expect(aff!.loanName).toBe(`${LIVE_AFFILIATE_LOAN_NAME} ${AFFILIATE_POSITION_LABEL}`);
    expect(aff!.signal).toBe('hold'); // 0.9 stored LTV is not an LTV-governor breach on an affiliate note
    const tp = body.ladder.find((e) => e.propertyId === a);
    expect(tp!.loanName).toBe('3540 E. Fifth Ave');
    // Confidentiality: the lender string never crosses the boundary.
    expect(JSON.stringify(body)).not.toContain('Oxford Capital');
  });

  it('buildMaturityTimeline lists the affiliate row, labeled, with no lender key', () => {
    const db = freshDb();
    const b = seedProperty(db, 'prop-b');
    seedLoan(db, { propertyId: b, lender: LIVE_AFFILIATE_LENDER, loanName: LIVE_AFFILIATE_LOAN_NAME });
    const events = buildMaturityTimeline(db, ASOF);
    expect(events).toHaveLength(1);
    expect(events[0]!.loanName).toBe(`${LIVE_AFFILIATE_LOAN_NAME} ${AFFILIATE_POSITION_LABEL}`);
    expect(Object.keys(events[0]!)).not.toContain('lender');
  });
});
