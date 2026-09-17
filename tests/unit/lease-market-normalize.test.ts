// tests/unit/lease-market-normalize.test.ts
import { describe, it, expect } from 'vitest';
import {
  addDays, daysBetween, isBenchmarkEligible, normalizeSuite, officeStratumFor, opexFromDefaults, opexFromQuotedMedian,
  parseRentText, priceObservation, resolveOpex, sizeBandFor, splitAddress,
  type EligibilityInput, type OpexEstimate, type RentInput,
} from '../../src/analytics/lease-market/normalize';

const T = { rangeMaxSpread: 0.2, monthlyValueCeiling: 3, rentMinPsfYr: 1, rentMaxPsfYr: 60 };
const OPEX: OpexEstimate = { tax: 1, ins: 0.25, cam: 0.5, total: 1.75, source: 'test' };
const input = (patch: Partial<RentInput>): RentInput => ({ rentLow: 8.5, rentHigh: null, rentPeriod: 'yr', rentBasis: 'NNN', rentIsTotal: false, availableSf: 10000, ...patch });
const price = (patch: Partial<RentInput>, opex: OpexEstimate | null = OPEX) => priceObservation(input(patch), opex, ['tax', 'ins'], T);

describe('dates', () => {
  it('counts whole days and shifts dates', () => {
    expect(daysBetween('2026-01-01', '2026-03-01')).toBe(59);
    expect(daysBetween('2026-03-01T12:00:00Z', '2026-03-02')).toBe(1);
    expect(addDays('2026-03-01', -365)).toBe('2025-03-01');
  });
});

describe('addresses', () => {
  it('abbreviates suffixes/directionals and splits embedded suites', () => {
    expect(splitAddress('1100 Rarig Avenue, Suite 200', null)).toEqual({ addressNorm: '1100 RARIG AVE', suiteNorm: '200' });
    expect(splitAddress('3540 East 5th Ave.', 'Ste. B')).toEqual({ addressNorm: '3540 E 5TH AVE', suiteNorm: 'B' });
    expect(splitAddress('55 New Plant Ct #104', null)).toEqual({ addressNorm: '55 NEW PLANT CT', suiteNorm: '104' });
    expect(splitAddress('100 Unit Road', null)).toEqual({ addressNorm: '100 UNIT RD', suiteNorm: '' });
    expect(splitAddress('9 Main St Suite 5', 'Unit 7')).toEqual({ addressNorm: '9 MAIN ST', suiteNorm: '7' });
  });
  it('normalizes suites', () => {
    expect(normalizeSuite('Unit A-2')).toBe('A-2');
    expect(normalizeSuite('# 104')).toBe('104');
    expect(normalizeSuite(null)).toBe('');
  });
});

describe('bands and strata', () => {
  it('bands on the boundaries', () => {
    expect([4999, 5000, 49999, 50000, 80000, 80001, 0].map(sizeBandFor)).toEqual(['<5K', '5-15K', '30-50K', '50-80K', '50-80K', null, null]);
  });
  it('stratifies only flex with a known office share', () => {
    expect(officeStratumFor('warehouse', 50, 40)).toBe('all');
    expect(officeStratumFor('flex', null, 40)).toBe('all');
    expect(officeStratumFor('flex', 40, 40)).toBe('office_ge40');
    expect(officeStratumFor('flex', 39.9, 40)).toBe('office_lt40');
  });
});

