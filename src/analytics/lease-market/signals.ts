// src/analytics/lease-market/signals.ts
//
// Lease Market Intelligence — per-space signals (spec rev 3 §3.7). Pure; no I/O.
// Internal analytics only; promotion to recon/outreach is a manual human action. Refute pass required.
import type {
  BuildingStatus, CompBasis, ConfidenceLabel, EvidenceValue, ListingStatus, LmThresholds, SignalKind, SignalSeverity,
} from '../../contracts/lease-market';
import { medianOf } from './benchmarks';
import { daysBetween } from './normalize';
import type { ResolvedComparables } from './similarity';

const EPS = 1e-9;

export interface ObservationPoint {
  observedAt: string;
  availableSf: number;
  askingNnnEq: number | null;
  rentLow: number | null;
  costarDom: number | null;
  isSublease: boolean;
  eligible: boolean;
}

export interface SpaceHistory {
  listingId: number;
  propertyId: number;
  marketId: string;
  addressDisplay: string;
  buildingStatus: BuildingStatus;
  isOraOwned: boolean;
  status: ListingStatus;
  removedAt: string | null;
  firstSeen: string;
  costarDateOnMarket: string | null;
  isNewInLatestExport: boolean;
  /** Ascending by observedAt. */
  observations: ObservationPoint[];
  priceCutInLatestExport: boolean;
  reductionCount: number;
  originalAsking: number | null;
  cumulativeReductionPct: number | null;
}

export function effectiveDom(h: Pick<SpaceHistory, 'firstSeen' | 'costarDateOnMarket'>, asOf: string): number {
  const own = daysBetween(h.firstSeen, asOf);
  const costar = h.costarDateOnMarket ? daysBetween(h.costarDateOnMarket, asOf) : 0;
  return Math.max(0, own, costar);
}

export function domReset(observations: readonly ObservationPoint[]): boolean {
  for (let i = 1; i < observations.length; i++) {
    const a = observations[i - 1]!.costarDom;
    const b = observations[i]!.costarDom;
    if (a !== null && b !== null && b < a) return true;
  }
  return false;
}

export function staleThresholdDays(baseline: number | null, tier: 'established' | 'entry', t: LmThresholds): number {
  if (baseline === null) return t.staleFallbackDays[tier];
  return Math.max(t.staleFloorDays, Math.round(t.staleBaselineMultiple * baseline));
}

export function completedDomBaseline(domsAtRemoval: readonly number[], minN: number): number | null {
  return domsAtRemoval.length >= minN ? medianOf(domsAtRemoval) : null;
}

export interface SignalDraft {
  propertyId: number;
  listingId: number | null;
  kind: SignalKind;
  severity: SignalSeverity;
  score: number | null;
  confidence: ConfidenceLabel | null;
  compBasis: CompBasis | null;
  cellKey: string | null;
  evidence: Record<string, EvidenceValue>;
}

export interface SpaceSignalContext {
  asOf: string;
  staleThresholdDays: number;
  propertyVacancyShare: number | null;
  comparables: ResolvedComparables | null;
  thresholds: LmThresholds;
}

export function spaceSignals(h: SpaceHistory, ctx: SpaceSignalContext): SignalDraft[] {
  if (h.isOraOwned || h.observations.length === 0) return [];
  const t = ctx.thresholds;
  const latest = h.observations[h.observations.length - 1]!;
  const prev = h.observations.length > 1 ? h.observations[h.observations.length - 2]! : null;
  const c = ctx.comparables;
  const out: SignalDraft[] = [];
  const push = (kind: SignalKind, severity: SignalSeverity, evidence: Record<string, EvidenceValue>) =>
    out.push({ propertyId: h.propertyId, listingId: h.listingId, kind, severity, score: null, confidence: c?.confidence ?? null, compBasis: c?.basis ?? null, cellKey: c?.cellKey ?? null, evidence });

  if (h.status === 'removed') {
    if (h.removedAt === null || h.buildingStatus !== 'existing') return [];
    const since = daysBetween(h.removedAt, ctx.asOf);
    const domAtRemoval = effectiveDom(h, h.removedAt);
    if (since >= 0 && since <= t.withdrawnLookbackDays && domAtRemoval >= ctx.staleThresholdDays) {
      push('withdrawn_after_stale', 'info', {
        address: h.addressDisplay, removedAt: h.removedAt, domAtRemoval, staleThresholdDays: ctx.staleThresholdDays,
        lastAskingNnnEq: latest.askingNnnEq, availableSf: latest.availableSf, outcome: 'unknown',
      });
    }
    return out;
  }
  if (h.status !== 'active' && h.status !== 'missing_once') return [];

  const dom = effectiveDom(h, ctx.asOf);
  // domSource: whichever clock actually produced the effective DOM (the CoStar clock only wins ties/exceeds).
  const ownDays = daysBetween(h.firstSeen, ctx.asOf);
  const costarDays = h.costarDateOnMarket ? daysBetween(h.costarDateOnMarket, ctx.asOf) : null;
  const domSource: EvidenceValue = costarDays !== null && costarDays >= ownDays ? 'costar_date_on_market' : 'first_seen';
  const base: Record<string, EvidenceValue> = {
    address: h.addressDisplay,
    effectiveDom: dom,
    domReset: domReset(h.observations),
    domSource,
    availableSf: latest.availableSf,
    askingNnnEq: latest.askingNnnEq,
    propertyVacancyShare: ctx.propertyVacancyShare,
    status: h.status,
  };

  if (h.isNewInLatestExport) push('new_listing', 'info', base);
  if (h.priceCutInLatestExport) {
    push('rent_cut', 'watch', {
      ...base, originalAsking: h.originalAsking, prevAskingNnnEq: prev?.askingNnnEq ?? null,
      reductionCount: h.reductionCount, cumulativeReductionPct: h.cumulativeReductionPct,
    });
  }
  if (h.buildingStatus === 'existing' && dom >= ctx.staleThresholdDays) {
    const high = h.reductionCount > 0 || (ctx.propertyVacancyShare !== null && ctx.propertyVacancyShare >= t.vacancyShareMin - EPS);
    push('stale', high ? 'high' : 'watch', { ...base, staleThresholdDays: ctx.staleThresholdDays, reductionCount: h.reductionCount });
  }
  if (
    latest.eligible && latest.askingNnnEq !== null && c !== null && c.confidence !== 'LOW' &&
    c.median !== null && c.p25 !== null &&
    latest.askingNnnEq <= c.p25 + EPS && latest.askingNnnEq <= t.belowMarketMedianRatio * c.median + EPS
  ) {
    push('below_market', 'watch', {
      ...base, comparableMedian: c.median, comparableP25: c.p25, comparableN: c.n, basis: c.basis,
      gapPct: (latest.askingNnnEq - c.median) / c.median,
    });
  }
  return out;
}
