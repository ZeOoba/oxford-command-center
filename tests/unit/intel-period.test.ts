// tests/unit/intel-period.test.ts
//
// Pure helpers backing the module-level time control (PFI Phase B.3 item 3). The control
// governs which period's LEVELS/benchmarks display; scores stay on the latest full year.
// availablePeriods offers full years (latest first) then any YTD/partial period last, with
// FY{p} / {p} YTD labels; defaultPeriod selects the latest full year; isYtdPeriod drives the
// persistent "YTD (partial)" banner. Deterministic, null/empty-safe.
import { describe, expect, it } from 'vitest';
import { availablePeriods, defaultPeriod, isYtdPeriod } from '../../src/modules/intel/period-intel';
import type { PeriodMetrics } from '../../src/modules/intel/analytics-hooks';

const pm = (propertyId: string, period: string, grainHint: string | null): PeriodMetrics => ({
  propertyId,
  propertyName: propertyId,
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

describe('availablePeriods', () => {
  it('returns distinct periods, full years (latest first) then YTD last, with FY/YTD labels', () => {
    const opts = availablePeriods([
      pm('a', '2024', 'year'),
      pm('b', '2024', 'year'), // duplicate period collapses
      pm('a', '2026', 'ytd'),
      pm('a', '2023', 'year'),
      pm('a', '2025', 'year'),
    ]);
    expect(opts).toEqual([
      { period: '2025', grainHint: 'year', isYtd: false, label: 'FY2025' },
      { period: '2024', grainHint: 'year', isYtd: false, label: 'FY2024' },
      { period: '2023', grainHint: 'year', isYtd: false, label: 'FY2023' },
      { period: '2026', grainHint: 'ytd', isYtd: true, label: '2026 YTD' },
    ]);
  });

  it('is empty-safe', () => {
    expect(availablePeriods([])).toEqual([]);
  });
});

describe('defaultPeriod', () => {
  it('selects the latest full year', () => {
    expect(defaultPeriod(availablePeriods([pm('a', '2024', 'year'), pm('a', '2025', 'year'), pm('a', '2026', 'ytd')]))).toBe(
      '2025',
    );
  });

  it('falls back to the latest available when there is no full year', () => {
    expect(defaultPeriod(availablePeriods([pm('a', '2026', 'ytd')]))).toBe('2026');
  });

  it('is empty-safe', () => {
    expect(defaultPeriod([])).toBeNull();
  });
});

describe('isYtdPeriod', () => {
  const opts = availablePeriods([pm('a', '2025', 'year'), pm('a', '2026', 'ytd')]);

  it('is true only for a YTD/partial period', () => {
    expect(isYtdPeriod(opts, '2026')).toBe(true);
    expect(isYtdPeriod(opts, '2025')).toBe(false);
  });

  it('is false for an unknown or null period', () => {
    expect(isYtdPeriod(opts, '2099')).toBe(false);
    expect(isYtdPeriod(opts, null)).toBe(false);
  });
});
