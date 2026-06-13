// tests/unit/intel-benchmarks-view.test.ts
//
// Pure helpers backing BenchmarksView (the view itself is browser-verified, not
// jsdom-rendered). They derive the period selector's options (the FULL-YEAR periods
// present in metrics, latest first so the default selection is the latest FY — never a
// 2026-YTD, pre-mortem #5/#7) and the per-metric value formatter (so $/SF render as
// dollars, ratios as percentages). Deterministic, null-safe.
import { describe, expect, it } from 'vitest';
import {
  availableFyPeriods,
  metricFormatter,
  METRIC_KEYS,
  METRIC_LABELS,
} from '../../src/modules/intel/benchmarks-intel';
import type { NumericMetricKey } from '../../src/modules/intel/analytics-hooks';
import type { PeriodMetrics } from '../../src/modules/intel/analytics-hooks';

const pm = (period: string, grainHint: string | null): PeriodMetrics => ({
  propertyId: `p-${period}`,
  propertyName: period,
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
});

describe('availableFyPeriods', () => {
  it('returns distinct full-year periods, latest first (so default = latest FY)', () => {
    const metrics: PeriodMetrics[] = [
      pm('2023', 'year'),
      pm('2024', 'year'),
      pm('2024', 'year'), // duplicate period (different property) → deduped
      pm('2025', 'year'),
    ];
    expect(availableFyPeriods(metrics)).toEqual(['2025', '2024', '2023']);
  });

  it('excludes YTD/partial periods — benchmarks are a full-year cohort (pre-mortem #5/#7)', () => {
    const metrics: PeriodMetrics[] = [
      pm('2024', 'year'),
      pm('2025', 'year'),
      pm('2026', 'ytd'), // partial — never offered as a benchmark period
    ];
    expect(availableFyPeriods(metrics)).toEqual(['2025', '2024']);
  });

  it('is empty-safe', () => {
    expect(availableFyPeriods([])).toEqual([]);
  });
});

describe('metricFormatter', () => {
  it('formats dollar + $/SF metrics as USD', () => {
    expect(metricFormatter('noi')(1234567)).toBe('$1,234,567');
    expect(metricFormatter('revenue')(500000)).toBe('$500,000');
    // $/SF carries cents
    expect(metricFormatter('noiPerSf')(6.25)).toBe('$6.25');
    expect(metricFormatter('revenuePerSf')(10.5)).toBe('$10.50');
    expect(metricFormatter('expensePerSf')(4)).toBe('$4.00');
    expect(metricFormatter('taxesPerSf')(1.1)).toBe('$1.10');
    expect(metricFormatter('insurancePerSf')(0.5)).toBe('$0.50');
    expect(metricFormatter('repairsPerSf')(0.8)).toBe('$0.80');
  });

  it('formats ratio metrics as percentages', () => {
    expect(metricFormatter('noiMargin')(0.6)).toBe('60.0%');
    expect(metricFormatter('expenseRatio')(0.4)).toBe('40.0%');
  });

  it('renders null/non-finite as em-dash for every metric', () => {
    for (const key of METRIC_KEYS) {
      expect(metricFormatter(key)(null)).toBe('—');
      expect(metricFormatter(key)(Number.NaN)).toBe('—');
    }
  });
});

describe('metric enum metadata', () => {
  it('exposes exactly the 12 benchmarkable metric keys with friendly labels', () => {
    const expected: NumericMetricKey[] = [
      'revenue',
      'opex',
      'noi',
      'oxfordNoi',
      'noiMargin',
      'expenseRatio',
      'revenuePerSf',
      'noiPerSf',
      'expensePerSf',
      'taxesPerSf',
      'insurancePerSf',
      'repairsPerSf',
    ];
    expect([...METRIC_KEYS]).toEqual(expected);
    for (const key of expected) {
      expect(typeof METRIC_LABELS[key]).toBe('string');
      expect(METRIC_LABELS[key].length).toBeGreaterThan(0);
    }
  });
});
