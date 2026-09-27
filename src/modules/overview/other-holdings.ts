// src/modules/overview/other-holdings.ts
//
// Ratified 2026-09-23: the residence (9510 Persimmon Tree) is excluded from investment KPIs and
// must be REPORTED beside the headline value wherever that headline appears — never silently
// dropped. Three surfaces show the same headline "Portfolio Value" figure (Overview KPI strip,
// Portfolio strip, Principal Value tile) and each built its own copy of this clause, which is how
// the wording drifted (I-1, 2026-09-23 review). This is the single shared source for that clause —
// every surface calls it instead of composing the string itself.
import { fmtUsdCompact } from '@analytics/index';
import type { PortfolioKpis } from '@analytics/index';

/** The other-holdings disclosure clause, e.g. "+$2.00M other holdings" — or '' when there is no
 *  residence row (otherHoldingsCount is 0/null). Callers compose this with their own count text;
 *  this function owns only the $ clause so the wording can never drift between surfaces. */
export function otherHoldingsClause(k: PortfolioKpis): string {
  return k.otherHoldingsCount.value ? `+${fmtUsdCompact(k.otherHoldingsValue.value)} other holdings` : '';
}

/** The full "N investment properties" sublabel, disclosure first when it exists: e.g.
 *  "+$2.00M other holdings · 1 investment property" or, with no residence row, "2 investment
 *  properties". Shared so the ordering/pluralization rule lives in exactly one place. */
export function investmentPropertiesSublabel(k: PortfolioKpis): string {
  const n = k.propertyCount.value ?? 0;
  const count = `${n} investment propert${n === 1 ? 'y' : 'ies'}`;
  const clause = otherHoldingsClause(k);
  return clause ? `${clause} · ${count}` : count;
}

/** Equity Invested disclosure (ratified 2026-09-24): the headline stays investment-only; the
 *  residence's equity is reported beside it, e.g. "+$900K other holdings" — or '' with none. */
export function otherHoldingsEquityClause(k: Pick<PortfolioKpis, 'otherHoldingsCount' | 'otherHoldingsEquity'>): string {
  return k.otherHoldingsCount.value ? signedClause(k.otherHoldingsEquity.value, 'other holdings') : '';
}

/** Total Debt disclosure for a residence mortgage (governor loop is investment-only — ratified
 *  2026-09-24): "+$X other-holdings debt", or '' when the residence carries no loan balance. */
export function otherHoldingsDebtClause(k: Pick<PortfolioKpis, 'otherHoldingsCount' | 'otherHoldingsDebt'>): string {
  return k.otherHoldingsCount.value ? signedClause(k.otherHoldingsDebt.value, 'other-holdings debt') : '';
}

/** Sign-symmetric disclosure (mirrors affiliateNotesClause): '' unless finite and non-zero; '+' only
 *  when positive — a negative figure keeps fmtUsdCompact's own minus (refute wf_fc63f5bf-8e7). */
function signedClause(amount: number | null | undefined, suffix: string): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount === 0) return '';
  return `${amount > 0 ? '+' : ''}${fmtUsdCompact(amount)} ${suffix}`;
}
