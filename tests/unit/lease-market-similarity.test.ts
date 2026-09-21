import { describe, it, expect } from 'vitest';
import {
  haversineMi, resolveComparables, scoreSimilarity, selectComps, type CompCandidate, type SpaceProfile,
} from '../../src/analytics/lease-market/similarity';
import type { ComputedCell } from '../../src/analytics/lease-market/benchmarks';
import type { LmThresholds, SimilarityWeights } from '../../src/contracts/lease-market';

const W: SimilarityWeights = { location: 30, size: 25, clearHeight: 15, age: 10, loading: 10, office: 10 };
const T = {
  similarityMinScore: 60, similarityTopK: 15, similarityMinComps: 8, similarityHighComps: 15, belowMarketMinN: 10,
  similarityPerPropertyCap: 3, similarityUnknownLowCap: 3,
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

  // R8: nine identical suites in one building must not be able to fill (and dominate) the comp set.
  it('caps a single dominant property at 3 comps, keeping its highest scorers', () => {
    const sister = (n: number): CompCandidate => ({ ...subject, listingId: n, propertyId: 900, askingNnnEq: 4.0, addressDisplay: `sister ${n}` });
    const other = (n: number): CompCandidate => ({ ...subject, listingId: 100 + n, propertyId: 1000 + n, askingNnnEq: 8.0, addressDisplay: `other ${n}` });
    const candidates = [...Array.from({ length: 9 }, (_, i) => sister(i + 1)), ...Array.from({ length: 6 }, (_, i) => other(i + 1))];
    const sel = selectComps(subject, null, candidates, W, T);
    expect(sel.comps.filter((c) => c.candidate.propertyId === 900)).toHaveLength(3);
    expect(sel.comps).toHaveLength(9); // 3 capped sister suites + 6 distinct-property others
    expect(sel.sufficient).toBe(true);
  });
});

