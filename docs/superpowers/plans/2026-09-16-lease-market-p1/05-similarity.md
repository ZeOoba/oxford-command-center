### Task 05: Similarity comparable sets + confidence (pure)

**Files:**
- Create: `src/analytics/lease-market/similarity.ts`
- Test: `tests/unit/lease-market-similarity.test.ts`

**Interfaces:**
- Consumes: Task 02 `LmSubtype`, `SimilarityWeights`, `ConfidenceLabel`, `CompBasis`, `LmThresholds`; Task 04 `quantileSorted`, `ComputedCell`.
- Produces:
  - `interface SpaceProfile { marketId: string; submarket: string|null; subtype: LmSubtype; lat: number|null; lon: number|null; availableSf: number; clearHeightFt: number|null; yearBuilt: number|null; docks: number|null; driveIns: number|null; officePct: number|null }`
  - `interface CompCandidate extends SpaceProfile { listingId: number; propertyId: number; askingNnnEq: number; addressDisplay: string }`
  - `type SimilarityComponent = 'location'|'size'|'clearHeight'|'age'|'loading'|'office'`
  - `interface SimilarityResult { score: number; parts: Record<SimilarityComponent, number>; unknown: SimilarityComponent[]; distanceMi: number|null }`
  - `interface ScoredComp { candidate: CompCandidate; similarity: SimilarityResult }`
  - `haversineMi(lat1, lon1, lat2, lon2): number`
  - `scoreSimilarity(subject: SpaceProfile, candidate: SpaceProfile, w: SimilarityWeights): SimilarityResult | null` (null ⇔ different market or subtype)
  - `selectComps(subject: SpaceProfile, excludePropertyId: number|null, candidates: readonly CompCandidate[], w: SimilarityWeights, t: Pick<LmThresholds,'similarityMinScore'|'similarityTopK'|'similarityMinComps'>): { comps: ScoredComp[]; sufficient: boolean }`
  - `interface ResolvedComparables { basis: CompBasis; n: number; low; p25; median; p75; high: number|null; values: number[]; confidence: ConfidenceLabel; cellKey: string|null; comps: ScoredComp[] }`
  - `resolveComparables(subject, excludePropertyId, candidates, cell: ComputedCell|null, w, t: LmThresholds): ResolvedComparables`

Rules (spec rev 3 §3.6), per component: credit ∈ [0,1] × weight; score = round(Σ). Missing data on either side ⇒ credit 0.5 and the component is listed in `unknown`.
- **location:** both coordinates ⇒ `distance ≤ 2 mi ⇒ 1`, linear to 0 at 15 mi. No coordinates: both submarkets non-null and equal ⇒ 0.7; both non-null and different ⇒ 0.3; either null ⇒ 0.5 (unknown).
- **size:** ratio = min/max available SF; ≥ 0.8 ⇒ 1; ≤ 0.3 ⇒ 0; linear between.
- **clearHeight:** |Δ| ≤ 2 ⇒ 1, linear to 0 at 12. **age:** |Δ year| ≤ 5 ⇒ 1, linear to 0 at 35. **office:** |Δ pts| ≤ 10 ⇒ 1, linear to 0 at 50.
- **loading:** dock part 0.5 when both known and (docks > 0) matches, 0 when both known and differs, 0.25 when either unknown; drive-in part the same; unknown if either part was unknown.
- **selection:** excludes `excludePropertyId`; keeps score ≥ min; sorts by score desc, then listingId asc; takes top K; sufficient ⇔ count ≥ minComps.
- **resolution:** sufficient ⇒ basis `similarity`, stats over comp askings. Else cell with median ⇒ basis `cell`, stats over `cell.values`. Else basis `cell`, all stats null, n = cell?.n ?? 0.
- **confidence:** similarity: n ≥ HIGH threshold and cell not low coverage ⇒ HIGH; n ≥ min ⇒ MEDIUM. Cell: n ≥ belowMarketMinN and not market-level rollup and not low coverage ⇒ MEDIUM. Otherwise LOW.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/lease-market-similarity.test.ts
import { describe, it, expect } from 'vitest';
import {
  haversineMi, resolveComparables, scoreSimilarity, selectComps, type CompCandidate, type SpaceProfile,
} from '../../src/analytics/lease-market/similarity';
import type { ComputedCell } from '../../src/analytics/lease-market/benchmarks';
import type { LmThresholds, SimilarityWeights } from '../../src/contracts/lease-market';

