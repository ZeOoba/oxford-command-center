// src/shell/filter-slice.ts
//
// Filter-bar readout (ratified 2026-09-24): counts read "N investment · M other holding(s)" — the same
// basis as every investment KPI (isInvestmentProperty) — never a residence-inclusive "14 of 14 assets".
// Unfiltered: "13 investment · 1 other holding". Filtered: "3 of 13 investment · $0.6M NOI" (NOI over the
// matched INVESTMENT rows only), with the other-holdings clause only when a matched row is one.
import { isInvestmentProperty } from '@analytics/index';

export interface SliceRow {
  readonly type?: string | null;
  readonly noi: number;
}

export function filterSliceReadout(all: readonly SliceRow[], matched: readonly SliceRow[], isFiltered: boolean): string | undefined {
  if (all.length === 0) return undefined;
  const totalInvestment = all.filter(isInvestmentProperty).length;
  const investment = matched.filter(isInvestmentProperty);
  const other = matched.length - investment.length;
  const count =
    isFiltered && investment.length !== totalInvestment
      ? `${investment.length} of ${totalInvestment} investment`
      : `${investment.length} investment`;
  const otherClause = other > 0 ? ` · ${other} other holding${other === 1 ? '' : 's'}` : '';
  const noi = isFiltered ? ` · $${(investment.reduce((sum, p) => sum + p.noi, 0) / 1_000_000).toFixed(1)}M NOI` : '';
  return `${count}${otherClause}${noi}`;
}
