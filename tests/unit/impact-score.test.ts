import { describe, it, expect } from 'vitest';
import { compareByImpact, rankByImpact, type ImpactRankable } from '../../src/lib/impact-score';

const row = (id: string, usd: number | null | undefined, extra: Partial<ImpactRankable> = {}): ImpactRankable & { id: string } => ({
  id,
  impactUsd: usd,
  ...extra,
});
const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);

describe('rankByImpact', () => {
  it('orders by dollars descending', () => {
    expect(ids(rankByImpact([row('a', 10), row('b', 300), row('c', 50)]))).toEqual(['b', 'c', 'a']);
  });

  it('puts unquantified rows last and never treats null or undefined as $0', () => {
    // A $0 row is quantified and outranks an unquantified one.
    expect(ids(rankByImpact([row('n', null), row('z', 0), row('u', undefined), row('p', 5)]))).toEqual(['p', 'z', 'n', 'u']);
  });

  it('pins first regardless of dollars (safety items are never out-ranked by money)', () => {
    const out = rankByImpact([row('big', 1_000_000), row('lapsed', null, { pinned: true }), row('mid', 5_000)]);
    expect(ids(out)).toEqual(['lapsed', 'big', 'mid']);
  });

  it('breaks dollar ties by fewer days-to-act, unknown urgency last', () => {
    const out = rankByImpact([
      row('later', 100, { daysToAct: 90 }),
      row('unknown', 100),
      row('soon', 100, { daysToAct: 10 }),
    ]);
    expect(ids(out)).toEqual(['soon', 'later', 'unknown']);
  });

  it('does not let urgency override a larger dollar figure', () => {
    expect(ids(rankByImpact([row('urgent', 100, { daysToAct: 1 }), row('big', 200, { daysToAct: 365 })]))).toEqual(['big', 'urgent']);
  });

  it('is stable for full ties and does not mutate its input', () => {
    const input = [row('a', 7), row('b', 7), row('c', null), row('d', null)];
    const snapshot = ids(input);
    expect(ids(rankByImpact(input))).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(input)).toEqual(snapshot);
  });

  it('exposes the same order through compareByImpact', () => {
    const a = row('a', 10);
    const b = row('b', 20);
    expect(compareByImpact(a, b)).toBeGreaterThan(0);
    expect(compareByImpact(b, a)).toBeLessThan(0);
    expect(compareByImpact(a, a)).toBe(0);
  });
});
