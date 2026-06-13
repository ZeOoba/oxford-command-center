// tests/unit/intel-managers-view.test.ts
//
// Pure helper backing ManagersView (the view itself is browser-verified, not
// jsdom-rendered). It orders the PM scorecards by avg NOI growth descending — best manager
// first — with null growth pushed to the bottom (an unrankable manager never outranks a
// ranked one). Deterministic, non-mutating, null-safe.
import { describe, expect, it } from 'vitest';
import { sortScorecards } from '../../src/modules/intel/managers-intel';
import type { PmScorecard } from '../../src/modules/intel/analytics-hooks';

const sc = (
  propertyManager: string,
  avgNoiGrowth: number | null,
  over: Partial<PmScorecard> = {},
): PmScorecard => ({
  propertyManager,
  propertyCount: 2,
  smallSample: false,
  avgNoiPerSf: 6,
  avgNoiGrowth,
  avgExpenseGrowth: 0.05,
  ...over,
});

describe('sortScorecards', () => {
  it('orders by avg NOI growth descending (best manager first)', () => {
    const sorted = sortScorecards([sc('a', 0.1), sc('b', 0.3), sc('c', -0.2)]);
    expect(sorted.map((s) => s.propertyManager)).toEqual(['b', 'a', 'c']);
  });

  it('pushes null-growth managers to the bottom, after every ranked one', () => {
    const sorted = sortScorecards([sc('a', null), sc('b', 0.2), sc('c', null), sc('d', -0.1)]);
    expect(sorted.map((s) => s.propertyManager)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('is stable for equal growth and does not mutate the input', () => {
    const input = [sc('a', 0.1), sc('b', 0.1)];
    const sorted = sortScorecards(input);
    expect(sorted.map((s) => s.propertyManager)).toEqual(['a', 'b']);
    expect(input.map((s) => s.propertyManager)).toEqual(['a', 'b']); // input untouched
  });

  it('is empty-safe', () => {
    expect(sortScorecards([])).toEqual([]);
  });
});
