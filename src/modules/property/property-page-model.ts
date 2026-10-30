// src/modules/property/property-page-model.ts
//
// Pure model for the canonical property page (roadmap 2.2, /property/:id). The page joins two
// spines and never mixes them: the header's workbook figures come from the snapshot (Spine A), the
// monthly trends from the Property Financials P&L ledger (Spine B), each labelled with its basis.
// Ruling 2026-10-30: two NOI tiles (workbook / ledger T12), never compared or summed.
import type { Lease } from '@contracts/index';
import type { MarketRentGap } from '@contracts/lease-forecast';
import { addMonths } from '@analytics/portfolio-trends';
import type { AlertViewItem } from '@/brain/alerts-view';

/** The page's shareable path. */
export const propertyPagePath = (propertyId: string): string => `/property/${encodeURIComponent(propertyId)}`;

/** The page link from anywhere: `?scenario`/`?still` ride along; the page being left's own `tab`,
 *  `view` and Explorer `p` do not (same stripping as UiProvider.setActiveModule). */
export function propertyPageHref(propertyId: string, search: string): string {
  const params = new URLSearchParams(search);
  for (const k of ['tab', 'view', 'p']) params.delete(k);
  const qs = params.toString();
  return `${propertyPagePath(propertyId)}${qs ? `?${qs}` : ''}`;
}

/** The Property Financials entity whose ratified canonical id (server/property-financials/mapping.ts,
 *  carried on the dataset response's liveSf block) is this property; null when none maps to it. */
export function pfEntityFor(
  entries: Readonly<Record<string, { readonly canonicalId: string | null }>> | undefined,
  propertyId: string,
): string | null {
  if (!entries) return null;
  for (const [entity, e] of Object.entries(entries)) if (e.canonicalId === propertyId) return entity;
  return null;
}

/** Last calendar day of a YYYY-MM month as ISO, for an as-of stamp on a monthly series. */
export function monthEndIso(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export interface LedgerMonth {
  month: string;
  noi: number;
  revenue: number;
  opex: number;
  baseRent: number;
}

type CubeFigures = { readonly noi: number; readonly revenue: number; readonly opex: number; readonly base_rent: number };

/** One entity's monthly P&L cube as a month-sorted list (empty for an annual-only entity). */
export function ledgerMonths(cube: Readonly<Record<string, CubeFigures>> | undefined): LedgerMonth[] {
  if (!cube) return [];
  return Object.keys(cube)
    .sort()
    .map((month) => {
      const f = cube[month]!;
      return { month, noi: f.noi, revenue: f.revenue, opex: f.opex, baseRent: f.base_rent };
    });
}

/** Trailing-12 NOI at each month that closes 12 consecutive recorded months. A missing month is
 *  never bridged: any window containing it is dropped, so T12 is always 12 real months. */
export function rollingT12(months: readonly LedgerMonth[]): { month: string; value: number }[] {
  const out: { month: string; value: number }[] = [];
  for (let i = 11; i < months.length; i++) {
    const window = months.slice(i - 11, i + 1);
    const consecutive = window.every((m, j) => j === 0 || m.month === addMonths(window[j - 1]!.month, 1));
    if (consecutive) out.push({ month: months[i]!.month, value: window.reduce((s, m) => s + m.noi, 0) });
  }
  return out;
}

export type LadderBucket = 'past' | '0-12' | '13-24' | '25-36' | '37+' | 'no-date';

export const BUCKET_LABEL: Readonly<Record<LadderBucket, string>> = {
  past: 'Past end date',
  '0-12': '0–12 months',
  '13-24': '13–24 months',
  '25-36': '25–36 months',
  '37+': '37+ months',
  'no-date': 'No end date',
};

export function bucketOf(monthsToExpiry: number | null): LadderBucket {
  if (monthsToExpiry === null) return 'no-date';
  if (monthsToExpiry < 0) return 'past';
  if (monthsToExpiry <= 12) return '0-12';
  if (monthsToExpiry <= 24) return '13-24';
  if (monthsToExpiry <= 36) return '25-36';
  return '37+';
}

/** Market rent behind the gap column. `indicative` = the lease-market asking feed, shown apart and
 *  never mixed with a manual figure (roadmap ruling 4). `not-sourced` never carries a number. */
export type LadderMarket =
  | { kind: 'manual' | 'indicative'; psf: number | null; gapAnnualUsd: number | null }
  | { kind: 'not-sourced'; psf: null; gapAnnualUsd: null };

export interface LadderRow {
  leaseId: string;
  tenant: string;
  unit: string | null;
  sf: number;
  annualRent: number;
  rentPsf: number | null;
  leaseEnd: string | null;
  monthsToExpiry: number | null;
  bucket: LadderBucket;
  market: LadderMarket;
}

const NOT_SOURCED: LadderMarket = { kind: 'not-sourced', psf: null, gapAnnualUsd: null };

function marketOf(g: MarketRentGap | undefined): LadderMarket {
  if (!g || g.marketRentPsf === null) return NOT_SOURCED;
  if (g.provenance === 'derived' || g.provenance === 'real') return { kind: 'manual', psf: g.marketRentPsf, gapAnnualUsd: g.gapAnnualUsd };
  if (g.provenance === 'derived-asking') return { kind: 'indicative', psf: g.marketRentPsf, gapAnnualUsd: g.gapAnnualUsd };
  return NOT_SOURCED;
}

const BUCKET_ORDER: readonly LadderBucket[] = ['past', '0-12', '13-24', '25-36', '37+', 'no-date'];

/** The property's leases by expiry. Vacant rows are not leases; an expired lease still on the roll
 *  stays visible in "Past end date" (a data issue to resolve, not something to hide). */
export function rolloverLadder(leases: readonly Lease[], propertyId: string, gaps: readonly MarketRentGap[]): LadderRow[] {
  const gapById = new Map(gaps.map((g) => [g.leaseId, g]));
  return leases
    .filter((l) => l.propertyId === propertyId && l.status !== 'Vacant')
    .map((l) => ({
      leaseId: l.id,
      tenant: l.company ?? l.tenantName,
      unit: l.unit,
      sf: l.sf,
      annualRent: l.annualRent,
      rentPsf: l.rentPerSf,
      leaseEnd: l.leaseEnd,
      monthsToExpiry: l.monthsToExpiry,
      bucket: bucketOf(l.monthsToExpiry),
      market: marketOf(gapById.get(l.id)),
    }))
    .sort(
      (a, b) =>
        BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket) ||
        (a.monthsToExpiry ?? 0) - (b.monthsToExpiry ?? 0) ||
        a.tenant.localeCompare(b.tenant),
    );
}

/** Open alerts about this property: on the property itself or on one of its leases. */
export function propertyAlerts(items: readonly AlertViewItem[], propertyId: string, leaseIds: ReadonlySet<string>): AlertViewItem[] {
  return items.filter(({ insight: i }) =>
    i.entityType === 'property' ? i.entityId === propertyId : i.entityType === 'lease' && !!i.entityId && leaseIds.has(i.entityId),
  );
}
