// tests/unit/lease-market-radar.test.ts
import { describe, it, expect } from 'vitest';
import { scoreRadar, type RadarPropertyInput, type RadarSpaceInput } from '../../src/analytics/lease-market/radar';
import type { LmThresholds } from '../../src/contracts/lease-market';

const T: LmThresholds = {
  benchmarkMinN: 5, belowMarketMinN: 10, belowMarketMedianRatio: 0.85, lowCoverageQuotedShare: 0.5, staleFloorDays: 180,
  staleBaselineMultiple: 1.5, staleFallbackDays: { established: 180, entry: 270 }, completedDomMinN: 10, vacancyShareMin: 0.3,
  candidateMaxBuildingSf: 50000, benchmarkMaxBuildingSf: 80000, positioningBandPct: 0.1, rangeMaxSpread: 0.2, monthlyValueCeiling: 3,
  rentMinPsfYr: 1, rentMaxPsfYr: 60, quotedOpexMinN: 5, exportMinRowRatio: 0.7, exportRowCap: 2000, freshnessDays: 35,
  flexOfficeSplitPct: 40, similarityMinScore: 60, similarityTopK: 15, similarityMinComps: 8, similarityHighComps: 15,
  radarMinScore: 50, radarPushScore: 70, withdrawnLookbackDays: 90, sfChangePct: 0.05,
};

const sp = (patch: Partial<RadarSpaceInput> = {}): RadarSpaceInput => ({
  listingId: 1, availableSf: 12000, isSublease: false, effectiveDom: 300, reductionCount: 2, cumulativeReductionPct: -0.12,
  askingNnnEq: 7, eligible: true, comparableMedian: 9.3, comparableConfidence: 'MEDIUM', ...patch,
});
const prop = (patch: Partial<RadarPropertyInput> = {}): RadarPropertyInput => ({
  propertyId: 5, buildingSf: 30000, buildingStatus: 'existing', subtype: 'warehouse', ownerType: 'private', isOraOwned: false, spaces: [sp()], ...patch,
});
const ctx = { staleThresholdDays: 180, ownerScreenAvailable: true, thresholds: T };

describe('scoreRadar', () => {
  it('scores a strong candidate with every part visible', () => {
    const r = scoreRadar(prop(), ctx);
    expect(r.parts).toEqual({ dom: 25, reductions: 20, belowMarket: 18, vacancy: 10, buyBoxFit: 10, owner: 5 });
    expect(r).toMatchObject({ score: 88, eligible: true, isCandidate: true, gateFailures: [], confidence: 'MEDIUM', maxEffectiveDom: 300, reductionCount: 2, cumulativeReductionPct: -0.12, comparableMedian: 9.3 });
    expect(r.vacancyShare).toBeCloseTo(0.4);
    expect(r.bestGapPct).toBeCloseTo(-0.2473, 3);
    expect(r.indicativeRentGapUsd).toBeCloseTo(27600);
  });

  it('does not make a candidate from a weak profile', () => {
    const r = scoreRadar(prop({ spaces: [sp({ effectiveDom: 100, reductionCount: 0, cumulativeReductionPct: 0, askingNnnEq: 9.3, availableSf: 3000 })] }), ctx);
    expect(r).toMatchObject({ score: 15, isCandidate: false, eligible: true, indicativeRentGapUsd: null });
  });

  it.each([
    ['owner screen unavailable', {}, { ...ctx, ownerScreenAvailable: false }, /owner screen/],
    ['institutional owner', { ownerType: 'institutional' as const }, ctx, /owner type institutional/],
    ['never-call owner', { ownerType: 'never_call' as const }, ctx, /owner type never_call/],
    ['unscreened owner', { ownerType: 'unknown' as const }, ctx, /owner type unknown/],
    ['ORA-owned', { isOraOwned: true }, ctx, /ORA-owned/],
    ['unknown building SF', { buildingSf: null }, ctx, /building SF unknown/],
    ['building over 50K', { buildingSf: 60000 }, ctx, /> 50000/],
    ['proposed building', { buildingStatus: 'proposed' as const }, ctx, /building proposed/],
    ['sublease-only', { spaces: [sp({ isSublease: true })] }, ctx, /no direct/],
  ])('gates: %s', (_l, patch, c, re) => {
    const r = scoreRadar(prop(patch), c);
    expect(r.eligible).toBe(false);
    expect(r.isCandidate).toBe(false);
    expect(r.gateFailures.join('; ')).toMatch(re);
  });

  it('band boundaries', () => {
    const at = (s: Partial<RadarSpaceInput>) => scoreRadar(prop({ spaces: [sp(s)] }), ctx).parts;
    expect(at({ effectiveDom: 270 }).dom).toBe(25);
    expect(at({ effectiveDom: 269 }).dom).toBe(18);
    expect(at({ effectiveDom: 180 }).dom).toBe(18);
    expect(at({ effectiveDom: 135 }).dom).toBe(10);
    expect(at({ effectiveDom: 134 }).dom).toBe(0);
    expect(at({ reductionCount: 1, cumulativeReductionPct: -0.05 }).reductions).toBe(10);
    expect(at({ reductionCount: 0, cumulativeReductionPct: -0.049 }).reductions).toBe(0);
    expect(at({ comparableMedian: 10, askingNnnEq: 7.5 }).belowMarket).toBe(25);
    expect(at({ comparableMedian: 10, askingNnnEq: 8.5 }).belowMarket).toBe(18);
    expect(at({ comparableMedian: 10, askingNnnEq: 9 }).belowMarket).toBe(10);
    expect(at({ comparableMedian: 10, askingNnnEq: 9.1 }).belowMarket).toBe(0);
    expect(at({ comparableMedian: 10, askingNnnEq: 7.5, comparableConfidence: 'LOW' }).belowMarket).toBe(0);
    expect(at({ availableSf: 15000 }).vacancy).toBe(15);
    expect(at({ availableSf: 4500 }).vacancy).toBe(5);
    expect(scoreRadar(prop({ buildingSf: 8000, subtype: 'flex', spaces: [sp({ availableSf: 4000 })] }), ctx).parts.buyBoxFit).toBe(6);
    expect(scoreRadar(prop({ ownerType: 'verify' }), ctx).parts.owner).toBe(2);
  });

  it('aggregates vacancy across live spaces and ignores subleases', () => {
    const r = scoreRadar(prop({ spaces: [sp({ listingId: 1, availableSf: 6000 }), sp({ listingId: 2, availableSf: 6000 }), sp({ listingId: 3, availableSf: 9000, isSublease: true })] }), ctx);
    expect(r.vacancyShare).toBeCloseTo(0.4);
    expect(r.parts.vacancy).toBe(10);
  });
});
