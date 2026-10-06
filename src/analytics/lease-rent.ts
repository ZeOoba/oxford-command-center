// src/analytics/lease-rent.ts
//
// Lease.annualRent is year-1 CASH rent NET of abated months (parse.ts: monthly x (12 - Abated
// Months), since 2026-10-06) -- NOT the contract run-rate. Consumers that mean the contract rate
// ("rent lost at expiry", renewal / market-reset math, PSF, any figure quoted to a tenant) must not
// read annualRent; they use contractAnnualRent. Cash-year consumers (reconciliation to the workbook
// total, tenant NOI allocation, WALT / concentration weights today) stay on annualRent.
// Pure and dependency-free so server/ and src/ can both import it.

/** Contract annual rent: monthlyRent x 12 for a live lease (status absent counts as live, for
 *  callers that do not carry it). Falls back to annualRent when the lease carries no usable
 *  monthlyRent (0 / non-finite / negative), and for rows whose monthlyRent is NOT a contract rate:
 *  a Vacant suite's monthlyRent is an ASKING rent and an Expired row's its last rent, so those keep
 *  their workbook annualRent and the monthlyRent is never promoted to a contract rate; an Unknown
 *  row (unrecognised status text such as Holdover/MTM) is live only when it bills (annualRent > 0).
 *  Known ambiguity: an Active / Expiring Soon row with annualRent 0 and monthlyRent > 0 is read as
 *  fully abated, though a zeroed cell or an un-restatused vacancy looks identical until Lease
 *  carries an explicit abatedMonths signal. */
export function contractAnnualRent(l: { monthlyRent: number; annualRent: number; status?: string | null }): number {
  if (l.status === 'Vacant' || l.status === 'Expired') return l.annualRent;
  if (l.status === 'Unknown' && !(l.annualRent > 0)) return l.annualRent;
  return Number.isFinite(l.monthlyRent) && l.monthlyRent > 0 ? l.monthlyRent * 12 : l.annualRent;
}
