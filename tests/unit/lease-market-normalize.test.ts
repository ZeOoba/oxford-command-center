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
