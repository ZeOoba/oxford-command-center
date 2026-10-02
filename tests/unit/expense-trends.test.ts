import { describe, expect, it } from 'vitest';
import type { ExpenseMonthPoint } from '@contracts/expenses-monthly';
import { monthRange } from '../../src/analytics/portfolio-trends';
import {
  MixedBasisError,
  buildPortfolioSeries,
  buildPropertySeries,
  sameMonthLastYear,
  topMovers,
  trailingAverage,
  varianceVsTrailing,
} from '../../src/analytics/expense-trends';

const pt = (propertyId: string, month: string, category: string, amount: number, basis: 'cash' | 'accrual'): ExpenseMonthPoint => ({
  propertyId, month, category, amount, basis, sourceSystem: 'quickbooks',
});

// A: cash, 2025-01..2026-02 (14 months). Utilities 100 (160 in 2026-02), Insurance 50.
const aPoints = (): ExpenseMonthPoint[] =>
  monthRange('2025-01', '2026-02').flatMap((m) => [
    pt('A', m, 'Utilities', m === '2026-02' ? 160 : 100, 'cash'),
    pt('A', m, 'Insurance', 50, 'cash'),
  ]);
// B: accrual, 2026-01..2026-02, Utilities 40.
const bPoints = (): ExpenseMonthPoint[] =>
  monthRange('2026-01', '2026-02').map((m) => pt('B', m, 'Utilities', 40, 'accrual'));
const fixture = (): ExpenseMonthPoint[] => [...aPoints(), ...bPoints()];

const a = () => buildPropertySeries(fixture(), 'A')!.months;

const mixedM = (): ExpenseMonthPoint[] => [
  pt('M', '2026-01', 'Utilities', 10, 'cash'),
  pt('M', '2026-02', 'Utilities', 10, 'accrual'),
];

describe('buildPropertySeries', () => {
  it('(a) totals and categories per month, ascending', () => {
    const s = buildPropertySeries(fixture(), 'A')!;
    expect(s.basis).toBe('cash');
    expect(s.months).toHaveLength(14);
    expect(s.months[0]!.month).toBe('2025-01');
    const feb = s.months.find((m) => m.month === '2026-02')!;
    expect(feb.total).toBe(210);
    expect(feb.byCategory).toEqual({ Utilities: 160, Insurance: 50 });
  });
  it('returns null for a property with no points', () => {
    expect(buildPropertySeries(fixture(), 'Z')).toBeNull();
  });
  it('(h) throws on mixed basis within one property', () => {
    expect(() => buildPropertySeries(mixedM(), 'M')).toThrow('mixed basis within property M');
  });
  it('includes negative amounts as-is and sums duplicate rows', () => {
    const pts = [pt('A', '2026-01', 'Utilities', 100, 'cash'), pt('A', '2026-01', 'Utilities', -30, 'cash')];
    expect(buildPropertySeries(pts, 'A')!.months[0]!.total).toBe(70);
  });
});

describe('buildPortfolioSeries', () => {
  it('(b) sums properties and flags mixed basis', () => {
    const p = buildPortfolioSeries(fixture(), ['A', 'B']);
    const feb = p.months.find((m) => m.month === '2026-02')!;
    expect(feb.total).toBe(250); // 210 + 40
    expect(feb.byCategory).toEqual({ Utilities: 200, Insurance: 50 });
    const jan = p.months.find((m) => m.month === '2026-01')!;
    expect(jan.total).toBe(190); // 150 + 40
    expect(p.months[0]!.month).toBe('2025-01');
    expect(p.months[0]!.total).toBe(150); // A only
    expect(p.basisMix).toEqual({ cash: 1, accrual: 1 });
    expect(p.mixedBasis).toBe(true);
    expect(p.excluded).toEqual([]);
  });
  it('(b) single property is not mixed', () => {
    const p = buildPortfolioSeries(fixture(), ['A']);
    expect(p.basisMix).toEqual({ cash: 1, accrual: 0 });
    expect(p.mixedBasis).toBe(false);
  });
  it('(g) points for ids outside propertyIds are ignored', () => {
    const base = buildPortfolioSeries(fixture(), ['A', 'B']);
    const withC = buildPortfolioSeries([...fixture(), pt('C', '2026-02', 'Utilities', 999, 'cash')], ['A', 'B']);
    expect(withC).toEqual(base);
  });
  it('(h) propagates mixed-basis error by default', () => {
    expect(() => buildPortfolioSeries([...aPoints(), ...mixedM()], ['A', 'M'])).toThrow('mixed basis within property M');
  });
  it('(h) skipMixedBasis excludes the property and reports it', () => {
    const p = buildPortfolioSeries([...aPoints(), ...mixedM()], ['A', 'M'], { skipMixedBasis: true });
    expect(p.excluded).toEqual(['M']);
    expect(p.basisMix).toEqual({ cash: 1, accrual: 0 });
    expect(p.months.find((m) => m.month === '2026-02')!.total).toBe(210);
  });
  it('(i) empty input', () => {
    const p = buildPortfolioSeries([], ['A']);
    expect(p).toEqual({ months: [], basisMix: { cash: 0, accrual: 0 }, mixedBasis: false, excluded: [] });
  });
});

