// @vitest-environment node
// HOSTILE REVIEW REPRO — round 13, determinism/order-independence lens. DELETE AFTER RUN.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { writeDebtSnapshot, readLastSnapshotRefusal } from '../../server/warehouse/debt-snapshot';
import { computePortfolioAggregateLtv } from '../../server/warehouse/debt-maturity';
import type { Loan } from '../../src/contracts/index';

function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'hostile-r13-'));
  return openWarehouse(join(dir, 'test.sqlite'));
}

function loan(id: string, overrides: Partial<Loan> = {}): Loan {
  return {
    id,
    name: `Loan ${id}`,
    counterparty: 'Bank',
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
    lender: 'Bank',
    balloon: false,
    flags: [],
    collateralProperty: null,
    ...overrides,
  } as Loan;
}
const poison = (l: Loan): Loan => ({ ...l, currentBalance: NaN, absBalance: NaN });

describe('HUNT (a): pass-9 reproductions must hold', () => {
  it('refused -> growth-degrade -> shrink-clean HOLDS the marker', () => {
    const db = freshDb();
    // clean book {A,B,C}
    writeDebtSnapshot(db, [loan('A'), loan('B'), loan('C')], '2026-06-01');
    expect(readLastSnapshotRefusal(db)).toBeNull();
    // refusal (empty payload)
    const r = writeDebtSnapshot(db, [], '2026-06-02');
    expect(r.refusedEmptySupersede).toBe(true);
    expect(readLastSnapshotRefusal(db)!.kind).toBe('refused');
    // growth write {A..E}, D+E fail
    const g = writeDebtSnapshot(
      db,
      [loan('A'), loan('B'), loan('C'), poison(loan('D')), poison(loan('E'))],
      '2026-06-03',
    );
    expect(g.degradedRows).toBe(2);
    const m = readLastSnapshotRefusal(db)!;
    expect(m.kind).toBe('degraded');
    expect(new Set(m.trustedIds)).toEqual(new Set(['A', 'B', 'C', 'D', 'E']));
    // shrink-clean {A,B,C} — must NOT clear
    const c = writeDebtSnapshot(db, [loan('A'), loan('B'), loan('C')], '2026-06-04');
    expect(c.staleMarkerHeld).toBe(true);
    expect(readLastSnapshotRefusal(db)!.kind).toBe('degraded');
  });

  it('destroy-F-then-add-G substitution cannot clear', () => {
    const db = freshDb();
    writeDebtSnapshot(db, [loan('E'), loan('F')], '2026-06-01');
    const d = writeDebtSnapshot(db, [loan('E'), poison(loan('F'))], '2026-06-02');
    expect(d.degradedRows).toBe(1);
    const c = writeDebtSnapshot(db, [loan('E'), loan('G')], '2026-06-03');
    expect(c.staleMarkerHeld).toBe(true);
    expect(readLastSnapshotRefusal(db)).not.toBeNull();
  });
});

