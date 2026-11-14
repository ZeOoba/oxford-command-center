import type { PortfolioSnapshot, Lease } from '../contracts/index';
import { RENEWAL_STAGES, type RenewalStage } from '../contracts/renewal';
import { slug } from '../contracts/common';
import { isInvestmentProperty } from '../analytics/property-basis';
import { incompleteGovernorRows } from '../analytics/governor-inputs';
import { DAY_MS } from '@/lib/time-constants';

const daysBetween = (isoTarget: string, isoFrom: string): number =>
  Math.round((new Date(isoTarget).getTime() - new Date(isoFrom).getTime()) / DAY_MS);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
/** Sum in ascending numeric order. Floating-point addition is not associative, so a sum in input row
 *  order can move a share by an ulp — enough to flip a figure on a display rounding boundary, and with
 *  it the concentration screen's label. Ordering by value needs no ids, so duplicate ids cannot
 *  collapse or reorder operands (refute wf_73fe7a17-a86, wf_90ccebf7-bea). */
const sumSorted = (xs: number[]): number => sum([...xs].sort((a, b) => a - b));

/**
 * Stable slug id from a tenant display name (the workbook has no tenant id).
 * Delegates to the canonical slug() so Unicode tenant names (e.g. "Müller GmbH")
 * receive NFKD normalisation + diacritic stripping instead of being silently
 * collapsed to bare hyphens, which would diverge from ids produced elsewhere
 * in the codebase and break tenant-note lookups.
 */
export function tenantSlug(name: string): string {
  return slug(name);
}

export interface TenantScorecard {
  id: string;
  name: string;
  properties: string[]; // distinct propertyKey
  leaseCount: number;
  sf: number;
  annualRent: number;
  pctNoi: number; // normally 0..1, below 0 when a known row's NOI is negative — tenant share of INVESTMENT NOI (pro-rata within each investment property; 0 for leases on a non-investment property; rent-share fallback for unlinked leases), normalized so the column sums to 100%
  /** Investment properties whose blank workbook NOI is summed as $0 in the basis (id order). Non-empty
   *  ⇒ every pctNoi is incomplete: the blank row's tenants read 0% and the rest are re-normalized
   *  without it. Empty when complete (follow-up to audit 2026-11-12 HIGH #2). */
  pctNoiIncomplete: string[];
  nextExpiry: string | null; // soonest leaseEnd ISO
  daysToExpiry: number | null;
  renewalStage: RenewalStage | null; // most-advanced stage across the tenant's leases
  health: string | null; // null until QuickBooks lands (Phase 3)
  notes: string;
  leases: Lease[];
}

interface Accum {
  id: string;
  name: string;
  properties: Set<string>;
  sf: number;
  annualRent: number;
  allocNoi: number;
  /** Each lease's NOI allocation, summed by sumSorted once every lease is in. */
  allocs: number[];
  nextExpiry: string | null;
  stageRank: number; // -1 = none
  leases: Lease[];
}

/**
 * Roll leases up per tenant with a pro-rata NOI allocation.
 *
 * @param referenceDate Optional day-count reference (YYYY-MM-DD) for daysToExpiry. Defaults to
 *   s.meta.asOf (the workbook data date) for backward compatibility — the workbook-frozen-date
 *   defect means callers should pass the real run date (see portfolioCriticalDates for the
 *   established convention).
 */
/** The share as displayed, one decimal of a percent ("12.3"). */
const pctNoiFigure = (pctNoi: number): string => (pctNoi * 100).toFixed(1);

/** True when the share DISPLAYS above 0.0%. Keyed to the displayed figure so a floating-point
 *  residue (a mathematically-zero share summed in lease order) never reads "0.0%" under a label that
 *  says it is screened (refute wf_70b387e9-d2c). */
export function pctNoiReadsPositive(t: Pick<TenantScorecard, 'pctNoi'>): boolean {
  return Number(pctNoiFigure(t.pctNoi)) > 0;
}

/** "12.3%", or "12.3% (incomplete)" when a blank workbook NOI is left out of the basis. */
export function pctNoiText(t: Pick<TenantScorecard, 'pctNoi' | 'pctNoiIncomplete'>): string {
  const pct = `${pctNoiFigure(t.pctNoi)}%`;
  return t.pctNoiIncomplete.length > 0 ? `${pct} (incomplete)` : pct;
}

