// src/analytics/expense-trends.ts — monthly operating-expense trend engine (Portfolio Trends Wave 3B).
// Pure functions over ExpenseMonthPoint rows. No DB, no I/O, no Date.now. Read-only reporting:
// not consumed by any scoring, verdict or capital-allocation path.
import type { ExpenseMonthPoint } from '@contracts/expenses-monthly';
import { addMonths, monthRange, type MonthKey } from './portfolio-trends';

export interface ExpenseMonthTotal {
  month: MonthKey;
  total: number;
  byCategory: Record<string, number>;
}

export interface PropertyExpenseSeries {
  propertyId: string;
  basis: 'cash' | 'accrual';
  months: ExpenseMonthTotal[];
}

export interface PortfolioExpenseSeries {
  /** Sums over the supplied properties, per month, ascending. */
  months: ExpenseMonthTotal[];
  /** Property counts per basis present in the sum. */
  basisMix: { cash: number; accrual: number };
  /** cash > 0 && accrual > 0. */
  mixedBasis: boolean;
  /** Property ids dropped because of mixed basis (only with opts.skipMixedBasis). */
  excluded: string[];
}

export interface ExpenseMover {
  propertyId: string;
  category: string;
  month: MonthKey;
  amount: number;
  baseline: number;
  delta: number;
  deltaPct: number | null;
}

const TRAILING_WINDOW = 12;

function aggregate(points: ExpenseMonthPoint[]): ExpenseMonthTotal[] {
  const byMonth = new Map<MonthKey, ExpenseMonthTotal>();
  for (const p of points) {
    let row = byMonth.get(p.month);
    if (!row) {
      row = { month: p.month, total: 0, byCategory: {} };
      byMonth.set(p.month, row);
    }
    row.total += p.amount;
    row.byCategory[p.category] = (row.byCategory[p.category] ?? 0) + p.amount;
  }
  return [...byMonth.values()].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
}

export class MixedBasisError extends Error {
  constructor(readonly propertyId: string) {
    super(`mixed basis within property ${propertyId}`);
    this.name = 'MixedBasisError';
  }
}

/** The single basis of one property's points; throws MixedBasisError if both bases are present. */
function singleBasis(own: ExpenseMonthPoint[], propertyId: string): 'cash' | 'accrual' {
  const bases = new Set(own.map((p) => p.basis));
  if (bases.size > 1) throw new MixedBasisError(propertyId);
  return own[0]!.basis;
}

export function buildPropertySeries(points: ExpenseMonthPoint[], propertyId: string): PropertyExpenseSeries | null {
  const own = points.filter((p) => p.propertyId === propertyId);
  if (own.length === 0) return null;
  return { propertyId, basis: singleBasis(own, propertyId), months: aggregate(own) };
}

export function buildPortfolioSeries(
  points: ExpenseMonthPoint[],
  propertyIds: readonly string[],
  opts?: { skipMixedBasis?: boolean },
): PortfolioExpenseSeries {
  const basisMix = { cash: 0, accrual: 0 };
  const excluded: string[] = [];
  const included: ExpenseMonthPoint[] = [];
  for (const id of new Set(propertyIds)) {
    let series: PropertyExpenseSeries | null;
    try {
      series = buildPropertySeries(points, id);
    } catch (err) {
      if (opts?.skipMixedBasis && err instanceof MixedBasisError) {
        excluded.push(id);
        continue;
      }
      throw err;
    }
    if (!series) continue;
    basisMix[series.basis] += 1;
    for (const p of points) if (p.propertyId === id) included.push(p);
  }
  return {
    months: aggregate(included),
    basisMix,
    mixedBasis: basisMix.cash > 0 && basisMix.accrual > 0,
    excluded,
  };
}

/** Mean of the `window` months BEFORE endMonth; null unless every one of them is present. */
export function trailingAverage(series: ExpenseMonthTotal[], endMonth: MonthKey, window: number): number | null {
  if (!Number.isInteger(window) || window < 1) return null;
  const byMonth = new Map(series.map((s) => [s.month, s.total]));
  let sum = 0;
  for (const m of monthRange(addMonths(endMonth, -window), addMonths(endMonth, -1))) {
    const v = byMonth.get(m);
    if (v === undefined) return null;
    sum += v;
  }
  return sum / window;
}

function delta(amount: number, baseline: number): { delta: number; deltaPct: number | null } {
  return { delta: amount - baseline, deltaPct: baseline === 0 ? null : (amount - baseline) / baseline };
}

export function varianceVsTrailing(
  series: ExpenseMonthTotal[],
  month: MonthKey,
  window: number = TRAILING_WINDOW,
): { amount: number; baseline: number; delta: number; deltaPct: number | null } | null {
  const row = series.find((s) => s.month === month);
  if (!row) return null;
  const baseline = trailingAverage(series, month, window);
  if (baseline === null) return null;
  return { amount: row.total, baseline, ...delta(row.total, baseline) };
}

export function topMovers(
  points: ExpenseMonthPoint[],
  propertyIds: readonly string[],
  month: MonthKey,
  limit = 5,
): ExpenseMover[] {
  const movers: ExpenseMover[] = [];
  for (const propertyId of new Set(propertyIds)) {
    const own = points.filter((p) => p.propertyId === propertyId);
    if (own.length === 0) continue;
    try {
      singleBasis(own, propertyId);
    } catch (err) {
      if (err instanceof MixedBasisError) continue; // shown as unavailable; never summed across bases
      throw err;
    }
    const categories = new Set(own.filter((p) => p.month === month).map((p) => p.category));
    for (const category of categories) {
      const catSeries = aggregate(own.filter((p) => p.category === category));
      const v = varianceVsTrailing(catSeries, month, TRAILING_WINDOW);
      if (!v) continue;
      movers.push({ propertyId, category, month, ...v });
    }
  }
  movers.sort(
    (a, b) =>
      Math.abs(b.delta) - Math.abs(a.delta) ||
      (a.propertyId < b.propertyId ? -1 : a.propertyId > b.propertyId ? 1 : 0) ||
      (a.category < b.category ? -1 : a.category > b.category ? 1 : 0),
  );
  return movers.slice(0, Math.max(0, limit));
}

export function sameMonthLastYear(series: ExpenseMonthTotal[], month: MonthKey): ExpenseMonthTotal | null {
  const target = addMonths(month, -12);
  return series.find((s) => s.month === target) ?? null;
}
