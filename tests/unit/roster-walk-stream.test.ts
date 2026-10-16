// Refute round 6, G3: the matcher's value walk joined only DIRECT sibling strings, so a word split
// across a parent and a child, a key and its value or sibling keys missed, and it walked neither
// toJSON results nor Map / Set contents. The walk now also scans the document-order string stream
// (what JSON.stringify would emit), is iterative and cycle-safe. The positive variants live in the
// shared roster-variants table (ROSTER_VALUE_VARIANTS); this pins the negatives, the bounds and the
// cost. Synthetic terms only.
import { describe, it, expect } from 'vitest';
import type { DealTerms } from '../../server/briefing/confidential';
import { matchRosterTerms, rosterMatchWithTerms } from '../../server/briefing/roster-match';
import { ScanBudgetError } from '../../server/briefing/roster-core';
import { scanTexts } from '../../server/briefing/confidential-normalize';

const terms: Record<string, DealTerms> = {
  k: { label: 'K', active: true, always: ['Kestrel Ridge', 'Heronmoor'] },
  w: { label: 'W', active: true, always: ['Westport'] },
  p: { label: 'P', active: true, always: ['$4,250,000'] },
};
const scan = (v: unknown) => rosterMatchWithTerms(v, terms)?.dealLabel ?? null;

describe('G3: document-order stream', () => {
  it.each<[string, unknown, string]>([
    ['parent / child', ['Kest', ['rel Ridge']], 'K'],
    ['deep parent / child', { a: ['Kes', { b: ['trel', [' Ri']] }], c: 'dge' }, 'K'],
    ['key / value', { Kest: 'rel Ridge' }, 'K'],
    ['sibling keys around a number', { Kest: 1, 'rel Ridge': 2 }, 'K'],
    ['Date-like toJSON inside a record', { at: { toJSON: () => 'Heron' }, b: 'moor' }, 'K'],
    ['Map entries', new Map<string, unknown>([['a', 'Heron'], ['b', 'moor']]), 'K'],
  ])('%s', (_n, v, label) => {
    expect(scan(v)).toBe(label);
  });

  it.each<[string, unknown]>([
    ['separate words across nesting', ['Mid', ['west portfolio']]],
    ['separate words across a key and value', { 'West Corp': 'port authority' }],
    ['numbers are not in the stream', { a: 4, b: 250, c: 0 }],
  ])('negative: %s', (_n, v) => {
    expect(scan(v)).toBeNull();
  });

  // CHANGED by the merge with origin/main (c04bf53b): moved out of the negatives above, where it was
  // `expect(scan(v)).toBeNull()`. rosterMatchWithTerms is now the OR of main's normalised
  // scanForConfidential and roster-core's matcher; main's canonical digit-run form reads the
  // flattened '42 50,000' as '4250000', so the union HITS 'P'. ACCEPTED fail-closed over-match
  // (availability cost), never a leak. roster-core's stream still never merges them (pinned below).
  it('cross-field digit groups: roster-core never merges them, the union over-matches (accepted)', () => {
    const v = { a: ['42'], b: { c: '50,000' } };
    expect(matchRosterTerms(v, terms)).toBeNull();
    expect(scan(v)).toBe('P');
  });

  it('a cycle terminates (the matcher core is cycle-safe)', () => {
    const a: Record<string, unknown> = { note: 'Heron' };
    a.self = a;
    a.tail = 'moor';
    expect(matchRosterTerms(a, terms)?.dealLabel).toBe('K');
  });

  it('a throwing toJSON propagates (fail closed, never a silent pass)', () => {
    expect(() => matchRosterTerms({ toJSON: () => { throw new Error('boom'); } }, terms)).toThrow('boom');
  });

  it('deep (20k levels) input does not overflow the matcher core', () => {
    let deep: unknown = 'Heronmoor';
    for (let i = 0; i < 20_000; i++) deep = [deep];
    expect(matchRosterTerms(deep, terms)?.dealLabel).toBe('K');
  });

  it('cost scales linearly with width (no quadratic in the stream)', () => {
    const build = (n: number) => {
      const rows: Record<string, unknown> = {};
      for (let i = 0; i < n; i++) rows[`r${i}`] = { note: ['Lease renewal - 22,000 SF', ['clear height 24 ft']], m: new Map([['k', 'v']]) };
      return rows;
    };
    const time = (v: unknown) => {
      const t0 = performance.now();
      expect(scan(v)).toBeNull();
      return performance.now() - t0;
    };
    time(build(2_000)); // warm-up
    // CHANGED (squash, machine-load robustness; was min of 2 runs per size and a 24x bound, which
    // failed once at 25.3x on a loaded box): the inputs are built once, the two sizes are timed
    // INTERLEAVED three times and the MIN of each is kept, so a load spike has to hit all three runs
    // of the small size and none of the large to skew the ratio. 8x the input: linear is ~8x,
    // quadratic ~64x; the 32x bound is still half the quadratic ratio, so a real quadratic fails.
    const smallV = build(10_000);
    const largeV = build(80_000);
    const smalls: number[] = [];
    const larges: number[] = [];
    for (let r = 0; r < 3; r++) {
      smalls.push(time(smallV));
      larges.push(time(largeV));
    }
    const small = Math.min(...smalls);
    const large = Math.min(...larges);
    expect(large / Math.max(small, 1)).toBeLessThan(32);
  });

  // Final refute, L3: the child list is charged to the budget as it is QUEUED, so a Map whose
  // iterator never ends throws instead of exhausting memory (the branch tip ran out of heap).
  it('a Map with an endless iterator throws ScanBudgetError (fail closed), it does not hang', () => {
    class Endless extends Map<unknown, unknown> {
      override *[Symbol.iterator](): MapIterator<[unknown, unknown]> {
        let i = 0;
        for (;;) yield [`k${i++}`, 'v'] as [unknown, unknown];
      }
    }
    expect(() => matchRosterTerms(new Endless(), terms)).toThrow(ScanBudgetError);
    expect(() => rosterMatchWithTerms(new Endless(), terms)).toThrow(ScanBudgetError);
  }, 30_000);

  // Final refute, L3: the ancestor chain was a Set with add / delete per enter / exit, which degraded
  // to O(depth) per visit when a shared object recurs under a deep spine (flattener: 20k levels
  // ~1 s, 4x per doubling; the branch tip's walk: 200k levels ~186 s). Now a never-deleted counter.
  it('a deep spine over one shared object costs about the same as over distinct objects', () => {
    const spine = (d: number, mk: () => unknown) => {
      let v: unknown = 'leaf';
      for (let i = 0; i < d; i++) v = { s: mk(), n: v };
      return v;
    };
    const shared = { a: 'x', b: ['y', 'z'] };
    const vShared = spine(20_000, () => shared);
    const vDistinct = spine(20_000, () => ({ a: 'x', b: ['y', 'z'] }));
    const t = (v: unknown) => {
      const runs: number[] = [];
      for (let r = 0; r < 3; r++) {
        const t0 = performance.now();
        scanTexts(v);
        runs.push(performance.now() - t0);
      }
      return Math.min(...runs);
    };
    t(vDistinct); // warm-up
    expect(t(vShared) / Math.max(t(vDistinct), 1)).toBeLessThan(5);
  }, 60_000);
});
