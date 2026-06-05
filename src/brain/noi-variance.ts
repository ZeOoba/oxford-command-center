import type { PortfolioSnapshot } from '../contracts/index';

export interface NoiVarianceRow {
  propertyId: string;
  name: string;
  budget: number | null;
  actual: number | null; // QB annual NOI
  variance: number | null; // actual − budget
  variancePct: number | null; // variance / budget
  belowBudget: boolean;
}

export interface NoiVarianceSummary {
  rows: NoiVarianceRow[];
  totalBudget: number;
  totalActual: number;
  totalVariance: number;
  belowBudgetCount: number;
  expenseRatio: number | null; // Σ expense / Σ income (QB)
  hasActuals: boolean;
}

export function noiVariance(s: PortfolioSnapshot): NoiVarianceSummary {
  const qbByProp = new Map<string, { noi: number; income: number; expense: number }>();
  let totalIncome = 0;
  let totalExpense = 0;
  for (const p of s.quickbooks?.properties ?? []) {
    if (p.propertyId) qbByProp.set(p.propertyId, { noi: p.annualNoi, income: p.annualIncome, expense: p.annualExpense });
    totalIncome += p.annualIncome;
    totalExpense += p.annualExpense;
  }

  const rows: NoiVarianceRow[] = s.properties.map((p) => {
    const budgetRaw = s.noiBudgets[p.id];
    const budget = typeof budgetRaw === 'number' ? budgetRaw : null;
    const qb = qbByProp.get(p.id);
    const actual = qb ? qb.noi : null;
    const variance = budget !== null && actual !== null ? actual - budget : null;
    const variancePct = variance !== null && budget ? variance / budget : null;
    return { propertyId: p.id, name: p.name, budget, actual, variance, variancePct, belowBudget: variance !== null && variance < 0 };
  });

  const totalBudget = rows.reduce((n, r) => n + (r.budget ?? 0), 0);
  const totalActual = rows.reduce((n, r) => n + (r.actual ?? 0), 0);
  return {
    rows,
    totalBudget,
    totalActual,
    totalVariance: totalActual - totalBudget,
    belowBudgetCount: rows.filter((r) => r.belowBudget).length,
    expenseRatio: totalIncome > 0 ? totalExpense / totalIncome : null,
    hasActuals: qbByProp.size > 0 || (s.quickbooks?.properties.length ?? 0) > 0,
  };
}
