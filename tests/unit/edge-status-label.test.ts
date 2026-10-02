// tests/unit/edge-status-label.test.ts — status labels, value formatting, latest-observed, board
// model (spec §8.3, F3, F4).
import { describe, expect, it } from 'vitest';
import type { EdgeStatus } from '@contracts/edge';
import {
  EDGE_BOARD_DEFAULT_STATE, EDGE_PICKER_SERIES, edgeCellDisplay, edgeSeriesHeader, edgeStatusLabel, filterEdgeMarkets,
  formatEdgeValue, latestObserved, localIsoToday, sortEdgeMarkets,
} from '../../src/modules/acquisitions/edge-hooks';
import { cell, fourMarkets, mkMarket, obs, TEST_FIELD_META, TEST_YEARS } from './edge-test-helpers';

describe('edgeStatusLabel', () => {
  it.each<[EdgeStatus, { text: string | null; title: string | null; dotted: boolean }]>([
    ['actual', { text: null, title: null, dotted: false }],
    ['estimated', { text: null, title: 'Est.', dotted: true }],
    ['nowcast', { text: null, title: 'Nowcast', dotted: true }],
    ['guide_only', { text: 'Pending manual pull', title: 'Pending manual pull', dotted: false }],
    ['null', { text: 'Not published', title: 'Not published', dotted: false }],
  ])('%s', (status, expected) => {
    expect(edgeStatusLabel(status)).toEqual(expected);
  });
});

describe('formatEdgeValue (F4: never a number for null)', () => {
  it('formats each unit', () => {
    expect(formatEdgeValue(1.42, 'pct_yoy')).toBe('+1.4%');
    expect(formatEdgeValue(-0.5, 'pct_yoy')).toBe('-0.5%');
    expect(formatEdgeValue(4, 'pct_level')).toBe('4.0%');
    expect(formatEdgeValue(1086.8, 'ksf')).toBe('1,087 kSF');
    expect(formatEdgeValue(3.2, 'per_10k')).toBe('3.2 /10k');
    expect(formatEdgeValue(63000, 'usd')).toBe('$63,000');
    expect(formatEdgeValue(1200, 'persons')).toBe('+1,200');
    expect(formatEdgeValue(-92423, 'persons')).toBe('-92,423');
    // rounding/sign come from the rounded value
    expect(formatEdgeValue(-0.04, 'pct_yoy')).toBe('0.0%');
    expect(formatEdgeValue(0.04, 'pct_yoy')).toBe('0.0%');
    expect(formatEdgeValue(-0.04, 'pct_level')).toBe('0.0%');
    expect(formatEdgeValue(-0.4, 'persons')).toBe('0');
    expect(formatEdgeValue(0.4, 'persons')).toBe('0');
    expect(formatEdgeValue(-5, 'usd')).toBe('-$5');
    expect(formatEdgeValue(-0.4, 'usd')).toBe('$0');
    expect(formatEdgeValue(-1234.6, 'usd')).toBe('-$1,235');
    expect(formatEdgeValue(-0.004, 'signal')).toBe('0.00');
    expect(formatEdgeValue(-0.4, 'ksf')).toBe('0 kSF');
  });

  it('returns null for null — the status label always wins', () => {
    for (const u of ['pct_yoy', 'pct_level', 'ksf', 'per_10k', 'usd', 'persons', 'signal'] as const) {
      expect(formatEdgeValue(null, u)).toBeNull();
    }
  });
});

describe('latestObserved', () => {
  it('takes the last index with an observed status and a non-null value', () => {
    expect(latestObserved(obs([1000, 1100, 1200, null, null]), TEST_YEARS)).toEqual({
      value: 1200, year: 2023, status: 'actual', isLatestYear: false,
    });
  });

  it('ignores a value under a non-observed status and null under an observed status', () => {
    const c = cell([1, 2, 3, 4, null], ['actual', 'actual', 'actual', 'guide_only', 'actual']);
    expect(latestObserved(c, TEST_YEARS)?.year).toBe(2023);
  });

  it('returns null when nothing is observed', () => {
    expect(latestObserved(cell([null, null, null, null, null], ['guide_only', 'guide_only', 'guide_only', 'guide_only', 'guide_only']), TEST_YEARS)).toBeNull();
  });
});

describe('edgeCellDisplay', () => {
  it('shows the year when the latest observation is not the final year', () => {
    expect(edgeCellDisplay(obs([1000, 1100, 1200, null, null]), 'persons', TEST_YEARS, 'migration').text).toBe('+1,200 (2023)');
  });

  it('marks estimated values dotted with an Est. title', () => {
    const d = edgeCellDisplay(cell([1, 1, 1, 1, 9], ['actual', 'actual', 'actual', 'actual', 'estimated']), 'pct_yoy', TEST_YEARS, 'trades');
    expect(d).toEqual({ text: '+9.0%', title: 'Est.', dotted: true, observed: true });
  });

  it('F4: storage reads Pending manual pull, never 0', () => {
    const d = edgeCellDisplay(fourMarkets()[0]!.series.storage, 'pct_yoy', TEST_YEARS, 'storage');
    expect(d.text).toBe('— Pending manual pull');
    expect(d.text).not.toMatch(/\d/);
  });

  it('truck reads Not yet available where null', () => {
    expect(edgeCellDisplay(fourMarkets()[0]!.series.truck, 'pct_yoy', TEST_YEARS, 'truck').text).toBe('— Not yet available');
  });
});

