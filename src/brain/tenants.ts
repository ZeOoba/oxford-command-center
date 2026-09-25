import type { PortfolioSnapshot, Lease } from '../contracts/index';
import { RENEWAL_STAGES, type RenewalStage } from '../contracts/renewal';
import { slug } from '../contracts/common';
import { isInvestmentProperty } from '../analytics/property-basis';
import { DAY_MS } from '@/lib/time-constants';

const daysBetween = (isoTarget: string, isoFrom: string): number =>
  Math.round((new Date(isoTarget).getTime() - new Date(isoFrom).getTime()) / DAY_MS);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

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
  pctNoi: number; // 0..1 — tenant share of INVESTMENT NOI (pro-rata within each investment property; 0 for leases on a non-investment property; rent-share fallback for unlinked leases), normalized so the column sums to 100%
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
export function tenantScorecards(s: PortfolioSnapshot, referenceDate?: string): TenantScorecard[] {
  // Basis (ratified 2026-09-23): pctNoi is each tenant's share of INVESTMENT NOI — the same basis as
  // portfolioKpis. Three lease classes, decided by the property the lease links to:
  //   • linked to an investment property      → pro-rata slice of that property's NOI by rent share;
  //   • linked to a NON-investment property   → 0 (exactly as before the basis change). The residence's
  //     NOI is outside the basis, so its tenant holds no share, is excluded from totalAllocNoi and never
  //     reaches the concentration surface; its rent is likewise kept OUT of the fallback weight below,
  //     so the numerator and denominator of `margin` are on one basis;
  //   • genuinely unlinked (propertyId null / unknown id) → rent-share fallback, annualRent × margin.
  const investment = s.properties.filter(isInvestmentProperty);
  const nonInvestmentIds = new Set(s.properties.filter((p) => !isInvestmentProperty(p)).map((p) => p.id));
  const linksToNonInvestment = (l: Lease): boolean => l.propertyId !== null && nonInvestmentIds.has(l.propertyId);
  const portfolioNoi = sum(investment.map((p) => p.noi));
  const totalRent = sum(s.leases.filter((l) => !linksToNonInvestment(l)).map((l) => l.annualRent));
  const margin = totalRent > 0 ? portfolioNoi / totalRent : 0; // investment NOI per $ of investment/unlinked rent (fallback weight)

  // Property NOI by id, and linked-rent per property (denominator for pro-rata allocation).
  const propNoi = new Map<string, number>();
  for (const p of investment) propNoi.set(p.id, p.noi);
  const propLinkedRent = new Map<string, number>();
  for (const l of s.leases) {
    if (l.propertyId !== null && propNoi.has(l.propertyId)) {
      propLinkedRent.set(l.propertyId, (propLinkedRent.get(l.propertyId) ?? 0) + l.annualRent);
    }
  }

  const byTenant = new Map<string, Accum>();
  for (const l of s.leases) {
    const name = l.company ?? l.tenantName;
    const id = tenantSlug(name);
    const acc =
      byTenant.get(id) ??
      { id, name, properties: new Set<string>(), sf: 0, annualRent: 0, allocNoi: 0, nextExpiry: null, stageRank: -1, leases: [] };

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
    acc.allocNoi += alloc;
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
  const totalAllocNoi = sum(accums.map((a) => a.allocNoi));
  const cards: TenantScorecard[] = accums.map((a) => ({
    id: a.id,
    name: a.name,
    properties: [...a.properties],
    leaseCount: a.leases.length,
    sf: a.sf,
    annualRent: a.annualRent,
    pctNoi: totalAllocNoi > 0 ? a.allocNoi / totalAllocNoi : 0,
    nextExpiry: a.nextExpiry,
    daysToExpiry: a.nextExpiry ? daysBetween(a.nextExpiry, referenceDate ?? s.meta.asOf) : null,
    renewalStage: a.stageRank >= 0 ? RENEWAL_STAGES[a.stageRank]! : null,
    health: null,
    notes: s.tenantNotes[a.id] ?? '',
    leases: a.leases,
  }));

  return cards.sort((a, b) => b.annualRent - a.annualRent);
}