const W: SimilarityWeights = { location: 30, size: 25, clearHeight: 15, age: 10, loading: 10, office: 10 };
const T = {
  similarityMinScore: 60, similarityTopK: 15, similarityMinComps: 8, similarityHighComps: 15, belowMarketMinN: 10,
} as LmThresholds;

const subject: SpaceProfile = {
  marketId: 'columbus', submarket: 'East', subtype: 'warehouse', lat: 39.96, lon: -82.9, availableSf: 10000,
  clearHeightFt: 20, yearBuilt: 1990, docks: 2, driveIns: 1, officePct: 10,
};
let id = 1;
const cand = (patch: Partial<CompCandidate> = {}): CompCandidate => ({ ...subject, listingId: id++, propertyId: id + 1000, askingNnnEq: 9, addressDisplay: 'x', ...patch });

describe('haversineMi', () => {
  it('measures roughly one degree of latitude as 69 miles', () => {
    expect(haversineMi(39, -82, 40, -82)).toBeCloseTo(69.1, 0);
  });
});

describe('scoreSimilarity', () => {
  it('an identical space scores 100', () => {
    expect(scoreSimilarity(subject, subject, W)).toMatchObject({ score: 100, unknown: [], distanceMi: 0 });
  });
  it('different market or subtype is excluded', () => {
    expect(scoreSimilarity(subject, { ...subject, marketId: 'madison' }, W)).toBeNull();
    expect(scoreSimilarity(subject, { ...subject, subtype: 'flex' }, W)).toBeNull();
  });
  it('applies linear decay per component', () => {
    const far = scoreSimilarity(subject, { ...subject, lat: subject.lat! + 8.5 / 69.1 }, W)!; // ~8.5 mi => (15-8.5)/13 = 0.5
    expect(far.parts.location).toBeCloseTo(15, 0);
    const half = scoreSimilarity(subject, { ...subject, availableSf: 18181.8 }, W)!; // ratio 0.55 => 0.5
    expect(half.parts.size).toBeCloseTo(12.5, 1);
    expect(scoreSimilarity(subject, { ...subject, clearHeightFt: 27 }, W)!.parts.clearHeight).toBeCloseTo(7.5, 5); // Δ7 => 0.5
    expect(scoreSimilarity(subject, { ...subject, yearBuilt: 2010 }, W)!.parts.age).toBeCloseTo(5, 5); // Δ20 => 0.5
    expect(scoreSimilarity(subject, { ...subject, officePct: 40 }, W)!.parts.office).toBeCloseTo(5, 5); // Δ30 => 0.5
    expect(scoreSimilarity(subject, { ...subject, docks: 0 }, W)!.parts.loading).toBe(5);
  });
  it('gives half credit and reports unknown components', () => {
    const r = scoreSimilarity(subject, { ...subject, lat: null, lon: null, submarket: null, clearHeightFt: null, docks: null }, W)!;
    expect(r.unknown.sort()).toEqual(['clearHeight', 'loading', 'location']);
    expect(r.parts.location).toBe(15);
    expect(r.parts.clearHeight).toBe(7.5);
    expect(r.parts.loading).toBe(7.5);
    expect(r.distanceMi).toBeNull();
  });
  it('uses submarket when coordinates are missing', () => {
    expect(scoreSimilarity({ ...subject, lat: null }, { ...subject, lat: null }, W)!.parts.location).toBe(21);
    expect(scoreSimilarity({ ...subject, lat: null }, { ...subject, lat: null, submarket: 'West' }, W)!.parts.location).toBe(9);
  });
});

