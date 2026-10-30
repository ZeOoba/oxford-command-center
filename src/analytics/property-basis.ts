/**
 * Investment-basis predicate — the ONE home for the residence exclusion.
 *
 * Ratified 2026-09-23 (Gabriel): the residence (`type === 'Residence'`, 9510 Persimmon Tree) is not
 * an investment asset. It is reported as "other holdings" beside — never inside — investment KPIs
 * and allocations (it diluted the weighted cap ~24 bps and occupancy). The solar row stays in: it
 * is income-producing and typed among the investment types.
 *
 * Every investment surface filters through this predicate so the basis cannot drift between them —
 * a market slice must never sum past the headline it sits beside. Callers: portfolioKpis and
 * buildAnalytics' market allocations (engine.ts), the AI portfolio tool (server/ai/tools.ts), the
 * leasing-brief property count (server/warehouse/lease-forecast-api.ts), tenant NOI shares
 * (src/brain/tenants.ts) and warehouse occupancy capture (server/warehouse/occupancy.ts).
 *
 * Deliberately NOT applied to non-investment surfaces: the Portfolio detail table (lists every row),
 * `scripts/reconcile.ts` (a workbook self-total data-quality check that carves the residence out of
 * the SF subtotal by design) and `reconcile-noi.ts`'s `isResidence` flag (semantically "is the
 * residence", which must not silently widen if this predicate ever grows).
 *
 * Structural parameter: accepts a `Property` or any row carrying an optional `type` (the warehouse
 * occupancy view). A row with no type is an investment row — matches the prior `!== 'Residence'`
 * behavior at every call site.
 */
export const isInvestmentProperty = (p: { readonly type?: string | null }): boolean => p.type !== 'Residence';

// 2026-10-30 (Gabriel): the residence is now removed from the snapshot at parse
// (server/workbook/parse.ts excludeNonInvestmentHoldings), so on live data this predicate no longer
// sees one. It stays as defense in depth for any snapshot that predates that change.

/** `DataQualityFlag.field` set by parse.ts flagLandlordCostsNotSourced on an NNN (not absolute)
 *  property whose expenses read $0: landlord-paid roof, structure and paving are not sourced, so
 *  its NOI is overstated by them (ruling 2026-10-30). Surfaces key on it to label the NOI. */
export const LANDLORD_COSTS_NOT_SOURCED_FIELD = 'landlordCosts';

export const landlordCostsNotSourced = (p: { readonly flags: readonly { readonly field: string }[] }): boolean =>
  p.flags.some((f) => f.field === LANDLORD_COSTS_NOT_SOURCED_FIELD);
