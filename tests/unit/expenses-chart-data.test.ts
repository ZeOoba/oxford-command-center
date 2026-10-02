import { describe, expect, it } from 'vitest';
import type { ExpenseMonthPoint } from '@contracts/expenses-monthly';
import { monthRange } from '../../src/analytics/portfolio-trends';
import { type ExpenseMover, type ExpenseMonthTotal } from '../../src/analytics/expense-trends';
import { EXPENSES_MONTHLY_KEY } from '../../src/modules/portfolio/expenses-hooks';
import { completeMonthTotals } from '../../src/modules/portfolio/expenses-chart-data';
import {
  heatmapCells,
  heatmapColLabels,
  monthInitial,
  monthLabel,
  moverLines,
  overlayLastYear,
  stackedExpenseData,
  topCategories,
  unavailablePropertyIds,
} from '../../src/modules/portfolio/expenses-chart-data';

const MONTHS = monthRange('2025-09', '2026-10'); // 14 months

const BASE: Record<string, number> = {
  Taxes: 100,
  Insurance: 80,
  Utilities: 50,
  Repairs: 50,
  Admin: 10,
  Landscaping: 10,
  Snow: 10,
};

function pt(
  propertyId: string,
  month: string,
  category: string,
  amount: number,
  basis: 'cash' | 'accrual' = 'accrual',
): ExpenseMonthPoint {
  return { propertyId, month, category, amount, basis, sourceSystem: 'quickbooks' };
}

/** Property A: 7 categories x 14 months. Snow spikes to 1000 in 2025-09 (outside trailing-12 ending
 *  2026-10); Taxes spikes to 160 in 2026-10. Per-month total = 310 (370 in 2026-10). */
function propertyA(): ExpenseMonthPoint[] {
  const out: ExpenseMonthPoint[] = [];
  for (const m of MONTHS) {
    for (const [cat, base] of Object.entries(BASE)) {
      let amt = base;
      if (cat === 'Snow' && m === '2025-09') amt = 1000;
      if (cat === 'Taxes' && m === '2026-10') amt = 160;
      out.push(pt('A', m, cat, amt));
    }
  }
  return out;
}

const mixedB = [
  pt('B', '2026-09', 'Taxes', 5, 'cash'),
  pt('B', '2026-10', 'Taxes', 5, 'accrual'),
  pt('B', '2026-10', 'Zeta', 9999, 'accrual'),
];
// Property C: zero baseline -> deltaPct null.
const zeroC = monthRange('2025-10', '2026-10').map((m) => pt('C', m, 'Admin', 0));
const POINTS = [...propertyA(), ...mixedB, ...zeroC];

describe('EXPENSES_MONTHLY_KEY', () => {
  it('is rooted at warehouse/analytics/expenses/monthly', () => {
    expect([...EXPENSES_MONTHLY_KEY]).toEqual(['warehouse', 'analytics', 'expenses', 'monthly']);
  });
});

describe('monthLabel / monthInitial / heatmapColLabels', () => {
  it('labels all 12 months', () => {
    const abbr = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const init = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
    abbr.forEach((a, i) => {
      const key = `2026-${String(i + 1).padStart(2, '0')}`;
      expect(monthLabel(key)).toBe(`${a} '26`);
      expect(monthInitial(key)).toBe(init[i]);
    });
    expect(monthLabel('2025-12')).toBe("Dec '25");
  });
  it('heatmapColLabels is 3-letter abbreviations', () => {
    expect(heatmapColLabels(['2026-09', '2026-10'])).toEqual(['Sep', 'Oct']);
  });
});

describe('topCategories', () => {
  it('ranks by trailing-12 total, ties by name asc, cut at n (7 cats -> 5), ignores months outside window', () => {
    // trailing-12 = 2025-11..2026-10. Taxes 11*100+160=1260; Insurance 960; Repairs 600; Utilities 600;
    // Admin/Landscaping/Snow 120 each (Snow's 1000 in 2025-09 is outside the window).
    // Ties: Repairs < Utilities; 5th slot among 3-way tie = Admin.
    expect(topCategories(POINTS, ['A'])).toEqual(['Taxes', 'Insurance', 'Repairs', 'Utilities', 'Admin']);
  });
  it('honours n and is deterministic', () => {
    expect(topCategories(POINTS, ['A'], 2)).toEqual(['Taxes', 'Insurance']);
    expect(topCategories([...POINTS].reverse(), ['A'])).toEqual(topCategories(POINTS, ['A']));
  });
  it('returns fewer than n when fewer categories exist, and [] for no points', () => {
    expect(topCategories(zeroC, ['C'])).toEqual(['Admin']);
    expect(topCategories(POINTS, ['nope'])).toEqual([]);
  });
  it('window ends at the latest month present for the supplied ids', () => {
    // A only through 2026-08: window 2025-09..2026-08, so Taxes 1200, Snow 1000+11*10 = 1110, Insurance 960, Repairs 600, Utilities 600.
    const trimmed = propertyA().filter((p) => p.month <= '2026-08');
    expect(topCategories(trimmed, ['A'])).toEqual(['Taxes', 'Snow', 'Insurance', 'Repairs', 'Utilities']);
  });
});

