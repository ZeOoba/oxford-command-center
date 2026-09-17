// src/modules/lease-market/hooks.ts
//
// Lease Market Intelligence — TanStack Query hooks + pure display helpers (spec rev 3 §4).
// Reads degrade on the static mirror via fetchParsedOrMirror. Helpers are exported for unit tests.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchParsedOrMirror, QUERY_OPTS } from '../intel/hooks';
import { ORA_JSON_MUTATION_HEADERS } from '@contracts/client-header';
import {
  ChangesResponse, HistoryResponse, LeaseMarketSummaryResponse, PositioningResponse, RadarDecisionResponse, RadarResponse, SignalsResponse,
  type ConfidenceLabel, type CurvePoint, type EvidenceValue, type ListingEventKind, type ListingEventRow, type PositioningBand,
  type PositioningRowSource, type RadarCandidate, type RadarDecisionInput, type RadarDecisionKind, type SignalKind, type SignalRow,
  type SignalSeverity, type SimilarityComponent,
} from '@contracts/lease-market';
import type { CurveDatum } from '@/charts/rent-curve-layout';
import type { BadgeTone } from '@/primitives/Badge';

const BASE = '/api/warehouse/lease-market';

export const LEASE_MARKET_KEYS = {
  summary: ['warehouse', 'lease-market', 'summary'] as const,
  positioning: ['warehouse', 'lease-market', 'positioning'] as const,
  radar: ['warehouse', 'lease-market', 'radar'] as const,
  signals: ['warehouse', 'lease-market', 'signals'] as const,
  changes: ['warehouse', 'lease-market', 'changes'] as const,
  history: (id: number) => ['warehouse', 'lease-market', 'history', id] as const,
};

export function useLeaseMarketSummary() {
  return useQuery({ queryKey: LEASE_MARKET_KEYS.summary, queryFn: () => fetchParsedOrMirror(`${BASE}/summary`, LeaseMarketSummaryResponse), ...QUERY_OPTS });
}
export function useLeaseMarketPositioning() {
  return useQuery({ queryKey: LEASE_MARKET_KEYS.positioning, queryFn: () => fetchParsedOrMirror(`${BASE}/positioning`, PositioningResponse), ...QUERY_OPTS });
}
export function useLeaseMarketRadar() {
  return useQuery({ queryKey: LEASE_MARKET_KEYS.radar, queryFn: () => fetchParsedOrMirror(`${BASE}/radar`, RadarResponse), ...QUERY_OPTS });
}
export function useLeaseMarketSignals() {
  return useQuery({ queryKey: LEASE_MARKET_KEYS.signals, queryFn: () => fetchParsedOrMirror(`${BASE}/signals`, SignalsResponse), ...QUERY_OPTS });
}
export function useLeaseMarketChanges() {
  return useQuery({ queryKey: LEASE_MARKET_KEYS.changes, queryFn: () => fetchParsedOrMirror(`${BASE}/changes`, ChangesResponse), ...QUERY_OPTS });
}
export function useLeaseMarketHistory(listingId: number | null) {
  return useQuery({
    queryKey: LEASE_MARKET_KEYS.history(listingId ?? -1),
    queryFn: () => fetchParsedOrMirror(`${BASE}/history/${listingId}`, HistoryResponse),
    enabled: listingId !== null,
    ...QUERY_OPTS,
  });
}

export async function postRadarDecision(input: RadarDecisionInput) {
  // Fix round 2, item 4: literal path (not `${BASE}/...`) so check-write-schema-drift.ts's static scanner can match this caller.
  const res = await fetch('/api/warehouse/lease-market/radar/decision', { method: 'POST', headers: ORA_JSON_MUTATION_HEADERS, body: JSON.stringify(input) });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ? `Radar decision failed (${res.status}): ${body.error}` : `Radar decision failed (${res.status})`);
  }
  return RadarDecisionResponse.parse(await res.json());
}

export function useRadarDecision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: postRadarDecision,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LEASE_MARKET_KEYS.radar });
    },
  });
}

// ── Pure helpers ───────────────────────────────────────────────────────────────
export function fmtPsf(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `$${v.toFixed(2)}`;
}
export function fmtPct(v: number | null | undefined, signed = true): string {
  if (v === null || v === undefined) return '—';
  const pct = Math.round(v * 100);
  // A value that rounds to 0 (including tiny negatives, which Math.round can leave as -0) must
  // read as a plain "0%" — never "+0%" or "-0%".
  return signed && pct > 0 ? `+${pct}%` : `${pct}%`;
}
export function fmtSf(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `${Math.round(v).toLocaleString('en-US')} SF`;
}
export function fmtUsd(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `$${Math.round(v).toLocaleString('en-US')}`;
}

export function curvePointsFor(curve: readonly CurvePoint[], marketId: string): CurveDatum[] {
  return curve
    .filter((p) => p.marketId === marketId)
    .map((p) => ({ id: String(p.listingId), sf: p.availableSf, value: p.askingNnnEq, solid: p.solid, highlight: p.isOra, label: p.address ?? `${p.subtype} · ${fmtSf(p.availableSf)}` }));
}

export const KIND_LABELS: Record<SignalKind, string> = {
  radar_candidate: 'Radar candidate',
  below_market: 'Below market',
  stale: 'Stale',
  rent_cut: 'Rent cut',
  withdrawn_after_stale: 'Withdrawn after stale',
  new_listing: 'New listing',
};

export const EVENT_LABELS: Record<ListingEventKind, string> = {
  new: 'New', returned: 'Returned', price_cut: 'Price cut', price_increase: 'Price increase', sf_change: 'SF change',
  dom_reset: 'DOM reset', missing: 'Missing once', removed: 'Removed',
};

