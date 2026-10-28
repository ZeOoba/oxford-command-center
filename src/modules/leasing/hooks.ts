// src/modules/leasing/hooks.ts
//
// Phase 3 W2 — TanStack Query hooks + pure display helpers for the Leasing
// Intelligence UI.
//
// Consumes:
//   GET /api/warehouse/leasing/forecast → LeaseForecastResponse
//
// Error policy mirrors src/modules/debt/hooks.ts exactly:
//   - 503 / non-JSON (mirror) → WarehouseUnavailableError → module degrades gracefully.
//   - Real API errors surface as thrown Error (4xx with JSON body).
//   - Zod parse validates the full response at the client boundary.
//
// Pure helpers (buildSignalMap, buildGapMap, likelihoodTone, gapChipLabel) are exported
// so the unit-test suite can verify them without React or network.
import { useQuery } from '@tanstack/react-query';
import { fetchParsedOrMirror, QUERY_OPTS } from '../intel/hooks';
import { LeaseForecastResponse } from '@contracts/lease-forecast';
import type {
  RenewalSignal,
  MarketRentGap,
  RenewalLikelihood,
  ExpiryBucket,
} from '@contracts/lease-forecast';
import type { BadgeTone } from '@/primitives/Badge';
import { fmtUsdCompact } from '@analytics/index';

export type { RenewalSignal, MarketRentGap, RenewalLikelihood };

// ── Query keys ─────────────────────────────────────────────────────────────────

export const LEASING_KEYS = {
  forecast: ['warehouse', 'leasing', 'forecast'] as const,
};

// ── Read hooks ─────────────────────────────────────────────────────────────────

/**
 * Full leasing forecast: renewal signals, velocity, market gaps, and expiry bucket totals.
 * Degrades gracefully on the static mirror (WarehouseUnavailableError → empty state).
 */
export function useLeaseForecast() {
  return useQuery({
    queryKey: LEASING_KEYS.forecast,
    queryFn: () => fetchParsedOrMirror('/api/warehouse/leasing/forecast', LeaseForecastResponse),
    ...QUERY_OPTS,
  });
}

// ── Canonical bucket display order (active horizons only) ─────────────────────
// 'expired' and 'unknown' are not shown as KPI cards — they fold into signal rows.

export const BUCKET_DISPLAY_ORDER: ExpiryBucket[] = ['0-6m', '6-12m', '12-24m', '24m+'];

// ── Pure display helpers (unit-tested; no React dependencies) ─────────────────

/**
 * Map a RenewalLikelihood to a Badge tone.
 * Tone map: likely → green · uncertain → neutral · at-risk → amber · lapsing → red
 */
export function likelihoodTone(likelihood: RenewalLikelihood): BadgeTone {
  switch (likelihood) {
    case 'likely':    return 'green';
    case 'uncertain': return 'neutral';
    case 'at-risk':   return 'amber';
    case 'lapsing':   return 'red';
  }
}

/**
 * Build a leaseId → RenewalSignal lookup map from the forecast response.
 * Last-write wins on duplicate leaseId (the contract forbids duplicates; this is defensive).
 */
export function buildSignalMap(signals: RenewalSignal[]): Map<string, RenewalSignal> {
  const m = new Map<string, RenewalSignal>();
  for (const s of signals) m.set(s.leaseId, s);
  return m;
}

/**
 * Build a leaseId → MarketRentGap lookup map from the forecast response.
 * Absent-provenance entries are included so callers can render '—' correctly.
 */
export function buildGapMap(gaps: MarketRentGap[]): Map<string, MarketRentGap> {
  const m = new Map<string, MarketRentGap>();
  for (const g of gaps) m.set(g.leaseId, g);
  return m;
}

// ── Leases outside the four bucket cards ──────────────────────────────────────

export interface UnbucketedGroup {
  count: number;
  rent: number;
}

export interface UnbucketedSummary {
  total: number;
  /** Past end date, status not Expired — a month-to-month tenancy, not an expired one. */
  mtm: UnbucketedGroup;
  /** Past end date and the workbook itself says Expired. */
  expired: UnbucketedGroup;
  /** No lease end date on file. */
  noEnd: UnbucketedGroup;
}

