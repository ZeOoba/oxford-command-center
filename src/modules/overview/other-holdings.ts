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
