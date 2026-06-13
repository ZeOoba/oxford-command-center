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
  pickPeriodMetrics,
  recommendedAction,
  rootCauseLine,
} from '../../src/modules/intel/property-intel';
import type { NoiDecomposition, PeriodMetrics, PropertyScore } from '../../src/modules/intel/analytics-hooks';

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

const decomp = (over: Partial<NoiDecomposition>): NoiDecomposition => ({
  propertyId: 'p',
  from: '2024',
  to: '2025',
  totalDelta: 0,
  drivers: [],
  ...over,
});

describe('rootCauseLine', () => {
  it('names the largest |Δ| driver, its contribution %, the signed ΔNOI and the FY bridge', () => {
    const line = rootCauseLine(
      decomp({
        totalDelta: 50000,
        drivers: [
          { category: 'Rental Revenue', delta: 40000, contributionPct: 0.8 },
          { category: 'Taxes', delta: 10000, contributionPct: 0.2 },
        ],
      }),
    );
    expect(line).toBe('Largest driver: Rental Revenue, 80.0% of the +$50,000 change (FY2024→FY2025).');
  });

  it('uses the minus glyph for a NOI decline and picks the largest by absolute delta', () => {
    const line = rootCauseLine(
      decomp({
        from: '2023',
        to: '2024',
        totalDelta: -30000,
        drivers: [
          { category: 'Insurance', delta: -5000, contributionPct: 0.1667 },
          { category: 'Repairs & Maintenance', delta: -25000, contributionPct: 0.8333 },
        ],
      }),
    );
    expect(line).toBe('Largest driver: Repairs & Maintenance, 83.3% of the −$30,000 change (FY2023→FY2024).');
  });

  it('reports an essentially-flat year when ΔNOI ≈ 0 (null contribution)', () => {
    const line = rootCauseLine(decomp({ totalDelta: 0, drivers: [{ category: 'Taxes', delta: 0, contributionPct: null }] }));
    expect(line).toBe('NOI essentially flat FY2024→FY2025.');
  });

  it('returns null with no decomposition or no drivers (single-period property)', () => {
    expect(rootCauseLine(null)).toBeNull();
    expect(rootCauseLine(decomp({ totalDelta: 100, drivers: [] }))).toBeNull();
  });
});

const score = (capitalAction: PropertyScore['capitalAction'], reasons: string[]): PropertyScore =>
  ({
    propertyId: 'p',
    propertyName: 'P',
    period: '2025',
    health: 60,
    healthBand: 'good',
    attentionBand: 'green',
    capitalAction,
    subScores: {},
    noiPerSfQuartile: 2,
    reasons,
  }) as unknown as PropertyScore;

describe('recommendedAction', () => {
  it('maps the capital action to a verb and appends the leading reason', () => {
    expect(recommendedAction(score('disposition-candidate', ['bottom-quartile NOI/SF', 'NOI declined 12%']))).toBe(
      'Evaluate for disposition — bottom-quartile NOI/SF.',
    );
    expect(recommendedAction(score('monitor', ['elevated expense ratio']))).toBe('Monitor closely — elevated expense ratio.');
    expect(recommendedAction(score('hold', ['stable']))).toBe('Hold — stable.');
  });

  it('drops the reason clause when there are no reasons', () => {
    expect(recommendedAction(score('invest', []))).toBe('Deploy capital.');
  });
});

describe('pickPeriodMetrics', () => {
  const series = [
    pm('2023', 'year', { noi: 50 }),
    pm('2024', 'year', { noi: 60 }),
    pm('2025', 'year', { noi: 70 }),
    pm('2026', 'ytd', { noi: 30 }),
  ];

  it('returns the row matching the requested period (FY or YTD)', () => {
    expect(pickPeriodMetrics(series, '2024')?.noi).toBe(60);
    expect(pickPeriodMetrics(series, '2026')?.noi).toBe(30);
  });

  it('falls back to the latest full year for an absent or null period', () => {
    expect(pickPeriodMetrics(series, '2099')?.noi).toBe(70);
    expect(pickPeriodMetrics(series, null)?.noi).toBe(70);
  });

  it('is empty/no-full-year safe', () => {
    expect(pickPeriodMetrics([], '2024')).toBeNull();
    expect(pickPeriodMetrics([pm('2026', 'ytd', { noi: 30 })], '2099')).toBeNull();
  });
});
