// src/analytics/debt-basis.ts
//
// Debt-basis rules — the ONE home for "which debt counts" (sibling of ./property-basis, which owns
// the residence rule). Ratified 2026-09-24 (Gabriel): Oxford-to-Oxford ("affiliate") notes are
// EXCLUDED from investment Overview Total Debt, aggregate LTV, per-property LTV and Capital › Debt
// External Debt, and shown separately ("+$X affiliate notes"). Live cases: the 1100 Rarig property
// row (lender "Oxford Capital", loanBalance ≈ $1.10M) and the borrower loan "3883 from Oxford (50%)"
// (≈ $385K). With both excluded, the Overview-vs-Capital debt-basis flag reconciles to the cent.
//
// Identification: the workbook carries no "affiliate" field, so this is an explicit whole-phrase
// lender-name list — not a fuzzy heuristic — matched against Property.lender (Property NOI col 19)
// and a borrower loan's lender/counterparty (Loan Index col 3). Borrower direction ONLY: a
// lender-direction note naming "(Oxford Capital)" is Oxford's own receivable (Capital Deployed).
// The list is pending Gabriel's completeness confirmation (plan Q1); extend it here and nowhere else.
import { fmtPct, fmtUsdCompact } from './format';

/** Oxford lending entities. A note owed TO one of these BY an Oxford property is an affiliate note. */
export const AFFILIATE_LENDER_NAMES: readonly string[] = ['Oxford Capital'];

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whole phrase: the name must not be glued to a letter/digit on either side ("NotOxford Capital",
// "Oxford Capitalist" do not match). No `g` flag, so `.test` carries no lastIndex state.
const AFFILIATE_RE = new RegExp(
  `(?:^|[^a-z0-9])(?:${AFFILIATE_LENDER_NAMES.map(escapeRe).join('|')})(?:[^a-z0-9]|$)`,
  'i',
);

export function namesAffiliateLender(text: string | null | undefined): boolean {
  return typeof text === 'string' && AFFILIATE_RE.test(text);
}

type DebtRow = { readonly lender?: string | null; readonly loanBalance?: number | null };

/** A property row whose outstanding loan balance is owed to an Oxford affiliate lender. */
export function isAffiliateNoteProperty(p: DebtRow): boolean {
  return (p.loanBalance ?? 0) > 0 && namesAffiliateLender(p.lender);
}

/** A BORROWER-direction loan-schedule row whose lender is an Oxford affiliate. */
export function isAffiliateBorrowerLoan(l: {
  readonly direction: string;
  readonly lender?: string | null;
  readonly counterparty?: string | null;
}): boolean {
  return l.direction === 'borrower' && (namesAffiliateLender(l.lender) || namesAffiliateLender(l.counterparty));
}

/** The property row's loan balance on the investment (third-party) basis: 0 for an affiliate note. */
export function investmentLoanBalance(p: DebtRow): number {
  return isAffiliateNoteProperty(p) ? 0 : (p.loanBalance ?? 0);
}

/** Per-property LTV on the investment basis: null when the row's only debt is an affiliate note. */
export function investmentLtv(p: DebtRow & { readonly ltv: number | null }): number | null {
  return isAffiliateNoteProperty(p) ? null : p.ltv;
}

/** Display label for a per-property LTV cell — names the exclusion rather than showing a number. */
export function propertyLtvLabel(p: DebtRow & { readonly ltv: number | null }): string {
  return isAffiliateNoteProperty(p) ? 'affiliate note' : fmtPct(p.ltv);
}

/** Disclosure clause for a debt headline, e.g. "+$1.10M affiliate notes"; '' when there are none. */
export function affiliateNotesClause(amount: number | null | undefined): string {
  return typeof amount === 'number' && amount > 0 ? `+${fmtUsdCompact(amount)} affiliate notes` : '';
}

/** Field root for the Overview-vs-Capital debt-basis data-quality flags (server/reconcile-runtime.ts). */
export const DEBT_BASIS_FIELD = 'debt.basis';

/** True for a debt-basis flag: entity 'debt' and field exactly 'debt.basis' or 'debt.basis.<…>'. */
export function isDebtBasisFlag(f: { readonly entity: string; readonly field: string }): boolean {
  return f.entity === 'debt' && (f.field === DEBT_BASIS_FIELD || f.field.startsWith(`${DEBT_BASIS_FIELD}.`));
}
