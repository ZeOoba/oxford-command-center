import { describe, it, expect } from 'vitest';
import { expandUnitTokens, resolveByUnit, type UnitLease } from '../../server/ar/resolve-by-unit';

const LEASES: UnitLease[] = [
  { id: 'L-A4', unit: 'A4', propertyId: 'northwood' },
  { id: 'L-A15', unit: 'A15', propertyId: 'northwood' },
  { id: 'L-B1', unit: 'B1', propertyId: 'northwood' },
  { id: 'L-B4', unit: 'B4', propertyId: 'northwood' },
  { id: 'L-C1C2', unit: 'C1+C2', propertyId: 'northwood' },
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
