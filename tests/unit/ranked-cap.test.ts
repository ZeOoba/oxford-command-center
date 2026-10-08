import { describe, it, expect } from 'vitest';
import { allocateBudget, coverage, MAX_ITEMS } from '../../src/lib/ranked-cap';

describe('allocateBudget', () => {
  it('shows everything when the total fits the budget', () => {
    expect(allocateBudget([3, 2, 1], 10)).toEqual([3, 2, 1]);
  });

  it('guarantees each non-empty tier its floor, then fills in tier order', () => {
    // 20 critical / 34 warning / 6 info, budget 10, floor 2 -> floors 2/2/2, remaining 4 go to the first tier.
    expect(allocateBudget([20, 34, 6], 10, 2)).toEqual([6, 2, 2]);
  });

  it('never allocates more than a tier holds, and passes surplus down the order', () => {
    // First tier has only 1 item, so its leftover budget flows to the next tiers.
    // floors 1/2/2 (=5), the remaining 5 go to the first tier that can still take them.
    expect(allocateBudget([1, 30, 30], 10, 2)).toEqual([1, 7, 2]);
  });

  it('never exceeds the budget even when the floors alone would', () => {
    const a = allocateBudget([9, 9, 9, 9], 5, 2);
    expect(a.reduce((x, y) => x + y, 0)).toBe(5);
    expect(a).toEqual([2, 2, 1, 0]);
  });

  it('leaves empty tiers at zero', () => {
    expect(allocateBudget([0, 15, 0], 10, 2)).toEqual([0, 10, 0]);
  });

  it('is a no-op for an unbounded budget', () => {
    expect(allocateBudget([50, 50], Infinity)).toEqual([50, 50]);
  });

  it('defaults the surface ceiling to ten', () => {
    expect(MAX_ITEMS).toBe(10);
  });
});

describe('coverage', () => {
  const rows = [
    { usd: 58_000, signals: 1, shown: true },
    { usd: 48_000, signals: 1, shown: true },
    { usd: 10_000, signals: 3, shown: false }, // a group of 3
    { usd: null, signals: 1, shown: true }, // unquantified but shown
    { usd: null, signals: 1, shown: false },
  ];

  it('counts signals, not rows, so a group of 3 is 3 signals', () => {
    const c = coverage(rows);
    expect(c.signalsTotal).toBe(7);
    expect(c.signalsShown).toBe(3);
  });

  it('reports dollars on screen vs total quantified exposure', () => {
    const c = coverage(rows);
    expect(c.usdShown).toBe(106_000);
    expect(c.usdTotal).toBe(116_000);
    expect(c.pct).toBe(91);
  });

  it('counts unquantified signals separately instead of treating them as zero-dollar', () => {
    expect(coverage(rows).unquantified).toBe(2);
  });

  it('returns a null pct when nothing is quantified', () => {
    const c = coverage([{ usd: null, signals: 2, shown: true }]);
    expect(c.pct).toBeNull();
    expect(c.unquantified).toBe(2);
  });
});
