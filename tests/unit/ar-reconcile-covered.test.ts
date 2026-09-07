import { describe, it, expect } from 'vitest';
import { reconcileCoveredProperties, type LeaseProperty } from '../../server/ar/reconcile-covered';
import type { TenantArrears } from '../../src/contracts/index';

// Deliberately NOT a clean 1-property-per-building roster. `multi` stands in for
// sepich-portfolio-columbus-oh-8-props: ONE propertyId spanning several buildings, which is the
// topology in which the whole partial-export bug class lives and which the first version of these
// tests could not see.
const ROSTER: LeaseProperty[] = [
  { id: 'p1-alpha', propertyId: 'prop-1', status: 'Active' },
  { id: 'p1-bravo', propertyId: 'prop-1', status: 'Active' },
  { id: 'p1-charlie', propertyId: 'prop-1', status: 'Active' },
  { id: 'p1-expired', propertyId: 'prop-1', status: 'Expired' },
  { id: 'p2-delta', propertyId: 'prop-2', status: 'Active' },
  { id: 'p2-echo', propertyId: 'prop-2', status: 'Active' },
  { id: 'bldgA-1', propertyId: 'multi', status: 'Active' },
  { id: 'bldgA-2', propertyId: 'multi', status: 'Active' },
  { id: 'bldgB-1', propertyId: 'multi', status: 'Active' },
  { id: 'bldgB-2', propertyId: 'multi', status: 'Active' },
  { id: 'bldgB-3', propertyId: 'multi', status: 'Active' },
];

function ar(d30: number, asOfDate: string | null, sourceFile = 'old.xlsx'): TenantArrears {
  return {
    d30, d60: 0, d90: 0, d90plus: 0,
    asOfDate: asOfDate === null ? null : new Date(`${asOfDate}T00:00:00.000Z`),
    sourceFile,
  } as TenantArrears;
}
const iso = (d: unknown): string =>
  d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
const NONE: ReadonlySet<string> = new Set();

const run = (
  persisted: Record<string, TenantArrears>,
  written: Record<string, TenantArrears>,
  seen: ReadonlySet<string> = NONE,
  leases: LeaseProperty[] = ROSTER,
) => reconcileCoveredProperties({ persisted, written, seen, leases });

describe('reconcileCoveredProperties — core rule', () => {
  it('zeroes a row at a covered property that a covering report did not list', () => {
    const r = run(
      { 'p1-alpha': ar(500, '2026-07-15'), 'p1-bravo': ar(100, '2026-07-15') },
      { 'p1-bravo': ar(250, '2026-08-21', 'new.xlsx') },
    );
    expect(Object.keys(r.zeroed)).toEqual(['p1-alpha']);
    expect(r.zeroed['p1-alpha']!.d30).toBe(0);
    expect(iso(r.zeroed['p1-alpha']!.asOfDate)).toBe('2026-08-21');
    expect(r.clearedUsd).toBe(500);
  });

  it('NEVER touches a property this run did not cover (absence of data is not payment)', () => {
    const r = run({ 'p2-delta': ar(900, '2026-07-15') }, { 'p1-bravo': ar(250, '2026-08-21') });
    expect(r.zeroed).toEqual({});
    expect(r.skippedUncovered).toEqual(['p2-delta']);
  });

  it('NEVER zeroes on an empty incoming set — a broken parse must not wipe the book', () => {
    const r = run({ 'p1-alpha': ar(500, '2026-07-15'), 'p2-delta': ar(900, '2026-07-15') }, {});
    expect(r.zeroed).toEqual({});
    expect(r.coveredPropertyIds).toEqual([]);
  });

  it('skips a lease absent from the roster rather than guessing its property', () => {
    const r = run({ 'ghost-lease': ar(700, '2026-07-15') }, { 'p1-bravo': ar(250, '2026-08-21') });
    expect(r.zeroed).toEqual({});
    expect(r.skippedUnmapped).toEqual(['ghost-lease']);
  });

  it('an UNDATED write cannot make a property reconcilable', () => {
    const r = run({ 'p1-alpha': ar(500, '2026-07-15') }, { 'p1-bravo': ar(250, null) });
    expect(r.zeroed).toEqual({});
    expect(r.coveredPropertyIds).toEqual([]);
  });

  it('does not mutate its inputs', () => {
    const persisted = { 'p1-alpha': ar(500, '2026-07-15') };
    const snapshot = JSON.stringify(persisted);
    run(persisted, { 'p1-bravo': ar(250, '2026-08-21') });
    expect(JSON.stringify(persisted)).toBe(snapshot);
  });
});

