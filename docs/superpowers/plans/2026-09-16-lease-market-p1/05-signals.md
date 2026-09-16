### Task 05: Signals (pure)

**Files:**
- Create: `src/analytics/lease-market/signals.ts`
- Test: `tests/unit/lease-market-signals.test.ts`

**Interfaces:**
- Consumes: Task 02 types `BuildingStatus`, `OwnerType`, `SignalKind`, `SignalSeverity`, `LmThresholds`, `EvidenceValue`; Task 03 `daysBetween`; Task 04 `ComputedCell`, `medianOf`.
- Produces:
  - `interface ObservationPoint { observedAt: string; availableSf: number; askingNnnEq: number | null; rentLow: number | null; costarDom: number | null; isSublease: boolean; eligible: boolean }`
  - `interface ListingHistory { listingId: number; marketId: string; addressDisplay: string; buildingStatus: BuildingStatus; buildingSf: number | null; yearBuilt: number | null; clearHeightFt: number | null; docks: number | null; ownerName: string | null; ownerType: OwnerType; isOraOwned: boolean; firstSeen: string; costarDateOnMarket: string | null; isNewInLatestExport: boolean; observations: ObservationPoint[] }` — observations ascending by `observedAt`
  - `effectiveDom(h: Pick<ListingHistory, 'firstSeen' | 'costarDateOnMarket'>, asOf: string): number`
  - `domReset(observations: readonly ObservationPoint[]): boolean`
  - `staleThresholdDays(baseline: number | null, tier: 'established' | 'entry', t: LmThresholds): number`
  - `completedDomBaseline(domsAtRemoval: readonly number[], minN: number): number | null`
  - `interface SignalDraft { listingId: number; kind: SignalKind; severity: SignalSeverity; cellKey: string | null; evidence: Record<string, EvidenceValue> }`
  - `interface SignalContext { asOf: string; cell: ComputedCell | null; staleThresholdDays: number; ownerListingCount: number; ownerScreenAvailable: boolean; thresholds: LmThresholds }`
  - `listingSignals(h: ListingHistory, ctx: SignalContext): SignalDraft[]`

Rules (spec §3.5–3.6): ORA-owned listings and listings with no observations emit nothing. `effectiveDom = max(0, days(firstSeen→asOf), days(costarDateOnMarket→asOf))`. `rent_cut` when the latest asking NNN-eq (else rent_low) is lower than the previous observation's by more than $0.005. `stale` needs `buildingStatus === 'existing'`; severity `high` if rent cut or vacancy share ≥ threshold, else `watch`. `below_market` needs latest eligible · cell median and P25 present · `cell.n >= belowMarketMinN` · `cell.rolledUp !== 'market'` · `!cell.lowCoverage` · asking ≤ P25 and ≤ ratio × median. `acq_candidate` needs owner screen available · ≥ 2 of {stale, rent_cut, high vacancy, below_market} · building SF known and ≤ candidate max · existing · latest not sublease · owner type not institutional / never_call / unknown.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/lease-market-signals.test.ts
import { describe, it, expect } from 'vitest';
import {
  completedDomBaseline, domReset, effectiveDom, listingSignals, staleThresholdDays,
  type ListingHistory, type ObservationPoint, type SignalContext,
} from '../../src/analytics/lease-market/signals';
import type { ComputedCell } from '../../src/analytics/lease-market/benchmarks';
import type { LmThresholds } from '../../src/contracts/lease-market';

const T: LmThresholds = {
  benchmarkMinN: 5, belowMarketMinN: 10, belowMarketMedianRatio: 0.85, lowCoverageQuotedShare: 0.5,
  staleFloorDays: 180, staleBaselineMultiple: 1.5, staleFallbackDays: { established: 180, entry: 270 },
  completedDomMinN: 10, vacancyShareMin: 0.3, candidateMaxBuildingSf: 50000, benchmarkMaxBuildingSf: 80000,
  positioningBandPct: 0.1, rangeMaxSpread: 0.2, monthlyValueCeiling: 3, exportMinRowRatio: 0.7,
  exportRowCap: 2000, freshnessDays: 35, flexOfficeSplitPct: 40,
};