describe('edgeSeriesHeader (F3)', () => {
  it('uses trueLabel + [PROXY] for the three proxies and never the raw key', () => {
    for (const k of ['hvacPermits', 'biz', 'eGrocery'] as const) {
      const h = edgeSeriesHeader(k, TEST_FIELD_META);
      expect(h).toBe(`${TEST_FIELD_META[k]!.trueLabel} [PROXY]`);
      expect(h).not.toContain(k);
    }
    expect(edgeSeriesHeader('storage', TEST_FIELD_META)).toBe('Self-storage asking rate growth');
    expect(edgeSeriesHeader('storage', {})).toBe('Unlabelled series');
  });

  it('the picker offers the 12 non-board series', () => {
    expect(EDGE_PICKER_SERIES).toHaveLength(12);
    expect(EDGE_PICKER_SERIES).toContain('hvacPermits');
    expect(EDGE_PICKER_SERIES).not.toContain('trades');
  });
});

describe('board model', () => {
  const a = mkMarket('a', 'Alpha', 'OH', 'named', { trades: obs([1, 1, 1, 1, 5]) });
  const b = mkMarket('b', 'Bravo', 'OH', 'auto', { trades: obs([1, 1, 1, 1, 9]) });
  const c = mkMarket('c', 'Charlie', 'OH', 'named_custom');
  const d = mkMarket('d', 'Delta', 'OH', 'auto', { trades: obs([1, 1, 1, 1, 1]) });
  const ids = (ms: { id: string }[]) => ms.map((m) => m.id);

  it('filters by set', () => {
    expect(ids(filterEdgeMarkets([a, b, c, d], 'buybox'))).toEqual(['a', 'c']);
    expect(ids(filterEdgeMarkets([a, b, c, d], 'auto'))).toEqual(['b', 'd']);
    expect(ids(filterEdgeMarkets([a, b, c, d], 'all'))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('pins buy-box first under All, sorted within each group, nulls last', () => {
    const s = { ...EDGE_BOARD_DEFAULT_STATE, set: 'all' as const };
    expect(ids(sortEdgeMarkets([a, b, c, d], s, TEST_YEARS))).toEqual(['a', 'c', 'b', 'd']);
    expect(ids(sortEdgeMarkets([a, b, c, d], { ...s, pinBuyBox: false }, TEST_YEARS))).toEqual(['b', 'a', 'd', 'c']);
    expect(ids(sortEdgeMarkets([a, b, c, d], { ...s, pinBuyBox: false, sortDir: 'asc' }, TEST_YEARS))).toEqual(['d', 'a', 'b', 'c']);
    expect(ids(sortEdgeMarkets([a, b, c, d], { ...s, pinBuyBox: false, sortKey: 'name', sortDir: 'asc' }, TEST_YEARS))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('guide_only / null series sort LAST in both directions, never as 0 between negatives and positives', () => {
    const neg = mkMarket('neg', 'Neg', 'OH', 'named', { trades: obs([-1, -1, -1, -1, -3]) });
    const pos = mkMarket('pos', 'Pos', 'OH', 'named', { trades: obs([1, 1, 1, 1, 3]) });
    const guide = mkMarket('guide', 'Guide', 'OH', 'named'); // all guide_only / null placeholder
    const s = { ...EDGE_BOARD_DEFAULT_STATE, set: 'all' as const, pinBuyBox: false };
    expect(ids(sortEdgeMarkets([guide, neg, pos], { ...s, sortDir: 'desc' }, TEST_YEARS))).toEqual(['pos', 'neg', 'guide']);
    expect(ids(sortEdgeMarkets([guide, neg, pos], { ...s, sortDir: 'asc' }, TEST_YEARS))).toEqual(['neg', 'pos', 'guide']);
  });

  it('estimated / nowcast latest values participate in the sort as observed', () => {
    const est = mkMarket('est', 'Est', 'OH', 'named', { trades: cell([1, 1, 1, 1, 8], ['actual', 'actual', 'actual', 'actual', 'estimated']) });
    const now = mkMarket('now', 'Now', 'OH', 'named', { trades: cell([1, 1, 1, 1, 6], ['actual', 'actual', 'actual', 'actual', 'nowcast']) });
    const act = mkMarket('act', 'Act', 'OH', 'named', { trades: obs([1, 1, 1, 1, 7]) });
    const s = { ...EDGE_BOARD_DEFAULT_STATE, set: 'all' as const, pinBuyBox: false };
    expect(ids(sortEdgeMarkets([now, act, est], s, TEST_YEARS))).toEqual(['est', 'act', 'now']);
  });

  it('defaults to Buy-box, pinned, trades desc, no extra columns', () => {
    expect(EDGE_BOARD_DEFAULT_STATE).toEqual({ set: 'buybox', pinBuyBox: true, sortKey: 'trades', sortDir: 'desc', extraColumns: [] });
  });
});

describe('localIsoToday', () => {
  it('formats the local date', () => {
    expect(localIsoToday(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});