describe('parseRentText', () => {
  const base = { withheld: false, isTotal: false, opexQuoted: null, ambiguous: false };
  it('single yearly NNN, ranges, monthly', () => {
    expect(parseRentText('$8.50/SF/YR NNN')).toEqual({ ...base, rentLow: 8.5, rentHigh: 8.5, rentPeriod: 'yr', basis: 'NNN' });
    expect(parseRentText('$8.00 - $10.00 /SF/YR Modified Gross')).toEqual({ ...base, rentLow: 8, rentHigh: 10, rentPeriod: 'yr', basis: 'MG' });
    expect(parseRentText('$0.75/SF/MO IG')).toEqual({ ...base, rentLow: 0.75, rentHigh: 0.75, rentPeriod: 'mo', basis: 'IG' });
    expect(parseRentText('$9.25 Industrial Gross')).toEqual({ ...base, rentLow: 9.25, rentHigh: 9.25, rentPeriod: null, basis: 'IG' });
  });
  it('base + quoted expenses', () => {
    expect(parseRentText('$7.25/SF + $2.50 NNN')).toEqual({ ...base, rentLow: 7.25, rentHigh: 7.25, rentPeriod: null, basis: 'NNN', opexQuoted: 2.5 });
    expect(parseRentText('$6.50/SF/YR + $1.95 CAM/TAX/INS')).toMatchObject({ rentLow: 6.5, basis: 'NNN', opexQuoted: 1.95, isTotal: false });
  });
  it('total-dollar quotes', () => {
    expect(parseRentText('$12,000/month + expenses')).toEqual({ ...base, rentLow: 12000, rentHigh: 12000, rentPeriod: 'mo', basis: 'NNN', isTotal: true });
    expect(parseRentText('$1,250/MO')).toMatchObject({ rentLow: 1250, rentPeriod: 'mo', isTotal: true });
    expect(parseRentText('$950/mo')).toMatchObject({ rentLow: 950, isTotal: true });
    expect(parseRentText('$120,000/YR NNN')).toMatchObject({ rentLow: 120000, rentPeriod: 'yr', basis: 'NNN', isTotal: true });
  });
  it('flags ambiguous no-unit amounts', () => {
    expect(parseRentText('$150')).toMatchObject({ ambiguous: true, isTotal: false });
  });
  it('withheld phrases and blanks', () => {
    for (const s of ['Withheld', 'Call for pricing', 'Negotiable', '']) expect(parseRentText(s).withheld).toBe(true);
  });

  // Fix round 1 (task review): add-on split, range separator gating, head-only period/basis,
  // non-negotiable/non-negotiable-adjacent quotes are not withheld, $.75 support.
  it('MG/IG + add-on is ambiguous (contradictory quote); NNN stated or unstated + add-on is NNN', () => {
    expect(parseRentText('$7.00/SF/YR Modified Gross + CAM')).toMatchObject({ rentLow: 7, basis: 'MG', ambiguous: true });
    expect(parseRentText('$6.00/SF/YR IG + $1.10 CAM')).toMatchObject({ basis: 'IG', ambiguous: true });
  });
  it('trailing numbers after the rent (CAM figure, escalation, range separator) are ignored/handled correctly', () => {
    expect(parseRentText('$4.00/SF/YR NNN, CAM $3.50')).toMatchObject({ rentLow: 4, rentHigh: 4, rentPeriod: 'yr', basis: 'NNN', ambiguous: false });
    expect(parseRentText('$3.25/SF/YR NNN w/ 3% annual increases')).toMatchObject({ rentLow: 3.25, rentHigh: 3.25, rentPeriod: 'yr' });
    expect(parseRentText('$2.75/SF NNN, 3% annual escalations')).toMatchObject({ rentLow: 2.75, rentHigh: 2.75, rentPeriod: null });
  });
  it('add-on opex quoted value derivation', () => {
    expect(parseRentText('$12,000/month + $1,500 CAM')).toMatchObject({ rentLow: 12000, rentPeriod: 'mo', isTotal: true, opexQuoted: null, basis: 'NNN' });
    const r = parseRentText('$7.25/SF/YR + $0.21/SF/MO CAM');
    expect(r.rentPeriod).toBe('yr');
    expect(r.rentLow).toBe(7.25);
    expect(r.opexQuoted).toBeCloseTo(2.52);
  });
  it('ranges require a separator between the two numbers', () => {
    expect(parseRentText('$8.00/SF/YR - $10.00/SF/YR')).toMatchObject({ rentLow: 8, rentHigh: 10 });
    expect(parseRentText('$8.00 to $10.00 NNN')).toMatchObject({ rentLow: 8, rentHigh: 10, basis: 'NNN' });
  });
  it('non-negotiable quotes and slash-annual quotes are not withheld; bare "Call ..." still is', () => {
    expect(parseRentText('$8.50/SF/YR NNN (non-negotiable)')).toMatchObject({ withheld: false, rentLow: 8.5 });
    expect(parseRentText('$8.50/SF NNN/Annual')).toMatchObject({ withheld: false, rentLow: 8.5 });
    expect(parseRentText('Call 614-555-1212')).toMatchObject({ withheld: true });
  });
  it('supports numbers with no leading zero', () => {
    expect(parseRentText('$.75/SF/MO NNN')).toMatchObject({ rentLow: 0.75, rentPeriod: 'mo' });
  });

  // Fix round 1, adversarial-review follow-up: a head stating two contradictory basis tokens, or a
  // head/tail split that hides or contradicts the true period, must flag ambiguous rather than
  // silently pass through as a clean high-confidence NNN quote.
  it('two distinct basis tokens in the head are flagged ambiguous', () => {
    expect(parseRentText('$8.50/SF/YR MG NNN')).toMatchObject({ ambiguous: true, rentLow: 8.5, basis: 'NNN' });
  });
  it('a period stated only in the truncated tail is flagged ambiguous, not silently dropped', () => {
    expect(parseRentText('$3.25/SF NNN (monthly)')).toMatchObject({ ambiguous: true, rentLow: 3.25, rentPeriod: null });
  });
  it('a bare "monthly" elsewhere in the text conflicting with an explicit head period is ambiguous, not silently overridden', () => {
    expect(parseRentText('$4.00/SF/YR NNN - monthly payments of $1,667')).toMatchObject({ ambiguous: true, rentLow: 4, rentHigh: 4 });
  });
  it('a range with a basis word between the two $-anchored figures is still recognized as a range', () => {
    expect(parseRentText('$8.00/SF/YR NNN - $10.00/SF/YR NNN')).toMatchObject({ rentLow: 8, rentHigh: 10, ambiguous: false });
  });
  it('a "+" before the first rent figure is a term-length marker, not an add-on split point; the $-anchored rent is still found', () => {
    // Fix round 2: previously this data-loss-via-premature-split case was pinned withheld:true
    // (the "+" split carved off "5" as basePart and lost the real "$4.00" into the discarded addon).
    // Rule: the add-on split only fires on a "+" that occurs AFTER the first rent figure.
    expect(parseRentText('5+ year term at $4.00/SF NNN')).toMatchObject({ withheld: false, rentLow: 4, basis: 'NNN' });
  });
  it('a bare number elsewhere in the text (not $-anchored) does not shadow the real $-anchored rent', () => {
    expect(parseRentText('2nd floor $8.50/SF/YR NNN')).toMatchObject({ rentLow: 8.5, rentHigh: 8.5, ambiguous: false });
  });
  it('a short "$12-14/SF/YR" range (only the low figure carries a "$") still parses as a range', () => {
    expect(parseRentText('$12-14/SF/YR NNN')).toMatchObject({ rentLow: 12, rentHigh: 14 });
  });
  it('a same-period tail after the head-cut does not falsely trip the tail-conflict guard', () => {
    expect(parseRentText('$8.50/SF/YR NNN, CAM $3.50').ambiguous).toBe(false);
    expect(parseRentText('$8.50/SF/YR NNN w/ $2.50/SF/YR CAM').ambiguous).toBe(false);
  });

  // Fix round 2 (second re-review): a later $-anchored figure must not silently be promoted over an
  // earlier plausible-looking rent figure that has no "$" of its own; percentages are never rent or
  // add-on candidates; a basis stated only after the head cut is still picked up.
  it('an earlier unanchored number that looks like the rent is not shadowed by a later $-anchored figure (e.g. a CAM estimate)', () => {
    const a = parseRentText('8.50/SF/YR NNN, $2.10 CAM');
    expect(a.ambiguous).toBe(true);
    expect(a.rentLow).not.toBe(2.1);
    const b = parseRentText('Asking 8.50 NNN; CAM est. $2.10/SF/YR');
    expect(b.ambiguous).toBe(true);
    expect(b.rentLow).not.toBe(2.1);
  });
  it('a number immediately followed by "%" is never a rent or add-on candidate', () => {
    expect(parseRentText('$3.25 - 3% bumps NNN')).toMatchObject({ rentLow: 3.25, rentHigh: 3.25 });
    expect(parseRentText('$4.00 - 3.75% bumps /SF/YR NNN')).toMatchObject({ rentLow: 4, rentHigh: 4 });
    expect(parseRentText('$6.00/SF/YR NNN + 15% admin fee on CAM').opexQuoted).toBeNull();
  });
  it('a basis stated only after the head cut is still picked up, not lost', () => {
    expect(parseRentText('$8.50/SF/YR, NNN')).toMatchObject({ basis: 'NNN', ambiguous: false });
    expect(parseRentText('$8.50 /SF/YR (NNN)')).toMatchObject({ basis: 'NNN', ambiguous: false });
  });
});