function obs(patch: Partial<ObservationPoint> = {}): ObservationPoint {
  return { observedAt: '2026-03-01', availableSf: 5000, askingNnnEq: 9, rentLow: 9, costarDom: 10, isSublease: false, eligible: true, ...patch };
}
function hist(patch: Partial<ListingHistory> = {}): ListingHistory {
  return {
    listingId: 1, marketId: 'columbus', addressDisplay: '1 Main St', buildingStatus: 'existing', buildingSf: 30000,
    yearBuilt: 1985, clearHeightFt: 18, docks: 2, ownerName: 'SMITH FAMILY LLC', ownerType: 'private', isOraOwned: false,
    firstSeen: '2026-02-01', costarDateOnMarket: '2026-02-01', isNewInLatestExport: false, observations: [obs()], ...patch,
  };
}
function cell(patch: Partial<ComputedCell> = {}): ComputedCell {
  return {
    cellKey: 'columbus|East|warehouse|5-15K|all', marketId: 'columbus', submarket: 'East', subtype: 'warehouse',
    sizeBand: '5-15K', officeStratum: 'all', rolledUp: 'none', n: 10, totalN: 12, quotedShare: 10 / 12,
    p25: 8.2, median: 9, p75: 10, lowCoverage: false, values: [], physicalMedians: { clearHeightFt: 22, yearBuilt: 1998, docks: 3 },
    ...patch,
  };
}
function ctx(patch: Partial<SignalContext> = {}): SignalContext {
  return { asOf: '2026-03-01', cell: cell(), staleThresholdDays: 180, ownerListingCount: 1, ownerScreenAvailable: true, thresholds: T, ...patch };
}
const kinds = (h: ListingHistory, c: SignalContext) => listingSignals(h, c).map((s) => s.kind).sort();

