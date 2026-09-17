// tests/unit/lease-market-benchmarks.test.ts
import { describe, it, expect } from 'vitest';
import {
  cellIndex, computeCell, medianOf, midRankPercentile, quantileSorted, toCellBenchmark,
  type BenchRow, type CellTarget,
} from '../../src/analytics/lease-market/benchmarks';

const P = { minN: 5, lowCoverageShare: 0.5 };
const TARGET: CellTarget = { marketId: 'columbus', submarket: 'East', subtype: 'warehouse', sizeBand: '15-30K', officeStratum: 'all' };
let nextId = 1;
function row(patch: Partial<BenchRow>): BenchRow {
  return {
    listingId: nextId++, marketId: 'columbus', submarket: 'East', subtype: 'warehouse', sizeBand: '15-30K',
    officeStratum: 'all', askingNnnEq: 8, eligible: true, clearHeightFt: null, yearBuilt: null, docks: null, ...patch,
  };
}

describe('quantiles', () => {
  it('interpolates', () => {
    expect(quantileSorted([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantileSorted([1, 2, 3, 4], 0.25)).toBe(1.75);
    expect(quantileSorted([], 0.5)).toBeNull();
    expect(medianOf([3, 1, 2])).toBe(2);
  });
  it('mid-rank percentile counts ties as half', () => {
    expect(midRankPercentile(3, [1, 2, 3, 4])).toBe(0.625);
    expect(midRankPercentile(0.5, [1, 2])).toBe(0);
    expect(midRankPercentile(5, [])).toBeNull();
  });
});

describe('computeCell', () => {
  it('uses the exact cell when it has n >= 5', () => {
    const rows = [6, 7, 8, 9, 10].map((v) => row({ askingNnnEq: v })).concat([row({ eligible: false, askingNnnEq: null })]);
    const c = computeCell(TARGET, rows, P);
    expect(c.rolledUp).toBe('none');
    expect(c.cellKey).toBe('columbus|East|warehouse|15-30K|all');
    expect([c.n, c.totalN, c.median, c.p25, c.p75]).toEqual([5, 6, 8, 7, 9]);
    expect(c.quotedShare).toBeCloseTo(5 / 6);
    expect(c.lowCoverage).toBe(false);
    expect(c.values).toEqual([6, 7, 8, 9, 10]);
  });

  it('widens the size band before dropping the submarket', () => {
    const rows = [
      ...[7, 8, 9].map((v) => row({ askingNnnEq: v })),
      ...[10, 11].map((v) => row({ askingNnnEq: v, sizeBand: '30-50K' })),
      ...[1, 1, 1, 1, 1].map((v) => row({ askingNnnEq: v, submarket: 'West' })),
    ];
    const c = computeCell(TARGET, rows, P);
    expect(c.rolledUp).toBe('size_band');
    expect(c.cellKey).toBe('columbus|East|warehouse|5-15K~30-50K|all');
    expect(c.n).toBe(5);
    expect(c.median).toBe(9);
    expect(c.sizeBand).toBe('15-30K');
  });

  it('rolls to market level when the submarket is thin', () => {
    const rows = [...[7, 8].map((v) => row({ askingNnnEq: v })), ...[9, 10, 11].map((v) => row({ askingNnnEq: v, submarket: 'West' }))];
    const c = computeCell(TARGET, rows, P);
    expect(c.rolledUp).toBe('market');
    expect(c.submarket).toBeNull();
    expect(c.cellKey).toBe('columbus|*|warehouse|5-15K~30-50K|all');
    expect(c.median).toBe(9);
  });

  it('returns null stats when nothing reaches n', () => {
    const c = computeCell(TARGET, [row({ askingNnnEq: 7 }), row({ askingNnnEq: 8 })], P);
    expect(c.rolledUp).toBe('market');
    expect([c.n, c.median, c.p25, c.p75]).toEqual([2, null, null, null]);
    expect(c.values).toEqual([]);
  });

  it('flags low coverage when most rows are unquoted', () => {
    const rows = [...[6, 7, 8, 9, 10].map((v) => row({ askingNnnEq: v })), ...Array.from({ length: 6 }, () => row({ eligible: false, askingNnnEq: null }))];
    const c = computeCell(TARGET, rows, P);
    expect(c.lowCoverage).toBe(true);
    expect(c.median).toBe(8);
  });

  it('a null-submarket target is market level from the start', () => {
    const rows = [5, 6, 7, 8, 9].map((v, i) => row({ askingNnnEq: v, submarket: i % 2 ? 'East' : 'West' }));
    const c = computeCell({ ...TARGET, submarket: null }, rows, P);
    expect(c.rolledUp).toBe('market');
    expect(c.cellKey).toBe('columbus|*|warehouse|15-30K|all');
  });

  it('never mixes subtypes, markets, or office strata', () => {
    const rows = [
      ...[6, 7, 8, 9, 10].map((v) => row({ askingNnnEq: v, subtype: 'flex' })),
      ...[6, 7, 8, 9, 10].map((v) => row({ askingNnnEq: v, marketId: 'madison' })),
      ...[6, 7, 8, 9, 10].map((v) => row({ askingNnnEq: v, officeStratum: 'office_ge40' })),
    ];
    expect(computeCell(TARGET, rows, P).n).toBe(0);
  });

  it('reports physical medians over matched rows', () => {
    const rows = [18, 20, 24, 22, 20].map((h, i) => row({ askingNnnEq: 6 + i, clearHeightFt: h, yearBuilt: 1980 + i, docks: i }));
    const c = computeCell(TARGET, rows, P);
    expect(c.physicalMedians).toEqual({ clearHeightFt: 20, yearBuilt: 1982, docks: 2 });
  });
});

describe('cellIndex / toCellBenchmark', () => {
  it('memoizes by target and strips internal fields', () => {
    const rows = [6, 7, 8, 9, 10].map((v) => row({ askingNnnEq: v }));
    const idx = cellIndex(rows, P);
    const a = idx(TARGET);
    expect(idx({ ...TARGET })).toBe(a);
    const pub = toCellBenchmark(a) as Record<string, unknown>;
    expect(pub.values).toBeUndefined();
    expect(pub.physicalMedians).toBeUndefined();
    expect(pub.median).toBe(8);
  });
});