// CRITICAL 1 — `written` is only what survived six suppressions. A suppressed lease was SEEN by the
// pipeline and deliberately not written; treating it as paid destroys real money.
describe('suppressed rows (`seen`) are never reconciled', () => {
  it.each([
    ['review-queue row', 'p1-alpha'],
    ['rejected-stale row', 'p1-alpha'],
    ['undated-conflict row', 'p1-alpha'],
    ['ambiguous-tie row', 'p1-alpha'],
  ])('preserves a %s', (_label, leaseId) => {
    const r = run(
      { [leaseId]: ar(12380.94, '2026-07-15') },
      { 'p1-bravo': ar(250, '2026-08-21') },
      new Set([leaseId]),
    );
    expect(r.zeroed).toEqual({});
    expect(r.restamped).toEqual({});
    expect(r.skippedSuppressed).toEqual([leaseId]);
    expect(r.clearedUsd).toBe(0);
  });

  it('reproduces the reviewed repro shape: a suppressed balance survives alongside a real write', () => {
    const r = run(
      { 'p1-alpha': ar(12380.94, '2026-07-15'), 'p1-charlie': ar(5952.77, '2026-07-15') },
      { 'p1-bravo': ar(250, '2026-08-21') },
      new Set(['p1-alpha', 'p1-charlie']),
    );
    expect(r.clearedUsd).toBe(0);
    expect(r.skippedSuppressed).toEqual(['p1-alpha', 'p1-charlie']);
  });
});

// HIGH 4 — the earlier draft skipped already-zero rows, freezing their stamp forever and re-firing
// ar-stale ~35 days later from rows the fix itself wrote.
describe('re-stamping (the fix must not re-create the bug it fixes)', () => {
  it('re-stamps an already-zero covered row instead of freezing its stamp', () => {
    const r = run({ 'p1-alpha': ar(0, '2026-07-15') }, { 'p1-bravo': ar(250, '2026-08-21') });
    expect(r.zeroed).toEqual({});
    expect(Object.keys(r.restamped)).toEqual(['p1-alpha']);
    expect(iso(r.restamped['p1-alpha']!.asOfDate)).toBe('2026-08-21');
    expect(r.clearedUsd).toBe(0); // no false "cleared" dollars
  });

  it('a zeroed row does not go stale again on the next covering run (two-run aging)', () => {
    const run1 = run({ 'p1-alpha': ar(500, '2026-07-15') }, { 'p1-bravo': ar(250, '2026-08-21') });
    const afterRun1 = { ...run1.zeroed, ...run1.restamped };
    const run2 = run(afterRun1, { 'p1-bravo': ar(300, '2026-11-20') });
    expect(iso({ ...run2.zeroed, ...run2.restamped }['p1-alpha']!.asOfDate)).toBe('2026-11-20');
  });

  it('re-stamps a CREDIT row without destroying the credit', () => {
    const credit = { ...ar(0, '2026-01-01'), d30: -1200 } as TenantArrears;
    const r = run({ 'p1-alpha': credit }, { 'p1-bravo': ar(250, '2026-08-21') });
    expect(r.zeroed).toEqual({});
    expect(r.restamped['p1-alpha']!.d30).toBe(-1200);
    expect(iso(r.restamped['p1-alpha']!.asOfDate)).toBe('2026-08-21');
  });
});

// CRITICAL 2 / HIGH 5 — stamping with the property MAX fabricates freshness and makes the zero
// durable, because filterAgainstPersisted then rejects every older recovering report.
describe('per-report as-of, not per-property max', () => {
  it('stamps with the EARLIEST qualifying report, not the property max', () => {
    const r = run(
      { 'bldgB-1': ar(REDACTED-AMT, '2026-07-15') },
      {
        'bldgA-1': ar(10, '2026-09-15'), 'bldgA-2': ar(10, '2026-09-15'),
        'bldgB-2': ar(10, '2026-08-01'), 'bldgB-3': ar(10, '2026-08-01'),
      },
    );
    // Evidence for building B is dated 08-01; certifying it current as of 09-15 is a fabrication.
    expect(iso(r.zeroed['bldgB-1']!.asOfDate)).toBe('2026-08-01');
  });

  it('a row newer than every qualifying report is preserved', () => {
    const r = run({ 'p2-delta': ar(300, '2026-07-25') }, { 'p2-echo': ar(10, '2026-07-20') });
    expect(r.zeroed).toEqual({});
    expect(r.skippedNewer).toEqual(['p2-delta']);
  });

  it('the zero it writes is recoverable by a later report (not blocked by a fabricated stamp)', () => {
    const r = run(
      { 'bldgB-1': ar(REDACTED-AMT, '2026-07-15') },
      { 'bldgA-1': ar(10, '2026-09-15'), 'bldgB-2': ar(10, '2026-08-01'), 'bldgB-3': ar(10, '2026-08-01') },
    );
    const stamp = new Date(iso(r.zeroed['bldgB-1']!.asOfDate)).getTime();
    // A 2026-09-01 recovery report is NEWER than the 08-01 stamp, so filterAgainstPersisted admits it.
    expect(new Date('2026-09-01T00:00:00.000Z').getTime()).toBeGreaterThan(stamp);
  });
});

