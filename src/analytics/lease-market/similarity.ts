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
// M-2: the cap value itself now lives in config (thresholds.similarityPerPropertyCap), not hardcoded.
const byScoreThenListingId = (a: ScoredComp, b: ScoredComp) => b.similarity.score - a.similarity.score || a.candidate.listingId - b.candidate.listingId;

export function selectComps(
  subject: SpaceProfile,
  excludePropertyId: number | null,
  candidates: readonly CompCandidate[],
  w: SimilarityWeights,
  t: Pick<LmThresholds, 'similarityMinScore' | 'similarityTopK' | 'similarityMinComps' | 'similarityPerPropertyCap'>,
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
  const capped = [...byProperty.values()].flatMap((list) => list.sort(byScoreThenListingId).slice(0, t.similarityPerPropertyCap));
  const comps = capped.sort(byScoreThenListingId).slice(0, t.similarityTopK);
  return { comps, sufficient: comps.length >= t.similarityMinComps };
}

// I-1: the confidence cap must be driven by what the SUBJECT itself cannot locate or compare, not by
// which candidate happened to be missing which field. A fully-populated subject can be matched against
// 15 comps that are each individually missing a DIFFERENT field (a realistic CoStar-data spread), and
// every one of those pairwise gaps still earns its ordinary 0.5-credit partial score in scoreSimilarity
// (top-K selection behaviour is unchanged) -- but none of them reflect anything uncertain about the
// SUBJECT, so none of them may cap the subject's own confidence. Only size is never "unknown": a
// SpaceProfile always carries a concrete availableSf.
export function subjectUnknownComponents(subject: SpaceProfile): SimilarityComponent[] {
  const unknown: SimilarityComponent[] = [];
  const hasCoords = subject.lat !== null && subject.lon !== null;
  if (!hasCoords && subject.submarket === null) unknown.push('location');
  if (subject.clearHeightFt === null) unknown.push('clearHeight');
  if (subject.yearBuilt === null) unknown.push('age');
  if (subject.officePct === null) unknown.push('office');
  if (subject.docks === null || subject.driveIns === null) unknown.push('loading');
  return unknown.sort();
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
  // I-1 (was R3): the SUBJECT's own unknown components (see subjectUnknownComponents), sorted for
  // determinism -- NOT a union of whatever individual comps happened to be missing (that read a fully-
  // populated subject as LOW confidence whenever its 15 comps were each thin on a different field; see
  // the I-1 fix note on resolveComparables). Empty on the cell/null-fallback bases, which carry no
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
    // I-1 (was R3): an unknown component isn't a neutral 0.5 credit for confidence purposes -- it
    // means the similarity claim is partly a guess. But it is a guess about the SUBJECT, not about
    // whichever comps happened to be thin on data -- a fully-populated subject compared against 15
    // comps that each individually lack a DIFFERENT field is still a HIGH-confidence read on the
    // subject; only the subject's OWN missing fields (subjectUnknownComponents) may cap its confidence.
    // similarityUnknownLowCap+ unknown components caps at LOW regardless of comp count; location alone
    // caps HIGH down to MEDIUM. These caps apply on top of the ordinary n/low-coverage computation,
    // never loosen it.
    const unknown = subjectUnknownComponents(subject);
    const baseConfidence: ConfidenceLabel = n >= t.similarityHighComps && !(cell?.lowCoverage ?? false) ? 'HIGH' : 'MEDIUM';
    const confidence: ConfidenceLabel = unknown.length >= t.similarityUnknownLowCap ? 'LOW' : unknown.includes('location') ? 'MEDIUM' : baseConfidence;
    return { basis: 'similarity', n, ...statsOf(selection.comps.map((c) => c.candidate.askingNnnEq)), confidence, cellKey, comps: selection.comps, unknown };
  }
  if (cell && cell.median !== null) {
    const confidence: ConfidenceLabel = cell.n >= t.belowMarketMinN && cell.rolledUp !== 'market' && !cell.lowCoverage ? 'MEDIUM' : 'LOW';
    return { basis: 'cell', n: cell.n, ...statsOf(cell.values), confidence, cellKey, comps: [], unknown: [] };
  }
  return { basis: 'cell', n: cell?.n ?? 0, values: [], low: null, p25: null, median: null, p75: null, high: null, confidence: 'LOW', cellKey, comps: [], unknown: [] };
}
