import { describe, expect, it } from 'vitest';
import { dayLabel } from '../../src/modules/renewals/day-label';

describe('renewals dayLabel', () => {
  it('labels a passed lease end as holdover, matching the Monitor insight vocabulary', () => {
    expect(dayLabel(-752)).toBe('Holdover · 752d');
    expect(dayLabel(38)).toBe('38d');
    expect(dayLabel(null)).toBe('—');
  });
});
