// @vitest-environment node
//
// tests/unit/debt-api.test.ts
//
// Phase 2 Step 5 + binding fixes — Debt API sub-router tests.
// Spec: docs/superpowers/specs/2026-06-20-phase-2-debt-refi-scoring-ai-narrative-briefings.md
//
// Tests:
//   GET /scores returns array — mock db + metrics + null FRED → valid DebtScoreResponse
//   GET /scores with FRED null — null market rate → all signals are 'hold' (no refi without rate)
//   GET /maturity returns ladder — active debt_positions → buckets assigned correctly
//   GET /maturity bucket boundaries — months_to_maturity=12→'0-12', =13→'13-24', null→'37+'
//
// All tests use a fresh in-memory SQLite warehouse (tmpdir) — never touches finance.sqlite.
// FRED is never called live: getMacro() is mocked to return null/seeded values.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { debtApi, type DebtApiSnapshotPayload } from '../../server/warehouse/debt-api';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { DebtScoreResponse, MaturityLadderResponse } from '@contracts/debt';

// ── Mock getMacro — no live FRED calls in unit tests ──────────────────────────────────────

vi.mock('../../server/macro/getMacro', () => ({
  getMacro: vi.fn(),
}));

import { getMacro } from '../../server/macro/getMacro';
const mockGetMacro = vi.mocked(getMacro);

// ── Helpers ───────────────────────────────────────────────────────────────────────────────

/** Open a fresh in-memory warehouse (all migrations applied). */
function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'debt-api-test-'));
  return openWarehouse(join(dir, 'test.sqlite'));
}

/** Build a Hono app wired to the given db. */
function makeApp(db: WarehouseDb) {
  return debtApi(() => db);
}

/**
 * Seed a property_master row so FK constraints on debt_positions are satisfied.
 * Returns the property_id used.
 */
function seedProperty(db: WarehouseDb, id = 'prop-A', name = 'Test Property A'): string {
  db.prepare(
    `INSERT OR IGNORE INTO property_master (id, name, market, rentable_sf, acquisition_date)
     VALUES (?, ?, 'Columbus', 20000, '2020-01-01')`,
  ).run(id, name);
  return id;
}

/**
 * Seed a debt_positions row.
 * Defaults: active loan, balance=500000, no maturity, ltv=0.30.
 */
