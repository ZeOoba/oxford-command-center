// @vitest-environment node
//
// tests/unit/property-financials-pyfloat.test.ts — T9a. The committed monthly-long.csv and dataset.json
// were produced by a Python pipeline: amounts carry Python's float repr ("141.0", "1508.25") and every
// rounded figure uses Python's round() (round-half-to-even on the exact binary value, e.g. 8950.5 -> 8950).
// The rebuild must reproduce both byte-for-byte, so the two helpers are pinned here.
import { describe, expect, it } from 'vitest';
import { pyRepr, pyRound } from '@analytics/property-financials/pyfloat';

describe('pyRound — Python round() semantics', () => {
  it('rounds half to even when the binary value is exactly halfway', () => {
    expect(pyRound(8950.5, 0)).toBe(8950);
    expect(pyRound(8951.5, 0)).toBe(8952);
    expect(pyRound(2.5, 0)).toBe(2);
    expect(pyRound(-2.5, 0)).toBe(-2);
    expect(pyRound(0.125, 2)).toBe(0.12);
    expect(pyRound(0.375, 2)).toBe(0.38);
    expect(pyRound(1234.125, 2)).toBe(1234.12);
  });

  it('rounds non-halfway values by their exact binary value, like Python (not by decimal appearance)', () => {
    // 2.675 is stored as 2.67499999... so Python gives 2.67 (toFixed also does; naive *100 math does not).
    expect(pyRound(2.675, 2)).toBe(2.67);
    // 1.005 is stored below 1.005 -> 1.0
    expect(pyRound(1.005, 2)).toBe(1);
    expect(pyRound(227122.56000000003, 2)).toBe(227122.56);
    expect(pyRound(0.123456, 3)).toBe(0.123);
    expect(pyRound(-0.4555, 3)).toBe(-0.456);
    expect(pyRound(10.957, 3)).toBe(10.957);
  });

  it('returns exact integers for ndigits 0 and handles zero / negatives', () => {
    expect(pyRound(13719.16, 0)).toBe(13719);
    expect(pyRound(-13719.66, 0)).toBe(-13720);
    expect(pyRound(0, 2)).toBe(0);
    expect(Object.is(pyRound(-0.001, 2), 0)).toBe(true); // never emits -0
    expect(Number.isInteger(pyRound(99.5, 0))).toBe(true);
  });

  it('refuses non-finite input', () => {
    expect(() => pyRound(Number.NaN, 2)).toThrow(/finite/);
    expect(() => pyRound(Number.POSITIVE_INFINITY, 0)).toThrow(/finite/);
  });
});

describe('pyRepr — Python float repr for CSV amounts', () => {
  it('prints integers with a trailing .0 and other values at shortest round-trip precision', () => {
    expect(pyRepr(141)).toBe('141.0');
    expect(pyRepr(550000)).toBe('550000.0');
    expect(pyRepr(0)).toBe('0.0');
    expect(pyRepr(-2415)).toBe('-2415.0');
    expect(pyRepr(1508.25)).toBe('1508.25');
    expect(pyRepr(642.95)).toBe('642.95');
    expect(pyRepr(-7656.07)).toBe('-7656.07');
    expect(pyRepr(0.1 + 0.2)).toBe('0.30000000000000004');
  });

  it('normalises negative zero to 0.0 and refuses values Python would print in exponent form', () => {
    expect(pyRepr(-0)).toBe('0.0');
    expect(() => pyRepr(1e16)).toThrow(/exponent/);
    expect(() => pyRepr(0.00001)).toThrow(/exponent/);
    expect(() => pyRepr(Number.NaN)).toThrow(/finite/);
  });
});
