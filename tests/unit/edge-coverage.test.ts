// @vitest-environment node
//
// Coverage rule (spec §5.2): filled iff value !== null AND status ∈ {actual, estimated, nowcast};
// disagreements are not filled and are listed in inconsistent[]; allPlaceholder when nothing filled.
import { describe, expect, it } from 'vitest';
import { EDGE_SERIES } from '@contracts/edge';
import { computeCoverage } from '../../server/edge/coverage';
import { cell, fourMarkets, mkMarket, obs, TEST_YEARS } from './edge-test-helpers';

const row = (rows: ReturnType<typeof computeCoverage>, field: string) => {
  const r = rows.find((x) => x.field === field);
  if (!r) throw new Error(`no coverage row for ${field}`);
  return r;
};

describe('computeCoverage', () => {
  it('returns one row per series in EDGE_SERIES order', () => {
    expect(computeCoverage(fourMarkets(), TEST_YEARS).map((r) => r.field)).toEqual([...EDGE_SERIES]);
  });

  it('counts filled cells per series and per year', () => {
    const rows = computeCoverage(fourMarkets(), TEST_YEARS);
    expect(row(rows, 'pop')).toMatchObject({ filled: 20, total: 20, pct: 1, byYear: [4, 4, 4, 4, 4], allPlaceholder: false });
    expect(row(rows, 'migration')).toMatchObject({ filled: 12, byYear: [4, 4, 4, 0, 0] });
    expect(row(rows, 'truck')).toMatchObject({ filled: 5, total: 20, byYear: [1, 1, 1, 1, 1] });
  });

  it('counts estimated as filled and reports the status mix', () => {
    const r = row(computeCoverage(fourMarkets(), TEST_YEARS), 'trades');
    expect(r.filled).toBe(20);
    expect(r.statusCounts).toEqual({ actual: 19, estimated: 1, nowcast: 0, guide_only: 0, null: 0 });
  });

  it('flags allPlaceholder for storage, mfgInvest and ios', () => {
    const rows = computeCoverage(fourMarkets(), TEST_YEARS);
    for (const f of ['storage', 'mfgInvest', 'ios']) {
      expect(row(rows, f)).toMatchObject({ filled: 0, allPlaceholder: true });
      expect(row(rows, f).statusCounts.guide_only).toBe(20);
    }
  });

  it('lists value/status disagreements as inconsistent and never counts them filled', () => {
    const m = mkMarket('x', 'X', 'OH', 'auto', {
      vac: cell([1.0, null, 2.0, null, 3.0], ['null', 'actual', 'guide_only', 'null', 'actual']),
    });
    const r = row(computeCoverage([m], TEST_YEARS), 'vac');
    expect(r.filled).toBe(1);
    expect(r.inconsistent).toEqual([
      { marketId: 'x', year: 2021 },
      { marketId: 'x', year: 2022 },
      { marketId: 'x', year: 2023 },
    ]);
  });

  it('handles an empty market list without dividing by zero', () => {
    const r = row(computeCoverage([], TEST_YEARS), 'pop');
    expect(r).toMatchObject({ filled: 0, total: 0, pct: 0, allPlaceholder: false, byYear: [0, 0, 0, 0, 0] });
  });

  it('obs() helper marks nulls as Not published', () => {
    expect(obs([1, null]).status).toEqual(['actual', 'null']);
  });
});
