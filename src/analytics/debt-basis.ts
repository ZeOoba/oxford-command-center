// src/analytics/debt-basis.ts
//
// Debt-basis rules — the ONE home for "which debt counts" (sibling of ./property-basis, which owns
// the residence rule). Ratified 2026-09-24 (Gabriel): Oxford-to-Oxford ("affiliate") notes are
// EXCLUDED from investment Overview Total Debt, aggregate LTV, per-property LTV and Capital › Debt
// External Debt, and shown separately ("+$X affiliate notes"). Live cases: the 1100 Rarig property
// row (lender "Oxford Capital") and the borrower loan "3883 from Oxford (50%)"
// With both excluded, the Overview-vs-Capital debt-basis flag reconciles to the cent.
//
// Identification: the workbook carries no "affiliate" field, so this is an explicit whole-phrase
// lender-name list — not a fuzzy heuristic — matched against Property.lender (Property NOI col 19)
// and a borrower loan's lender/counterparty (Loan Index col 3). Borrower direction ONLY: a
// lender-direction note naming "(Oxford Capital)" is Oxford's own receivable (Capital Deployed).
// Q1 ratified complete 2026-09-26 (Gabriel): the list is ['Oxford Capital']; extend it here and nowhere else.
// Split basis, ratified 2026-09-27 (Gabriel): affiliate notes are out of Total Debt and LTV (balance
// basis) but their debt service STAYS in DSCR and debt service — it is real cash out of the property,
// so DSCR remains conservative. Do not apply these predicates to debt-service or DSCR inputs.
// "Oxford Capital Partners" is the firm's own styling — a borrowing in the firm's name FROM a bank is
// third-party debt, so that phrase is explicitly excluded. Whitespace (incl. NBSP / newlines) is
// collapsed before matching. Known limit: a property row carries ONE lender string and is classified
// whole — a row mixing third-party and affiliate debt is not split.
import { fmtPct, fmtUsdCompact } from './format';

/** Oxford lending entities. A note owed TO one of these BY an Oxford property is an affiliate note. */
export const AFFILIATE_LENDER_NAMES: readonly string[] = ['Oxford Capital'];

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whole phrase: the name must not be glued to a letter/digit on either side ("NotOxford Capital",
// "Oxford Capitalist" do not match) and must not be followed by " Partners" (the firm's own name,
// not a lender). Input is whitespace-normalized first, so a single space is the only separator the
// pattern has to handle. No `g` flag, so `.test` carries no lastIndex state.
const AFFILIATE_RE = new RegExp(
  `(?:^|[^a-z0-9])(?:${AFFILIATE_LENDER_NAMES.map(escapeRe).join('|')})(?! partners(?:[^a-z0-9]|$))(?:[^a-z0-9]|$)`,
  'i',
);

/** Collapse any run of whitespace (space, NBSP, tab, newline) to one space and trim. */
const normalizeWs = (s: string): string => s.replace(/\s+/g, ' ').trim();

export function namesAffiliateLender(text: string | null | undefined): boolean {
  return typeof text === 'string' && AFFILIATE_RE.test(normalizeWs(text));
}

type DebtRow = { readonly lender?: string | null; readonly loanBalance?: number | null };

/** A property row whose outstanding loan balance is owed to an Oxford affiliate lender. */
export function isAffiliateNoteProperty(p: DebtRow): boolean {
  const bal = p.loanBalance;
  // Sign-agnostic: a negative affiliate balance is still an affiliate note. Only a zero / missing /
  // non-finite balance means there is no note to exclude.
  return typeof bal === 'number' && Number.isFinite(bal) && bal !== 0 && namesAffiliateLender(p.lender);
}

/** A BORROWER-direction loan-schedule row whose lender is an Oxford affiliate. */
export function isAffiliateBorrowerLoan(l: {
  readonly direction: string;
  readonly lender?: string | null;
  readonly counterparty?: string | null;
}): boolean {
  return l.direction === 'borrower' && (namesAffiliateLender(l.lender) || namesAffiliateLender(l.counterparty));
}

/**
 * A warehouse `debt_positions` row owed to an Oxford affiliate. Ratified 2026-09-26 (Gabriel):
 * the warehouse debt path excludes these from the LTV governor basis (debt-scoring D1 LTV,
 * debt-maturity aggregate LTV) by read-side filter; position views still list them, labeled.
 * debt_positions holds BORROWER-direction rows only (writeDebtSnapshot filters on direction) and
 * persists no counterparty column, so the predicate reads the stored `lender`; `loan_name` (free
 * text) is consulted ONLY when no lender is stored at all — a third-party lender row whose name
 * merely mentions an affiliate ("Refi of Oxford Capital note") stays third-party, exactly as
 * isAffiliateBorrowerLoan classifies the workbook row (independent review 2026-09-26, major).
 * Live stored string this must match: 'Lender 05 / Oxford Capital — Oxford 50% share'.
 * DSCR / debt-service treatment is an OPEN ruling — this predicate must not be applied there.
 */
export function isAffiliateDebtPosition(row: {
  readonly lender?: string | null;
  readonly loan_name?: string | null;
}): boolean {
  if (typeof row.lender === 'string' && row.lender.trim() !== '') return namesAffiliateLender(row.lender);
  return namesAffiliateLender(row.loan_name);
}

/** Suffix appended to an affiliate position's loan name on position views (ladder / timeline). */
export const AFFILIATE_POSITION_LABEL = '[affiliate note]';

/** The property row's loan balance on the investment (third-party) basis: 0 for an affiliate note. */
export function investmentLoanBalance(p: DebtRow): number {
  if (isAffiliateNoteProperty(p)) return 0;
  const bal = p.loanBalance;
  return typeof bal === 'number' && Number.isFinite(bal) ? bal : 0;
}

/** Per-property LTV on the investment basis: null when the row's only debt is an affiliate note. */
export function investmentLtv(p: DebtRow & { readonly ltv: number | null }): number | null {
  return isAffiliateNoteProperty(p) ? null : p.ltv;
}

/** Display label for a per-property LTV cell — names the exclusion rather than showing a number. */
export function propertyLtvLabel(p: DebtRow & { readonly ltv: number | null }): string {
  return isAffiliateNoteProperty(p) ? 'affiliate note' : fmtPct(p.ltv);
}

/**
 * Disclosure clause for a debt headline, e.g. "+$2.35M affiliate notes"; '' when there are none.
 * Sign-symmetric: a negative total is still disclosed ("-$13K affiliate notes") — the '+' prefix is
 * added only for a positive amount; otherwise fmtUsdCompact's own minus sign stands.
 */
export function affiliateNotesClause(amount: number | null | undefined): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount === 0) return '';
  return `${amount > 0 ? '+' : ''}${fmtUsdCompact(amount)} affiliate notes`;
}

/** Field root for the Overview-vs-Capital debt-basis data-quality flags (server/reconcile-runtime.ts). */
export const DEBT_BASIS_FIELD = 'debt.basis';

/** True for a debt-basis flag: entity 'debt' and field exactly 'debt.basis' or 'debt.basis.<…>'. */
export function isDebtBasisFlag(f: { readonly entity: string; readonly field: string }): boolean {
  return f.entity === 'debt' && (f.field === DEBT_BASIS_FIELD || f.field.startsWith(`${DEBT_BASIS_FIELD}.`));
}