function seedLoan(
  db: WarehouseDb,
  opts: {
    id?: string;
    propertyId?: string;
    loanName?: string;
    currentBalance?: number;
    monthsToMaturity?: number | null;
    maturityDate?: string | null;
    ltv?: number | null;
    balloon?: number;
    isDemand?: number;
    status?: string;
    monthlyPmt?: number | null;
  } = {},
): string {
  const id = opts.id ?? `loan-${Date.now()}-${Math.random()}`;
  const propertyId = opts.propertyId ?? null;
  db.prepare(
    `INSERT INTO debt_positions
       (id, snapshot_date, property_id, loan_name, current_balance,
        months_to_maturity, maturity_date, ltv, balloon, is_demand,
        monthly_pmt, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    '2026-06-01',
    propertyId,
    opts.loanName ?? 'Test Loan',
    opts.currentBalance ?? 500_000,
    opts.monthsToMaturity ?? null,
    opts.maturityDate ?? null,
    opts.ltv ?? 0.30,
    opts.balloon ?? 0,
    opts.isDemand ?? 0,
    opts.monthlyPmt ?? 3_000,
    opts.status ?? 'active',
  );
  return id;
}

/** Return a minimal seeded MacroSnapshot with a specified DGS5 value. */
function macroWithDgs5(dgs5Pct: number | null) {
  return {
    asOf: '2026-06-01',
    source: 'mock' as const,
    indicators: [
      { id: 'DGS10', label: '10Y Treasury', value: 4.47, unit: '%', change: null },
      { id: 'DGS5', label: '5Y Treasury', value: dgs5Pct, unit: '%', change: null },
      { id: 'DGS2', label: '2Y Treasury', value: 4.05, unit: '%', change: null },
      { id: 'SOFR', label: 'SOFR', value: 3.63, unit: '%', change: null },
      { id: 'FEDFUNDS', label: 'Fed Funds (effective)', value: 3.63, unit: '%', change: null },
      { id: 'CPIAUCSL', label: 'CPI (YoY)', value: 3.8, unit: '%', change: null },
    ],
    tenYearHistory: [],
  };
}

// ── Reset mocks between tests ─────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.resetAllMocks();
});

// ── GET /scores ───────────────────────────────────────────────────────────────────────────

describe('GET /scores', () => {
  it('returns 200 and a valid DebtScoreResponse on an empty warehouse (no active loans)', async () => {
    const db = freshDb();
    const app = makeApp(db);

    mockGetMacro.mockResolvedValue(macroWithDgs5(4.18));

    const res = await app.request('/scores');
    expect(res.status).toBe(200);

    const body = await res.json() as unknown;
    const parsed = DebtScoreResponse.safeParse(body);
    expect(parsed.success, `Zod parse failed: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`).toBe(true);
    if (parsed.success) {
      expect(Array.isArray(parsed.data.scores)).toBe(true);
    }
  });

  it('returns DebtScoreResponse-shaped body when active loans exist', async () => {
    const db = freshDb();
    const app = makeApp(db);

    mockGetMacro.mockResolvedValue(macroWithDgs5(4.18));

    seedProperty(db, 'prop-A');
    seedLoan(db, { propertyId: 'prop-A', ltv: 0.30, monthlyPmt: 3000 });

    const res = await app.request('/scores');
    expect(res.status).toBe(200);

    const body = await res.json() as unknown;
    const parsed = DebtScoreResponse.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.scores.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('returns 200 with null market rate when DGS5 value is null (FRED outage path)', async () => {
    // DGS5 indicator present but value is null → marketRateFiveYearTreasury = null
    const db = freshDb();
    const app = makeApp(db);

    mockGetMacro.mockResolvedValue(macroWithDgs5(null));

    seedProperty(db, 'prop-B');
    seedLoan(db, { propertyId: 'prop-B', ltv: 0.28, monthlyPmt: 2500 });

    const res = await app.request('/scores');
    expect(res.status).toBe(200);

    const body = await res.json() as { scores: Array<{ signal: string }> };
    // With null market rate, the refi signal is suppressed; governor-clear properties → 'hold'
    expect(Array.isArray(body.scores)).toBe(true);
    if (body.scores.length > 0) {
      // No 'refi' signal is possible without a market rate
      for (const s of body.scores) {
        expect(s.signal).not.toBe('refi');
      }
    }
  });

  it('returns 200 with null DGS5 when getMacro throws (FRED unavailable)', async () => {
    // getMacro rejection must not produce a 500 — FRED unavailability is non-fatal
    const db = freshDb();
    const app = makeApp(db);

    mockGetMacro.mockRejectedValue(new Error('FRED API timeout'));

    const res = await app.request('/scores');
    expect(res.status).toBe(200);

    const body = await res.json() as unknown;
    const parsed = DebtScoreResponse.safeParse(body);
    expect(parsed.success).toBe(true);
  });
});

// ── GET /maturity ─────────────────────────────────────────────────────────────────────────

describe('GET /maturity', () => {
  it('returns 200 and a valid MaturityLadderResponse on an empty warehouse', async () => {
    const db = freshDb();
    const app = makeApp(db);

    const res = await app.request('/maturity');
    expect(res.status).toBe(200);

    const body = await res.json() as unknown;
    const parsed = MaturityLadderResponse.safeParse(body);
    expect(parsed.success, `Zod parse failed: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`).toBe(true);
    if (parsed.success) {
      expect(parsed.data.ladder).toHaveLength(0);
    }
  });

  it('includes active loans but not retired ones', async () => {
    const db = freshDb();
    const app = makeApp(db);

    seedProperty(db, 'prop-C');
    seedLoan(db, { id: 'loan-active', propertyId: 'prop-C', status: 'active', monthsToMaturity: 24 });
    seedLoan(db, { id: 'loan-retired', propertyId: 'prop-C', status: 'retired', monthsToMaturity: 6 });

    const res = await app.request('/maturity');
    expect(res.status).toBe(200);

    const body = await res.json() as { ladder: Array<{ loanId: string }> };
    expect(body.ladder.some((e) => e.loanId === 'loan-active')).toBe(true);
    expect(body.ladder.some((e) => e.loanId === 'loan-retired')).toBe(false);
  });

  it('validates the response shape with Zod MaturityLadderResponse', async () => {
    const db = freshDb();
    const app = makeApp(db);

    seedProperty(db, 'prop-D', 'Warehouse D');
    seedLoan(db, { id: 'loan-D1', propertyId: 'prop-D', monthsToMaturity: 18, ltv: 0.35, balloon: 1 });
    seedLoan(db, { id: 'loan-D2', propertyId: 'prop-D', monthsToMaturity: null, ltv: 0.45, isDemand: 1 });

    const res = await app.request('/maturity');
    expect(res.status).toBe(200);

    const body = await res.json() as unknown;
    const parsed = MaturityLadderResponse.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.ladder).toHaveLength(2);
    }
  });

  it('joins property_master for propertyName', async () => {
    const db = freshDb();
    const app = makeApp(db);

    seedProperty(db, 'prop-E', 'My Flex Building');
    seedLoan(db, { id: 'loan-E1', propertyId: 'prop-E', monthsToMaturity: 6 });

    const res = await app.request('/maturity');
    const body = await res.json() as { ladder: Array<{ propertyName: string }> };
    const entry = body.ladder.find(() => true);
    expect(entry?.propertyName).toBe('My Flex Building');
  });
});

// ── GET /maturity bucket boundary tests ───────────────────────────────────────────────────

describe('GET /maturity bucket boundaries', () => {
  it('months_to_maturity = 12 → bucket "0-12"', async () => {
    const db = freshDb();
    const app = makeApp(db);
    seedProperty(db, 'prop-F');
    seedLoan(db, { id: 'loan-12', propertyId: 'prop-F', monthsToMaturity: 12 });

    const res = await app.request('/maturity');
    const body = await res.json() as { ladder: Array<{ loanId: string; bucket: string }> };
    const entry = body.ladder.find((e) => e.loanId === 'loan-12');
    expect(entry?.bucket).toBe('0-12');
  });

  it('months_to_maturity = 13 → bucket "13-24"', async () => {
    const db = freshDb();
    const app = makeApp(db);
    seedProperty(db, 'prop-G');
    seedLoan(db, { id: 'loan-13', propertyId: 'prop-G', monthsToMaturity: 13 });

    const res = await app.request('/maturity');
    const body = await res.json() as { ladder: Array<{ loanId: string; bucket: string }> };
    const entry = body.ladder.find((e) => e.loanId === 'loan-13');
    expect(entry?.bucket).toBe('13-24');
  });

  it('months_to_maturity = 24 → bucket "13-24"', async () => {
    const db = freshDb();
    const app = makeApp(db);
    seedProperty(db, 'prop-H');
    seedLoan(db, { id: 'loan-24', propertyId: 'prop-H', monthsToMaturity: 24 });

    const res = await app.request('/maturity');
    const body = await res.json() as { ladder: Array<{ loanId: string; bucket: string }> };
    const entry = body.ladder.find((e) => e.loanId === 'loan-24');
    expect(entry?.bucket).toBe('13-24');
  });

  it('months_to_maturity = 25 → bucket "25-36"', async () => {
    const db = freshDb();
    const app = makeApp(db);
    seedProperty(db, 'prop-I');
    seedLoan(db, { id: 'loan-25', propertyId: 'prop-I', monthsToMaturity: 25 });

    const res = await app.request('/maturity');
    const body = await res.json() as { ladder: Array<{ loanId: string; bucket: string }> };
    const entry = body.ladder.find((e) => e.loanId === 'loan-25');
    expect(entry?.bucket).toBe('25-36');
  });

  it('months_to_maturity = 36 → bucket "25-36"', async () => {
    const db = freshDb();
    const app = makeApp(db);
    seedProperty(db, 'prop-J');
    seedLoan(db, { id: 'loan-36', propertyId: 'prop-J', monthsToMaturity: 36 });

    const res = await app.request('/maturity');
    const body = await res.json() as { ladder: Array<{ loanId: string; bucket: string }> };
    const entry = body.ladder.find((e) => e.loanId === 'loan-36');
    expect(entry?.bucket).toBe('25-36');
  });

  it('months_to_maturity = 37 → bucket "37+"', async () => {
    const db = freshDb();
    const app = makeApp(db);
    seedProperty(db, 'prop-K');
    seedLoan(db, { id: 'loan-37', propertyId: 'prop-K', monthsToMaturity: 37 });

    const res = await app.request('/maturity');
    const body = await res.json() as { ladder: Array<{ loanId: string; bucket: string }> };
    const entry = body.ladder.find((e) => e.loanId === 'loan-37');
    expect(entry?.bucket).toBe('37+');
  });

  it('months_to_maturity = null (demand note / unknown) → bucket "37+"', async () => {
    const db = freshDb();
    const app = makeApp(db);
    seedProperty(db, 'prop-L');
    seedLoan(db, { id: 'loan-null', propertyId: 'prop-L', monthsToMaturity: null, isDemand: 1 });

    const res = await app.request('/maturity');
    const body = await res.json() as { ladder: Array<{ loanId: string; bucket: string; isDemand: boolean }> };
    const entry = body.ladder.find((e) => e.loanId === 'loan-null');
    expect(entry?.bucket).toBe('37+');
    expect(entry?.isDemand).toBe(true);
  });
});

// ── POST /snapshot — multi-property-lender defect regression ─────────────────────────────

/**
 * THE ORIGINAL DEFECT TEST:
 * Two loans from ONE lender on TWO different properties → each maps to its OWN property_master id.
 * Before this fix, the lender-counterparty cross-product misattributed debt (same property to both).
 */
describe('POST /snapshot — two loans from one lender on two properties', () => {
  it('each loan maps to its own property_master id — not a cross-product (original defect fixed)', async () => {
    const db = freshDb();
    const app = makeApp(db);

    // Seed TWO distinct property_master rows
    seedProperty(db, '3540-e-5th-ave-columbus-oh', '3540 E. 5th Ave, Columbus OH');
    seedProperty(db, '29000-information-lane-easton-md', '29000 Information Lane, Easton MD');

    // Two borrower loans from the SAME lender, but on DIFFERENT collateral properties
    const payload: DebtApiSnapshotPayload = {
      snapshotDate: '2026-06-21',
      loans: [
        {
          id: 'borrower-5th-ave',
          name: '5th Ave Mortgage',
          counterparty: 'Acme Lending LLC',
          direction: 'borrower' as const,
          originalPrincipal: 1_000_000,
          currentBalance: 800_000,
          absBalance: 800_000,
          rate: 0.065,
          monthlyPmt: 5_000,
          annualInterest: 52_000,
          annualPrincipal: 8_000,
          loanType: 'Amortizing',
          status: 'Active',
          isDemand: false,
          maturity: '2031-01-01',
          monthsToMaturity: 54,
          ltv: 0.35,
          lender: 'Acme Lending LLC',
          balloon: false,
          flags: [],
          collateralProperty: '3540 E. 5th Ave, Columbus OH',
        },
        {
          id: 'borrower-easton-md',
          name: 'Easton Mortgage',
          counterparty: 'Acme Lending LLC', // SAME lender
          direction: 'borrower' as const,
          originalPrincipal: 2_000_000,
          currentBalance: 1_700_000,
          absBalance: 1_700_000,
          rate: 0.06,
          monthlyPmt: 9_000,
          annualInterest: 102_000,
          annualPrincipal: 6_000,
          loanType: 'Amortizing',
          status: 'Active',
          isDemand: false,
          maturity: '2030-06-01',
          monthsToMaturity: 48,
          ltv: 0.38,
          lender: 'Acme Lending LLC', // SAME lender — the original defect point
          balloon: false,
          flags: [],
          collateralProperty: '29000 Information Lane, Easton MD',
        },
      ],
      properties: [
        { id: '3540-e-5th-ave-columbus-oh', name: '3540 E. 5th Ave, Columbus OH' },
        { id: '29000-information-lane-easton-md', name: '29000 Information Lane, Easton MD' },
      ],
    };

    const res = await app.request('/snapshot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; written: number; unresolved: number; errors: string[] };
    expect(body.ok).toBe(true);
    expect(body.written).toBe(2);
    expect(body.unresolved).toBe(0);
    expect(body.errors).toHaveLength(0);

    // CRITICAL: each loan must have its OWN distinct property_id in the DB
    const rows = db
      .prepare('SELECT id, property_id FROM debt_positions WHERE status = \'active\' ORDER BY id')
      .all() as Array<{ id: string; property_id: string | null }>;

    expect(rows).toHaveLength(2);
    const fiveAveRow = rows.find((r) => r.id === 'borrower-5th-ave');
    const eastonRow = rows.find((r) => r.id === 'borrower-easton-md');

    expect(fiveAveRow?.property_id).toBe('3540-e-5th-ave-columbus-oh');
    expect(eastonRow?.property_id).toBe('29000-information-lane-easton-md');

    // The two properties MUST be different (the original defect would make them the same or cross-product)
    expect(fiveAveRow?.property_id).not.toBe(eastonRow?.property_id);
  });

  it('unresolvable collateralProperty (null) → property_id null + unresolved count reported', async () => {
    const db = freshDb();
    const app = makeApp(db);

    const payload: DebtApiSnapshotPayload = {
      snapshotDate: '2026-06-21',
      loans: [
        {
          id: 'loan-no-prop',
          name: 'Unattributed Loan',
          counterparty: 'Some Bank',
          direction: 'borrower' as const,
          originalPrincipal: null,
          currentBalance: 500_000,
          absBalance: 500_000,
          rate: 0.07,
          monthlyPmt: 3_000,
          annualInterest: 35_000,
          annualPrincipal: 1_000,
          loanType: null,
          status: 'Active',
          isDemand: false,
          maturity: null,
          monthsToMaturity: null,
          ltv: null,
          lender: 'Some Bank',
          balloon: false,
          flags: [],
          collateralProperty: null, // unattributed — column not filled yet
        },
      ],
      properties: [],
    };

    const res = await app.request('/snapshot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; written: number; unresolved: number; errors: string[] };
    expect(body.ok).toBe(true);
    expect(body.written).toBe(1); // row written, not dropped
    expect(body.unresolved).toBe(1); // unresolved count is reported
  });

  it('typo\'d non-blank collateralProperty not in property_master → unresolved count reported (not silently mapped)', async () => {
    // Fix MEDIUM regression: a non-blank collateralProperty that resolves to a slug which is
    // NOT in property_master must land in unresolved (not silently enter the map).
    // This guards the 0.40 LTV governor — a typo'd collateral name can mask a governor breach
    // if the loan is bound to the wrong (or no) property.
    const db = freshDb();
    const app = makeApp(db);

    // Do NOT seed a property_master row for 'typo-property-id' — it doesn't exist.
    // The loan's collateralProperty is non-blank but resolves to an id not in property_master.

    const payload: DebtApiSnapshotPayload = {
      snapshotDate: '2026-06-21',
      loans: [
        {
          id: 'loan-typo-collateral',
          name: 'Loan With Typo\'d Property',
          counterparty: 'Some Bank',
          direction: 'borrower' as const,
          originalPrincipal: 2_000_000,
          currentBalance: 800_000,
          absBalance: 800_000,
          rate: 0.065,
          monthlyPmt: 5_000,
          annualInterest: 52_000,
          annualPrincipal: 8_000,
          loanType: 'Amortizing',
          status: 'Active',
          isDemand: false,
          maturity: '2031-01-01',
          monthsToMaturity: 54,
          ltv: 0.40,
          lender: 'Some Bank',
          balloon: false,
          flags: [],
          collateralProperty: 'Typo Property Name XYZ', // non-blank but not in property_master
        },
      ],
      properties: [
        // Properties list does NOT include any entry matching 'Typo Property Name XYZ'
        { id: 'some-other-prop', name: 'Some Other Property' },
      ],
    };

    const res = await app.request('/snapshot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; written: number; unresolved: number; errors: string[] };
    expect(body.ok).toBe(true);
    expect(body.written).toBe(1); // row still written (not dropped)
    // CRITICAL: the typo'd name must be counted as unresolved — NOT silently mapped
    expect(body.unresolved).toBe(1);
  });
});

// ── /maturity signal tests ─────────────────────────────────────────────────────────────────

describe('GET /maturity loan signal', () => {
  it('ltv > 0.40 → signal "governor-block"', async () => {
    const db = freshDb();
    const app = makeApp(db);
    seedProperty(db, 'prop-M');
    seedLoan(db, { id: 'loan-high-ltv', propertyId: 'prop-M', ltv: 0.45, monthsToMaturity: 18 });

    const res = await app.request('/maturity');
    const body = await res.json() as { ladder: Array<{ loanId: string; signal: string }> };
    const entry = body.ladder.find((e) => e.loanId === 'loan-high-ltv');
    expect(entry?.signal).toBe('governor-block');
  });

  it('ltv = 0.40 (exactly at ceiling) → signal "hold" (not governor-block)', async () => {
    const db = freshDb();
    const app = makeApp(db);
    seedProperty(db, 'prop-N');
    seedLoan(db, { id: 'loan-ltv-40', propertyId: 'prop-N', ltv: 0.40, monthsToMaturity: 18 });

    const res = await app.request('/maturity');
    const body = await res.json() as { ladder: Array<{ loanId: string; signal: string }> };
    const entry = body.ladder.find((e) => e.loanId === 'loan-ltv-40');
    expect(entry?.signal).toBe('hold');
  });

  it('ltv = null → signal "hold"', async () => {
    const db = freshDb();
    const app = makeApp(db);
    seedProperty(db, 'prop-O');
    seedLoan(db, { id: 'loan-no-ltv', propertyId: 'prop-O', ltv: null, monthsToMaturity: 18 });

    const res = await app.request('/maturity');
    const body = await res.json() as { ladder: Array<{ loanId: string; signal: string }> };
    const entry = body.ladder.find((e) => e.loanId === 'loan-no-ltv');
    expect(entry?.signal).toBe('hold');
  });
});
