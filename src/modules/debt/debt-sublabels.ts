// src/modules/debt/debt-sublabels.ts
//
// Sublabel builders for the two debt headlines (Overview "Total Debt", Capital › Debt "External
// Debt"). KpiStat truncates from the END, so a disclosure clause (affiliate notes excluded —
// ratified 2026-09-24) leads, then the basis clause (2026-09-23 review), then the metric. Shared so
// the ordering rule lives in one place and is unit-tested.
import { affiliateNotesClause, fmtPct } from '@analytics/index';
import type { DebtSummary, PortfolioKpis } from '@analytics/index';

const join = (parts: string[]): string => parts.filter((x) => x.length > 0).join(' · ');

export function overviewTotalDebtSublabel(
  k: Pick<PortfolioKpis, 'ltv' | 'affiliateDebt' | 'ltvIncomplete' | 'affiliateIncomplete'>,
): string {
  const aff = affiliateNotesClause(k.affiliateDebt.value, (k.affiliateIncomplete ?? []).map((r) => r.name));
  // Audit 2026-11-12 HIGH #2: a blank Loan Balance makes the total a lower bound and LTV incomplete.
  if ((k.ltvIncomplete ?? []).length > 0) {
    return join([aff, 'property loan balances, at least', 'LTV incomplete']);
  }
  return join([aff, 'property loan balances', `${fmtPct(k.ltv.value)} LTV`]);
}

export function externalDebtSublabel(d: Pick<DebtSummary, 'affiliateDebt'>, thirdPartyBorrowerCount: number): string {
  const n = thirdPartyBorrowerCount;
  return join([affiliateNotesClause(d.affiliateDebt), 'loan schedule', `${n} third-party borrower loan${n === 1 ? '' : 's'}`]);
}