describe('LENS: order-dependence of the damage latch', () => {
  // Identical two-write suffix: [{E,F,G} with G's insert failing] then [{E,F}].
  // Only difference: whether a degraded marker ALREADY stood when G's damage occurred.
  it('CONTROL: G destroyed while marker CLEAN -> final {E,F} write cannot clear (G latched)', () => {
    const db = freshDb();
    writeDebtSnapshot(db, [loan('E'), loan('F'), loan('G')], '2026-06-01'); // clean book with G
    const d = writeDebtSnapshot(db, [loan('E'), loan('F'), poison(loan('G'))], '2026-06-02');
    expect(d.degradedRows).toBe(1);
    expect(new Set(readLastSnapshotRefusal(db)!.trustedIds)).toContain('G');
    const c = writeDebtSnapshot(db, [loan('E'), loan('F')], '2026-06-03');
    expect(c.staleMarkerHeld).toBe(true); // held — G must return or human opt-in
  });

  it('DEFECT?: G destroyed while a degraded marker ALREADY stands -> same suffix CLEARS with G off-book', () => {
    const db = freshDb();
    // clean {E,F}
    writeDebtSnapshot(db, [loan('E'), loan('F')], '2026-06-01');
    // damage 1: F's insert fails -> degraded, trustedIds {E,F}
    writeDebtSnapshot(db, [loan('E'), poison(loan('F'))], '2026-06-02');
    expect(new Set(readLastSnapshotRefusal(db)!.trustedIds)).toEqual(new Set(['E', 'F']));
    // clean-but-held write lands G (real loan, successfully vetted + inserted)
    const held = writeDebtSnapshot(db, [loan('E'), loan('G')], '2026-06-03');
    expect(held.staleMarkerHeld).toBe(true);
    // damage 2 DURING the degraded window: payload asserts {E,F,G}; F recovers, G's insert FAILS
    // (G's prior active row superseded then lost). degraded-over-degraded carries trustedIds
    // UNCHANGED — G's brand-new damage is never latched.
    const d2 = writeDebtSnapshot(db, [loan('E'), loan('F'), poison(loan('G'))], '2026-06-04');
    expect(d2.degradedRows).toBe(1);
    const m = readLastSnapshotRefusal(db)!;
    expect(new Set(m.trustedIds)).toEqual(new Set(['E', 'F'])); // G missing from recovery obligation
    // final clean {E,F} — G (destroyed by insert failure, flagged DEGRADED one write ago) never
    // returned, yet the marker CLEARS:
    const c = writeDebtSnapshot(db, [loan('E'), loan('F')], '2026-06-05');
    const after = readLastSnapshotRefusal(db);
    // Record outcome:
    console.log('order-dependence outcome:', {
      cleared: after === null,
      staleMarkerHeld: c.staleMarkerHeld,
      activeIds: (db.prepare("SELECT id FROM debt_positions WHERE status='active'").all() as any[]).map((r) => r.id),
    });
    const agg = computePortfolioAggregateLtv(db);
    console.log('aggregate after clear:', { lastWriteRefused: agg.lastWriteRefused, cleared: agg.clearedConservatively });
    expect(after).toBeNull(); // <- demonstrates the flip vs CONTROL
  });
});

describe('LENS: input-array permutation invariance', () => {
  it('permuting the loans array does not change written/degraded/marker-set semantics', () => {
    const base = [loan('A'), loan('B'), poison(loan('C')), loan('D', { direction: 'lender' }), loan('E')];
    const perm = [base[4]!, base[2]!, base[0]!, base[3]!, base[1]!];
    const db1 = freshDb();
    const db2 = freshDb();
    writeDebtSnapshot(db1, [loan('A'), loan('B'), loan('C'), loan('E')], '2026-06-01');
    writeDebtSnapshot(db2, [loan('A'), loan('B'), loan('C'), loan('E')], '2026-06-01');
    const r1 = writeDebtSnapshot(db1, base, '2026-06-02');
    const r2 = writeDebtSnapshot(db2, perm, '2026-06-02');
    expect(r1.written).toBe(r2.written);
    expect(r1.degradedRows).toBe(r2.degradedRows);
    expect(r1.refusedEmptySupersede).toBe(r2.refusedEmptySupersede);
    const m1 = readLastSnapshotRefusal(db1)!;
    const m2 = readLastSnapshotRefusal(db2)!;
    expect(m1.kind).toBe(m2.kind);
    expect(new Set(m1.trustedIds)).toEqual(new Set(m2.trustedIds));
  });
});

describe('HUNT (e): staleMarkerHeld truth table', () => {
  it('false on refused; false on degraded; false on clean-clear', () => {
    const db = freshDb();
    writeDebtSnapshot(db, [loan('A'), loan('B'), loan('C')], '2026-06-01');
    const refused = writeDebtSnapshot(db, [], '2026-06-02');
    expect(refused.staleMarkerHeld).toBe(false);
    const cleanClearRefusal = writeDebtSnapshot(db, [loan('A'), loan('B'), loan('C')], '2026-06-03');
    expect(cleanClearRefusal.staleMarkerHeld).toBe(false);
    expect(readLastSnapshotRefusal(db)).toBeNull();
    const degraded = writeDebtSnapshot(db, [loan('A'), loan('B'), poison(loan('C'))], '2026-06-04');
    expect(degraded.staleMarkerHeld).toBe(false);
    const recover = writeDebtSnapshot(db, [loan('A'), loan('B'), loan('C')], '2026-06-05');
    expect(recover.staleMarkerHeld).toBe(false); // full recovery -> cleared, not held
    expect(readLastSnapshotRefusal(db)).toBeNull();
  });
});
