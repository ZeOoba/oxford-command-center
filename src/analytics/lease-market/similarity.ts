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
//
// DETERMINISM (weekly sweep 2026-09-21): the tie-break used to be the AUTOINCREMENT listingId, i.e. the
// order the CoStar export happened to be sorted in when it was ingested. Ties are pervasive -- the score is
// an integer, sister suites in one building are identical on every physical field, and three of the six
// components are constant in the shipped export -- so which rents reached the top-K cut depended on the
// export's row order. The same candidates in a different sort produced a comp median of 8.50 vs 11.00,
// flipping the radar score (71 vs 78), the below_market signal and the market-rent feed.
//
// Two layers, both functions of the DATA only:
//   * RANK (compareScoredComps): finer unrounded score, then closeness, then size fit -- the "data key" --
//     then address, rent, every remaining candidate field, and the surrogate ids last.
//   * CUT (cutAtTopK, used for the global top-K AND the per-property cap): when the data key ties across the
//     cut, the tied group is sorted by rent and the seats are filled at EVENLY SPACED RANKS through it
//     (lowest, ..., highest). Cutting inside a tie on address/rent/listingId is arbitrary or -- with a rent
//     key -- biased toward cheap comps; "closest to the group median" was tried and rejected because it
//     compresses the range (biases p25 up / p75 down, and a plurality can win every seat). Rank-stratified
//     selection keeps the tied group's own median AND its spread, and is a function of the tied set alone.
const SCORE_EPS = 1e-9;
const cmpNumber = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0);
const cmpText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0); // code-unit, locale-independent
/** Closer is better; an unknown distance ranks after every known one. */
const cmpDistance = (a: number | null, b: number | null): number =>
  a === null ? (b === null ? 0 : 1) : b === null ? -1 : cmpNumber(a, b);
/** Unknown (null) sorts after every known value. */
const cmpNullable = (a: number | null, b: number | null): number => cmpDistance(a, b);
const cmpNullableText = (a: string | null, b: string | null): number =>
  a === null ? (b === null ? 0 : 1) : b === null ? -1 : cmpText(a, b);
const rawScore = (sc: ScoredComp): number =>
  Math.round(Object.values(sc.similarity.parts).reduce((a, b) => a + b, 0) / SCORE_EPS);

/** The part of the ranking that reflects how good a comp IS; 0 means tied. */
function compareDataKey(subject: SpaceProfile): (a: ScoredComp, b: ScoredComp) => number {
  return (a, b) =>
    cmpNumber(rawScore(b), rawScore(a)) || // higher unrounded score first
    cmpDistance(a.similarity.distanceMi, b.similarity.distanceMi) ||
    cmpNumber(
      Math.abs(a.candidate.availableSf - subject.availableSf),
      Math.abs(b.candidate.availableSf - subject.availableSf),
    );
}

/** Strict total order: the data key, then address / rent / listingId so the sort itself is stable. */
function compareScoredComps(subject: SpaceProfile): (a: ScoredComp, b: ScoredComp) => number {
  const byData = compareDataKey(subject);
  return (a, b) =>
    byData(a, b) ||
    cmpText(a.candidate.addressDisplay, b.candidate.addressDisplay) ||
    cmpNumber(a.candidate.askingNnnEq, b.candidate.askingNnnEq) ||
    // Every remaining scored/physical field, so two candidates that differ in ANY of them rank the same
    // whatever order they arrived in. Only candidates identical on all of these reach the surrogate ids.
    cmpNumber(a.candidate.availableSf, b.candidate.availableSf) ||
    cmpNullable(a.candidate.clearHeightFt, b.candidate.clearHeightFt) ||
    cmpNullable(a.candidate.yearBuilt, b.candidate.yearBuilt) ||
    cmpNullable(a.candidate.docks, b.candidate.docks) ||
    cmpNullable(a.candidate.driveIns, b.candidate.driveIns) ||
    cmpNullable(a.candidate.officePct, b.candidate.officePct) ||
    cmpNullableText(a.candidate.submarket, b.candidate.submarket) ||
    cmpNullable(a.candidate.lat, b.candidate.lat) ||
    cmpNullable(a.candidate.lon, b.candidate.lon) ||
    cmpNumber(a.candidate.propertyId, b.candidate.propertyId) ||
    cmpNumber(a.candidate.listingId, b.candidate.listingId);
}

/**
 * Cut `ranked` (sorted by byRank) to `k` seats without letting row order decide who is in. `ranked` is
 * sorted by a refinement of the data key, so candidates tied on it with the K-th are one contiguous run
 * [lo, hi). Everything strictly ahead of the run is kept; the run supplies the remaining seats at evenly
 * spaced ranks of its rent-sorted order, so the tied group's median and spread both survive the cut.
 */
function cutAtTopK(
  ranked: ScoredComp[],
  k: number,
  byData: (a: ScoredComp, b: ScoredComp) => number,
  byRank: (a: ScoredComp, b: ScoredComp) => number,
): ScoredComp[] {
  if (ranked.length <= k) return ranked;
  const boundary = ranked[k - 1];
  if (boundary === undefined) return [];
  let lo = k - 1;
  while (lo > 0 && byData(ranked[lo - 1]!, boundary) === 0) lo -= 1;
  let hi = k;
  while (hi < ranked.length && byData(ranked[hi]!, boundary) === 0) hi += 1;
  if (hi === k) return ranked.slice(0, k); // no tie straddles the cut

  const byRent = ranked
    .slice(lo, hi)
    .sort((a, b) => cmpNumber(a.candidate.askingNnnEq, b.candidate.askingNnnEq) || byRank(a, b));
  const seats = k - lo;
  // n > seats here, so with seats >= 2 the spacing (n-1)/(seats-1) exceeds 1 and the rounded ranks are
  // distinct; a single seat takes the middle of the group.
  const picks =
    seats === 1
      ? [Math.floor((byRent.length - 1) / 2)]
      : Array.from({ length: seats }, (_, i) => Math.round((i * (byRent.length - 1)) / (seats - 1)));
  return [...ranked.slice(0, lo), ...picks.map((i) => byRent[i]!)].sort(byRank);
}

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
  const byRank = compareScoredComps(subject);
  const byData = compareDataKey(subject);
  const byProperty = new Map<number, ScoredComp[]>();
  for (const sc of scored) {
    const list = byProperty.get(sc.candidate.propertyId);
    if (list) list.push(sc);
    else byProperty.set(sc.candidate.propertyId, [sc]);
  }
  // R8 cap, through the same order-independent cut as the global top-K: suites that tie on every scored
  // field are sampled at evenly spaced rent ranks instead of always keeping the lowest asks.
  const capped = [...byProperty.values()].flatMap((list) =>
    cutAtTopK(list.sort(byRank), t.similarityPerPropertyCap, byData, byRank),
  );
  const ranked = capped.sort(byRank);
  const comps = cutAtTopK(ranked, t.similarityTopK, byData, byRank);
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
