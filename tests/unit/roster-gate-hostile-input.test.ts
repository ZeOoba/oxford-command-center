// Refute round 7, H2: every gate enters through rosterMatchWithTerms, which runs the raw
// scanForConfidential pass (collectText) BEFORE the iterative matcher core. collectText was
// recursive, so ANY cyclic input (even one with no roster term) or a 20k-deep input threw a
// RangeError and the request was refused for the wrong reason. Pinned behaviour, at the GATE level:
//  - a cycle, a 20k-deep array and a wide object never throw a RangeError; what is reachable is
//    scanned (a planted term is caught, clean input returns null);
//  - a throwing getter / throwing toJSON still THROWS (fail closed, never a silent pass).
// Synthetic roster only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DealTerms } from '../../server/briefing/confidential';
import { collectText, scanForConfidential } from '../../server/briefing/confidential';
import { rosterMatch, rosterMatchWithTerms } from '../../server/briefing/roster-match';
import { publicationRosterScan } from '../../server/sources/deal-declassification';

const ROSTER: Record<string, DealTerms> = { syn: { label: 'Syn', active: true, always: ['Heronmoor'] } };

let dir: string;
const saved = { path: process.env.CONFIDENTIAL_TERMS_PATH, ph: process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER };
beforeEach(() => {
  delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  dir = mkdtempSync(join(tmpdir(), 'gate-hostile-'));
  const p = join(dir, 't.json');
  writeFileSync(p, JSON.stringify(ROSTER), 'utf8');
  process.env.CONFIDENTIAL_TERMS_PATH = p;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  if (saved.path === undefined) delete process.env.CONFIDENTIAL_TERMS_PATH;
  else process.env.CONFIDENTIAL_TERMS_PATH = saved.path;
  if (saved.ph === undefined) delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  else process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = saved.ph;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const gates: Array<[string, (v: unknown) => unknown]> = [
  ['rosterMatchWithTerms', (v) => rosterMatchWithTerms(v, ROSTER)],
  ['rosterMatch', (v) => rosterMatch(v)],
  ['publicationRosterScan', (v) => publicationRosterScan(v)],
];

function cyclic(withTerm: boolean): unknown {
  const a: Record<string, unknown> = { note: withTerm ? 'site: Heronmoor' : 'lease renewal' };
  const b: unknown[] = [a, 'clear height 24 ft'];
  a.self = a;
  a.peer = b;
  a.tail = 'end';
  return a;
}
function deep(withTerm: boolean): unknown {
  let v: unknown = withTerm ? 'Heronmoor' : 'lease renewal';
  for (let i = 0; i < 20_000; i++) v = [v];
  return v;
}
function wide(withTerm: boolean): unknown {
  const o: Record<string, unknown> = {};
  for (let i = 0; i < 200_000; i++) o[`k${i}`] = `row ${i}`;
  if (withTerm) o.last = 'Heronmoor';
  return o;
}

describe.each(gates)('H2: %s on hostile shapes', (_g, gate) => {
  it.each<[string, (t: boolean) => unknown]>([
    ['cyclic object', cyclic],
    ['20k-deep array', deep],
    ['wide object (200k keys)', wide],
  ])('%s: never a RangeError; reachable text scanned', (_n, build) => {
    expect(gate(build(true))).toEqual({ dealLabel: 'Syn' });
    expect(gate(build(false))).toBeNull();
  });

  it('a throwing getter fails closed (throws, not a RangeError)', () => {
    const v = { a: 'x', get b(): string { throw new Error('getter boom'); } };
    expect(() => gate(v)).toThrow('getter boom');
  });

  it('a throwing toJSON fails closed (throws, not a RangeError)', () => {
    expect(() => gate({ a: 'x', b: { toJSON: () => { throw new Error('toJSON boom'); } } })).toThrow('toJSON boom');
  });
});

describe('H2: collectText keeps its flattening semantics and is cycle-safe', () => {
  it('flattens in document order with single-space joins', () => {
    expect(collectText({ a: ['x', 'y'], b: { c: 'z' }, d: 4, e: true })).toBe('x y z 4 true');
    expect(collectText([null, 'a', [], 'b'])).toBe(' a  b');
  });
  it('a cycle terminates (the ancestor itself contributes nothing)', () => {
    const a: Record<string, unknown> = { n: 'Heron' };
    a.self = a;
    a.t = 'moor';
    expect(collectText(a)).toBe('Heron  moor');
  });
  it('20k-deep input does not overflow', () => {
    expect(scanForConfidential(deep(true), ROSTER)).toEqual({ dealLabel: 'Syn' });
  });
});
