// server/ai/debt-basis-copy.ts
//
// AI copy for the two debt headlines (item 13, 2026-09-24). Overview Total Debt / LTV are PROPERTY
// LOAN BALANCES (Property NOI sheet); Capital › Debt External Debt is the LOAN SCHEDULE (third-party
// borrower loans). Both exclude Oxford-affiliate notes (src/analytics/debt-basis.ts). One basis per
// sentence, and any live debt-basis data-quality flag is surfaced rather than papered over.
import type { DataQualityFlag } from '../../src/contracts/index';
import type { DebtSummary, PortfolioKpis } from '../../src/analytics/types';
import { DEBT_BASIS_FIELD, isDebtBasisFlag } from '../../src/analytics/debt-basis';
import { fmtPct, fmtUsdCompact } from '../../src/analytics/format';

export const TOTAL_DEBT_BASIS = 'Σ investment-property loan balances (Property NOI sheet); Oxford-affiliate notes excluded';
export const EXTERNAL_DEBT_BASIS = 'Σ third-party borrower loans (loan schedule); Oxford-affiliate notes excluded';

export function debtBasisIssues(flags: readonly DataQualityFlag[]): string[] {
  return flags.filter(isDebtBasisFlag).map((f) => f.issue);
}

export function externalDebtSentence(d: DebtSummary): string {
  const rate = d.weightedAvgRate !== null ? fmtPct(d.weightedAvgRate, 2) : '—';
  const aff = d.affiliateDebt > 0 ? ` Oxford-affiliate notes of ${fmtUsdCompact(d.affiliateDebt)} are excluded.` : '';
  return `External debt ${fmtUsdCompact(d.externalDebt)} at ${rate} weighted (loan schedule, third-party borrower loans).${aff}`;
}

export function portfolioLtvSentence(k: PortfolioKpis): string {
  const aff = k.affiliateDebt.value ? `; ${fmtUsdCompact(k.affiliateDebt.value)} of affiliate notes excluded` : '';
  return `Portfolio LTV ${fmtPct(k.ltv.value)} (property loan balances ${fmtUsdCompact(k.totalDebt.value)} ÷ investment value${aff}).`;
}

/**
 * checkDebtBasis (server/reconcile-runtime.ts) emits per-row flags (`debt.basis.property.<id>`,
 * `debt.basis.loan.<id>`) and aggregate ones (`debt.basis`, `debt.basis.affiliate`). On live data the
 * only flag is the affiliate aggregate ($1.10M property rows vs $385K loan schedule) — calling that
 * "1 row" would misstate it, so rows and aggregate totals are counted separately.
 */
export function debtBasisNote(flags: readonly DataQualityFlag[]): string | null {
  const all = flags.filter(isDebtBasisFlag);
  if (all.length === 0) return null;
  const rows = all.filter((f) => f.field.startsWith(`${DEBT_BASIS_FIELD}.property.`) || f.field.startsWith(`${DEBT_BASIS_FIELD}.loan.`)).length;
  const agg = all.length - rows;
  const parts: string[] = [];
  if (rows > 0) parts.push(`${rows} row${rows === 1 ? '' : 's'}`);
  if (agg > 0) parts.push(`${agg} aggregate total${agg === 1 ? '' : 's'}`);
  return `Basis note: the loan schedule and the property loan balances disagree on ${parts.join(' and ')} — see System Health › Reconciliation.`;
}
