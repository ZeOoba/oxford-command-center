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
  similarityPerPropertyCap: 3, similarityUnknownLowCap: 3,
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

  // ── Fix round 1: float tolerance regressions ──────────────────────────────
  it('reductions: depth band fires at exactly -0.1 despite floating-point rounding (EPS)', () => {
    // 9/10 - 1 = -0.09999999999999998 in IEEE 754 double precision; must still clear the -0.1 depth band.
    const parts = scoreRadar(prop({ spaces: [sp({ reductionCount: 1, cumulativeReductionPct: 9 / 10 - 1 })] }), ctx).parts;
    expect(parts.reductions).toBe(14); // 6 (count=1) + 8 (depth <= -0.1)
  });
  it('reductions: depth band at -0.05 from a division artifact still resolves to the shallow band', () => {
    // 19/20 - 1 = -0.050000000000000044 in IEEE 754 double precision.
    const parts = scoreRadar(prop({ spaces: [sp({ reductionCount: 0, cumulativeReductionPct: 19 / 20 - 1 })] }), ctx).parts;
    expect(parts.reductions).toBe(4); // 0 (count=0) + 4 (depth <= -0.05)
  });
  it('below market: gap fires at exactly the -0.15 band despite floating-point rounding (EPS)', () => {
    // (7.65 - 9) / 9 = -0.14999999999999997 in IEEE 754 double precision; must still clear the -0.15 band.
    const parts = scoreRadar(prop({ spaces: [sp({ askingNnnEq: 7.65, comparableMedian: 9, comparableConfidence: 'MEDIUM' })] }), ctx).parts;
    expect(parts.belowMarket).toBe(18);
  });

  // ── Fix round 1: decision-rule pins ───────────────────────────────────────
  it('radar candidate threshold: score exactly 50 is a candidate, exactly 49 is not', () => {
    // Shared parts: dom=25 (effectiveDom 300 >= 1.5x180), reductions=0, belowMarket=0 (askingNnnEq null),
    // vacancy=10 (10,000 / 30,000 = 0.333), owner=5 (private). Only subtype differs:
    //   warehouse -> buyBoxFit = 6 (size, 10-50K) + 4 (warehouse) = 10 -> total 25+10+10+5 = 50
    //   flex      -> buyBoxFit = 6 (size, 10-50K) + 3 (flex)      =  9 -> total 25+10+9+5  = 49
    const base = sp({ effectiveDom: 300, reductionCount: 0, cumulativeReductionPct: 0, askingNnnEq: null, comparableMedian: null, availableSf: 10000 });
    const at50 = scoreRadar(prop({ buildingSf: 30000, subtype: 'warehouse', ownerType: 'private', spaces: [base] }), ctx);
    expect(at50.score).toBe(50);
    expect(at50.isCandidate).toBe(true);
    const at49 = scoreRadar(prop({ buildingSf: 30000, subtype: 'flex', ownerType: 'private', spaces: [base] }), ctx);
    expect(at49.score).toBe(49);
    expect(at49.isCandidate).toBe(false);
  });

  it('best-gap across spaces: the most negative gap wins; subleases and LOW-confidence gaps are ignored', () => {
    const r = scoreRadar(prop({
      spaces: [
        sp({ listingId: 1, availableSf: 8000, askingNnnEq: 8.8, comparableMedian: 10, comparableConfidence: 'MEDIUM' }), // gap ~ -0.12
        sp({ listingId: 2, availableSf: 10000, askingNnnEq: 7.0, comparableMedian: 10, comparableConfidence: 'MEDIUM' }), // gap -0.30 (best)
        sp({ listingId: 3, availableSf: 9000, askingNnnEq: 5, comparableMedian: 10, comparableConfidence: 'MEDIUM', isSublease: true }), // ignored: sublease
        sp({ listingId: 4, availableSf: 9000, askingNnnEq: 5, comparableMedian: 10, comparableConfidence: 'LOW' }), // ignored: LOW confidence
      ],
    }), ctx);
    expect(r.bestGapPct).toBeCloseTo(-0.3, 5);
    expect(r.parts.belowMarket).toBe(25);
    expect(r.indicativeRentGapUsd).toBeCloseTo(30000); // (10 - 7.0) * 10000, from the -0.30 space
  });

  it('confidence ranks to the highest among live spaces when no best-gap space exists', () => {
    const r = scoreRadar(prop({
      spaces: [
        sp({ listingId: 1, comparableConfidence: 'LOW', askingNnnEq: null }),
        sp({ listingId: 2, comparableConfidence: 'HIGH', askingNnnEq: null }),
        sp({ listingId: 3, comparableConfidence: 'MEDIUM', askingNnnEq: null }),
      ],
    }), ctx);
    expect(r.confidence).toBe('HIGH');
    expect(r.comparableMedian).toBeNull(); // no best-gap space -> comparableMedian falls to null, not a fallback find
  });

  it('vacancy share is reported raw (unclamped) while points clamp at 1', () => {
    const r = scoreRadar(prop({ buildingSf: 30000, spaces: [sp({ availableSf: 40000 })] }), ctx);
    expect(r.parts.vacancy).toBe(15);
    expect(r.vacancyShare).toBeCloseTo(1.333, 3);
  });

  it('buy-box size points at both boundaries (10K and 50K) and affiliated owner points', () => {
    expect(scoreRadar(prop({ buildingSf: 10000 }), ctx).parts.buyBoxFit).toBe(10); // size 6 + warehouse 4
    expect(scoreRadar(prop({ buildingSf: 50000 }), ctx).parts.buyBoxFit).toBe(10); // size 6 + warehouse 4
    expect(scoreRadar(prop({ ownerType: 'affiliated' }), ctx).parts.owner).toBe(2);
  });

  // ── Fix round 1: NaN guards ────────────────────────────────────────────────
  it('a non-finite effective DOM does not crash scoring and yields dom=0', () => {
    const r = scoreRadar(prop({ spaces: [sp({ effectiveDom: Number.POSITIVE_INFINITY })] }), ctx);
    expect(r.parts.dom).toBe(0);
    expect(Number.isFinite(r.score)).toBe(true);
  });
  it('skips a space with a non-finite askingNnnEq when selecting the best gap', () => {
    const r = scoreRadar(prop({
      spaces: [
        sp({ listingId: 1, askingNnnEq: Number.NaN, comparableMedian: 10 }),
        sp({ listingId: 2, askingNnnEq: 7.5, comparableMedian: 10 }), // gap -0.25
      ],
    }), ctx);
    expect(r.parts.belowMarket).toBe(25);
    expect(r.bestGapPct).toBeCloseTo(-0.25, 5);
  });

  // ── Fix round 1: buildingSf <= 0 treated as unknown ───────────────────────
  it('buildingSf <= 0 is treated as unknown: gated, size points 0, vacancyShare null', () => {
    for (const buildingSf of [0, -500]) {
      const r = scoreRadar(prop({ buildingSf }), ctx);
      expect(r.eligible).toBe(false);
      expect(r.gateFailures.join('; ')).toMatch(/building SF unknown/);
      expect(r.vacancyShare).toBeNull();
      expect(r.parts.buyBoxFit).toBe(4); // 0 size points + warehouse subtype 4
    }
  });
});
