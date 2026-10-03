// @vitest-environment node
//
// tests/unit/edge-contracts.test.ts — Oxford Edge Phase 1 contract invariants (spec §3, §5.2, §6).
import { describe, expect, it } from 'vitest';
import {
  EDGE_SERIES, EdgeSeriesCell, EdgeStatus, RecordPullRequest, SERIES_UNITS, EdgeMarketsResponse,
} from '@contracts/edge';
import * as contracts from '@contracts/index';

describe('Edge contracts', () => {
  it('declares exactly 18 series and a unit for every one (no more, no less)', () => {
    expect(EDGE_SERIES).toHaveLength(18);
    expect(Object.keys(SERIES_UNITS).sort()).toEqual([...EDGE_SERIES].sort());
  });

  it('pins the unit table from spec §3', () => {
    expect(SERIES_UNITS.vac).toBe('pct_level');
    expect(SERIES_UNITS.loss).toBe('pct_level');
    expect(SERIES_UNITS.per).toBe('ksf');
    expect(SERIES_UNITS.carriers).toBe('per_10k');
    expect(SERIES_UNITS.incLevel).toBe('usd');
    expect(SERIES_UNITS.mfgInvest).toBe('usd');
    expect(SERIES_UNITS.migration).toBe('persons');
    expect(SERIES_UNITS.ios).toBe('signal');
    for (const k of ['pop', 'job', 'inc', 'trades', 'biz', 'hvacPermits', 'truck', 'storage', 'rent', 'eGrocery'] as const) {
      expect(SERIES_UNITS[k]).toBe('pct_yoy');
    }
  });

  it("treats 'null' as a string status member distinct from JSON null", () => {
    expect(EdgeStatus.safeParse('null').success).toBe(true);
    expect(EdgeStatus.safeParse(null).success).toBe(false);
  });

  it('rejects a series cell whose values and status lengths differ', () => {
    expect(EdgeSeriesCell.safeParse({ values: [1, null], status: ['actual'] }).success).toBe(false);
    expect(EdgeSeriesCell.safeParse({ values: [1, null], status: ['actual', 'null'] }).success).toBe(true);
  });

  it('RecordPullRequest is strict and bounds the note at 2000 chars', () => {
    const ok = { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-30', note: 'baseline' };
    expect(RecordPullRequest.safeParse(ok).success).toBe(true);
    expect(RecordPullRequest.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(RecordPullRequest.safeParse({ ...ok, kind: 'rent' }).success).toBe(false);
    expect(RecordPullRequest.safeParse({ ...ok, doneOn: '09/30/2026' }).success).toBe(false);
    expect(RecordPullRequest.safeParse({ ...ok, note: 'x'.repeat(2001) }).success).toBe(false);
    const { note: _note, ...noNote } = ok;
    expect(RecordPullRequest.safeParse(noNote).success).toBe(true);
  });

  it('accepts an empty (missing-dataset) markets envelope', () => {
    const empty = {
      availability: 'missing', dir: 'C:/nowhere', freshness: null, readError: null, lastGoodLoadedAt: null,
      years: [], fieldMeta: {}, sources: {}, coverage: [], markets: [], rejectedMarkets: [], marketCount: 0,
      issues: [], outsidePullScope: { truck: [], mfgInvest: [] },
    };
    expect(EdgeMarketsResponse.safeParse(empty).success).toBe(true);
  });

  it('is re-exported from the contracts index', () => {
    expect(contracts.EDGE_SERIES).toBe(EDGE_SERIES);
  });
});
