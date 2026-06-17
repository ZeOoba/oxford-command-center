import { describe, it, expect } from 'vitest';
import { coerceNonNegMoney } from '../../src/lib/money';

describe('coerceNonNegMoney — shared overlay numeric coercer', () => {
  it('keeps a positive finite number', () => {
    expect(coerceNonNegMoney(3000)).toBe(3000);
    expect(coerceNonNegMoney(1200.5)).toBe(1200.5);
  });
  it('clamps a negative number / 0 / non-finite to 0', () => {
    expect(coerceNonNegMoney(-100)).toBe(0);
    expect(coerceNonNegMoney(0)).toBe(0);
    expect(coerceNonNegMoney(NaN)).toBe(0);
    expect(coerceNonNegMoney(Infinity)).toBe(0);
  });
  it('non-numeric values → 0', () => {
    expect(coerceNonNegMoney(undefined)).toBe(0);
    expect(coerceNonNegMoney(null)).toBe(0);
    expect(coerceNonNegMoney('n/a')).toBe(0);
    expect(coerceNonNegMoney({})).toBe(0);
    expect(coerceNonNegMoney(true)).toBe(0);
  });
  it('salvages plain and currency/comma-formatted strings (real QB/Excel export formats)', () => {
    expect(coerceNonNegMoney('4000')).toBe(4000);
    expect(coerceNonNegMoney('12,500')).toBe(12500);
    expect(coerceNonNegMoney('$4,000')).toBe(4000);
    expect(coerceNonNegMoney('1,200.00')).toBe(1200);
    expect(coerceNonNegMoney(' 5000 ')).toBe(5000);
  });
  it('treats accounting-parens / explicit-negative strings as credits → 0', () => {
    expect(coerceNonNegMoney('(500)')).toBe(0);
    expect(coerceNonNegMoney('-100')).toBe(0);
    expect(coerceNonNegMoney('($8,000.00)')).toBe(0);
  });
  it('empty / whitespace string → 0', () => {
    expect(coerceNonNegMoney('')).toBe(0);
    expect(coerceNonNegMoney('   ')).toBe(0);
  });
});
