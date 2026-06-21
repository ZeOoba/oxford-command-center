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

/**
 * Produce a compact chip label for a MarketRentGap column cell.
 *   - provenance 'absent' or null gapPsf → '—'
 *   - underMarket → '↓ {gap}/SF'
 *   - at or above market → '↑ {|gap|}/SF'
 */
export function gapChipLabel(gap: MarketRentGap): string {
  if (gap.provenance === 'absent' || gap.gapPsf === null) return '—';
  const abs = Math.abs(gap.gapPsf);
  if (gap.underMarket) return `↓ ${abs.toFixed(2)}/SF`;
  return `↑ ${abs.toFixed(2)}/SF`;
}
