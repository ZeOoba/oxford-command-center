import { describe, it, expect } from 'vitest';
import { expandUnitTokens, resolveByUnit, type UnitLease } from '../../server/ar/resolve-by-unit';

const LEASES: UnitLease[] = [
  { id: 'L-A4', unit: 'A4', propertyId: 'northwood' },
  { id: 'L-A15', unit: 'A15', propertyId: 'northwood' },
  { id: 'L-B1', unit: 'B1', propertyId: 'northwood' },
  { id: 'L-B4', unit: 'B4', propertyId: 'northwood' },
  { id: 'L-C1C2', unit: 'C1+C2', propertyId: 'northwood' },
  { id: 'L-C4', unit: 'C4', propertyId: 'northwood' },
  { id: 'L-A11A12C3', unit: 'A11+A12+C3', propertyId: 'northwood' },
  { id: 'L-A4-OTHER', unit: 'A4', propertyId: 'other-prop' },
];

describe('expandUnitTokens', () => {
  it('normalizes number-then-letter (AR export convention) to letter-then-number', () => {
    expect(expandUnitTokens('4A')).toEqual(new Set(['A4']));
  });

  it('normalizes letter-then-number (lease roster convention) to the same canonical form', () => {
    expect(expandUnitTokens('A4')).toEqual(new Set(['A4']));
  });

  it('strips a leading zero', () => {
    expect(expandUnitTokens('01B')).toEqual(new Set(['B1']));
    expect(expandUnitTokens('04B')).toEqual(new Set(['B4']));
  });

  it('distributes a LEADING shared letter across a dash-separated numeric list', () => {
    expect(expandUnitTokens('C 1-2')).toEqual(new Set(['C1', 'C2']));
  });

  it('distributes a TRAILING shared letter across a dash-separated numeric list', () => {
    // Real AR row (2203-2207 Northwood): '11-12A' means units 11 and 12 of building A.
    expect(expandUnitTokens('11-12A')).toEqual(new Set(['A11', 'A12']));
  });

  it('canonicalizes each piece independently when every piece already carries its own letter', () => {
    expect(expandUnitTokens('A11+A12+C3')).toEqual(new Set(['A11', 'A12', 'C3']));
  });

  it('treats a plus-separated compound the same as a dash-separated one', () => {
    expect(expandUnitTokens('C1+C2')).toEqual(expandUnitTokens('C 1-2'));
  });

  it('treats the word "and" the same as a separator', () => {
    expect(expandUnitTokens('A11 and A12')).toEqual(new Set(['A11', 'A12']));
  });

  it('strips a parenthetical USE annotation the export appends to the unit label', () => {
    // Real AR row (2203-2207 Northwood, 2026-08-21): 'C 4 (storage)' is unit C4 — the parenthetical
    // describes the use, not the unit. Before this, it folded into the token as 'C4STORAGE'.
    expect(expandUnitTokens('C 4 (storage)')).toEqual(new Set(['C4']));
  });

  it('strips an annotation from a COMPOUND label without losing the expansion', () => {
    expect(expandUnitTokens('C 1-2 (storage)')).toEqual(new Set(['C1', 'C2']));
  });

  it('returns an EMPTY set for an annotation-only label — no unit identity to match on', () => {
    expect(expandUnitTokens('(storage)')).toEqual(new Set());
  });

  it('leaves an un-annotated label behaving exactly as before', () => {
    expect(expandUnitTokens('C4')).toEqual(new Set(['C4']));
    expect(expandUnitTokens('C7-C12')).toEqual(new Set(['C7', 'C12']));
  });

  // The parentheses in these labels carry IDENTITY, not a use descriptor. Stripping them would
  // delete a real character and retarget the row onto a different unit (or none). Each expectation
  // below is the pre-existing behaviour, pinned so the annotation rule can never widen onto them.
  it('does NOT strip a parenthetical containing a digit — it is identity, not an annotation', () => {
    // 'C 4 (2)' is unit C42. Stripping '(2)' would yield C4 — a DIFFERENT, real unit.
    expect(expandUnitTokens('C 4 (2)')).toEqual(new Set(['C42']));
  });

  it('does NOT strip a parenthetical holding a bare identity letter', () => {
    // '12(A)' is unit A12. Stripping '(A)' would yield '12' — no unit at all.
    expect(expandUnitTokens('12(A)')).toEqual(new Set(['A12']));
  });

  it('strips a word-shaped annotation even off a letter-only unit label', () => {
    expect(expandUnitTokens('Sign (billboard)')).toEqual(new Set(['SIGN']));
  });
});

