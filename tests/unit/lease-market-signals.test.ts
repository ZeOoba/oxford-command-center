// tests/unit/lease-market-signals.test.ts
import { describe, it, expect } from 'vitest';
import {
  completedDomBaseline, domReset, effectiveDom, spaceSignals, staleThresholdDays,
  type ObservationPoint, type SpaceHistory, type SpaceSignalContext,
} from '../../src/analytics/lease-market/signals';
import type { ResolvedComparables } from '../../src/analytics/lease-market/similarity';
import type { LmThresholds } from '../../src/contracts/lease-market';

const T: LmThresholds = {
  benchmarkMinN: 5, belowMarketMinN: 10, belowMarketMedianRatio: 0.85, lowCoverageQuotedShare: 0.5, staleFloorDays: 180,
  staleBaselineMultiple: 1.5, staleFallbackDays: { established: 180, entry: 270 }, completedDomMinN: 10, vacancyShareMin: 0.3,
  candidateMaxBuildingSf: 50000, benchmarkMaxBuildingSf: 80000, positioningBandPct: 0.1, rangeMaxSpread: 0.2, monthlyValueCeiling: 3,
  rentMinPsfYr: 1, rentMaxPsfYr: 60, quotedOpexMinN: 5, exportMinRowRatio: 0.7, exportRowCap: 2000, freshnessDays: 35,
  flexOfficeSplitPct: 40, similarityMinScore: 60, similarityTopK: 15, similarityMinComps: 8, similarityHighComps: 15,
  radarMinScore: 50, radarPushScore: 70, withdrawnLookbackDays: 90, sfChangePct: 0.05,
};

const obs = (patch: Partial<ObservationPoint> = {}): ObservationPoint => ({ observedAt: '2026-03-01', availableSf: 5000, askingNnnEq: 9, rentLow: 9, costarDom: 10, isSublease: false, eligible: true, ...patch });
const space = (patch: Partial<SpaceHistory> = {}): SpaceHistory => ({
  listingId: 1, propertyId: 7, marketId: 'columbus', addressDisplay: '1 Main St', buildingStatus: 'existing', isOraOwned: false,
  status: 'active', removedAt: null, firstSeen: '2026-02-01', costarDateOnMarket: '2026-02-01', isNewInLatestExport: false,
  observations: [obs()], priceCutInLatestExport: false, reductionCount: 0, originalAsking: 9, cumulativeReductionPct: 0, ...patch,
});
const comps = (patch: Partial<ResolvedComparables> = {}): ResolvedComparables => ({
  basis: 'similarity', n: 12, low: 7, p25: 8.2, median: 9, p75: 10, high: 11, values: [], confidence: 'MEDIUM', cellKey: 'k', comps: [], ...patch,
});
const ctx = (patch: Partial<SpaceSignalContext> = {}): SpaceSignalContext => ({ asOf: '2026-03-01', staleThresholdDays: 180, propertyVacancyShare: 0.1, comparables: comps(), thresholds: T, ...patch });
const kinds = (h: SpaceHistory, c: SpaceSignalContext) => spaceSignals(h, c).map((s) => s.kind).sort();