describe('trailingAverage', () => {
  it('(c) mean of the 12 months before endMonth', () => {
    expect(trailingAverage(a(), '2026-02', 12)).toBe(150); // 2025-02..2026-01, each 100+50
  });
  it('(c) window 13 uses 2025-01..2026-01 (all present) = 150; window 14 lacks 2024-12 -> null', () => {
    expect(trailingAverage(a(), '2026-02', 13)).toBe(150);
    expect(trailingAverage(a(), '2026-02', 14)).toBeNull();
  });
  it('(c) null when a month inside the window is missing', () => {
    const gap = a().filter((m) => m.month !== '2025-08');
    expect(trailingAverage(gap, '2026-02', 12)).toBeNull();
  });
  it('excludes endMonth itself', () => {
    expect(trailingAverage(a(), '2026-02', 1)).toBe(150); // 2026-01
    expect(trailingAverage(a(), '2026-03', 1)).toBe(210); // 2026-02
  });
});

describe('varianceVsTrailing', () => {
  it('(d) 210 vs 150 -> delta 60, 40%', () => {
    expect(varianceVsTrailing(a(), '2026-02')).toEqual({ amount: 210, baseline: 150, delta: 60, deltaPct: 0.4 });
  });
  it('(d) zero baseline -> deltaPct null', () => {
    const pts = [
      ...monthRange('2025-01', '2025-12').map((m) => pt('Z', m, 'Utilities', 0, 'cash')),
      pt('Z', '2026-01', 'Utilities', 50, 'cash'),
    ];
    const z = buildPropertySeries(pts, 'Z')!.months;
    expect(varianceVsTrailing(z, '2026-01')).toEqual({ amount: 50, baseline: 0, delta: 50, deltaPct: null });
  });
  it('null when month missing or window incomplete', () => {
    expect(varianceVsTrailing(a(), '2027-01')).toBeNull();
    expect(varianceVsTrailing(a(), '2025-06')).toBeNull();
  });
  it('honors a custom window', () => {
    // 3 months before 2026-02: 2025-11..2026-01 = 150 each
    expect(varianceVsTrailing(a(), '2026-02', 3)).toEqual({ amount: 210, baseline: 150, delta: 60, deltaPct: 0.4 });
  });
});