export const DECISION_LABELS: Record<RadarDecisionKind, string> = {
  investigate: 'Investigate', monitor: 'Monitor', pass: 'Pass', pursued: 'Pursued', loi: 'LOI', closed: 'Closed',
};

export function bandTone(band: PositioningBand): BadgeTone {
  return band === 'above' ? 'amber' : band === 'below' ? 'blue' : band === 'in_band' ? 'green' : 'neutral';
}
export function bandLabel(band: PositioningBand): string {
  return band === 'above' ? 'Above market' : band === 'below' ? 'Below market' : band === 'in_band' ? 'In range' : 'No ORA asking';
}

// Go-live change (2026-09-17): PositioningRow.source tells Gabriel whether a Rent Position row came
// from an ORA-owned CoStar listing (what CoStar says we're marketing) or a matched rent-roll vacancy
// (what our rent roll says is empty) — see the contract's own doc comment on PositioningRowSource.
export function sourceLabel(source: PositioningRowSource): string {
  return source === 'listing' ? 'CoStar listing' : 'Rent-roll vacancy';
}
export function sourceTone(source: PositioningRowSource): BadgeTone {
  return source === 'listing' ? 'gold' : 'purple';
}
export function severityTone(s: SignalSeverity): BadgeTone {
  return s === 'high' ? 'red' : s === 'watch' ? 'amber' : 'neutral';
}
export function confidenceTone(c: ConfidenceLabel | null): BadgeTone {
  return c === 'HIGH' ? 'green' : c === 'MEDIUM' ? 'blue' : 'neutral';
}

const num = (v: EvidenceValue | undefined): number | null => (typeof v === 'number' ? v : null);
const cuts = (n: number | null) => `${n ?? 0} cut${n === 1 ? '' : 's'}`;

export function evidenceSummary(s: SignalRow): string {
  const e = s.evidence;
  switch (s.kind) {
    case 'new_listing':
      return `${fmtSf(num(e.availableSf))} · ${num(e.askingNnnEq) === null ? 'rent withheld' : fmtPsf(num(e.askingNnnEq))}`;
    case 'stale':
      return `DOM ${num(e.effectiveDom) ?? '—'}d (threshold ${num(e.staleThresholdDays) ?? '—'}d)${e.domReset === true ? ' · DOM reset' : ''}${(num(e.reductionCount) ?? 0) > 0 ? ` · ${cuts(num(e.reductionCount))}` : ''}`;
    case 'rent_cut':
      return `${fmtPsf(num(e.prevAskingNnnEq))} → ${fmtPsf(num(e.askingNnnEq))} · ${cuts(num(e.reductionCount))}, ${fmtPct(num(e.cumulativeReductionPct))} since first ask`;
    case 'below_market':
      return `${fmtPsf(num(e.askingNnnEq))} vs comparable median ${fmtPsf(num(e.comparableMedian))} (${fmtPct(num(e.gapPct))}) · n ${num(e.comparableN) ?? '—'} ${typeof e.basis === 'string' ? e.basis : ''}`.trim();
    case 'withdrawn_after_stale':
      return `Removed ${typeof e.removedAt === 'string' ? e.removedAt : '—'} after ${num(e.domAtRemoval) ?? '—'}d · outcome unknown`;
    case 'radar_candidate':
      return `Score ${s.score ?? '—'}`;
  }
}

export function radarWhy(c: RadarCandidate): string {
  const p = c.parts;
  const bits: string[] = [];
  if (p.dom > 0) bits.push(`DOM ${c.maxEffectiveDom}d (+${p.dom})`);
  if (p.reductions > 0) bits.push(`${cuts(c.reductionCount)} ${fmtPct(c.cumulativeReductionPct)} (+${p.reductions})`);
  if (p.belowMarket > 0) bits.push(`${fmtPct(c.bestGapPct)} vs comps (+${p.belowMarket})`);
  if (p.vacancy > 0) bits.push(`vacancy ${fmtPct(c.vacancyShare, false)} (+${p.vacancy})`);
  if (p.buyBoxFit > 0) bits.push(`buy-box (+${p.buyBoxFit})`);
  if (p.owner > 0) bits.push(`owner ${c.ownerType} (+${p.owner})`);
  return bits.join(' · ');
}

// R3 (deferred UI-fix round): human labels for ResolvedComparables.unknown / ComparableStats.unknown,
// so a MEDIUM/LOW confidence caused by missing subject/comp data is explainable in the UI.
export const SIMILARITY_LABELS: Record<SimilarityComponent, string> = {
  location: 'location', size: 'size', clearHeight: 'clear height', age: 'age', loading: 'loading', office: 'office',
};
export function unknownLabel(unknown: readonly SimilarityComponent[]): string {
  return unknown.length === 0 ? '' : `unknown: ${unknown.map((c) => SIMILARITY_LABELS[c]).join(', ')}`;
}

export function eventSummary(e: ListingEventRow): string {
  switch (e.kind) {
    case 'price_cut':
    case 'price_increase':
      return `${fmtPsf(e.prevValue)} → ${fmtPsf(e.newValue)}`;
    case 'sf_change':
      return `${fmtSf(e.prevValue)} → ${fmtSf(e.newValue)}`;
    case 'dom_reset':
      return `CoStar DOM ${e.prevValue ?? '—'}d → ${e.newValue ?? '—'}d`;
    case 'new':
    case 'returned':
      return e.newValue === null ? 'rent withheld' : fmtPsf(e.newValue);
    case 'missing':
      return 'absent from latest complete export';
    case 'removed':
      return 'absent from two consecutive complete exports — outcome unknown';
  }
}
