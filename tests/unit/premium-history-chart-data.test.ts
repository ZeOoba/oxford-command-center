// tests/unit/premium-history-chart-data.test.ts
//
// I-3: PremiumHistoryCard's policy-year bar chart mixed different coverage per bar with no
// indication of how many policy lines fed it, and the current calendar year's total is
// necessarily partial (the year isn't over yet) but read identically to a complete prior year.
// premiumHistoryBars surfaces byYear[].lines in the label and marks the current year "(partial)".
import { describe, expect, it } from 'vitest';
import { premiumHistoryBars } from '../../src/modules/insurance/premium-history-chart-data';

describe('premiumHistoryBars', () => {
  it('labels each bar with its distinct-line count', () => {
    const bars = premiumHistoryBars(
      [{ year: 2024, premium: 100, lines: 5 }, { year: 2025, premium: 200, lines: 1 }],
      new Date('2020-01-01T00:00:00Z'), // neither year is "now" — nothing partial
    );
    expect(bars).toEqual([
      { label: '2024 · 5', value: 100 },
      { label: '2025 · 1', value: 200 },
    ]);
  });

  it('marks the current calendar year as partial', () => {
    const bars = premiumHistoryBars(
      [{ year: 2025, premium: 100, lines: 2 }, { year: 2026, premium: 50, lines: 1 }],
      new Date('2026-09-24T00:00:00Z'),
    );
    expect(bars).toEqual([
      { label: '2025 · 2', value: 100 },
      { label: '2026* · 1', value: 50 },
    ]);
  });

  it('defaults "now" to the real wall clock when not passed', () => {
    const thisYear = new Date().getFullYear();
    const bars = premiumHistoryBars([{ year: thisYear, premium: 10, lines: 1 }]);
    expect(bars[0]!.label).toContain('*');
  });

  it('returns an empty array for no years', () => {
    expect(premiumHistoryBars([])).toEqual([]);
  });
});