describe('topMovers', () => {
  it('(e) A/Utilities first (delta 60); B excluded (<12 prior months)', () => {
    const m = topMovers(fixture(), ['A', 'B'], '2026-02');
    expect(m[0]).toEqual({ propertyId: 'A', category: 'Utilities', month: '2026-02', amount: 160, baseline: 100, delta: 60, deltaPct: 0.6 });
    expect(m.map((x) => x.propertyId)).not.toContain('B');
    expect(m[1]).toEqual({ propertyId: 'A', category: 'Insurance', month: '2026-02', amount: 50, baseline: 50, delta: 0, deltaPct: 0 });
    expect(m).toHaveLength(2);
  });
  it('respects limit and sorts by |delta| desc including negatives', () => {
    const pts = [
      ...aPoints().filter((p) => p.month !== '2026-02'),
      pt('A', '2026-02', 'Utilities', 10, 'cash'), // delta -90
      pt('A', '2026-02', 'Insurance', 80, 'cash'), // delta +30
    ];
    const m = topMovers(pts, ['A'], '2026-02', 1);
    expect(m).toHaveLength(1);
    expect(m[0]!.category).toBe('Utilities');
    expect(m[0]!.delta).toBe(-90);
    expect(m[0]!.deltaPct).toBe(-0.9);
  });
  it('ties break on propertyId then category ascending', () => {
    const mk = (id: string) =>
      monthRange('2025-01', '2026-02').flatMap((mo) => [
        pt(id, mo, 'Zeta', mo === '2026-02' ? 150 : 100, 'cash'),
        pt(id, mo, 'Alpha', mo === '2026-02' ? 150 : 100, 'cash'),
      ]);
    const m = topMovers([...mk('B'), ...mk('A')], ['A', 'B'], '2026-02');
    expect(m.map((x) => `${x.propertyId}/${x.category}`)).toEqual(['A/Alpha', 'A/Zeta', 'B/Alpha', 'B/Zeta']);
  });
  it('(g) ignores properties not in propertyIds', () => {
    const cPts = monthRange('2025-01', '2026-02').map((mo) => pt('C', mo, 'Utilities', mo === '2026-02' ? 9999 : 1, 'cash'));
    expect(topMovers([...fixture(), ...cPts], ['A', 'B'], '2026-02')).toEqual(topMovers(fixture(), ['A', 'B'], '2026-02'));
  });
  it('(i) empty input', () => {
    expect(topMovers([], ['A'], '2026-02')).toEqual([]);
  });
});

describe('sameMonthLastYear', () => {
  it('(f) returns the 2025-02 total (150)', () => {
    const r = sameMonthLastYear(a(), '2026-02')!;
    expect(r.month).toBe('2025-02');
    expect(r.total).toBe(150);
  });
  it('(f) null when absent', () => {
    expect(sameMonthLastYear(a(), '2025-06')).toBeNull();
  });
});

describe('topMovers mixed basis', () => {
  // M: would be the top mover (delta 900) but carries both bases in one month.
  const mRows = (): ExpenseMonthPoint[] => [
    ...monthRange('2025-01', '2026-01').map((mo) => pt('M', mo, 'Utilities', 100, 'cash')),
    pt('M', '2026-02', 'Utilities', 1000, 'accrual'),
  ];
  it('excludes a mixed-basis property without throwing; clean property still appears', () => {
    const m = topMovers([...fixture(), ...mRows()], ['A', 'B', 'M'], '2026-02');
    expect(m.map((x) => x.propertyId)).not.toContain('M');
    expect(m[0]).toMatchObject({ propertyId: 'A', category: 'Utilities', delta: 60 });
  });
  it('clean-property result is identical with and without the mixed property rows', () => {
    expect(topMovers([...fixture(), ...mRows()], ['A', 'B', 'M'], '2026-02')).toEqual(
      topMovers(fixture(), ['A', 'B'], '2026-02'),
    );
  });
});

describe('MixedBasisError', () => {
  it('is thrown by buildPropertySeries with the property id', () => {
    try {
      buildPropertySeries(mixedM(), 'M');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(MixedBasisError);
      expect((e as MixedBasisError).propertyId).toBe('M');
    }
  });
  it('skipMixedBasis does not swallow other errors', () => {
    const bad = { propertyId: 'X', month: '2026-01', category: 'U', amount: 1, sourceSystem: 'unknown' } as unknown as ExpenseMonthPoint;
    Object.defineProperty(bad, 'basis', { get() { throw new TypeError('boom'); } });
    expect(() => buildPortfolioSeries([bad], ['X'], { skipMixedBasis: true })).toThrow('boom');
  });
});

describe('January wrap', () => {
  // 2025-01..2026-01, total 10 in 2025-01..2025-12 and 99 in 2026-01
  const pts = monthRange('2025-01', '2026-01').map((mo) => pt('W', mo, 'U', mo === '2026-01' ? 99 : 10, 'cash'));
  const w = () => buildPropertySeries(pts, 'W')!.months;
  it('sameMonthLastYear 2026-01 -> 2025-01 total (10)', () => {
    const r = sameMonthLastYear(w(), '2026-01')!;
    expect(r.month).toBe('2025-01');
    expect(r.total).toBe(10);
  });
  it('trailingAverage at 2026-01 window 12 uses 2025-01..2025-12 (mean 10)', () => {
    expect(trailingAverage(w(), '2026-01', 12)).toBe(10);
    expect(varianceVsTrailing(w(), '2026-01')).toEqual({ amount: 99, baseline: 10, delta: 89, deltaPct: 8.9 });
  });
});