// Weekly sweep 2026-09-21 (determinism lens): comp selection broke score ties on the AUTOINCREMENT listingId,
// i.e. the row order of the CoStar export, so the same candidates in a different sort produced a different
// comp median (8.50 vs 11.00 in the reviewer's repro), flipping the radar score, below_market and the feed.
describe('selectComps — order independence', () => {
  // Small deterministic PRNG so the permutations are reproducible.
  const shuffled = <T,>(xs: readonly T[], seed: number): T[] => {
    const out = [...xs];
    let s = seed;
    for (let i = out.length - 1; i > 0; i--) {
      s = (s * 1664525 + 1013904223) % 4294967296;
      const j = s % (i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  /** 20 comps, every one IDENTICAL to the subject on every scored field (all tie at score 100, distance 0,
   *  same size), each in its own property with its own rent. K = 15 cuts straight through the tie. */
  const tied = (): CompCandidate[] =>
    Array.from({ length: 20 }, (_, i) =>
      cand({ listingId: 500 + i, propertyId: 7000 + i, askingNnnEq: 5 + i, addressDisplay: `${100 + i} Tie Rd` }),
    );
  const NO_SPLIT_T = { ...T, similarityPerPropertyCap: 3 };

  it('picks the same comps and the same median whatever order the rows arrive in', () => {
    const base = tied();
    const reference = selectComps(subject, null, base, W, NO_SPLIT_T);
    const refIds = reference.comps.map((c) => c.candidate.listingId).sort((a, b) => a - b);
    for (let seed = 1; seed <= 25; seed++) {
      // Re-issue listingIds in the permuted order too: that is what a different export sort does.
      const permuted = shuffled(base, seed).map((c, i) => ({ ...c, listingId: 9000 + i }));
      const sel = selectComps(subject, null, permuted, W, NO_SPLIT_T);
      const rents = sel.comps.map((c) => c.candidate.askingNnnEq).sort((a, b) => a - b);
      expect(rents).toEqual(reference.comps.map((c) => c.candidate.askingNnnEq).sort((a, b) => a - b));
    }
    expect(refIds.length).toBeGreaterThan(0);
  });

  it('still honours the top-K cap when a tie straddles the cut', () => {
    const sel = selectComps(subject, null, tied(), W, NO_SPLIT_T);
    expect(sel.comps).toHaveLength(15); // 20 tie on the data key; K = 15 seats, none decided by row order
  });

  it('keeps the tied group median and spread: seats are stratum midpoints over rent ranks, not the cheapest', () => {
    const rents = selectComps(subject, null, tied(), W, NO_SPLIT_T)
      .comps.map((c) => c.candidate.askingNnnEq)
      .sort((a, b) => a - b);
    // Group rents 5..24 (median 14.5). A rent-ascending key would keep 5..19 (median 12); median-proximity
    // would keep 7..21 and compress the spread. Stratum midpoints keep the median and the spread without
    // pinning the extremes.
    expect(rents[0]).toBeLessThanOrEqual(7);
    expect(Math.max(...rents)).toBeGreaterThanOrEqual(22);
    expect(Math.abs(rents[Math.floor(rents.length / 2)]! - 14.5)).toBeLessThanOrEqual(1);
  });

  it('a bimodal tied group keeps BOTH modes instead of letting one street name win every seat', () => {
    // 5 @ $8 and 5 @ $12, all tied on the data key; 4 seats at the cut. Median-proximity returned
    // [8,8,8,8] (address ordering decided the equidistant pairs).
    const group = [
      ...Array.from({ length: 5 }, (_, i) => cand({ listingId: 300 + i, propertyId: 6000 + i, askingNnnEq: 8, addressDisplay: `A${i} Low St` })),
      ...Array.from({ length: 5 }, (_, i) => cand({ listingId: 310 + i, propertyId: 6100 + i, askingNnnEq: 12, addressDisplay: `Z${i} High St` })),
    ];
    const rents = selectComps(subject, null, group, W, { ...T, similarityTopK: 4 }).comps
      .map((c) => c.candidate.askingNnnEq)
      .sort((a, b) => a - b);
    expect(rents).toEqual([8, 8, 12, 12]);
  });

  it('a plurality does not win every seat (6 @ $12 + 4 @ $8, 4 seats)', () => {
    const group = [
      ...Array.from({ length: 6 }, (_, i) => cand({ listingId: 320 + i, propertyId: 6200 + i, askingNnnEq: 12, addressDisplay: `H${i} St` })),
      ...Array.from({ length: 4 }, (_, i) => cand({ listingId: 330 + i, propertyId: 6300 + i, askingNnnEq: 8, addressDisplay: `L${i} St` })),
    ];
    const rents = selectComps(subject, null, group, W, { ...T, similarityTopK: 4 }).comps
      .map((c) => c.candidate.askingNnnEq)
      .sort((a, b) => a - b);
    expect(rents).toEqual([8, 8, 12, 12]);
  });

  it('the per-property cap samples identical sister suites across the rent range, not the cheapest', () => {
    const sisters = Array.from({ length: 6 }, (_, i) =>
      cand({ listingId: 700 + i, propertyId: 900, askingNnnEq: 4 + i, addressDisplay: 'One Building Ave' }),
    );
    const rents = selectComps(subject, null, sisters, W, NO_SPLIT_T).comps
      .map((c) => c.candidate.askingNnnEq)
      .sort((a, b) => a - b);
    expect(rents).toEqual([4, 6, 8]); // stratum midpoints, half-even at the exact .5s; the old rent-ascending tie-break kept [4, 5, 6]
  });

  it('an anomalous sister-suite ask is not guaranteed a seat in a 10-suite building (reviewer: [8 x9, 30] kept [8, 8, 30])', () => {
    const sisters = [...Array.from({ length: 9 }, () => 8), 30].map((r, i) =>
      cand({ listingId: 800 + i, propertyId: 901, askingNnnEq: r, addressDisplay: 'Anomaly Ave' }),
    );
    const rents = selectComps(subject, null, sisters, W, NO_SPLIT_T).comps.map((c) => c.candidate.askingNnnEq);
    expect(rents).toEqual([8, 8, 8]);
  });

  it('resolves a full tie on the remaining DATA fields (docks 2 vs 3), never on arrival order', () => {
    const mk = (listingId: number, docks: number): CompCandidate =>
      cand({ listingId, propertyId: 5000 + listingId, askingNnnEq: 9, addressDisplay: 'Same Ave', docks });
    const chosen = ([[2, 3], [3, 2]] as const).map((order) => {
      // reissue listingIds in arrival order, as a different export sort would
      const cs = order.map((docks, i) => mk(10 + i, docks));
      return selectComps(subject, null, cs, W, { ...T, similarityTopK: 1, similarityMinScore: 0 }).comps[0]!.candidate.docks;
    });
    expect(chosen[0]).toBe(chosen[1]);
    expect(chosen[0]).toBe(2); // lower docks first: the direction is pinned, not just determinism
  });

  it('resolveComparables returns an identical median for every permutation (the reviewer repro)', () => {
    const base = tied();
    const medians = new Set<number | null>();
    for (let seed = 1; seed <= 25; seed++) {
      const permuted = shuffled(base, seed).map((c, i) => ({ ...c, listingId: 100 + i }));
      medians.add(resolveComparables(subject, null, permuted, null, W, T).median);
    }
    expect([...medians]).toHaveLength(1);
  });

  it('still ranks a genuinely better comp ahead of a worse one (data key first)', () => {
    const near = cand({ listingId: 900, propertyId: 8001, askingNnnEq: 20, addressDisplay: 'Z' });
    const farther = cand({ listingId: 1, propertyId: 8002, askingNnnEq: 3, addressDisplay: 'A', lat: 39.99, lon: -82.9 });
    const sel = selectComps(subject, null, [farther, near], W, { ...T, similarityTopK: 1 });
    expect(sel.comps.map((c) => c.candidate.listingId)).toEqual([900]); // closer wins despite the higher listingId
  });

  it('an unknown distance ranks after a known one', () => {
    const known = cand({ listingId: 901, propertyId: 8003, askingNnnEq: 9, addressDisplay: 'K' });
    const unknown = cand({ listingId: 2, propertyId: 8004, askingNnnEq: 9, addressDisplay: 'A', lat: null, lon: null, submarket: 'East' });
    const sel = selectComps(subject, null, [unknown, known], W, { ...T, similarityTopK: 2, similarityMinScore: 0 });
    expect(sel.comps[0]!.candidate.listingId).toBe(901);
  });

  it('a single seat over an even-sized tied group does not always take the upper middle (half-even rounding)', () => {
    let above = 0;
    let total = 0;
    for (let n = 2; n <= 40; n += 2) {
      const group = Array.from({ length: n }, (_, i) =>
        cand({ listingId: 1000 + i, propertyId: 9100 + i, askingNnnEq: 5 + i, addressDisplay: `G${i} Rd` }),
      );
      const rent = selectComps(subject, null, group, W, { ...T, similarityTopK: 1 }).comps[0]!.candidate.askingNnnEq;
      const lowerMiddle = 5 + n / 2 - 1;
      total += 1;
      if (rent > lowerMiddle) above += 1;
    }
    // half-up rounding gave 20/20; half-even alternates
    expect(above / total).toBeGreaterThan(0.3);
    expect(above / total).toBeLessThan(0.7);
  });

  it('cap-3 bound on the anomaly protection: dropped from 7 tied suites up, can hold a seat in a 4-6 suite building', () => {
    const keeps30 = (n: number) => {
      const rents = [...Array.from({ length: n - 1 }, () => 8), 30];
      const sisters = rents.map((r, i) => cand({ listingId: 600 + i, propertyId: 950 + n, askingNnnEq: r, addressDisplay: `Bound${n} Ave` }));
      return selectComps(subject, null, sisters, W, NO_SPLIT_T).comps.some((c) => c.candidate.askingNnnEq === 30);
    };
    expect(keeps30(7)).toBe(false);
    expect(keeps30(10)).toBe(false);
    // documented behavior, not a guarantee: small buildings can still carry the outlier
    expect([keeps30(4), keeps30(5), keeps30(6)].some(Boolean)).toBe(true);
  });

  it('sister suites identical on every field are capped deterministically whatever the order', () => {
    const sisters = Array.from({ length: 6 }, (_, i) =>
      cand({ listingId: 700 + i, propertyId: 900, askingNnnEq: 4 + i, addressDisplay: 'One Building Ave' }),
    );
    const key = (cs: CompCandidate[]) =>
      selectComps(subject, null, cs, W, NO_SPLIT_T).comps.map((c) => c.candidate.askingNnnEq).sort((a, b) => a - b);
    const ref = key(sisters);
    expect(ref).toHaveLength(3);
    for (let seed = 1; seed <= 15; seed++) {
      expect(key(shuffled(sisters, seed).map((c, i) => ({ ...c, listingId: 50 + i })))).toEqual(ref);
    }
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
    // 16 candidates all tie on the data key, K = 15: the cut samples evenly spaced rent ranks, so the
    // group's full range survives (this used to drop the highest LISTING ID, i.e. 9.5 and the top of the
    // range, purely because of row order) and one interior comp (8.7) is the one left out.
    expect(r).toMatchObject({ basis: 'similarity', n: 15, confidence: 'HIGH', low: 8, high: 9.5 });
    expect(r.median).toBeCloseTo(8.8);
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

  // R3: an unknown component is a guess, not free evidence — confidence must be capped down from
  // whatever the raw n/coverage computation would otherwise give.
  describe('confidence is capped by unknown components (R3)', () => {
    const noLocSubject: SpaceProfile = { ...subject, lat: null, lon: null, submarket: null };
    const noLocCand = (n: number): CompCandidate => ({
      ...subject, lat: null, lon: null, submarket: null, listingId: n, propertyId: 2000 + n, askingNnnEq: 9, addressDisplay: 'x',
    });

    it('caps at MEDIUM when only location is unknown, even at n=15', () => {
      const comps = Array.from({ length: 16 }, (_, i) => noLocCand(i + 1));
      const r = resolveComparables(noLocSubject, null, comps, null, W, T);
      expect(r.n).toBe(15);
      expect(r.confidence).toBe('MEDIUM');
      expect(r.unknown).toEqual(['location']);
    });

    it('caps at LOW when 3 or more components are unknown', () => {
      const blankSubject: SpaceProfile = {
        ...subject, lat: null, lon: null, submarket: null, clearHeightFt: null, yearBuilt: null, docks: null, driveIns: null, officePct: null,
      };
      const blankCand = (n: number): CompCandidate => ({ ...blankSubject, listingId: n, propertyId: 3000 + n, askingNnnEq: 9, addressDisplay: 'x' });
      const comps = Array.from({ length: 16 }, (_, i) => blankCand(i + 1));
      const r = resolveComparables(blankSubject, null, comps, null, W, T);
      expect(r.n).toBe(15);
      expect(r.confidence).toBe('LOW');
      expect(r.unknown.length).toBeGreaterThanOrEqual(3);
    });

    it('an all-known comp set is unaffected (unchanged HIGH at n=15, empty unknown)', () => {
      const comps = Array.from({ length: 16 }, (_, i) => cand({ askingNnnEq: (80 + i) / 10 }));
      const r = resolveComparables(subject, null, comps, cell({}), W, T);
      expect(r.confidence).toBe('HIGH');
      expect(r.unknown).toEqual([]);
    });

    // I-1: a fully-populated subject must not be capped down just because its comps are each
    // individually missing a DIFFERENT field. Before the fix, resolveComparables unioned every
    // per-comp `unknown` list -- 3 comps missing location + 3 missing clearHeight + 3 missing age + 3
    // missing loading + 3 missing office union to all 5 components, capping a fully-known subject at
    // LOW. On real CoStar data (15 comps, each thin on some different field is the NORMAL case) that
    // silently killed below_market signals, zeroed the radar's belowMarket points, and dropped the
    // property from the market-rent feed.
    it('a fully-populated subject is not capped by comps that are each missing a different field (I-1)', () => {
      const group = (field: 'location' | 'clearHeight' | 'age' | 'loading' | 'office', n: number): CompCandidate => {
        const base = cand({ listingId: n, propertyId: 4000 + n, askingNnnEq: 9 });
        if (field === 'location') return { ...base, lat: null, lon: null, submarket: null };
        if (field === 'clearHeight') return { ...base, clearHeightFt: null };
        if (field === 'age') return { ...base, yearBuilt: null };
        if (field === 'loading') return { ...base, docks: null, driveIns: null };
        return { ...base, officePct: null };
      };
      const comps = [
        ...Array.from({ length: 3 }, (_, i) => group('location', i + 1)),
        ...Array.from({ length: 3 }, (_, i) => group('clearHeight', i + 4)),
        ...Array.from({ length: 3 }, (_, i) => group('age', i + 7)),
        ...Array.from({ length: 3 }, (_, i) => group('loading', i + 10)),
        ...Array.from({ length: 3 }, (_, i) => group('office', i + 13)),
      ];
      const r = resolveComparables(subject, null, comps, null, W, T);
      expect(r.n).toBe(15);
      expect(r.confidence).toBe('HIGH');
      expect(r.unknown).toEqual([]);
    });
  });

  // R8: with the dominant property capped to 3 comps, the median is driven by the other six buildings.
  it('a per-property-capped comp set is driven by the six non-dominant buildings, not the nine sister suites', () => {
    const sister = (n: number): CompCandidate => ({ ...subject, listingId: n, propertyId: 900, askingNnnEq: 4.0, addressDisplay: `sister ${n}` });
    const other = (n: number): CompCandidate => ({ ...subject, listingId: 100 + n, propertyId: 1000 + n, askingNnnEq: 8.0, addressDisplay: `other ${n}` });
    const candidates = [...Array.from({ length: 9 }, (_, i) => sister(i + 1)), ...Array.from({ length: 6 }, (_, i) => other(i + 1))];
    const r = resolveComparables(subject, null, candidates, null, W, T);
    expect(r.basis).toBe('similarity');
    expect(r.comps.filter((c) => c.candidate.propertyId === 900)).toHaveLength(3);
    expect(r.median).toBe(8);
  });
});