/**
 * The four bucket cards cover 0-6m..24m+ only, so the forecast's 'expired' and 'unknown' buckets were
 * invisible and the cards summed to fewer leases than the rent roll. This groups what they leave out,
 * from the same signals the cards are built on (no engine change).
 */
export function summarizeUnbucketed(signals: RenewalSignal[]): UnbucketedSummary {
  const out: UnbucketedSummary = {
    total: 0,
    mtm: { count: 0, rent: 0 },
    expired: { count: 0, rent: 0 },
    noEnd: { count: 0, rent: 0 },
  };
  for (const s of signals) {
    const group =
      s.expiryBucket === 'expired' ? (s.monthToMonth ? out.mtm : out.expired)
      : s.expiryBucket === 'unknown' ? out.noEnd
      : null;
    if (!group) continue;
    group.count += 1;
    group.rent += s.annualRent;
    out.total += 1;
  }
  return out;
}

/** One-line footnote for the leases the cards leave out; null when every lease is bucketed. */
export function unbucketedFootnote(s: UnbucketedSummary): string | null {
  if (s.total === 0) return null;
  const parts: string[] = [];
  if (s.mtm.count > 0) parts.push(`${s.mtm.count} month-to-month past end date (${fmtUsdCompact(s.mtm.rent)}/yr)`);
  if (s.expired.count > 0) parts.push(`${s.expired.count} expired (${fmtUsdCompact(s.expired.rent)}/yr)`);
  if (s.noEnd.count > 0) parts.push(`${s.noEnd.count} with no end date (${fmtUsdCompact(s.noEnd.rent)}/yr)`);
  return `${s.total} ${s.total === 1 ? 'lease' : 'leases'} not in a bucket: ${parts.join(', ')}.`;
}

/**
 * Same rule as the forecast's `monthToMonth` flag (lease-forecast.ts renewalSignals): the end date has
 * passed and the workbook status is not Expired. Used for the rent-roll label only.
 */
export function isMonthToMonth(lease: { status: string; leaseEnd: string | null }, asOf: string): boolean {
  if (!lease.leaseEnd || !asOf || lease.status === 'Expired') return false;
  return new Date(lease.leaseEnd).getTime() < new Date(asOf).getTime();
}

// ── Market-rent suggestions ───────────────────────────────────────────────────

export interface MarketRentSuggestion {
  key: string;
  psf: number;
}

/**
 * Lease-market-feed asking rents (provenance 'derived-asking') not yet confirmed in the overlay, one per
 * property. Display-only: nothing is written until the user accepts one, and the feed itself never
 * reaches the NOI forecast (see lease-forecast-api.ts header).
 */
export function suggestMarketRents(gaps: MarketRentGap[], existing: Record<string, number>): MarketRentSuggestion[] {
  const seen = new Set<string>();
  const out: MarketRentSuggestion[] = [];
  for (const g of gaps) {
    if (g.provenance !== 'derived-asking') continue;
    if (g.marketRentPsf === null || !(g.marketRentPsf > 0)) continue;
    if (seen.has(g.propertyKey)) continue;
    if ((existing[g.propertyKey] ?? 0) > 0) continue;
    seen.add(g.propertyKey);
    out.push({ key: g.propertyKey, psf: g.marketRentPsf });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Produce a compact chip label for a MarketRentGap column cell.
 *   - provenance 'absent' or null gapPsf → '—'
 *   - underMarket → '↓ {gap}/SF'
 *   - at or above market → '↑ {|gap|}/SF'
 *   - provenance 'derived-asking' (lease-market feed, no manual override) → suffixed ' (asking)'
 */
export function gapChipLabel(gap: MarketRentGap): string {
  if (gap.provenance === 'absent' || gap.gapPsf === null) return '—';
  const abs = Math.abs(gap.gapPsf);
  const label = gap.underMarket ? `↓ ${abs.toFixed(2)}/SF` : `↑ ${abs.toFixed(2)}/SF`;
  return gap.provenance === 'derived-asking' ? `${label} (asking)` : label;
}