describe('topCategories mixed-basis exclusion', () => {
  it('ignores mixed-basis properties: a category only in the mixed property never ranks; clean ranking unchanged', () => {
    const withB = topCategories(POINTS, ['A', 'B'], 8);
    expect(withB).not.toContain('Zeta');
    expect(withB).toEqual(topCategories(POINTS, ['A'], 8));
    expect(topCategories(POINTS, ['B'])).toEqual([]);
  });
});

describe('unavailablePropertyIds', () => {
  it('returns only mixed-basis ids, sorted; unloaded ids are not reported; empty input -> []', () => {
    const extra = [pt('A0', '2026-10', 'Taxes', 1, 'cash'), pt('A0', '2026-09', 'Taxes', 1, 'accrual')];
    expect(unavailablePropertyIds([...POINTS, ...extra], ['C', 'B', 'A', 'Z', 'A0'])).toEqual(['A0', 'B']);
    expect(unavailablePropertyIds(POINTS, ['A', 'C', 'Z'])).toEqual([]);
    expect(unavailablePropertyIds([], [])).toEqual([]);
    expect(unavailablePropertyIds(POINTS, [])).toEqual([]);
  });
});

describe('stackedExpenseData', () => {
  const series: ExpenseMonthTotal[] = [
    { month: '2026-09', total: 60, byCategory: { Taxes: 30, Insurance: 20, Snow: 6, Admin: 4 } },
    { month: '2026-10', total: 0, byCategory: {} },
    { month: '2026-11', total: 40, byCategory: { Insurance: 40 } },
  ];
  it('orders segments by keys and folds the rest into Other when keys has Other', () => {
    const d = stackedExpenseData(series, ['Taxes', 'Insurance', 'Other']);
    expect(d[0]).toEqual({
      label: "Sep '26",
      segments: [
        { key: 'Taxes', value: 30 },
        { key: 'Insurance', value: 20 },
        { key: 'Other', value: 10 },
      ],
    });
  });
  it('skips months with no data and drops unlisted categories when Other not in keys', () => {
    const d = stackedExpenseData(series, ['Insurance', 'Taxes']);
    expect(d.map((x) => x.label)).toEqual(["Sep '26", "Nov '26"]);
    expect(d[0]!.segments).toEqual([
      { key: 'Insurance', value: 20 },
      { key: 'Taxes', value: 30 },
    ]);
    expect(d[1]!.segments).toEqual([
      { key: 'Insurance', value: 40 },
      { key: 'Taxes', value: 0 },
    ]);
  });
  it('a real category named Other merges into the folded Other segment', () => {
    const row: ExpenseMonthTotal = { month: '2026-09', total: 40, byCategory: { Taxes: 30, Other: 7, Snow: 3 } };
    expect(stackedExpenseData([row], ['Taxes', 'Other'])[0]!.segments).toEqual([
      { key: 'Taxes', value: 30 },
      { key: 'Other', value: 10 },
    ]);
  });
  it('Other segment is 0 (kept) when nothing folds', () => {
    const d = stackedExpenseData([series[2]!], ['Insurance', 'Other']);
    expect(d[0]!.segments).toEqual([
      { key: 'Insurance', value: 40 },
      { key: 'Other', value: 0 },
    ]);
  });
});

describe('overlayLastYear', () => {
  const series: ExpenseMonthTotal[] = [
    { month: '2025-10', total: 300, byCategory: { Taxes: 300 } },
    { month: '2026-09', total: 310, byCategory: { Taxes: 310 } },
    { month: '2026-10', total: 370, byCategory: { Taxes: 370 } },
  ];
  it('returns same-month-last-year totals labelled by the displayed month; omits months with no prior year', () => {
    expect(overlayLastYear(series, ['2026-09', '2026-10'])).toEqual([{ label: "Oct '26", value: 300 }]);
  });
  it('crosses the year boundary (2026-01 -> 2025-01)', () => {
    const s2: ExpenseMonthTotal[] = [{ month: '2025-01', total: 5, byCategory: { X: 5 } }];
    expect(overlayLastYear(s2, ['2026-01'])).toEqual([{ label: "Jan '26", value: 5 }]);
  });
  it('omits a prior-year month with an empty byCategory (no data is not a 0 overlay)', () => {
    const s3: ExpenseMonthTotal[] = [
      { month: '2025-10', total: 0, byCategory: {} },
      { month: '2025-11', total: 0, byCategory: { X: 0 } },
    ];
    expect(overlayLastYear(s3, ['2026-10', '2026-11'])).toEqual([{ label: "Nov '26", value: 0 }]);
  });
});

