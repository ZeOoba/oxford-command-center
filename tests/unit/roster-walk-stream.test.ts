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

/**
 * A deterministic cost meter for `fn` (replaces wall-clock timing, which swings ~3x with machine
 * load): while `fn` runs, each String.prototype scanning method is wrapped to charge the characters
 * it is handed (the receiver's length from the start position; a slice's result length), and
 * Array.prototype.join its result length. A scan whose string work grows quadratically (re-reading
 * or re-normalising a growing text per piece) charges quadratically. Restored in `finally`.
 */
function meter(fn: () => void): number {
  let chars = 0;
  const S = String.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const A = Array.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const saved: Array<[Record<string, (...a: unknown[]) => unknown>, string, (...a: unknown[]) => unknown]> = [];
  const wrap = (
    proto: Record<string, (...a: unknown[]) => unknown>,
    name: string,
    charge: (self: unknown, args: unknown[], out: unknown) => number,
  ) => {
    const orig = proto[name]!;
    saved.push([proto, name, orig]);
    proto[name] = function (this: unknown, ...args: unknown[]) {
      const out = orig.apply(this, args);
      chars += charge(this, args, out);
      return out;
    };
  };
  const fromPos = (self: unknown, args: unknown[]) => {
    const len = String(self).length;
    const p = typeof args[1] === 'number' ? Math.max(0, Math.min(len, args[1])) : 0;
    return len - p;
  };
  const whole = (self: unknown) => String(self).length;
  for (const m of ['indexOf', 'includes', 'startsWith']) wrap(S, m, fromPos);
  for (const m of ['lastIndexOf', 'endsWith', 'normalize', 'split', 'toLowerCase', 'toUpperCase', 'replace', 'replaceAll', 'match', 'matchAll', 'search', 'trim']) wrap(S, m, whole);
  for (const m of ['slice', 'substring']) wrap(S, m, (_s, _a, out) => String(out).length);
  wrap(A, 'join', (_s, _a, out) => String(out).length);
  try {
    fn();
  } finally {
    for (const [proto, name, orig] of saved.reverse()) proto[name] = orig;
  }
  return chars;
}

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

  // CHANGED (2026-11-02, CI determinism): this was a wall-clock ratio (min of 3 interleaved runs at
  // 10k / 80k rows, < 32x). It took ~28 s idle and hit the 60 s timeout on the loaded self-hosted
  // runner. Cost is now COUNTED, so the result no longer depends on machine load: `meter` charges
  // every string primitive the scan calls with the characters it is handed (see below), and every
  // row's `note` is an accessor that counts its reads (the walk work). 8x the input: linear is 8x,
  // quadratic ~64x. The meter is validated on a known-quadratic loop in the same test, so a ratio
  // under the bound means "linear", not "the meter saw nothing".
  it('cost scales linearly with width (no quadratic in the stream)', () => {
    let reads = 0;
    const build = (n: number) => {
      const rows: Record<string, unknown> = {};
      for (let i = 0; i < n; i++) {
        const row: Record<string, unknown> = { m: new Map([['k', 'v']]) };
        Object.defineProperty(row, 'note', {
          enumerable: true,
          get: () => {
            reads++;
            return ['Lease renewal - 22,000 SF', ['clear height 24 ft']];
          },
        });
        rows[`r${i}`] = row;
      }
      return rows;
    };
    const cost = (v: unknown) => {
      reads = 0;
      const chars = meter(() => expect(scan(v)).toBeNull());
      return { chars, reads };
    };
    const small = cost(build(1_000));
    const large = cost(build(8_000));
    // Positive controls: the meter and the accessor both saw the scan's work.
    expect(small.reads).toBeGreaterThan(0);
    expect(small.chars).toBeGreaterThan(1_000 * 'clear height 24 ft'.length);
    // The walk work is EXACTLY linear: every walk reads each row's note the same number of times.
    expect(large.reads).toBe(8 * small.reads);
    // The string work is linear (8x, with slack for fixed per-scan cost); a quadratic is ~64x.
    expect(large.chars / small.chars).toBeLessThan(10);
    // The meter itself sees a quadratic: re-scanning a growing prefix per row reads ~64x at 8x.
    const quadratic = (n: number) =>
      meter(() => {
        let prefix = '';
        for (let i = 0; i < n; i++) {
          prefix += 'ab';
          prefix.includes('zz');
        }
      });
    expect(quadratic(8_000) / quadratic(1_000)).toBeGreaterThan(32);
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
