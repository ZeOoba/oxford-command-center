// tests/unit/intel-property-view.test.ts
//
// Pure helpers backing PropertyIntelView (the view itself is browser-verified, not
// jsdom-rendered). These select/shape the metric series the page draws — period
// labelling ('FY2024' / '2026 YTD'), the full-year set, the two latest FY periods the
// ΔNOI waterfall bridges, and the sparkline number arrays. Deterministic, null-safe.
import { describe, expect, it } from 'vitest';
import {
  buildAnnualSeries,
  fullYearPeriods,
  periodLabel,
  pickDriverPeriods,
} from '../../src/modules/intel/property-intel';
import type { PeriodMetrics } from '../../src/modules/intel/analytics-hooks';

const pm = (period: string, grainHint: string | null, over: Partial<PeriodMetrics> = {}): PeriodMetrics => ({
  propertyId: 'p',
  propertyName: 'P',
  period,
  grainHint,
  rentableSf: 10000,
  ownershipPct: 1,
  revenue: 100,
  opex: 40,
  noi: 60,
  noiMargin: 0.6,
  expenseRatio: 0.4,
  capex: 0,
  ti: 0,
  leasing: 0,
  categories: {},
  revenueCategories: {},
  revenuePerSf: 0.01,
  noiPerSf: 0.006,
  expensePerSf: 0.004,
  taxesPerSf: 0.001,
  insurancePerSf: 0.0005,
  repairsPerSf: 0.0008,
  oxfordNoi: 60,
  ...over,
});

describe('periodLabel', () => {
  it('labels full-year periods FY{year} and YTD periods "{year} YTD"', () => {
    expect(periodLabel('2024', 'year')).toBe('FY2024');
    expect(periodLabel('2026', 'ytd')).toBe('2026 YTD');
    // Unknown grain falls back to the bare period (never throws).
    expect(periodLabel('2025', null)).toBe('2025');
  });
});

describe('fullYearPeriods', () => {
  it('keeps only grainHint==="year" metrics, sorted ascending by period', () => {
    const fy = fullYearPeriods([
      pm('2026', 'ytd'),
      pm('2025', 'year'),
      pm('2023', 'year'),
      pm('2024', 'year'),
    ]);
    expect(fy.map((m) => m.period)).toEqual(['2023', '2024', '2025']);
  });

  it('returns [] when there are no full-year periods (YTD-only property)', () => {
    expect(fullYearPeriods([pm('2026', 'ytd')])).toEqual([]);
  });
});

describe('pickDriverPeriods', () => {
  it('picks the two latest full-year periods as {from, to}', () => {
    const picked = pickDriverPeriods([
      pm('2023', 'year'),
      pm('2024', 'year'),
      pm('2025', 'year'),
      pm('2026', 'ytd'),
    ]);
    expect(picked).toEqual({ from: '2024', to: '2025' });
  });

  it('returns null with fewer than two full-year periods (no bridge)', () => {
    expect(pickDriverPeriods([pm('2025', 'year'), pm('2026', 'ytd')])).toBeNull();
    expect(pickDriverPeriods([pm('2026', 'ytd')])).toBeNull();
    expect(pickDriverPeriods([])).toBeNull();
  });
});

describe('buildAnnualSeries', () => {
  it('builds an ascending-by-period numeric series, dropping null selector values', () => {
    const series = buildAnnualSeries(
      [
        pm('2025', 'year', { noi: 70 }),
        pm('2023', 'year', { noi: 50 }),
        pm('2024', 'year', { noi: 60 }),
      ],
      (m) => m.noi,
    );
    expect(series).toEqual([50, 60, 70]);
  });

  it('drops periods whose selector is null (e.g. null $/SF on a no-SF property)', () => {
    const series = buildAnnualSeries(
      [pm('2024', 'year', { noiPerSf: null }), pm('2025', 'year', { noiPerSf: 0.006 })],
      (m) => m.noiPerSf,
    );
    expect(series).toEqual([0.006]);
  });

  it('returns [] for an empty metric set', () => {
    expect(buildAnnualSeries([], (m) => m.noi)).toEqual([]);
  });
});