describe('DOM helpers', () => {
  it('effective DOM keeps the older clock', () => {
    expect(effectiveDom({ firstSeen: '2026-01-01', costarDateOnMarket: '2025-06-01' }, '2026-03-01')).toBe(273);
    expect(effectiveDom({ firstSeen: '2026-01-01', costarDateOnMarket: null }, '2026-03-01')).toBe(59);
  });
  it('detects a CoStar DOM reset', () => {
    expect(domReset([obs({ costarDom: 200 }), obs({ costarDom: 30 })])).toBe(true);
    expect(domReset([obs({ costarDom: 30 }), obs({ costarDom: 60 })])).toBe(false);
  });
  it('stale threshold uses the baseline or the tier fallback', () => {
    expect(staleThresholdDays(null, 'entry', T)).toBe(270);
    expect(staleThresholdDays(100, 'established', T)).toBe(180);
    expect(staleThresholdDays(200, 'established', T)).toBe(300);
  });
  it('completed-DOM baseline needs n >= minN', () => {
    expect(completedDomBaseline([1, 2, 3, 4, 5, 6, 7, 8, 9], 10)).toBeNull();
    expect(completedDomBaseline([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 10)).toBe(5.5);
  });
});

describe('listingSignals', () => {
  it('emits nothing for ORA-owned listings', () => {
    expect(listingSignals(hist({ isOraOwned: true, isNewInLatestExport: true }), ctx())).toEqual([]);
  });

  it('new listing', () => {
    expect(kinds(hist({ isNewInLatestExport: true }), ctx())).toEqual(['new_listing']);
  });

  it('stale at the threshold, with DOM source evidence', () => {
    const s = listingSignals(hist({ firstSeen: '2026-01-01', costarDateOnMarket: '2025-06-01' }), ctx());
    expect(s.map((x) => x.kind)).toEqual(['stale']);
    expect(s[0]!.severity).toBe('watch');
    expect(s[0]!.evidence.effectiveDom).toBe(273);
    expect(s[0]!.evidence.domSource).toBe('costar_date_on_market');
  });

  it('proposed buildings are never stale', () => {
    expect(kinds(hist({ buildingStatus: 'proposed', costarDateOnMarket: '2025-01-01' }), ctx())).toEqual([]);
  });

  it('rent cut on NNN-eq, falling back to rent_low', () => {
    expect(kinds(hist({ observations: [obs({ askingNnnEq: 9 }), obs({ askingNnnEq: 8.5 })] }), ctx())).toEqual(['rent_cut']);
    expect(kinds(hist({ observations: [obs({ askingNnnEq: null, rentLow: 12 }), obs({ askingNnnEq: null, rentLow: 11 })] }), ctx())).toEqual(['rent_cut']);
    expect(kinds(hist({ observations: [obs({ askingNnnEq: 9 }), obs({ askingNnnEq: 8.999 })] }), ctx())).toEqual([]);
  });

  it('below market fires only on a qualified cell', () => {
    const cheap = hist({ observations: [obs({ askingNnnEq: 7.5 })] });
    expect(kinds(cheap, ctx())).toEqual(['below_market']);
    expect(kinds(hist({ observations: [obs({ askingNnnEq: 7.8 })] }), ctx())).toEqual([]); // above 0.85 × 9 = 7.65
    expect(kinds(cheap, ctx({ cell: cell({ n: 9 }) }))).toEqual([]);
    expect(kinds(cheap, ctx({ cell: cell({ rolledUp: 'market' }) }))).toEqual([]);
    expect(kinds(cheap, ctx({ cell: cell({ lowCoverage: true }) }))).toEqual([]);
    expect(kinds(cheap, ctx({ cell: null }))).toEqual([]);
    expect(kinds(hist({ observations: [obs({ askingNnnEq: 7.5, eligible: false })] }), ctx())).toEqual([]);
    const ev = listingSignals(cheap, ctx())[0]!.evidence;
    expect(ev.cellMedian).toBe(9);
    expect(ev.clearHeightFt).toBe(18);
    expect(ev.cellClearHeightFt).toBe(22);
  });

  describe('acq_candidate', () => {
    // stale (DOM 273) + high vacancy (12,000 / 30,000 = 40%)
    const strong = () => hist({ firstSeen: '2026-01-01', costarDateOnMarket: '2025-06-01', observations: [obs({ availableSf: 12000 })] });

    it('fires on two hits and marks stale high severity', () => {
      const s = listingSignals(strong(), ctx({ ownerListingCount: 3 }));
      expect(s.map((x) => x.kind).sort()).toEqual(['acq_candidate', 'stale']);
      expect(s.find((x) => x.kind === 'stale')!.severity).toBe('high');
      const c = s.find((x) => x.kind === 'acq_candidate')!;
      expect(c.severity).toBe('high');
      expect(c.evidence.ownerListingCount).toBe(3);
      expect(c.evidence.vacancyShare).toBeCloseTo(0.4);
    });
    it('needs two hits', () => {
      expect(kinds(hist({ firstSeen: '2026-01-01', costarDateOnMarket: '2025-06-01' }), ctx())).toEqual(['stale']);
    });
    it.each([
      ['institutional owner', { ownerType: 'institutional' as const }],
      ['never-call owner', { ownerType: 'never_call' as const }],
      ['unscreened owner', { ownerType: 'unknown' as const }],
      ['building over 50K SF', { buildingSf: 60000 }],
      ['unknown building SF', { buildingSf: null }],
    ])('is withheld for %s', (_l, patch) => {
      expect(kinds({ ...strong(), ...patch }, ctx())).not.toContain('acq_candidate');
    });
    it('is withheld when the latest space is a sublease', () => {
      expect(kinds(hist({ firstSeen: '2026-01-01', costarDateOnMarket: '2025-06-01', observations: [obs({ availableSf: 12000, isSublease: true })] }), ctx())).not.toContain('acq_candidate');
    });
    it('is withheld when the owner screen is unavailable', () => {
      expect(kinds(strong(), ctx({ ownerScreenAvailable: false }))).not.toContain('acq_candidate');
    });
    it('keeps affiliated and verify owners, flagged', () => {
      const a = listingSignals({ ...strong(), ownerType: 'affiliated' }, ctx()).find((x) => x.kind === 'acq_candidate')!;
      expect(a.evidence.ownerAffiliated).toBe(true);
      const v = listingSignals({ ...strong(), ownerType: 'verify' }, ctx()).find((x) => x.kind === 'acq_candidate')!;
      expect(v.evidence.ownerVerify).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/lease-market-signals.test.ts`
Expected: FAIL — cannot resolve `signals`.

- [ ] **Step 3: Write the implementation**

```ts
// src/analytics/lease-market/signals.ts
//
// Lease Market Intelligence — per-listing signals (spec §3.6). Pure; no I/O.
// Signals are internal analytics only; promotion to recon/outreach is a manual human action.
// Financial-decision source: refute pass required.
import type { BuildingStatus, EvidenceValue, LmThresholds, OwnerType, SignalKind, SignalSeverity } from '../../contracts/lease-market';
import type { ComputedCell } from './benchmarks';
import { medianOf } from './benchmarks';
import { daysBetween } from './normalize';

export interface ObservationPoint {
  observedAt: string;
  availableSf: number;
  askingNnnEq: number | null;
  rentLow: number | null;
  costarDom: number | null;
  isSublease: boolean;
  eligible: boolean;
}

export interface ListingHistory {
  listingId: number;
  marketId: string;
  addressDisplay: string;
  buildingStatus: BuildingStatus;
  buildingSf: number | null;
  yearBuilt: number | null;
  clearHeightFt: number | null;
  docks: number | null;
  ownerName: string | null;
  ownerType: OwnerType;
  isOraOwned: boolean;
  firstSeen: string;
  costarDateOnMarket: string | null;
  isNewInLatestExport: boolean;
  /** Ascending by observedAt. */
  observations: ObservationPoint[];
}

export function effectiveDom(h: Pick<ListingHistory, 'firstSeen' | 'costarDateOnMarket'>, asOf: string): number {
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
  listingId: number;
  kind: SignalKind;
  severity: SignalSeverity;
  cellKey: string | null;
  evidence: Record<string, EvidenceValue>;
}

export interface SignalContext {
  asOf: string;
  cell: ComputedCell | null;
  staleThresholdDays: number;
  ownerListingCount: number;
  ownerScreenAvailable: boolean;
  thresholds: LmThresholds;
}

const CANDIDATE_EXCLUDED_OWNERS: ReadonlySet<OwnerType> = new Set<OwnerType>(['institutional', 'never_call', 'unknown']);
const CUT_EPSILON = 0.005;

export function listingSignals(h: ListingHistory, ctx: SignalContext): SignalDraft[] {
  if (h.isOraOwned || h.observations.length === 0) return [];
  const t = ctx.thresholds;
  const latest = h.observations[h.observations.length - 1]!;
  const prev = h.observations.length > 1 ? h.observations[h.observations.length - 2]! : null;
  const cell = ctx.cell;
  const cellKey = cell?.cellKey ?? null;

  const dom = effectiveDom(h, ctx.asOf);
  const vacancyShare = h.buildingSf !== null && h.buildingSf > 0 ? latest.availableSf / h.buildingSf : null;
  const base: Record<string, EvidenceValue> = {
    address: h.addressDisplay,
    effectiveDom: dom,
    domReset: domReset(h.observations),
    domSource: h.costarDateOnMarket ? 'costar_date_on_market' : 'first_seen',
    availableSf: latest.availableSf,
    buildingSf: h.buildingSf,
    vacancyShare,
    askingNnnEq: latest.askingNnnEq,
  };

  let rentCut = false;
  if (prev) {
    if (prev.askingNnnEq !== null && latest.askingNnnEq !== null) rentCut = latest.askingNnnEq < prev.askingNnnEq - CUT_EPSILON;
    else if (prev.rentLow !== null && latest.rentLow !== null) rentCut = latest.rentLow < prev.rentLow - CUT_EPSILON;
  }
  const highVacancy = vacancyShare !== null && vacancyShare >= t.vacancyShareMin;
  const stale = h.buildingStatus === 'existing' && dom >= ctx.staleThresholdDays;
  const belowMarket =
    latest.eligible &&
    latest.askingNnnEq !== null &&
    cell !== null &&
    cell.median !== null &&
    cell.p25 !== null &&
    cell.n >= t.belowMarketMinN &&
    cell.rolledUp !== 'market' &&
    !cell.lowCoverage &&
    latest.askingNnnEq <= cell.p25 &&
    latest.askingNnnEq <= t.belowMarketMedianRatio * cell.median;

  const out: SignalDraft[] = [];
  const push = (kind: SignalKind, severity: SignalSeverity, extra: Record<string, EvidenceValue> = {}) =>
    out.push({ listingId: h.listingId, kind, severity, cellKey, evidence: { ...base, ...extra } });

  if (h.isNewInLatestExport) push('new_listing', 'info');
  if (rentCut && prev) {
    push('rent_cut', 'watch', { prevAskingNnnEq: prev.askingNnnEq, prevRentLow: prev.rentLow, latestRentLow: latest.rentLow, prevObservedAt: prev.observedAt });
  }
  if (stale) push('stale', rentCut || highVacancy ? 'high' : 'watch', { staleThresholdDays: ctx.staleThresholdDays });
  if (belowMarket && cell && cell.median !== null && latest.askingNnnEq !== null) {
    push('below_market', 'watch', {
      cellMedian: cell.median,
      cellP25: cell.p25,
      cellN: cell.n,
      quotedShare: cell.quotedShare,
      gapPct: (latest.askingNnnEq - cell.median) / cell.median,
      clearHeightFt: h.clearHeightFt,
      cellClearHeightFt: cell.physicalMedians.clearHeightFt,
      yearBuilt: h.yearBuilt,
      cellYearBuilt: cell.physicalMedians.yearBuilt,
      docks: h.docks,
      cellDocks: cell.physicalMedians.docks,
    });
  }

  const hits = [stale, rentCut, highVacancy, belowMarket].filter(Boolean).length;
  if (
    ctx.ownerScreenAvailable &&
    hits >= 2 &&
    h.buildingSf !== null &&
    h.buildingSf <= t.candidateMaxBuildingSf &&
    h.buildingStatus === 'existing' &&
    !latest.isSublease &&
    !CANDIDATE_EXCLUDED_OWNERS.has(h.ownerType)
  ) {
    push('acq_candidate', 'high', {
      stale,
      rentCut,
      highVacancy,
      belowMarket,
      ownerName: h.ownerName,
      ownerType: h.ownerType,
      ownerVerify: h.ownerType === 'verify',
      ownerAffiliated: h.ownerType === 'affiliated',
      ownerListingCount: ctx.ownerListingCount,
      cellN: cell?.n ?? null,
      quotedShare: cell?.quotedShare ?? null,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `npx vitest run tests/unit/lease-market-signals.test.ts && npm run typecheck && npx eslint src/analytics/lease-market tests/unit/lease-market-signals.test.ts --max-warnings 0`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/analytics/lease-market/signals.ts tests/unit/lease-market-signals.test.ts
git commit -F <message-file>   # "feat(analytics): lease market listing signals"
```
