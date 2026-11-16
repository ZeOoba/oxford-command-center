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

/** Names of the rows whose blank Loan Balance makes aggregate LTV incomplete (structural, never parsed
 *  from prose — a name may itself contain a dash). Empty when complete. */
export function ltvIncompleteNames(k: Pick<PortfolioKpis, 'ltvIncomplete'>): string[] {
  return (k.ltvIncomplete ?? []).map((r) => r.name);
}

/** Names of the rows whose blank NOI is left out of Σ NOI. Empty when complete. */
export function noiIncompleteNames(k: Pick<PortfolioKpis, 'noiIncomplete'>): string[] {
  return (k.noiIncomplete ?? []).map((r) => r.name);
}

/** "$X", or "$X (incomplete: excludes blank NOI on …)". No "at least": unlike a loan balance, a
 *  blank NOI may be negative (a vacant row with carrying costs), so no bound direction is claimed. */
export function portfolioNoiText(k: PortfolioKpis): string {
  const gap = noiIncompleteNames(k);
  return gap.length > 0 ? `${fmtUsdCompact(k.noi.value)} (incomplete: excludes blank NOI on ${gap.join(', ')})` : fmtUsdCompact(k.noi.value);
}

/** Names of the affiliate-lender rows whose blank balance leaves affiliateDebt incomplete. */
export function affiliateIncompleteNames(k: Pick<PortfolioKpis, 'affiliateIncomplete'>): string[] {
  return (k.affiliateIncomplete ?? []).map((r) => r.name);
}

/** The affiliate-notes amount for a text surface: "$X", "$X (incomplete: balance blank on …)",
 *  "balance blank on …" when the only affiliate note is blank, or null when there is none
 *  (refute wf_da5abccb-d31: a blank affiliate balance used to drop the disclosure entirely). */
export function affiliateNotesAmountText(k: Pick<PortfolioKpis, 'affiliateDebt' | 'affiliateIncomplete'>): string | null {
  const blank = affiliateIncompleteNames(k);
  const v = k.affiliateDebt.value;
  if (v) return blank.length > 0 ? `${fmtUsdCompact(v)} (incomplete: balance blank on ${blank.join(', ')})` : fmtUsdCompact(v);
  return blank.length > 0 ? `balance blank on ${blank.join(', ')}` : null;
}

/** Overview debt bullet: a lower bound is never printed as a total. */
export function portfolioDebtLine(k: PortfolioKpis): string {
  const blankAff = affiliateIncompleteNames(k);
  const aff = k.affiliateDebt.value
    ? ` · +${fmtUsdCompact(k.affiliateDebt.value)} affiliate notes excluded${blankAff.length > 0 ? ` (incomplete: balance blank on ${blankAff.join(', ')})` : ''}`
    : blankAff.length > 0 ? ` · affiliate notes excluded (balance blank on ${blankAff.join(', ')})` : '';
  const gap = ltvIncompleteNames(k);
  return gap.length > 0
    ? `• Debt at least ${fmtUsdCompact(k.totalDebt.value)} (property loan balances; LTV incomplete — blank Loan Balance on ${gap.join(', ')})${aff}.`
    : `• Debt ${fmtUsdCompact(k.totalDebt.value)} (property loan balances; LTV ${fmtPct(k.ltv.value)})${aff}.`;
}

export function portfolioLtvSentence(k: PortfolioKpis): string {
  const blankAff = affiliateIncompleteNames(k);
  const aff = k.affiliateDebt.value
    ? `; ${fmtUsdCompact(k.affiliateDebt.value)} of affiliate notes excluded${blankAff.length > 0 ? ` (incomplete: balance blank on ${blankAff.join(', ')})` : ''}`
    : blankAff.length > 0 ? `; affiliate notes excluded (balance blank on ${blankAff.join(', ')})` : '';
  // Audit 2026-11-12 HIGH #2: a blank Loan Balance makes the aggregate incomplete. Say so, and name
  // the debt as a lower bound, rather than printing a bare dash beside an understated total.
  const gap = ltvIncompleteNames(k);
  if (gap.length > 0) return `Portfolio LTV incomplete (blank Loan Balance on ${gap.join(', ')}); property loan balances of at least ${fmtUsdCompact(k.totalDebt.value)} ÷ investment value${aff}.`;
  return `Portfolio LTV ${fmtPct(k.ltv.value)} (property loan balances ${fmtUsdCompact(k.totalDebt.value)} ÷ investment value${aff}).`;
}

/**
 * checkDebtBasis (server/reconcile-runtime.ts) emits per-row flags (`debt.basis.property.<id>`,
 * `debt.basis.loan.<id>`) and aggregate ones (`debt.basis`, `debt.basis.affiliate`). On live data the
 * only flag is the affiliate aggregate (the property-row balance vs the smaller loan-schedule balance) — calling that
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
