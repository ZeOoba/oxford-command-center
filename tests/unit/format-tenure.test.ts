import { describe, expect, it } from 'vitest';
import { fmtTenure } from '../../src/analytics/format';

describe('fmtTenure', () => {
  it('rounds months and switches to years at 24 mo', () => {
    expect(fmtTenure(13.73305954825462)).toBe('14 mo tenure');
    expect(fmtTenure(28.747433264887064)).toBe('2.4 yr tenure');
    expect(fmtTenure(393.72484599589325)).toBe('32.8 yr tenure');
    expect(fmtTenure(0.2)).toBe('<1 mo tenure');
  });
});