// CRITICAL 2 (guard half) — the partial-export shape must be refused, not reported-and-done.
describe('rule 5 — partial-export refusal', () => {
  it('REFUSES a property that would lose more balances than it gained rows', () => {
    const r = run(
      {
        'bldgB-1': ar(REDACTED-AMT, '2026-07-15'), 'bldgB-2': ar(9596.90, '2026-07-15'),
        'bldgB-3': ar(REDACTED-AMT, '2026-07-15'),
      },
      { 'bldgA-1': ar(10, '2026-09-15'), 'bldgA-2': ar(10, '2026-09-15') },
    );
    expect(r.zeroed).toEqual({});
    expect(r.clearedUsd).toBe(0);
    expect(r.refusedProperties).toEqual([
      { propertyId: 'multi', written: 2, wouldZero: 3, leaseIds: ['bldgB-1', 'bldgB-2', 'bldgB-3'] },
    ]);
  });

  it('allows the routine shape (more written than zeroed)', () => {
    const r = run(
      { 'bldgB-1': ar(100, '2026-07-15') },
      {
        'bldgA-1': ar(10, '2026-08-01'), 'bldgA-2': ar(10, '2026-08-01'),
        'bldgB-2': ar(10, '2026-08-01'),
      },
    );
    expect(Object.keys(r.zeroed)).toEqual(['bldgB-1']);
    expect(r.refusedProperties).toEqual([]);
  });

  it('a refusal blocks zeroing but still re-stamps zero/credit rows (no frozen clock)', () => {
    const r = run(
      {
        'bldgB-1': ar(500, '2026-07-15'), 'bldgB-2': ar(500, '2026-07-15'),
        'bldgB-3': ar(0, '2026-07-15'),
      },
      { 'bldgA-1': ar(10, '2026-08-01') },
    );
    expect(r.refusedProperties.map((x) => x.propertyId)).toEqual(['multi']);
    expect(r.zeroed).toEqual({});                       // money preserved
    expect(Object.keys(r.restamped)).toEqual(['bldgB-3']); // clock released
    expect(iso(r.restamped['bldgB-3']!.asOfDate)).toBe('2026-08-01');
  });

  it('a refusal is scoped to its property and does not block a healthy one', () => {
    const r = run(
      { 'bldgB-1': ar(500, '2026-07-15'), 'bldgB-2': ar(500, '2026-07-15'), 'p1-alpha': ar(300, '2026-07-15') },
      { 'bldgA-1': ar(10, '2026-08-01'), 'p1-bravo': ar(10, '2026-08-01'), 'p1-charlie': ar(10, '2026-08-01') },
    );
    expect(r.refusedProperties.map((x) => x.propertyId)).toEqual(['multi']);
    expect(Object.keys(r.zeroed)).toEqual(['p1-alpha']);
  });
});

// MED 6 — a move-out balance is the most collectible-and-contested AR there is.
describe('Expired leases are never auto-cleared', () => {
  it('preserves an Expired lease balance and reports it', () => {
    const r = run({ 'p1-expired': ar(2574.70, '2026-07-15') }, { 'p1-bravo': ar(250, '2026-08-21') });
    expect(r.zeroed).toEqual({});
    expect(r.restamped).toEqual({});
    expect(r.skippedExpired).toEqual(['p1-expired']);
  });
});

describe('reporting', () => {
  it('per-property written-vs-zeroed makes the shape legible', () => {
    const r = run(
      { 'p1-alpha': ar(500, '2026-07-15'), 'p1-charlie': ar(250, '2026-07-15') },
      { 'p1-bravo': ar(10, '2026-08-21'), 'p2-echo': ar(10, '2026-08-21') },
    );
    // 2 would zero vs 1 written at prop-1 -> refused, and the refusal is what's reported.
    expect(r.refusedProperties.map((x) => x.propertyId)).toEqual(['prop-1']);
    expect(r.byProperty['prop-2']).toEqual({ written: 1, zeroed: 0, restamped: 0, clearedUsd: 0 });
  });

  it('accumulates cleared dollars in cents (no float drift)', () => {
    // One zeroing candidate per property, each with >=2 written rows, so rule 5 does not refuse.
    const r = run(
      { 'p1-alpha': ar(0.1, '2026-07-15'), 'bldgB-1': ar(0.2, '2026-07-15') },
      {
        'p1-bravo': ar(10, '2026-08-21'), 'p1-charlie': ar(10, '2026-08-21'),
        'bldgA-1': ar(10, '2026-08-21'), 'bldgA-2': ar(10, '2026-08-21'),
      },
    );
    expect(r.clearedUsd).toBe(0.3); // not 0.30000000000000004
  });

  it('handles an ISO-STRING asOfDate as well as a Date', () => {
    const persisted = { 'p1-alpha': { d30: 500, d60: 0, d90: 0, d90plus: 0, asOfDate: '2026-07-15T00:00:00.000Z', sourceFile: 'x' } as unknown as TenantArrears };
    const r = run(persisted, { 'p1-bravo': ar(250, '2026-08-21') });
    expect(Object.keys(r.zeroed)).toEqual(['p1-alpha']);
  });
});