describe('selectComps', () => {
  it('filters by score, excludes the subject property, orders, caps at K, and flags sufficiency', () => {
    const good = Array.from({ length: 20 }, (_, i) => cand({ yearBuilt: 1990 + i }));
    const poor = cand({ availableSf: 60000, clearHeightFt: 40, lat: 41, yearBuilt: 1950 });
    const self = cand({ propertyId: 42 });
    const sel = selectComps(subject, 42, [...good, poor, self], W, T);
    expect(sel.comps).toHaveLength(15);
    expect(sel.sufficient).toBe(true);
    expect(sel.comps.some((c) => c.candidate.propertyId === 42)).toBe(false);
    expect(sel.comps.some((c) => c.candidate === poor)).toBe(false);
    const scores = sel.comps.map((c) => c.similarity.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(selectComps(subject, null, good.slice(0, 7), W, T).sufficient).toBe(false);
  });
});

describe('resolveComparables', () => {
  const cell = (patch: Partial<ComputedCell>): ComputedCell => ({
    cellKey: 'k', marketId: 'columbus', submarket: 'East', subtype: 'warehouse', sizeBand: '5-15K', officeStratum: 'all',
    rolledUp: 'none', n: 12, totalN: 14, quotedShare: 12 / 14, p25: 8, median: 9, p75: 10, lowCoverage: false,
    values: [7, 8, 8, 8.5, 9, 9, 9, 9.5, 10, 10, 10.5, 11], physicalMedians: { clearHeightFt: null, yearBuilt: null, docks: null }, ...patch,
  });

  it('uses similarity when sufficient, with HIGH confidence at 15 comps', () => {
    const comps = Array.from({ length: 16 }, (_, i) => cand({ askingNnnEq: (80 + i) / 10 }));
    const r = resolveComparables(subject, null, comps, cell({}), W, T);
    expect(r).toMatchObject({ basis: 'similarity', n: 15, confidence: 'HIGH', low: 8, high: 9.4 });
    expect(r.median).toBeCloseTo(8.7);
  });
  it('MEDIUM with 8-14 similarity comps; HIGH blocked by low coverage', () => {
    expect(resolveComparables(subject, null, Array.from({ length: 9 }, () => cand()), cell({}), W, T).confidence).toBe('MEDIUM');
    expect(resolveComparables(subject, null, Array.from({ length: 16 }, () => cand()), cell({ lowCoverage: true }), W, T).confidence).toBe('MEDIUM');
  });
  it('falls back to the cell', () => {
    const r = resolveComparables(subject, null, [], cell({}), W, T);
    expect(r).toMatchObject({ basis: 'cell', n: 12, median: 9, low: 7, high: 11, confidence: 'MEDIUM', cellKey: 'k', comps: [] });
    expect(resolveComparables(subject, null, [], cell({ rolledUp: 'market' }), W, T).confidence).toBe('LOW');
    expect(resolveComparables(subject, null, [], cell({ n: 9 }), W, T).confidence).toBe('LOW');
  });
  it('is LOW with null stats when nothing is available', () => {
    expect(resolveComparables(subject, null, [], null, W, T)).toMatchObject({ basis: 'cell', n: 0, median: null, confidence: 'LOW', cellKey: null });
    expect(resolveComparables(subject, null, [], cell({ median: null, p25: null, p75: null, values: [], n: 3 }), W, T)).toMatchObject({ n: 3, median: null, confidence: 'LOW' });
  });
});
```

- [ ] **Step 2:** `npx vitest run tests/unit/lease-market-similarity.test.ts` — Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```ts
// src/analytics/lease-market/similarity.ts
//
// Lease Market Intelligence — transparent similarity comparable sets (spec rev 3 §3.6, cross-exam A4/A6).
// Every component is a simple linear rule over fields the CoStar export actually carries; no black-box
// percentages. Comps are returned with their scores so every positioning number is auditable.
// Financial-decision source: refute pass required.
import type { CompBasis, ConfidenceLabel, LmSubtype, LmThresholds, SimilarityWeights } from '../../contracts/lease-market';
import { quantileSorted, type ComputedCell } from './benchmarks';

export interface SpaceProfile {
  marketId: string;
  submarket: string | null;
  subtype: LmSubtype;
  lat: number | null;
  lon: number | null;
  availableSf: number;
  clearHeightFt: number | null;
  yearBuilt: number | null;
  docks: number | null;
  driveIns: number | null;
  officePct: number | null;
}

export interface CompCandidate extends SpaceProfile {
  listingId: number;
  propertyId: number;
  askingNnnEq: number;
  addressDisplay: string;
}

export type SimilarityComponent = 'location' | 'size' | 'clearHeight' | 'age' | 'loading' | 'office';

export interface SimilarityResult {
  score: number;
  parts: Record<SimilarityComponent, number>;
  unknown: SimilarityComponent[];
  distanceMi: number | null;
}

export interface ScoredComp {
  candidate: CompCandidate;
  similarity: SimilarityResult;
}

export function haversineMi(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** 1 at or below `full`, 0 at or above `zero`, linear between. */
function decay(value: number, full: number, zero: number): number {
  if (value <= full) return 1;
  if (value >= zero) return 0;
  return (zero - value) / (zero - full);
}

export function scoreSimilarity(subject: SpaceProfile, candidate: SpaceProfile, w: SimilarityWeights): SimilarityResult | null {
  if (subject.marketId !== candidate.marketId || subject.subtype !== candidate.subtype) return null;
  const unknown: SimilarityComponent[] = [];
  const credit: Record<SimilarityComponent, number> = { location: 0, size: 0, clearHeight: 0, age: 0, loading: 0, office: 0 };
  let distanceMi: number | null = null;

  if (subject.lat !== null && subject.lon !== null && candidate.lat !== null && candidate.lon !== null) {
    distanceMi = haversineMi(subject.lat, subject.lon, candidate.lat, candidate.lon);
    credit.location = decay(distanceMi, 2, 15);
  } else if (subject.submarket !== null && candidate.submarket !== null) {
    credit.location = subject.submarket === candidate.submarket ? 0.7 : 0.3;
  } else {
    credit.location = 0.5;
    unknown.push('location');
  }

  const ratio = Math.min(subject.availableSf, candidate.availableSf) / Math.max(subject.availableSf, candidate.availableSf);
  credit.size = ratio >= 0.8 ? 1 : ratio <= 0.3 ? 0 : (ratio - 0.3) / 0.5;

  const pair = (name: SimilarityComponent, a: number | null, b: number | null, full: number, zero: number) => {
    if (a === null || b === null) {
      credit[name] = 0.5;
      unknown.push(name);
    } else {
      credit[name] = decay(Math.abs(a - b), full, zero);
    }
  };
  pair('clearHeight', subject.clearHeightFt, candidate.clearHeightFt, 2, 12);
  pair('age', subject.yearBuilt, candidate.yearBuilt, 5, 35);
  pair('office', subject.officePct, candidate.officePct, 10, 50);

  const parity = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : (a > 0) === (b > 0) ? 0.5 : 0);
  const dock = parity(subject.docks, candidate.docks);
  const drive = parity(subject.driveIns, candidate.driveIns);
  credit.loading = (dock ?? 0.25) + (drive ?? 0.25);
  if (dock === null || drive === null) unknown.push('loading');

  const parts = {
    location: credit.location * w.location,
    size: credit.size * w.size,
    clearHeight: credit.clearHeight * w.clearHeight,
    age: credit.age * w.age,
    loading: credit.loading * w.loading,
    office: credit.office * w.office,
  };
  const score = Math.round(Object.values(parts).reduce((a, b) => a + b, 0));
  return { score, parts, unknown, distanceMi };
}

export function selectComps(
  subject: SpaceProfile,
  excludePropertyId: number | null,
  candidates: readonly CompCandidate[],
  w: SimilarityWeights,
  t: Pick<LmThresholds, 'similarityMinScore' | 'similarityTopK' | 'similarityMinComps'>,
): { comps: ScoredComp[]; sufficient: boolean } {
  const comps = candidates
    .filter((c) => c.propertyId !== excludePropertyId)
    .flatMap((c) => {
      const similarity = scoreSimilarity(subject, c, w);
      return similarity && similarity.score >= t.similarityMinScore ? [{ candidate: c, similarity }] : [];
    })
    .sort((a, b) => b.similarity.score - a.similarity.score || a.candidate.listingId - b.candidate.listingId)
    .slice(0, t.similarityTopK);
  return { comps, sufficient: comps.length >= t.similarityMinComps };
}

export interface ResolvedComparables {
  basis: CompBasis;
  n: number;
  low: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  high: number | null;
  values: number[];
  confidence: ConfidenceLabel;
  cellKey: string | null;
  comps: ScoredComp[];
}

function statsOf(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    values: sorted,
    low: sorted[0] ?? null,
    p25: quantileSorted(sorted, 0.25),
    median: quantileSorted(sorted, 0.5),
    p75: quantileSorted(sorted, 0.75),
    high: sorted.length > 0 ? sorted[sorted.length - 1]! : null,
  };
}