describe('heatmapCells', () => {
  it('computes deltaPct vs trailing 12, nulls for unavailable/zero baseline, skips mixed-basis and unloaded', () => {
    const cells = heatmapCells(POINTS, ['A', 'B', 'C', 'Z'], ['2025-12', '2026-10']);
    // A 2025-12: only 3 prior months -> null. A 2026-10: (370-310)/310.
    // C 2025-12: no 12 prior months -> null; C 2026-10: baseline 0 -> deltaPct null -> null.
    expect(cells.map((c) => [c.row, c.col])).toEqual([
      ['A', '2025-12'],
      ['A', '2026-10'],
      ['C', '2025-12'],
      ['C', '2026-10'],
    ]);
    expect(cells[0]!.value).toBeNull();
    expect(cells[1]!.value).toBeCloseTo(60 / 310, 10);
    expect(cells[2]!.value).toBeNull();
    expect(cells[3]!.value).toBeNull();
  });
  it('honours the window argument', () => {
    // window 3 for A at 2025-12: baseline months 2025-09..2025-11 = (1300+310+310)/3; amount 310.
    const cells = heatmapCells(POINTS, ['A'], ['2025-12'], 3);
    const baseline = (1300 + 310 + 310) / 3; // 2025-09 total: Snow 1000 replaces 10 -> 1300
    expect(cells[0]!.value).toBeCloseTo((310 - baseline) / baseline, 10);
  });
});

describe('moverLines', () => {
  const mk = (o: Partial<ExpenseMover>): ExpenseMover => ({
    propertyId: 'p1',
    category: 'Utilities',
    month: '2026-10',
    amount: 210,
    baseline: 150,
    delta: 60,
    deltaPct: 0.4,
    ...o,
  });
  it('formats a positive delta with plus signs and one-decimal percent', () => {
    expect(moverLines([mk({})], { p1: '1100 Rarig' })).toEqual(['Utilities at 1100 Rarig +$60 (+40.0%) vs trailing 12 mo']);
  });
  it('uses a true minus (U+2212) for negative delta and no plus', () => {
    const [s] = moverLines([mk({ delta: -1234, deltaPct: -0.125 })], { p1: '1100 Rarig' });
    expect(s).toBe('Utilities at 1100 Rarig −$1,234 (−12.5%) vs trailing 12 mo');
  });
  it('signs the rounded value: no +$0 / −$0 / −0.0%', () => {
    expect(moverLines([mk({ delta: 0.4, deltaPct: 0.0004 })], { p1: 'R' })).toEqual(['Utilities at R $0 (0.0%) vs trailing 12 mo']);
    expect(moverLines([mk({ delta: -0.2, deltaPct: -0.0004 })], { p1: 'R' })).toEqual(['Utilities at R $0 (0.0%) vs trailing 12 mo']);
    expect(moverLines([mk({ delta: 60, deltaPct: 0.0004 })], { p1: 'R' })).toEqual(['Utilities at R +$60 (0.0%) vs trailing 12 mo']);
  });
  it('omits the percentage when deltaPct is null', () => {
    expect(moverLines([mk({ category: 'Insurance', delta: 75, deltaPct: null })], { p1: 'Rarig' })).toEqual([
      'Insurance at Rarig +$75 vs trailing 12 mo',
    ]);
  });
  it('falls back to the property id when the name is unknown, and preserves order', () => {
    const out = moverLines([mk({ propertyId: 'zzz' }), mk({ propertyId: 'p1', delta: 5, deltaPct: 0.05 })], { p1: 'Rarig' });
    expect(out).toEqual(['Utilities at zzz +$60 (+40.0%) vs trailing 12 mo', 'Utilities at Rarig +$5 (+5.0%) vs trailing 12 mo']);
  });
});

describe('completeMonthTotals', () => {
  const p = (propertyId: string, month: string, amount: number): ExpenseMonthPoint => ({ propertyId, month, category: 'Taxes', amount, basis: 'cash', sourceSystem: 'quickbooks' });
  it('sums only months in which every id has data', () => {
    const pts = [p('a', '2026-08', 10), p('a', '2026-09', 10), p('b', '2026-09', 5), p('c', '2026-09', 99)];
    const m = completeMonthTotals(pts, ['a', 'b'], ['2026-08', '2026-09', '2026-10']);
    expect([...m.entries()]).toEqual([['2026-09', 15]]);
  });
});

describe('stackedExpenseData otherKey', () => {
  it('folds unlisted categories into the supplied bucket key, leaving a real "Other" series untouched', async () => {
    const { stackedExpenseData } = await import('../../src/modules/portfolio/expenses-chart-data');
    const row: ExpenseMonthTotal = { month: '2026-09', total: 1550, byCategory: { Other: 500, Taxes: 450, Snow: 400, Repairs: 200 } };
    const out = stackedExpenseData([row], ['Other', 'Taxes', 'Other (rest)'], 'Other (rest)');
    expect(out[0]!.segments).toEqual([{ key: 'Other', value: 500 }, { key: 'Taxes', value: 450 }, { key: 'Other (rest)', value: 600 }]);
    expect(out[0]!.segments.reduce((a, s) => a + s.value, 0)).toBe(1550);
  });
});
