### Task 06: Space signals + Acquisition Radar score (pure)

**Files:**
- Create: `src/analytics/lease-market/signals.ts`
- Create: `src/analytics/lease-market/radar.ts`
- Test: `tests/unit/lease-market-signals.test.ts`, `tests/unit/lease-market-radar.test.ts`

**Interfaces:**
- Consumes: Task 02 types; Task 03 `daysBetween`; Task 04 `medianOf`; Task 05 `ResolvedComparables`.
- Produces (signals.ts):
  - `interface ObservationPoint { observedAt: string; availableSf: number; askingNnnEq: number|null; rentLow: number|null; costarDom: number|null; isSublease: boolean; eligible: boolean }`
  - `interface SpaceHistory { listingId: number; propertyId: number; marketId: string; addressDisplay: string; buildingStatus: BuildingStatus; isOraOwned: boolean; status: ListingStatus; removedAt: string|null; firstSeen: string; costarDateOnMarket: string|null; isNewInLatestExport: boolean; observations: ObservationPoint[]; priceCutInLatestExport: boolean; reductionCount: number; originalAsking: number|null; cumulativeReductionPct: number|null }` (observations ascending)
  - `effectiveDom(h: Pick<SpaceHistory,'firstSeen'|'costarDateOnMarket'>, asOf: string): number` · `domReset(obs): boolean` · `staleThresholdDays(baseline: number|null, tier, t): number` · `completedDomBaseline(doms, minN): number|null`
  - `interface SignalDraft { propertyId: number; listingId: number|null; kind: SignalKind; severity: SignalSeverity; score: number|null; confidence: ConfidenceLabel|null; compBasis: CompBasis|null; cellKey: string|null; evidence: Record<string, EvidenceValue> }`
  - `interface SpaceSignalContext { asOf: string; staleThresholdDays: number; propertyVacancyShare: number|null; comparables: ResolvedComparables|null; thresholds: LmThresholds }`
  - `spaceSignals(h: SpaceHistory, ctx: SpaceSignalContext): SignalDraft[]`
- Produces (radar.ts):
  - `interface RadarSpaceInput { listingId: number; availableSf: number; isSublease: boolean; effectiveDom: number; reductionCount: number; cumulativeReductionPct: number|null; askingNnnEq: number|null; eligible: boolean; comparableMedian: number|null; comparableConfidence: ConfidenceLabel }`
  - `interface RadarPropertyInput { propertyId: number; buildingSf: number|null; buildingStatus: BuildingStatus; subtype: LmSubtype; ownerType: OwnerType; isOraOwned: boolean; spaces: RadarSpaceInput[] }`
  - `interface RadarContext { staleThresholdDays: number; ownerScreenAvailable: boolean; thresholds: LmThresholds }`
  - `interface RadarResult { eligible: boolean; gateFailures: string[]; isCandidate: boolean; score: number; parts: RadarScoreParts; confidence: ConfidenceLabel; vacancyShare: number|null; maxEffectiveDom: number; reductionCount: number; cumulativeReductionPct: number|null; bestGapPct: number|null; comparableMedian: number|null; indicativeRentGapUsd: number|null }`
  - `scoreRadar(p: RadarPropertyInput, ctx: RadarContext): RadarResult`

**Space signal rules (spec rev 3 §3.7):** ORA-owned or no observations ⇒ none. `removed` spaces emit only `withdrawn_after_stale` (info) when removed within `withdrawnLookbackDays`, building existing, and effective DOM at `removedAt` ≥ stale threshold; evidence includes `outcome: 'unknown'`. `active`/`missing_once` spaces: `new_listing` (info) if `isNewInLatestExport`; `rent_cut` (watch) if `priceCutInLatestExport`; `stale` if existing and effective DOM ≥ threshold — severity high when `reductionCount > 0` or property vacancy share ≥ `vacancyShareMin`, else watch; `below_market` (watch) if latest eligible, comparables confidence ≠ LOW, median and P25 present, asking ≤ P25 and ≤ `belowMarketMedianRatio` × median. Every draft carries `confidence`, `compBasis`, `cellKey` from `ctx.comparables` when present; `score` is null.

**Radar rules (spec rev 3 §3.8):** "live" spaces = non-sublease spaces. Gates: owner screen available · owner type ∉ {institutional, never_call, unknown} · not ORA-owned · building SF known and ≤ `candidateMaxBuildingSf` · building existing · ≥ 1 live space. Parts are ALWAYS computed (shown even when gated): dom (ratio of max live effective DOM to threshold: < 0.75 ⇒ 0, < 1 ⇒ 10, < 1.5 ⇒ 18, else 25) · reductions (max live count ≥ 2 ⇒ 12, = 1 ⇒ 6; min live cumulative ≤ −10% ⇒ +8, ≤ −5% ⇒ +4; cap 20) · belowMarket (best = min gap over live spaces that are eligible with asking and comparable median and confidence ≠ LOW: ≤ −25% ⇒ 25, ≤ −15% ⇒ 18, ≤ −10% ⇒ 10) · vacancy (Σ live available ÷ building SF, clamped to 1 for points: ≥ 0.5 ⇒ 15, ≥ 0.3 ⇒ 10, ≥ 0.15 ⇒ 5) · buyBoxFit (building 10,000–50,000 ⇒ 6, < 10,000 ⇒ 3, else 0; + warehouse 4 / flex 3) · owner (private 5, verify/affiliated 2, else 0). `indicativeRentGapUsd` = (median − asking) × available SF of the best-gap space when that gap < 0, else null. `confidence` = highest comparable confidence among live spaces (LOW if none). `isCandidate` ⇔ eligible and score ≥ `radarMinScore`.

