import { describe, expect, it } from 'vitest';
import { fmtTenure } from '../../src/analytics/format';

describe('fmtTenure', () => {
  it('rounds months and switches to years at 24 mo', () => {
    expect(fmtTenure(13.73305954825462)).toBe('14 mo tenure');
    expect(fmtTenure(28.747433264887064)).toBe('2.4 yr tenure');
    expect(fmtTenure(393.72484599589325)).toBe('32.8 yr tenure');
    expect(fmtTenure(0.2)).toBe('<1 mo tenure');
  });

  // 2026-09-23 review T12: round FIRST, then threshold — 23.6 mo must not read "24 mo" while 24.0
  // reads "2.0 yr". Non-finite or negative input is not a tenure at all → the em-dash convention.
  it('rounds before applying the 24-month threshold, and dashes non-finite/negative input', () => {
    expect(fmtTenure(1)).toBe('1 mo tenure');
    expect(fmtTenure(23.6)).toBe('2.0 yr tenure');
    expect(fmtTenure(24)).toBe('2.0 yr tenure');
    expect(fmtTenure(Number.NaN)).toBe('—');
    expect(fmtTenure(Number.POSITIVE_INFINITY)).toBe('—');
    expect(fmtTenure(-3)).toBe('—');
  });
});