export function tenantScorecards(s: PortfolioSnapshot, referenceDate?: string): TenantScorecard[] {
  // Basis (ratified 2026-09-23): pctNoi is each tenant's share of INVESTMENT NOI — the same basis as
  // portfolioKpis. Three lease classes, decided by the property the lease links to:
  //   • linked to an investment property      → pro-rata slice of that property's NOI by rent share;
  //   • linked to a NON-investment property   → 0 (exactly as before the basis change). The residence's
  //     NOI is outside the basis, so its tenant holds no share, is excluded from totalAllocNoi and never
  //     reaches the concentration surface; its rent is likewise kept OUT of the fallback weight below,
  //     so the numerator and denominator of `margin` are on one basis;
  //   • genuinely unlinked (propertyId null / unknown id) → rent-share fallback, annualRent × margin.
  // Every sum feeding pctNoi uses sumSorted, so the share does not depend on lease row order.
  // (Duplicate PROPERTY ids still resolve last-wins in propNoi below; that predates this change.)
  const investment = s.properties.filter(isInvestmentProperty);
  const nonInvestmentIds = new Set(s.properties.filter((p) => !isInvestmentProperty(p)).map((p) => p.id));
  const linksToNonInvestment = (l: Lease): boolean => l.propertyId !== null && nonInvestmentIds.has(l.propertyId);
  const portfolioNoi = sumSorted(investment.map((p) => p.noi));
  const pctNoiIncomplete = incompleteGovernorRows(investment, ['noi']).map((r) => r.name);
  const totalRent = sumSorted(s.leases.filter((l) => !linksToNonInvestment(l)).map((l) => l.annualRent));
  const margin = totalRent > 0 ? portfolioNoi / totalRent : 0; // investment NOI per $ of investment/unlinked rent (fallback weight)

  // Property NOI by id, and linked-rent per property (denominator for pro-rata allocation).
  const propNoi = new Map<string, number>();
  for (const p of investment) propNoi.set(p.id, p.noi);
  const linkedRents = new Map<string, number[]>();
  for (const l of s.leases) {
    if (l.propertyId !== null && propNoi.has(l.propertyId)) {
      const rents = linkedRents.get(l.propertyId) ?? [];
      rents.push(l.annualRent);
      linkedRents.set(l.propertyId, rents);
    }
  }
  const propLinkedRent = new Map<string, number>([...linkedRents].map(([pid, rents]) => [pid, sumSorted(rents)]));

  const byTenant = new Map<string, Accum>();
  for (const l of s.leases) {
    const name = l.company ?? l.tenantName;
    const id = tenantSlug(name);
    const acc =
      byTenant.get(id) ??
      { id, name, properties: new Set<string>(), sf: 0, annualRent: 0, allocNoi: 0, allocs: [], nextExpiry: null, stageRank: -1, leases: [] };

    // Pro-rata NOI allocation: each property's NOI split across its linked leases by rent share.
    const pid = l.propertyId;
    const pNoi = pid !== null ? propNoi.get(pid) : undefined;
    const pRent = pid !== null ? propLinkedRent.get(pid) : undefined;
    const alloc = linksToNonInvestment(l)
      ? 0 // linked to a non-investment property (the residence) → no investment NOI, as before
      : pid !== null && pNoi !== undefined && pRent !== undefined && pRent > 0
        ? pNoi * (l.annualRent / pRent)
        : l.annualRent * margin; // genuinely unlinked → rent-share fallback in NOI units

    acc.properties.add(l.propertyKey);
    acc.sf += l.sf;
    acc.annualRent += l.annualRent;
    acc.allocs.push(alloc);
    acc.leases.push(l);

    if (l.leaseEnd && (acc.nextExpiry === null || l.leaseEnd < acc.nextExpiry)) acc.nextExpiry = l.leaseEnd;

    // Look up renewal stage by lease id (overlay is keyed by leaseId, not tenant slug).
    const stage = s.renewalStages[l.id];
    if (stage !== undefined) acc.stageRank = Math.max(acc.stageRank, RENEWAL_STAGES.indexOf(stage));

    byTenant.set(id, acc);
  }

  // Normalize by total allocated NOI (not raw portfolio NOI) so the column sums to exactly 100%.
  // When every lease links to a property this equals portfolio NOI; the rent-share fallback for
  // unlinked leases would otherwise inflate the total past portfolio NOI, so we divide by the
  // realized total instead. Each tenant's share is therefore its slice of the firm's income.
  const accums = [...byTenant.values()];
  for (const a of accums) a.allocNoi = sumSorted(a.allocs);
  const totalAllocNoi = sumSorted(accums.map((a) => a.allocNoi));
  const cards: TenantScorecard[] = accums.map((a) => ({
    id: a.id,
    name: a.name,
    properties: [...a.properties],
    leaseCount: a.leases.length,
    sf: a.sf,
    annualRent: a.annualRent,
    pctNoi: totalAllocNoi > 0 ? a.allocNoi / totalAllocNoi : 0,
    pctNoiIncomplete,
    nextExpiry: a.nextExpiry,
    daysToExpiry: a.nextExpiry ? daysBetween(a.nextExpiry, referenceDate ?? s.meta.asOf) : null,
    renewalStage: a.stageRank >= 0 ? RENEWAL_STAGES[a.stageRank]! : null,
    health: null,
    notes: s.tenantNotes[a.id] ?? '',
    leases: a.leases,
  }));

  return cards.sort((a, b) => b.annualRent - a.annualRent);
}