describe('DOM helpers', () => {
  it('effective DOM keeps the older clock', () => {
    expect(effectiveDom({ firstSeen: '2026-01-01', costarDateOnMarket: '2025-06-01' }, '2026-03-01')).toBe(273);
    expect(effectiveDom({ firstSeen: '2026-01-01', costarDateOnMarket: null }, '2026-03-01')).toBe(59);
  });
  it('detects a CoStar DOM reset', () => {
    expect(domReset([obs({ costarDom: 200 }), obs({ costarDom: 30 })])).toBe(true);
    expect(domReset([obs({ costarDom: 30 }), obs({ costarDom: 60 })])).toBe(false);
  });
  it('stale threshold and baseline', () => {
    expect(staleThresholdDays(null, 'entry', T)).toBe(270);
    expect(staleThresholdDays(100, 'established', T)).toBe(180);
    expect(staleThresholdDays(200, 'established', T)).toBe(300);
    expect(completedDomBaseline([1, 2, 3, 4, 5, 6, 7, 8, 9], 10)).toBeNull();
    expect(completedDomBaseline([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 10)).toBe(5.5);
  });
});

describe('spaceSignals', () => {
  it('emits nothing for ORA-owned spaces', () => {
    expect(spaceSignals(space({ isOraOwned: true, isNewInLatestExport: true }), ctx())).toEqual([]);
  });
  it('new listing carries comparable metadata', () => {
    const [s] = spaceSignals(space({ isNewInLatestExport: true }), ctx());
    expect(s).toMatchObject({ kind: 'new_listing', severity: 'info', propertyId: 7, listingId: 1, confidence: 'MEDIUM', compBasis: 'similarity', cellKey: 'k', score: null });
  });
  it('rent cut from the latest export event, with reduction history', () => {
    const [s] = spaceSignals(space({ priceCutInLatestExport: true, reductionCount: 2, originalAsking: 10, cumulativeReductionPct: -0.1, observations: [obs({ askingNnnEq: 9.5 }), obs({ askingNnnEq: 9 })] }), ctx());
    expect(s).toMatchObject({ kind: 'rent_cut', severity: 'watch' });
    expect(s!.evidence).toMatchObject({ originalAsking: 10, prevAskingNnnEq: 9.5, askingNnnEq: 9, reductionCount: 2, cumulativeReductionPct: -0.1 });
  });
  it('stale severity rises with reductions or building vacancy', () => {
    const old = { firstSeen: '2026-01-01', costarDateOnMarket: '2025-06-01' };
    expect(spaceSignals(space(old), ctx())[0]).toMatchObject({ kind: 'stale', severity: 'watch' });
    expect(spaceSignals(space({ ...old, reductionCount: 1 }), ctx())[0]!.severity).toBe('high');
    expect(spaceSignals(space(old), ctx({ propertyVacancyShare: 0.4 }))[0]!.severity).toBe('high');
    expect(kinds(space({ ...old, buildingStatus: 'proposed' }), ctx())).toEqual([]);
  });
  it('below market needs confidence >= MEDIUM and both thresholds', () => {
    const cheap = space({ observations: [obs({ askingNnnEq: 7.5 })] });
    expect(kinds(cheap, ctx())).toEqual(['below_market']);
    expect(kinds(space({ observations: [obs({ askingNnnEq: 7.8 })] }), ctx())).toEqual([]);
    expect(kinds(cheap, ctx({ comparables: comps({ confidence: 'LOW' }) }))).toEqual([]);
    expect(kinds(cheap, ctx({ comparables: null }))).toEqual([]);
    expect(kinds(space({ observations: [obs({ askingNnnEq: 7.5, eligible: false })] }), ctx())).toEqual([]);
    expect(spaceSignals(cheap, ctx())[0]!.evidence).toMatchObject({ comparableMedian: 9, comparableP25: 8.2, comparableN: 12, basis: 'similarity' });
  });
  it('withdrawn after stale: removed within lookback after a stale run', () => {
    const removed = space({ status: 'removed', removedAt: '2026-02-15', firstSeen: '2025-06-01', costarDateOnMarket: null, isNewInLatestExport: true });
    expect(spaceSignals(removed, ctx())).toEqual([expect.objectContaining({ kind: 'withdrawn_after_stale', severity: 'info', evidence: expect.objectContaining({ outcome: 'unknown', domAtRemoval: 259 }) })]);
    expect(spaceSignals({ ...removed, removedAt: '2025-11-01' }, ctx())).toEqual([]); // outside 90 days
    expect(spaceSignals({ ...removed, firstSeen: '2026-01-01' }, ctx())).toEqual([]); // DOM 45 at removal
  });
});
