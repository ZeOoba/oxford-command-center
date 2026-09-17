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