describe('resolveByUnit', () => {
  it('resolves the AR number-then-letter form against the roster letter-then-number form', () => {
    const r = resolveByUnit({ unit: '4A', property: 'nbc-a', d30: 1, d30plus: 0 }, LEASES, 'northwood');
    expect(r).toEqual({ leaseId: 'L-A4', confidence: 'exact', ambiguous: false });
  });

  it('resolves a leading-zero unit', () => {
    const r = resolveByUnit({ unit: '01B', property: 'nbc-b', d30: 1, d30plus: 0 }, LEASES, 'northwood');
    expect(r.leaseId).toBe('L-B1');
  });

  it('resolves a leading-letter compound unit against a plus-separated lease unit', () => {
    const r = resolveByUnit({ unit: 'C 1-2', property: 'nbc-c', d30: 1, d30plus: 0 }, LEASES, 'northwood');
    expect(r.leaseId).toBe('L-C1C2');
  });

  it('does NOT match a proper subset of a larger merged lease — defers to review', () => {
    // Real case: the AR row '11-12A' expands to {A11,A12}; the only real lease covering those units
    // is a 3-unit merged lease {A11,A12,C3}. A subset is not an exact match — auto-attributing it
    // would be a guess about which lease the balance actually belongs to.
    const r = resolveByUnit({ unit: '11-12A', property: 'nbc-a', d30: 1, d30plus: 0 }, LEASES, 'northwood');
    expect(r).toEqual({ leaseId: null, confidence: 'none', ambiguous: false });
  });

  it('does not cross property boundaries', () => {
    const r = resolveByUnit({ unit: '4A', property: 'nbc-a', d30: 1, d30plus: 0 }, LEASES, 'other-prop');
    expect(r.leaseId).toBe('L-A4-OTHER');
  });

  it('returns none when the property is unresolved — never guesses across the portfolio', () => {
    const r = resolveByUnit({ unit: '4A', property: 'nbc-a', d30: 1, d30plus: 0 }, LEASES, null);
    expect(r).toEqual({ leaseId: null, confidence: 'none', ambiguous: false });
  });

  it('never near-matches a one-character-different unit', () => {
    const noB = LEASES.filter((l) => l.id !== 'L-B1' && l.id !== 'L-B4');
    const withOnlyB1: UnitLease[] = [...noB, { id: 'L-B1', unit: 'B1', propertyId: 'northwood' }];
    const r = resolveByUnit({ unit: '2B', property: 'nbc-b', d30: 1, d30plus: 0 }, withOnlyB1, 'northwood');
    expect(r.leaseId).toBeNull();
    expect(r.confidence).toBe('none');
  });

  it('resolves an annotated unit label onto the plain lease unit', () => {
    // The live row this fix was written for: a cents-only balance at 'C 4 (storage)' belongs to the C4 lease.
    const r = resolveByUnit({ unit: 'C 4 (storage)', property: 'nbc-c', d30: 0.42, d30plus: 0 }, LEASES, 'northwood');
    expect(r).toEqual({ leaseId: 'L-C4', confidence: 'exact', ambiguous: false });
  });

  it('does NOT let an annotation manufacture a match to a unit that has no lease', () => {
    const r = resolveByUnit({ unit: 'C 9 (storage)', property: 'nbc-c', d30: 1, d30plus: 0 }, LEASES, 'northwood');
    expect(r).toEqual({ leaseId: null, confidence: 'none', ambiguous: false });
  });

  it('routes an annotation-only unit label to review instead of matching an empty token', () => {
    const withBlank: UnitLease[] = [...LEASES, { id: 'L-BLANK', unit: '', propertyId: 'northwood' }];
    const r = resolveByUnit({ unit: '(storage)', property: 'nbc-c', d30: 1, d30plus: 0 }, withBlank, 'northwood');
    expect(r).toEqual({ leaseId: null, confidence: 'none', ambiguous: false });
  });

  it('flags ambiguity when two leases differ only by annotation — never silently picks one', () => {
    const dupes: UnitLease[] = [
      { id: 'S', unit: 'C4 (storage)', propertyId: 'northwood' },
      { id: 'O', unit: 'C4', propertyId: 'northwood' },
    ];
    const r = resolveByUnit({ unit: 'C 4 (storage)', property: 'nbc-c', d30: 1, d30plus: 0 }, dupes, 'northwood');
    expect(r.ambiguous).toBe(true);
    expect(r.leaseId).toBeNull();
  });

  // 2026-09-14 sweep, Fix A: the live-hit filter used `status !== 'Expired'` only. A 'Vacant'
  // record and an Active lease carrying annualRent === 0 (a roster placeholder that bills nothing
  // -- real row: Example Gymnastics, 2207 Northwood A15, with AR) both counted as LIVE and took
  // a clean 'exact' unit hit with no human review. The shared isDeadLease predicate now gates the
  // live set; the dead-sibling downgrade (PR #302's re-let hole) applies to every dead status.
  it('does NOT treat an Active lease with annualRent 0 as a live candidate -- routes to review (Fix A)', () => {
    const roster: UnitLease[] = [{ id: 'L-A15-EXAMPLE', unit: 'A15', propertyId: 'northwood', status: 'Active', annualRent: 0 }];
    const r = resolveByUnit({ unit: 'A15', property: 'nbc-a', d30: 765.43, d30plus: 1234.56 }, roster, 'northwood');
    expect(r).toEqual({ leaseId: null, confidence: 'none', ambiguous: false });
  });

  it('does NOT treat a Vacant record as a live candidate (Fix A)', () => {
    const roster: UnitLease[] = [{ id: 'L-A9-VACANT', unit: 'A9', propertyId: 'northwood', status: 'Vacant', annualRent: 0 }];
    const r = resolveByUnit({ unit: 'A9', property: 'nbc-a', d30: 1, d30plus: 0 }, roster, 'northwood');
    expect(r).toEqual({ leaseId: null, confidence: 'none', ambiguous: false });
  });

  it('a zero-rent Active sibling on a re-let unit downgrades the live match to ambiguous, exactly like an Expired sibling (Fix A)', () => {
    const roster: UnitLease[] = [
      { id: 'L-A15-OLD', unit: 'A15', propertyId: 'northwood', status: 'Active', annualRent: 0 },
      { id: 'L-A15-NEW', unit: 'A15', propertyId: 'northwood', status: 'Active', annualRent: 14400 },
    ];
    const r = resolveByUnit({ unit: 'A15', property: 'nbc-a', d30: 1, d30plus: 0 }, roster, 'northwood');
    expect(r).toEqual({ leaseId: null, confidence: 'none', ambiguous: true });
  });

  it('regression (Fix A): a live Active lease with positive rent, alone on its unit, still resolves exact', () => {
    const roster: UnitLease[] = [{ id: 'L-A4-LIVE', unit: 'A4', propertyId: 'northwood', status: 'Active', annualRent: 24000 }];
    const r = resolveByUnit({ unit: '4A', property: 'nbc-a', d30: 1, d30plus: 0 }, roster, 'northwood');
    expect(r).toEqual({ leaseId: 'L-A4-LIVE', confidence: 'exact', ambiguous: false });
  });

  it('regression (Fix A): a roster with no annualRent projection keeps the status-only behaviour', () => {
    // Callers that never populate annualRent (the pre-existing LEASES fixture above) are unchanged.
    const r = resolveByUnit({ unit: '4A', property: 'nbc-a', d30: 1, d30plus: 0 }, LEASES, 'northwood');
    expect(r).toEqual({ leaseId: 'L-A4', confidence: 'exact', ambiguous: false });
  });

  it('flags ambiguity and refuses to pick when two leases resolve to the same canonical unit', () => {
    const dupes: UnitLease[] = [
      { id: 'A', unit: '7A', propertyId: 'northwood' },
      { id: 'B', unit: 'A7', propertyId: 'northwood' },
    ];
    const r = resolveByUnit({ unit: '7A', property: 'nbc-a', d30: 1, d30plus: 0 }, dupes, 'northwood');
    expect(r.ambiguous).toBe(true);
    expect(r.leaseId).toBeNull();
  });
});