describe('priceObservation', () => {
  it('NNN yearly passes through at high confidence', () => {
    expect(price({})).toEqual({ askingPsfYr: 8.5, effectiveBasis: 'NNN', askingNnnEq: 8.5, opexEstPsf: null, opexSource: null, confidence: 'high', rejectedReason: null });
  });
  it('monthly annualizes; inferred monthly is low confidence; >= 3.00 unstated is yearly high', () => {
    expect(price({ rentLow: 0.75, rentPeriod: 'mo' })).toMatchObject({ askingNnnEq: 9, confidence: 'high' });
    expect(price({ rentLow: 0.75, rentPeriod: null })).toMatchObject({ askingNnnEq: 9, confidence: 'low' });
    expect(price({ rentLow: 7, rentPeriod: null })).toMatchObject({ askingNnnEq: 7, confidence: 'high' });
  });
  it('ranges: wide => UNKNOWN with reason; narrow => midpoint; inverted bounds swap', () => {
    expect(price({ rentLow: 8, rentHigh: 10 })).toMatchObject({ effectiveBasis: 'UNKNOWN', askingNnnEq: null, rejectedReason: expect.stringMatching(/spread/) });
    expect(price({ rentLow: 9, rentHigh: 10 }).askingNnnEq).toBeCloseTo(9.5);
    expect(price({ rentLow: 10, rentHigh: 9 }).askingNnnEq).toBeCloseTo(9.5);
  });
  it('totals convert with available SF and need a period', () => {
    expect(price({ rentLow: 12000, rentPeriod: 'mo', rentIsTotal: true, availableSf: 16000 })).toMatchObject({ askingNnnEq: 9, confidence: 'high' });
    expect(price({ rentLow: 120000, rentPeriod: 'yr', rentIsTotal: true, availableSf: 12000 }).askingNnnEq).toBeCloseTo(10);
    expect(price({ rentLow: 12000, rentPeriod: null, rentIsTotal: true })).toMatchObject({ effectiveBasis: 'UNKNOWN', rejectedReason: expect.stringMatching(/period/) });
  });
  it('rejects out-of-bounds asking rents (the "$12,000/mo NNN" per-SF defect)', () => {
    expect(price({ rentLow: 12000, rentPeriod: 'mo', rentIsTotal: false })).toMatchObject({ effectiveBasis: 'UNKNOWN', askingNnnEq: null, rejectedReason: expect.stringMatching(/outside/) });
    expect(price({ rentLow: 0.5, rentPeriod: 'yr' })).toMatchObject({ effectiveBasis: 'UNKNOWN' });
  });
  it('gross subtracts the opex total; MG subtracts only configured components', () => {
    expect(price({ rentLow: 12, rentBasis: 'GROSS' })).toEqual({ askingPsfYr: 12, effectiveBasis: 'GROSS', askingNnnEq: 10.25, opexEstPsf: 1.75, opexSource: 'test', confidence: 'low', rejectedReason: null });
    expect(price({ rentLow: 11, rentBasis: 'MG' })).toMatchObject({ askingNnnEq: 9.75, opexEstPsf: 1.25, confidence: 'low' });
  });
  it('MG cannot convert with a total-only (quoted median) opex estimate; gross can', () => {
    const quoted: OpexEstimate = { tax: null, ins: null, cam: null, total: 2, source: 'quoted-market-median n=6' };
    expect(price({ rentLow: 11, rentBasis: 'MG' }, quoted).askingNnnEq).toBeNull();
    expect(price({ rentLow: 11, rentBasis: 'GROSS' }, quoted)).toMatchObject({ askingNnnEq: 9, opexSource: 'quoted-market-median n=6' });
  });
  it('no opex => no NNN equivalent; withheld and missing carry nothing', () => {
    expect(price({ rentLow: 11, rentBasis: 'MG' }, null).askingNnnEq).toBeNull();
    expect(price({ rentBasis: 'WITHHELD' }).askingPsfYr).toBeNull();
    expect(price({ rentLow: null }).effectiveBasis).toBe('WITHHELD');
  });

  // Fix round 1 (task review): non-numeric bounds, exact-spread boundary, and component-level
  // MG/IG opex gating (a quoted-median-only estimate can't convert MG/IG even with an empty mgLandlordPays list).
  it('non-finite low/high reject as UNKNOWN', () => {
    expect(price({ rentLow: NaN })).toMatchObject({ effectiveBasis: 'UNKNOWN', askingNnnEq: null });
  });
  it('exactly the max spread passes (not rejected)', () => {
    expect(price({ rentLow: 4.1, rentHigh: 4.92 })).toMatchObject({ effectiveBasis: 'NNN' });
    expect(price({ rentLow: 4.1, rentHigh: 4.92 }).askingNnnEq).toBeCloseTo(4.51);
  });
  it('MG cannot convert with a component-level-null opex estimate even with an empty mgLandlordPays list', () => {
    const quoted: OpexEstimate = { tax: null, ins: null, cam: null, total: 2, source: 'q' };
    const input: RentInput = { rentLow: 11, rentHigh: null, rentPeriod: 'yr', rentBasis: 'MG', rentIsTotal: false, availableSf: 10000 };
    expect(priceObservation(input, quoted, [], T).askingNnnEq).toBeNull();
  });
  it('sub-ceiling unstated period is low confidence; at-ceiling unstated period is yearly high confidence', () => {
    const r1 = price({ rentLow: 2.99, rentPeriod: null });
    expect(r1.confidence).toBe('low');
    expect(r1.askingNnnEq).toBeCloseTo(35.88);
    expect(price({ rentLow: 3, rentPeriod: null })).toMatchObject({ askingNnnEq: 3, confidence: 'high' });
  });
});

