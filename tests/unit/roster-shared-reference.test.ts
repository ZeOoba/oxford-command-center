// Refute round 8, J1: the iterative collectText (H2) and the matcher walk skipped ANY object they
// had already seen, not just a cycle, so a SHARED non-cyclic object was scanned only at its first
// position. JSON.stringify writes every copy, so a term completed by the second copy
// ([s, {m: 'Kestrel'}, s] with s = {n: 'Ridge'}) passed. Pinned behaviour:
//  - a shared object is scanned wherever it reappears (only the current ancestor chain counts as a
//    cycle); the same data after JSON.parse(JSON.stringify(v)) hits the same way;
//  - a cycle still terminates;
//  - a DAG with exponential unfolding fails CLOSED (throws) quickly instead of hanging;
//  - realistic payloads (the repo's own large JSON) never trip the budget;
//  - collectText's output for ordinary input is byte-identical to the recursive form it replaced.
// Synthetic terms only.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DealTerms } from '../../server/briefing/confidential';
import { collectText, scanForConfidential } from '../../server/briefing/confidential';
import { matchRosterTerms, rosterMatchWithTerms } from '../../server/briefing/roster-match';

const terms: Record<string, DealTerms> = {
  k: { label: 'K', active: true, always: ['Kestrel Ridge'] },
  p: { label: 'P', active: true, always: ['$3,875,000'] },
};
const gate = (v: unknown) => rosterMatchWithTerms(v, terms)?.dealLabel ?? null;
const core = (v: unknown) => matchRosterTerms(v, terms)?.dealLabel ?? null;

/** collectText exactly as it was before H2 made it iterative (ca139e50): the byte-level reference. */
function recursiveCollectText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(recursiveCollectText).join(' ');
  if (typeof value === 'object') return Object.values(value).map(recursiveCollectText).join(' ');
  return '';
}

function sharedCases(): Array<[string, unknown, string]> {
  const s = { n: 'Ridge' };
  const sArr = ['Ridge'];
  const s2 = { z: 'rel Ridge' };
  const s3 = ['5,000'];
  return [
    ['shared object around a sibling record', [s, { m: 'Kestrel' }, s], 'K'],
    ['shared array around a sibling string', [sArr, 'Kestrel', sArr], 'K'],
    ['shared child under two records', { a: { x: 'Heron', p: s2 }, b: { y: 'Kest', p: s2 } }, 'K'],
    ['shared price group', [s3, '$3,87', s3], 'P'],
  ];
}

describe('J1: a shared (non-cyclic) object is scanned wherever it reappears', () => {
  it.each(sharedCases())('%s (gate)', (_n, v, label) => {
    expect(gate(v)).toBe(label);
    expect(gate(JSON.parse(JSON.stringify(v)))).toBe(label);
  });

  it.each(sharedCases())('%s (matcher core alone)', (_n, v, label) => {
    expect(core(v)).toBe(label);
  });

  it('a toJSON returning an already-seen object is scanned again', () => {
    const s = { n: 'Ridge' };
    const v = [s, 'Kestrel', { toJSON: () => s }];
    expect(JSON.stringify(v)).toBe('[{"n":"Ridge"},"Kestrel",{"n":"Ridge"}]');
    expect(core(v)).toBe('K');
    expect(gate(v)).toBe('K');
  });

  it('collectText writes every copy of a shared object, as the recursive form did', () => {
    const s = { n: 'Ridge' };
    const v = [s, 'Kestrel', s];
    expect(collectText(v)).toBe('Ridge Kestrel Ridge');
    expect(collectText(v)).toBe(recursiveCollectText(v));
    expect(scanForConfidential(v, terms)).toEqual({ dealLabel: 'K' });
  });

  it('a cycle still terminates; only the ancestor is skipped', () => {
    const a: Record<string, unknown> = { n: 'Heron' };
    a.self = a;
    a.t = 'moor';
    expect(collectText(a)).toBe('Heron  moor');
    const b: Record<string, unknown> = { n: 'Kestrel' };
    const c: Record<string, unknown> = { back: b, n: 'Ridge' };
    b.c = c;
    expect(gate(b)).toBe('K');
    expect(core(b)).toBe('K');
  });
});

describe('J1: an exponentially unfolding DAG fails closed quickly', () => {
  const dag = (depth: number) => {
    let n: unknown = { leaf: 'lease renewal' };
    for (let i = 0; i < depth; i++) n = { a: n, b: n };
    return n;
  };
  const arrDag = (depth: number) => {
    let n: unknown = ['x'];
    for (let i = 0; i < depth; i++) n = [n, n];
    return n;
  };
  it.each<[string, (v: unknown) => unknown]>([
    ['collectText', (v) => collectText(v)],
    ['matchRosterTerms', (v) => matchRosterTerms(v, terms)],
    ['rosterMatchWithTerms', (v) => rosterMatchWithTerms(v, terms)],
  ])('%s throws on 2^40 unfolding, well under the hang guard', (_n, fn) => {
    for (const v of [dag(40), arrDag(40)]) {
      const t0 = performance.now();
      expect(() => fn(v)).toThrow(/scan budget/);
      expect(performance.now() - t0).toBeLessThan(20_000);
    }
  });

  it('a toJSON that returns a fresh wrapper of itself (infinite unfolding) fails closed', () => {
    const o: Record<string, unknown> = {};
    o.toJSON = () => ({ again: o, note: 'x' });
    expect(() => matchRosterTerms(o, terms)).toThrow(/scan budget/);
  });

  it('a small DAG (shared reuse well inside the budget) still scans, every copy included', () => {
    expect(() => gate(dag(12))).not.toThrow();
    expect(collectText(arrDag(3))).toBe(recursiveCollectText(arrDag(3)));
  });
});

describe('J1: realistic payloads never trip the budget and keep byte-identical output', () => {
  const root = join(__dirname, '..', '..');
  const files = [
    'data/snapshots/portfolio.json',
    'data/property-financials/dataset.json',
    'docs/superpowers/specs/2026-06-12-pfi-account-mapping-seed.json',
    'architecture/status.json',
    'package-lock.json',
  ];
  it.each(files)('%s', (f) => {
    const v = JSON.parse(readFileSync(join(root, f), 'utf8')) as unknown;
    expect(collectText(v)).toBe(recursiveCollectText(v));
    expect(() => rosterMatchWithTerms(v, terms)).not.toThrow();
  });
  it('all of them in one payload', () => {
    const v = files.map((f) => JSON.parse(readFileSync(join(root, f), 'utf8')) as unknown);
    expect(collectText(v)).toBe(recursiveCollectText(v));
    expect(() => rosterMatchWithTerms(v, terms)).not.toThrow();
  });
  it('ordinary hand-built shapes match the recursive form byte for byte', () => {
    const shapes: unknown[] = [
      { a: ['x', 'y'], b: { c: 'z' }, d: 4, e: true },
      [null, 'a', [], 'b', undefined, {}, [[]], 0, false, ''],
      { k: { l: { m: [1, [2, [3, 'q']]] } }, n: null },
      'plain', 7, null, undefined, [],
    ];
    for (const s of shapes) expect(collectText(s)).toBe(recursiveCollectText(s));
  });
});