- [ ] **Step 1: Write the failing signals test**

```ts
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
```

- [ ] **Step 2: Write the failing radar test**

```ts
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
```

- [ ] **Step 3:** `npx vitest run tests/unit/lease-market-signals.test.ts tests/unit/lease-market-radar.test.ts` — Expected: FAIL.

- [ ] **Step 4: Write signals.ts**

```ts
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
  const base: Record<string, EvidenceValue> = {
    address: h.addressDisplay,
    effectiveDom: dom,
    domReset: domReset(h.observations),
    domSource: h.costarDateOnMarket ? 'costar_date_on_market' : 'first_seen',
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
    const high = h.reductionCount > 0 || (ctx.propertyVacancyShare !== null && ctx.propertyVacancyShare >= t.vacancyShareMin);
    push('stale', high ? 'high' : 'watch', { ...base, staleThresholdDays: ctx.staleThresholdDays, reductionCount: h.reductionCount });
  }
  if (
    latest.eligible && latest.askingNnnEq !== null && c !== null && c.confidence !== 'LOW' &&
    c.median !== null && c.p25 !== null &&
    latest.askingNnnEq <= c.p25 && latest.askingNnnEq <= t.belowMarketMedianRatio * c.median
  ) {
    push('below_market', 'watch', {
      ...base, comparableMedian: c.median, comparableP25: c.p25, comparableN: c.n, basis: c.basis,
      gapPct: (latest.askingNnnEq - c.median) / c.median,
    });
  }
  return out;
}
```

- [ ] **Step 5: Write radar.ts**