describe('splitAddress — empty rawSuite override', () => {
  it('does not let a blank rawSuite hide an embedded suite', () => {
    expect(splitAddress('9 Main St Suite 5', '')).toEqual({ addressNorm: '9 MAIN ST', suiteNorm: '5' });
  });
});

describe('sizeBandFor — boundary spot checks', () => {
  it('lands each boundary in the correct band', () => {
    expect(sizeBandFor(14999)).toBe('5-15K');
    expect(sizeBandFor(15000)).toBe('15-30K');
    expect(sizeBandFor(29999)).toBe('15-30K');
    expect(sizeBandFor(30000)).toBe('30-50K');
  });
});

describe('isBenchmarkEligible — 80K building', () => {
  it('accepts a building exactly at the max SF', () => {
    const base: EligibilityInput = { confidence: 'high', effectiveBasis: 'NNN', isSublease: false, originTier: 'T1', buildingStatus: 'existing', askingNnnEq: 8, buildingSf: 40000 };
    expect(isBenchmarkEligible({ ...base, buildingSf: 80000 }, 80000)).toBe(true);
  });
});

describe('opex estimates', () => {
  it('defaults win over quoted medians; quoted medians need n', () => {
    const d = { tax: 1, ins: 0.2, cam: 0.3, source: 'broker', asOf: '2026-01-01' };
    expect(opexFromDefaults(d)).toEqual({ tax: 1, ins: 0.2, cam: 0.3, total: 1.5, source: 'config: broker (2026-01-01)' });
    expect(opexFromQuotedMedian([2, 2.5, 3, 1.5], 5)).toBeNull();
    expect(opexFromQuotedMedian([2, 2.5, 3, 1.5, 2.2], 5)).toEqual({ tax: null, ins: null, cam: null, total: 2.2, source: 'quoted-market-median n=5' });
    expect(resolveOpex(d, [2, 2.5, 3, 1.5, 2.2], 5)?.total).toBe(1.5);
    expect(resolveOpex(null, [2, 2.5, 3, 1.5, 2.2], 5)?.total).toBe(2.2);
    expect(resolveOpex(null, [], 5)).toBeNull();
  });
});

describe('isBenchmarkEligible', () => {
  const base: EligibilityInput = { confidence: 'high', effectiveBasis: 'NNN', isSublease: false, originTier: 'T1', buildingStatus: 'existing', askingNnnEq: 8, buildingSf: 40000 };
  it('accepts the base case and unknown building SF', () => {
    expect(isBenchmarkEligible(base, 80000)).toBe(true);
    expect(isBenchmarkEligible({ ...base, buildingSf: null }, 80000)).toBe(true);
  });
  it.each([
    ['low confidence', { confidence: 'low' as const }],
    ['non-NNN basis', { effectiveBasis: 'MG' as const }],
    ['sublease', { isSublease: true }],
    ['alert-sourced', { originTier: 'T2' as const }],
    ['proposed building', { buildingStatus: 'proposed' as const }],
    ['no rent', { askingNnnEq: null }],
    ['building too large', { buildingSf: 90000 }],
  ])('rejects %s', (_l, patch) => {
    expect(isBenchmarkEligible({ ...base, ...patch }, 80000)).toBe(false);
  });
});
