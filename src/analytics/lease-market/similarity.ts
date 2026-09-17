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

// R8: a single dominant property (e.g. several identical vacant suites in one building) must not be
// able to fill the comp set and drag the median toward its own asking rent -- cap how many comps any
// one propertyId can contribute BEFORE the global top-K cut, keeping that property's highest scorers.
const PER_PROPERTY_COMP_CAP = 3;
const byScoreThenListingId = (a: ScoredComp, b: ScoredComp) => b.similarity.score - a.similarity.score || a.candidate.listingId - b.candidate.listingId;

export function selectComps(
  subject: SpaceProfile,
  excludePropertyId: number | null,
  candidates: readonly CompCandidate[],
  w: SimilarityWeights,
  t: Pick<LmThresholds, 'similarityMinScore' | 'similarityTopK' | 'similarityMinComps'>,
): { comps: ScoredComp[]; sufficient: boolean } {
  const scored = candidates
    .filter((c) => c.propertyId !== excludePropertyId)
    .flatMap((c) => {
      const similarity = scoreSimilarity(subject, c, w);
      return similarity && similarity.score >= t.similarityMinScore ? [{ candidate: c, similarity }] : [];
    });
  const byProperty = new Map<number, ScoredComp[]>();
  for (const sc of scored) {
    const list = byProperty.get(sc.candidate.propertyId);
    if (list) list.push(sc);
    else byProperty.set(sc.candidate.propertyId, [sc]);
  }
  const capped = [...byProperty.values()].flatMap((list) => list.sort(byScoreThenListingId).slice(0, PER_PROPERTY_COMP_CAP));
  const comps = capped.sort(byScoreThenListingId).slice(0, t.similarityTopK);
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
  // R3: the union of components that were unknown (missing on the subject and/or a comp) across the
  // selected comp set, sorted for determinism. Empty on the cell/null-fallback bases, which carry no
  // per-component similarity data. Exposed so the UI and evidence can show WHY confidence was capped.
  unknown: SimilarityComponent[];
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
    // R3: an unknown component isn't a neutral 0.5 credit for confidence purposes -- it means the
    // similarity claim is partly a guess. Union every component that was unknown on ANY selected comp
    // (in practice this is almost always driven by the subject's own missing fields, which recur
    // identically across every comp pairing) and cap confidence accordingly: 3+ unknown components
    // caps at LOW regardless of comp count; location alone caps at HIGH down to MEDIUM. These caps
    // apply on top of the ordinary n/low-coverage computation, never loosen it.
    const unknown = [...new Set(selection.comps.flatMap((c) => c.similarity.unknown))].sort();
    const baseConfidence: ConfidenceLabel = n >= t.similarityHighComps && !(cell?.lowCoverage ?? false) ? 'HIGH' : 'MEDIUM';
    const confidence: ConfidenceLabel = unknown.length >= 3 ? 'LOW' : unknown.includes('location') ? 'MEDIUM' : baseConfidence;
    return { basis: 'similarity', n, ...statsOf(selection.comps.map((c) => c.candidate.askingNnnEq)), confidence, cellKey, comps: selection.comps, unknown };
  }
  if (cell && cell.median !== null) {
    const confidence: ConfidenceLabel = cell.n >= t.belowMarketMinN && cell.rolledUp !== 'market' && !cell.lowCoverage ? 'MEDIUM' : 'LOW';
    return { basis: 'cell', n: cell.n, ...statsOf(cell.values), confidence, cellKey, comps: [], unknown: [] };
  }
  return { basis: 'cell', n: cell?.n ?? 0, values: [], low: null, p25: null, median: null, p75: null, high: null, confidence: 'LOW', cellKey, comps: [], unknown: [] };
}