```ts
// src/analytics/lease-market/radar.ts
//
// Lease Market Intelligence — Acquisition Radar (spec rev 3 §3.8, cross-exam A9). Pure; no I/O.
// Hard gates decide eligibility; a transparent 100-point score ranks. Every part is returned so the
// dashboard can show exactly why a property surfaced. indicativeRentGapUsd is gross, vacant space only —
// NOT NOI (cross-exam R5). Refute pass required.
import type { BuildingStatus, ConfidenceLabel, LmSubtype, LmThresholds, OwnerType, RadarScoreParts } from '../../contracts/lease-market';

export interface RadarSpaceInput {
  listingId: number;
  availableSf: number;
  isSublease: boolean;
  effectiveDom: number;
  reductionCount: number;
  cumulativeReductionPct: number | null;
  askingNnnEq: number | null;
  eligible: boolean;
  comparableMedian: number | null;
  comparableConfidence: ConfidenceLabel;
}

export interface RadarPropertyInput {
  propertyId: number;
  buildingSf: number | null;
  buildingStatus: BuildingStatus;
  subtype: LmSubtype;
  ownerType: OwnerType;
  isOraOwned: boolean;
  spaces: RadarSpaceInput[];
}

export interface RadarContext {
  staleThresholdDays: number;
  ownerScreenAvailable: boolean;
  thresholds: LmThresholds;
}

export interface RadarResult {
  eligible: boolean;
  gateFailures: string[];
  isCandidate: boolean;
  score: number;
  parts: RadarScoreParts;
  confidence: ConfidenceLabel;
  vacancyShare: number | null;
  maxEffectiveDom: number;
  reductionCount: number;
  cumulativeReductionPct: number | null;
  bestGapPct: number | null;
  comparableMedian: number | null;
  indicativeRentGapUsd: number | null;
}

const EXCLUDED_OWNERS: ReadonlySet<OwnerType> = new Set<OwnerType>(['institutional', 'never_call', 'unknown']);
const CONFIDENCE_RANK: Record<ConfidenceLabel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

export function scoreRadar(p: RadarPropertyInput, ctx: RadarContext): RadarResult {
  const t = ctx.thresholds;
  const live = p.spaces.filter((s) => !s.isSublease);

  const gateFailures: string[] = [];
  if (!ctx.ownerScreenAvailable) gateFailures.push('owner screen unavailable');
  if (EXCLUDED_OWNERS.has(p.ownerType)) gateFailures.push(`owner type ${p.ownerType}`);
  if (p.isOraOwned) gateFailures.push('ORA-owned');
  if (p.buildingSf === null) gateFailures.push('building SF unknown');
  else if (p.buildingSf > t.candidateMaxBuildingSf) gateFailures.push(`building ${p.buildingSf} SF > ${t.candidateMaxBuildingSf}`);
  if (p.buildingStatus !== 'existing') gateFailures.push(`building ${p.buildingStatus}`);
  if (live.length === 0) gateFailures.push('no direct (non-sublease) space');

  const maxEffectiveDom = live.reduce((m, s) => Math.max(m, s.effectiveDom), 0);
  const domRatio = ctx.staleThresholdDays > 0 ? maxEffectiveDom / ctx.staleThresholdDays : 0;
  const dom = domRatio < 0.75 ? 0 : domRatio < 1 ? 10 : domRatio < 1.5 ? 18 : 25;

  const reductionCount = live.reduce((m, s) => Math.max(m, s.reductionCount), 0);
  const depths = live.map((s) => s.cumulativeReductionPct).filter((v): v is number => v !== null);
  const cumulativeReductionPct = depths.length > 0 ? Math.min(...depths) : null;
  const countPts = reductionCount >= 2 ? 12 : reductionCount === 1 ? 6 : 0;
  const depthPts = cumulativeReductionPct !== null && cumulativeReductionPct <= -0.1 ? 8 : cumulativeReductionPct !== null && cumulativeReductionPct <= -0.05 ? 4 : 0;
  const reductions = Math.min(20, countPts + depthPts);

  let bestGapPct: number | null = null;
  let bestSpace: RadarSpaceInput | null = null;
  for (const s of live) {
    if (!s.eligible || s.askingNnnEq === null || s.comparableMedian === null || s.comparableMedian <= 0 || s.comparableConfidence === 'LOW') continue;
    const gap = (s.askingNnnEq - s.comparableMedian) / s.comparableMedian;
    if (bestGapPct === null || gap < bestGapPct) {
      bestGapPct = gap;
      bestSpace = s;
    }
  }
  const belowMarket = bestGapPct === null ? 0 : bestGapPct <= -0.25 ? 25 : bestGapPct <= -0.15 ? 18 : bestGapPct <= -0.1 ? 10 : 0;

  const liveSf = live.reduce((sum, s) => sum + s.availableSf, 0);
  const vacancyShare = p.buildingSf !== null && p.buildingSf > 0 ? liveSf / p.buildingSf : null;
  const shareForPoints = vacancyShare === null ? 0 : Math.min(1, vacancyShare);
  const vacancy = shareForPoints >= 0.5 ? 15 : shareForPoints >= 0.3 ? 10 : shareForPoints >= 0.15 ? 5 : 0;

  const sizePts = p.buildingSf === null ? 0 : p.buildingSf >= 10000 && p.buildingSf <= 50000 ? 6 : p.buildingSf < 10000 ? 3 : 0;
  const buyBoxFit = sizePts + (p.subtype === 'warehouse' ? 4 : 3);
  const owner = p.ownerType === 'private' ? 5 : p.ownerType === 'verify' || p.ownerType === 'affiliated' ? 2 : 0;

  const parts: RadarScoreParts = { dom, reductions, belowMarket, vacancy, buyBoxFit, owner };
  const score = dom + reductions + belowMarket + vacancy + buyBoxFit + owner;
  const confidence = live.reduce<ConfidenceLabel>((best, s) => (CONFIDENCE_RANK[s.comparableConfidence] > CONFIDENCE_RANK[best] ? s.comparableConfidence : best), 'LOW');
  const comparableMedian = bestSpace?.comparableMedian ?? live.find((s) => s.comparableMedian !== null)?.comparableMedian ?? null;
  const indicativeRentGapUsd =
    bestSpace && bestGapPct !== null && bestGapPct < 0 && bestSpace.askingNnnEq !== null && bestSpace.comparableMedian !== null
      ? (bestSpace.comparableMedian - bestSpace.askingNnnEq) * bestSpace.availableSf
      : null;
  const eligible = gateFailures.length === 0;

  return {
    eligible, gateFailures, isCandidate: eligible && score >= t.radarMinScore, score, parts, confidence, vacancyShare,
    maxEffectiveDom, reductionCount, cumulativeReductionPct, bestGapPct, comparableMedian, indicativeRentGapUsd,
  };
}
```

- [ ] **Step 6:** `npx vitest run tests/unit/lease-market-signals.test.ts tests/unit/lease-market-radar.test.ts && npm run typecheck && npx eslint src/analytics/lease-market tests/unit/lease-market-signals.test.ts tests/unit/lease-market-radar.test.ts --max-warnings 0` — Expected: PASS / clean.

- [ ] **Step 7: Commit** — `git add src/analytics/lease-market/signals.ts src/analytics/lease-market/radar.ts tests/unit/lease-market-signals.test.ts tests/unit/lease-market-radar.test.ts` ("feat(analytics): space signals and transparent acquisition radar score").
