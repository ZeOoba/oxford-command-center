// @vitest-environment node
//
// tests/unit/debt-snapshot.test.ts
//
// Phase 2 Steps 1–3 — debt_positions snapshot writer.
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
});

describe('writeDebtSnapshot — upsert semantics', () => {
  it('running twice with same snapshotDate updates the row; row count stays 1', () => {
    const db = freshDb();
    const loan = makeBorrowerLoan({ currentBalance: 850_000 });

    writeDebtSnapshot(db, [loan], '2026-06-21');
    const loanV2 = { ...loan, currentBalance: 840_000 };
    writeDebtSnapshot(db, [loanV2], '2026-06-21');

    const rows = db.prepare("SELECT current_balance FROM debt_positions WHERE id = ? AND status = 'active'").all('loan-001') as Array<{ current_balance: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.current_balance).toBe(840_000);
  });
});

describe('writeDebtSnapshot — supersede on new snapshotDate', () => {
  it('old row is marked superseded and a new active row is inserted on a new snapshotDate', () => {
    const db = freshDb();
    const loan = makeBorrowerLoan({ currentBalance: 850_000 });

    writeDebtSnapshot(db, [loan], '2026-05-01');
    writeDebtSnapshot(db, [{ ...loan, currentBalance: 840_000 }], '2026-06-01');

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
