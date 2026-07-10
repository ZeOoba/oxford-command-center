// @vitest-environment node
//
// tests/unit/debt-snapshot.test.ts
//
// Phase 2 Steps 1–3 + binding fixes — debt_positions snapshot writer.
// Verifies writeDebtSnapshot() write path, upsert semantics, supersede path,
// demand-note handling, and lender-column suppression in the DebtPosition Zod type.
//
// Uses in-memory SQLite (tmpdir) — never touches data/warehouse/finance.sqlite.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { writeDebtSnapshot } from '../../server/warehouse/debt-snapshot';
import { DebtPosition } from '../../src/contracts/debt';
import type { Loan } from '../../src/contracts/index';

function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'debt-snapshot-test-'));
  return openWarehouse(join(dir, 'test.sqlite'));
}

/** Minimal borrower loan fixture. */
function makeBorrowerLoan(overrides: Partial<Loan> = {}): Loan {
  return {
    id: 'loan-001',
    name: 'First Mortgage — 123 Main St',
    counterparty: 'First National Bank',
    direction: 'borrower',
    originalPrincipal: 1_000_000,
    currentBalance: 850_000,
    absBalance: 850_000,
    rate: 0.065,
    monthlyPmt: 5_700,
    annualInterest: 55_250,
    annualPrincipal: 13_150,
    loanType: 'Amortizing',
    status: 'Active',
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

describe('writeDebtSnapshot — direction filter', () => {
  it('writes borrower loans and excludes lender and internal loans', () => {
    const db = freshDb();
    const loans: Loan[] = [
      makeBorrowerLoan({ id: 'loan-b', direction: 'borrower' }),
      makeBorrowerLoan({ id: 'loan-l', direction: 'lender' }),
      makeBorrowerLoan({ id: 'loan-i', direction: 'internal' }),
    ];
    const result = writeDebtSnapshot(db, loans, '2026-06-21');
    expect(result.written).toBe(1);
    expect(result.errors).toHaveLength(0);

    const rows = db.prepare("SELECT id FROM debt_positions WHERE status = 'active'").all() as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('loan-b');
  });

  it('excludes loans with non-Active status when status is set', () => {
    const db = freshDb();
    const loans: Loan[] = [
      makeBorrowerLoan({ id: 'loan-active', status: 'Active' }),
      makeBorrowerLoan({ id: 'loan-null', status: null }),
      makeBorrowerLoan({ id: 'loan-paid', status: 'Paid Off' }),
      makeBorrowerLoan({ id: 'loan-retired', status: 'Retired' }),
    ];
    const result = writeDebtSnapshot(db, loans, '2026-06-21');
    expect(result.written).toBe(2); // Active + null
    const ids = (db.prepare("SELECT id FROM debt_positions WHERE status = 'active' ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain('loan-active');
    expect(ids).toContain('loan-null');
  });

  // Loan.status is free-form workbook text (src/contracts/loan.ts), not a fixed enum. The real
  // Loan Index tab never uses the literal word "Active" for a live loan — it uses descriptive
  // loan-type/maturity text instead. Confirmed empirically 2026-07-10 against the live workbook:
  // all 5 real borrower loans carried statuses like these and were silently excluded by a prior
  // allowlist-based filter, leaving debt_positions permanently empty.
  it('includes real-world descriptive active statuses (Amortizing, Interest Only, Balloon Due <date>)', () => {
    const db = freshDb();
    const loans: Loan[] = [
      makeBorrowerLoan({ id: 'loan-amortizing', status: 'Amortizing' }),
      makeBorrowerLoan({ id: 'loan-io', status: 'Interest Only' }),
      makeBorrowerLoan({ id: 'loan-balloon-due', status: 'Balloon Due Feb-27' }),
    ];
    const result = writeDebtSnapshot(db, loans, '2026-07-10');
    expect(result.written).toBe(3);
    const ids = (db.prepare("SELECT id FROM debt_positions WHERE status = 'active' ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual(['loan-amortizing', 'loan-balloon-due', 'loan-io']);
  });

  it('excludes additional known-terminal status text (Closed, Inactive, Terminated, Discharged)', () => {
    const db = freshDb();
    const loans: Loan[] = [
      makeBorrowerLoan({ id: 'loan-closed', status: 'Closed' }),
      makeBorrowerLoan({ id: 'loan-inactive', status: 'Inactive' }),
      makeBorrowerLoan({ id: 'loan-terminated', status: 'Terminated' }),
      makeBorrowerLoan({ id: 'loan-discharged', status: 'Discharged' }),
    ];
    const result = writeDebtSnapshot(db, loans, '2026-07-10');
    expect(result.written).toBe(0);
    const rows = db.prepare("SELECT id FROM debt_positions WHERE status = 'active'").all() as Array<{ id: string }>;
    expect(rows).toHaveLength(0);
  });
});

describe('writeDebtSnapshot — upsert semantics', () => {
  it('running twice with same snapshotDate updates the row; row count stays 1', () => {
    const db = freshDb();
    const loan = makeBorrowerLoan({ currentBalance: 850_000, absBalance: 850_000 });

    writeDebtSnapshot(db, [loan], '2026-06-21');
    // absBalance must match so the stored positive magnitude reflects the updated balance
    const loanV2 = { ...loan, currentBalance: 840_000, absBalance: 840_000 };
    writeDebtSnapshot(db, [loanV2], '2026-06-21');

    const rows = db.prepare("SELECT current_balance FROM debt_positions WHERE id = ? AND status = 'active'").all('loan-001') as Array<{ current_balance: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.current_balance).toBe(840_000);
  });
});

describe('writeDebtSnapshot — supersede on new snapshotDate', () => {
  it('old row is marked superseded and a new active row is inserted on a new snapshotDate', () => {
    const db = freshDb();
    const loan = makeBorrowerLoan({ currentBalance: 850_000, absBalance: 850_000 });

    writeDebtSnapshot(db, [loan], '2026-05-01');
    writeDebtSnapshot(db, [{ ...loan, currentBalance: 840_000, absBalance: 840_000 }], '2026-06-01');

    const superseded = db.prepare("SELECT id FROM debt_positions WHERE id = ? AND status = 'superseded'").all('loan-001') as Array<{ id: string }>;
    const active = db.prepare("SELECT current_balance, snapshot_date FROM debt_positions WHERE id = ? AND status = 'active'").all('loan-001') as Array<{ current_balance: number; snapshot_date: string }>;

    expect(superseded).toHaveLength(1);
    expect(active).toHaveLength(1);
    expect(active[0]?.current_balance).toBe(840_000);
    expect(active[0]?.snapshot_date).toBe('2026-06-01');
  });
});

describe('writeDebtSnapshot — demand notes', () => {
  it('handles demand notes (isDemand=true, null maturity) without error', () => {
    const db = freshDb();
    const demandNote = makeBorrowerLoan({
      id: 'loan-demand',
      isDemand: true,
      maturity: null,
      monthsToMaturity: null,
    });
    const result = writeDebtSnapshot(db, [demandNote], '2026-06-21');
    expect(result.written).toBe(1);
    expect(result.errors).toHaveLength(0);

    const row = db.prepare("SELECT is_demand, maturity_date FROM debt_positions WHERE id = ?").get('loan-demand') as { is_demand: number; maturity_date: string | null };
    expect(row.is_demand).toBe(1);
    expect(row.maturity_date).toBeNull();
  });
});

// ── F-stale: stale-row reconcile ─────────────────────────────────────────────────────────

describe('writeDebtSnapshot — F-stale: stale-row reconcile (paid-off loan removed)', () => {
  it('snapshot [A,B] then [A] → only A remains active; B is superseded', () => {
    const db = freshDb();

    const loanA = makeBorrowerLoan({ id: 'loan-A', name: 'Loan A' });
    const loanB = makeBorrowerLoan({ id: 'loan-B', name: 'Loan B' });

    // First snapshot: both A and B are active
    writeDebtSnapshot(db, [loanA, loanB], '2026-05-01');

    const afterFirst = db
      .prepare("SELECT id, status FROM debt_positions WHERE status = 'active' ORDER BY id")
      .all() as Array<{ id: string; status: string }>;
    expect(afterFirst.map((r) => r.id)).toEqual(['loan-A', 'loan-B']);

    // Second snapshot: B is removed (paid off) — only A is in the incoming set
    writeDebtSnapshot(db, [loanA], '2026-06-01');

    const activeAfter = db
      .prepare("SELECT id FROM debt_positions WHERE status = 'active' ORDER BY id")
      .all() as Array<{ id: string }>;
    expect(activeAfter.map((r) => r.id)).toEqual(['loan-A']);

    // B must be superseded, not dropped
    const bRow = db
      .prepare("SELECT id, status FROM debt_positions WHERE id = 'loan-B'")
      .get() as { id: string; status: string } | undefined;
    expect(bRow).toBeDefined();
    expect(bRow?.status).toBe('superseded');
  });
});

// ── F-FK-safe: property_id validated before insert ───────────────────────────────────────

describe('writeDebtSnapshot — F-FK-safe: invalid property_id → null + surfaced', () => {
  it('map value not in property_master → row written with property_id=null, error surfaced, not dropped', () => {
    const db = freshDb();

    const loan = makeBorrowerLoan({ id: 'loan-bad-prop' });
    // Map points to a property id that is NOT in property_master
    const badMap = new Map([['loan-bad-prop', 'nonexistent-property-id']]);

    const result = writeDebtSnapshot(db, [loan], '2026-06-01', badMap);

    // Row must be written (not dropped)
    expect(result.written).toBe(1);
    // Error must be surfaced
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('loan-bad-prop');

    // property_id must be null in the DB (not the invalid id)
    const row = db
      .prepare('SELECT property_id FROM debt_positions WHERE id = ?')
      .get('loan-bad-prop') as { property_id: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row?.property_id).toBeNull();
  });

  it('valid property_id in property_master → written with correct property_id', () => {
    const db = freshDb();

    // Seed a property_master row
    db.prepare(
      `INSERT INTO property_master (id, name, market, rentable_sf, acquisition_date)
       VALUES ('prop-valid', 'Valid Property', 'Columbus', 20000, '2020-01-01')`,
    ).run();

    const loan = makeBorrowerLoan({ id: 'loan-good-prop' });
    const goodMap = new Map([['loan-good-prop', 'prop-valid']]);

    const result = writeDebtSnapshot(db, [loan], '2026-06-01', goodMap);

    expect(result.written).toBe(1);
    expect(result.errors).toHaveLength(0);

    const row = db
      .prepare('SELECT property_id FROM debt_positions WHERE id = ?')
      .get('loan-good-prop') as { property_id: string | null } | undefined;
    expect(row?.property_id).toBe('prop-valid');
  });
});

// ── snapshot_date from generatedAt (not static asOf) ─────────────────────────────────────

describe('writeDebtSnapshot — snapshot_date is the caller-supplied date (generatedAt, not static)', () => {
  it('two refreshes on different dates → two rows (one active, one superseded)', () => {
    const db = freshDb();
    const loan = makeBorrowerLoan({ currentBalance: 800_000, absBalance: 800_000 });

    // Simulate refresh on 2026-06-10 (generatedAt)
    writeDebtSnapshot(db, [loan], '2026-06-10');
    // Simulate refresh on 2026-06-21 (generatedAt — different date)
    writeDebtSnapshot(db, [{ ...loan, currentBalance: 790_000, absBalance: 790_000 }], '2026-06-21');

    const all = db
      .prepare('SELECT snapshot_date, status, current_balance FROM debt_positions WHERE id = ? ORDER BY snapshot_date')
      .all('loan-001') as Array<{ snapshot_date: string; status: string; current_balance: number }>;

    expect(all).toHaveLength(2);
    expect(all[0]?.snapshot_date).toBe('2026-06-10');
    expect(all[0]?.status).toBe('superseded');
    expect(all[1]?.snapshot_date).toBe('2026-06-21');
    expect(all[1]?.status).toBe('active');
    expect(all[1]?.current_balance).toBe(790_000);
  });
});

// ── absBalance sign convention ────────────────────────────────────────────────────────────

describe('writeDebtSnapshot — absBalance sign convention (Fix LOW)', () => {
  it('a borrower loan with a negative currentBalance is stored with a POSITIVE current_balance (= absBalance)', () => {
    // conditions.ts documents: use absBalance, NEVER signed currentBalance, to avoid negative debt service.
    // For positive balances absBalance === currentBalance so existing tests are unaffected.
    // This test verifies the negative-balance edge case is normalised at write time.
    const db = freshDb();
    const loan = makeBorrowerLoan({
      id: 'loan-negative-balance',
      currentBalance: -750_000, // signed negative (e.g. data entry error or escrow direction)
      absBalance: 750_000,       // always positive magnitude
    });
    const result = writeDebtSnapshot(db, [loan], '2026-06-21');
    expect(result.written).toBe(1);
    expect(result.errors).toHaveLength(0);

    const row = db
      .prepare('SELECT current_balance FROM debt_positions WHERE id = ?')
      .get('loan-negative-balance') as { current_balance: number } | undefined;
    expect(row).toBeDefined();
    // Must be stored as the positive magnitude (absBalance), NOT the signed value
    expect(row?.current_balance).toBe(750_000);
    expect(row?.current_balance).toBeGreaterThan(0);
  });
});

describe('DebtPosition Zod type — lender suppression invariant', () => {
  it('lender is stored in the DB but DebtPosition.parse() does not include lender in the output', () => {
    const db = freshDb();
    const loan = makeBorrowerLoan({ lender: 'Confidential Bank LLC' });
    writeDebtSnapshot(db, [loan], '2026-06-21');

    // Read the raw DB row — lender SHOULD be stored
    const raw = db.prepare('SELECT * FROM debt_positions WHERE id = ?').get('loan-001') as Record<string, unknown>;
    expect(raw['lender']).toBe('Confidential Bank LLC');

    // Construct the client-facing shape (without lender) and parse through DebtPosition
    const clientShape = {
      id: raw['id'],
      propertyId: raw['property_id'] ?? null,
      loanName: raw['loan_name'],
      lender: raw['lender'],
      originalPrincipal: raw['original_principal'] ?? null,
      currentBalance: raw['current_balance'],
      rate: raw['rate'] ?? null,
      loanType: raw['loan_type'] ?? null,
      monthlyPmt: raw['monthly_pmt'] ?? null,
      annualInterest: raw['annual_interest'] ?? null,
      annualPrincipal: raw['annual_principal'] ?? null,
      isDemand: raw['is_demand'] === 1,
      maturityDate: raw['maturity_date'] ?? null,
      monthsToMaturity: raw['months_to_maturity'] ?? null,
      ltv: raw['ltv'] ?? null,
      balloon: raw['balloon'] === 1,
      snapshotDate: raw['snapshot_date'],
      status: raw['status'],
    };

    const parsed = DebtPosition.parse(clientShape);
    // lender must NOT appear on the parsed result
    expect(Object.prototype.hasOwnProperty.call(parsed, 'lender')).toBe(false);
    // Core fields are correctly mapped
    expect(parsed.loanName).toBe('First Mortgage — 123 Main St');
    expect(parsed.currentBalance).toBe(850_000);
    expect(parsed.isDemand).toBe(false);
  });
});
