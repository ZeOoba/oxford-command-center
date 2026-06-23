import { describe, it, expect } from 'vitest';
import {
  MIN_PAIRS,
  MIN_SHARED_PERIODS,
  N_FULL,
  pearson,
  spearman,
  wilson,
} from '../../server/insights/stats';

describe('insight-stats constants', () => {
  it('exports MIN_PAIRS = 5', () => {
    expect(MIN_PAIRS).toBe(5);
  });

  it('exports MIN_SHARED_PERIODS = 3', () => {
    expect(MIN_SHARED_PERIODS).toBe(3);
  });

  it('exports N_FULL = 14', () => {
    expect(N_FULL).toBe(14);
  });
});

describe('pearson', () => {
  it('returns 1 for perfect positive correlation [1,2,3] vs [1,2,3]', () => {
    const r = pearson([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]);
    expect(r).toBeCloseTo(1, 10);
  });

  it('returns -1 for perfect negative correlation [1,2,3,4,5] vs [5,4,3,2,1]', () => {
    const r = pearson([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]);
    expect(r).toBeCloseTo(-1, 10);
  });

  it('returns a finite number in [-1,1] for [1,2,3,4,5] vs [1,2,1,2,1]', () => {
    const r = pearson([1, 2, 3, 4, 5], [1, 2, 1, 2, 1]);
    expect(r).not.toBeNull();
    expect(isFinite(r as number)).toBe(true);
    expect(r as number).toBeGreaterThanOrEqual(-1);
    expect(r as number).toBeLessThanOrEqual(1);
  });

  it('returns null when n=2 < MIN_PAIRS=5', () => {
    expect(pearson([1, 2], [1, 2])).toBeNull();
  });

  it('returns null when n=4 < MIN_PAIRS=5', () => {
    expect(pearson([1, 2, 3, 4], [1, 2, 3, 4])).toBeNull();
  });

  it('returns null when denominator is 0 (constant arrays)', () => {
    expect(pearson([2, 2, 2, 2, 2], [1, 2, 3, 4, 5])).toBeNull();
  });
});

describe('spearman', () => {
  it('returns 1 for perfectly ranked [1,2,3,4,5] vs [1,2,3,4,5]', () => {
    const r = spearman([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]);
    expect(r).toBeCloseTo(1, 10);
  });

  it('returns -1 for reverse-ranked [1,2,3,4,5] vs [5,4,3,2,1]', () => {
    const r = spearman([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]);
    expect(r).toBeCloseTo(-1, 10);
  });

  it('returns null when n < MIN_PAIRS', () => {
    expect(spearman([1, 2], [1, 2])).toBeNull();
  });

  it('handles tied ranks using midpoint average', () => {
    // [1, 1, 3] → ranks [1.5, 1.5, 3]; result should be finite and in [-1,1]
    const r = spearman([1, 1, 3, 4, 5], [1, 2, 3, 4, 5]);
    expect(r).not.toBeNull();
    expect(isFinite(r as number)).toBe(true);
    expect(r as number).toBeGreaterThanOrEqual(-1);
    expect(r as number).toBeLessThanOrEqual(1);
  });
});

describe('wilson', () => {
  it('returns { low: null, high: null } when n=0', () => {
    expect(wilson(0, 0)).toEqual({ low: null, high: null });
  });

  it('returns finite bounds for wilson(8, 10)', () => {
    const result = wilson(8, 10);
    expect(result.low).not.toBeNull();
    expect(result.high).not.toBeNull();
    expect(isFinite(result.low as number)).toBe(true);
    expect(isFinite(result.high as number)).toBe(true);
  });

  it('wilson(8, 10) EXACTLY matches calibration.ts formula', () => {
    // Inline the calibration.ts formula verbatim to cross-check
    const hits = 8;
    const n = 10;
    const z = 1.96;
    const phat = hits / n;
    const z2 = z * z;
    const denom = 1 + z2 / n;
    const centre = (phat + z2 / (2 * n)) / denom;
    const margin = (z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n)) / denom;
    const expected = {
      low: Math.max(0, centre - margin),
      high: Math.min(1, centre + margin),
    };

    const actual = wilson(8, 10);
    expect(actual.low).toBe(expected.low);
    expect(actual.high).toBe(expected.high);
  });

  it('low bound is >= 0 and high bound is <= 1', () => {
    const r = wilson(8, 10);
    expect(r.low as number).toBeGreaterThanOrEqual(0);
    expect(r.high as number).toBeLessThanOrEqual(1);
  });

  it('wilson(0, 5) returns low=0 (boundary case)', () => {
    const r = wilson(0, 5);
    expect(r.low).toBe(0);
    expect(r.high).not.toBeNull();
  });

  it('wilson(5, 5) returns high=1 (boundary case)', () => {
    const r = wilson(5, 5);
    expect(r.low).not.toBeNull();
    expect(r.high).toBe(1);
  });
});