export function resolveComparables(
  subject: SpaceProfile,
  excludePropertyId: number | null,
  candidates: readonly CompCandidate[],
  cell: ComputedCell | null,
  w: SimilarityWeights,
  t: LmThresholds,
): ResolvedComparables {
  const selection = selectComps(subject, excludePropertyId, candidates, w, t);
  const cellKey = cell?.cellKey ?? null;
  if (selection.sufficient) {
    const n = selection.comps.length;
    const confidence: ConfidenceLabel = n >= t.similarityHighComps && !(cell?.lowCoverage ?? false) ? 'HIGH' : 'MEDIUM';
    return { basis: 'similarity', n, ...statsOf(selection.comps.map((c) => c.candidate.askingNnnEq)), confidence, cellKey, comps: selection.comps };
  }
  if (cell && cell.median !== null) {
    const confidence: ConfidenceLabel = cell.n >= t.belowMarketMinN && cell.rolledUp !== 'market' && !cell.lowCoverage ? 'MEDIUM' : 'LOW';
    return { basis: 'cell', n: cell.n, ...statsOf(cell.values), confidence, cellKey, comps: [] };
  }
  return { basis: 'cell', n: cell?.n ?? 0, values: [], low: null, p25: null, median: null, p75: null, high: null, confidence: 'LOW', cellKey, comps: [] };
}
```

- [ ] **Step 4:** `npx vitest run tests/unit/lease-market-similarity.test.ts && npm run typecheck && npx eslint src/analytics/lease-market tests/unit/lease-market-similarity.test.ts --max-warnings 0` — Expected: PASS / clean.

- [ ] **Step 5: Commit** — `git add src/analytics/lease-market/similarity.ts tests/unit/lease-market-similarity.test.ts` ("feat(analytics): transparent similarity comparable sets with confidence").

## REFUTE fixes (adversarial pass, 2026-09-17)

Two findings against `similarity.ts` were reproduced with `scratchpad/refute/probe-similarity.ts` before fixing (confirmed against the pre-fix code: a subject with every physical field null got 15 metro-wide comps at HIGH confidence; 9 sister suites in one building dominated a 15-comp set and dragged the median to the sister building's own rent), then closed test-first.

40. **R3 — an `unknown` component was worth a free 0.5 credit toward confidence, not a penalty.** `resolveComparables`'s HIGH/MEDIUM split looked only at `n` (comp count) and the cell's `lowCoverage` flag — a subject with null coordinates, submarket, clear height, year built and loading data still filled a 15-comp set (every candidate scored the same neutral 0.5-credit way) and got labeled HIGH, the platform's strongest confidence claim, on data that was mostly a guess. Fixed: `resolveComparables` now unions every `SimilarityComponent` marked `unknown` on any selected comp (in practice this set is almost always driven by the SUBJECT's own missing fields, since those recur identically across every comp pairing) and caps confidence on top of the existing n/coverage computation — 3 or more unknown components caps at LOW regardless of comp count; `location` alone (the highest-weighted component) caps at HIGH down to MEDIUM. The cap only ever lowers confidence, never raises it. The union is exposed as `ResolvedComparables.unknown: SimilarityComponent[]` (sorted, empty on the `cell`/null-fallback bases, which carry no per-component data) so the UI and evidence can show WHY confidence was capped — the "resolved-comparables shape" option named in the fix request, chosen over adding the field to `CompRow` because `CompRow` is constructed downstream in `server/warehouse/lease-market/positioning.ts` (out of this fix's allowed-file scope — see the session report) and `ResolvedComparables` is the shape `similarity.ts` itself owns end-to-end. **Follow-up needed outside this scope**: `positioning.ts`'s `CompRow` mapping does not yet surface a per-comp `unknown` list to the API/UI; that's a one-line addition (`unknown: c.similarity.unknown`) for whoever owns that file next, not implemented here.
41. **R8 — no per-property cap on the comp set.** `selectComps` filtered by score and took the global top-K with no per-`propertyId` limit, so several identical/near-identical suites in one building (all scoring the same against a fixed subject) could fill most or all of the comp set and pull the median toward that one building's own asking rent instead of the broader market. Fixed: candidates are now grouped by `propertyId` after scoring, each group is capped at its 3 highest-scoring comps (`PER_PROPERTY_COMP_CAP`), and only then is the merged set sorted and cut to `similarityTopK`. Verified: 9 identical sister suites (`$4.00`) + 6 comps in 6 distinct buildings (`$8.00`) now yields exactly 3 sister comps + all 6 others (9 total), with the median at `$8.00` (previously all 9 sister comps entered, dragging the median to `$4.00`).

Verification: `npx vitest run tests/unit/lease-market-similarity.test.ts` — new R3/R8 cases green alongside all existing pins (verified together: `npx vitest run tests/unit/lease-market*` — 414/424 green; the 10 failures are in `lease-market-compute.test.ts`, exclusively touching `compute.ts`'s own R10/R13/R16 in-flight work by the other agent on this branch, unrelated to `similarity.ts`/`normalize.ts`/`costar-parse.ts`). `npx tsc --noEmit` and `eslint --max-warnings 0` clean. Adding the required `unknown` field to `ResolvedComparables` required a one-line, purely-additive fixture update (`unknown: []`) in two out-of-scope test files that build `ResolvedComparables` mocks directly — `tests/unit/lease-market-positioning.test.ts` and `tests/unit/lease-market-signals.test.ts` — done to keep `tsc --noEmit` green after this file's own contract change; no behavioral assertion in either file changed.
