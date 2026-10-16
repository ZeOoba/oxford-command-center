// Refute round 8, J3: the walk expanded a boxed primitive with Object.entries and got nothing
// ({price: new Number(3875000)} returned null although JSON.stringify emits 3875000), and
// collectText flattened a String object character by character. Both now unbox Number / String /
// Boolean / BigInt objects the way JSON.stringify does (Number via ToNumber, String via ToString,
// Boolean / BigInt by their internal value), after toJSON. A throwing valueOf / toString still
// propagates: the scan fails closed. Synthetic terms only.
import { describe, it, expect } from 'vitest';
import type { DealTerms } from '../../server/briefing/confidential';
import { collectText, scanForConfidential } from '../../server/briefing/confidential';
import { matchRosterTerms, rosterMatchWithTerms } from '../../server/briefing/roster-match';

const terms: Record<string, DealTerms> = {
  p: { label: 'P', active: true, always: ['$3,875,000'] },
  k: { label: 'K', active: true, always: ['Kestrel Ridge'] },
  n: { label: 'N', active: true, always: ['98765432101234567890'] },
};
const core = (v: unknown) => matchRosterTerms(v, terms)?.dealLabel ?? null;
const gate = (v: unknown) => rosterMatchWithTerms(v, terms)?.dealLabel ?? null;

describe('J3: boxed primitives are unboxed as JSON.stringify does', () => {
  it.each<[string, unknown, string]>([
    ['boxed Number', { price: new Number(3875000) }, 'P'],
    ['boxed Number nested in an array', { rows: [{ v: [new Number(3875000)] }] }, 'P'],
    ['boxed String', { name: new String('Kestrel Ridge') }, 'K'],
    ['boxed String as an array element', ['site', new String('Kestrel Ridge')], 'K'],
    ['boxed String split across a nesting level', ['Kest', [new String('rel Ridge')]], 'K'],
    ['boxed String returned by toJSON', { at: { toJSON: () => new String('Kestrel Ridge') } }, 'K'],
    ['boxed BigInt', { id: Object(98765432101234567890n) as object }, 'N'],
  ])('%s (matcher core)', (_n, v, label) => {
    expect(core(v)).toBe(label);
    expect(gate(v)).toBe(label);
  });

  it('JSON.stringify agrees on the unboxed values', () => {
    expect(JSON.stringify({ price: new Number(3875000) })).toBe('{"price":3875000}');
    expect(JSON.stringify({ name: new String('Kestrel Ridge') })).toBe('{"name":"Kestrel Ridge"}');
    expect(JSON.stringify({ f: new Boolean(false) })).toBe('{"f":false}');
  });

  it('collectText unboxes instead of dropping or spelling out', () => {
    expect(collectText({ a: new String('Kestrel Ridge'), b: new Number(7), c: new Boolean(true) })).toBe('Kestrel Ridge 7 true');
    expect(collectText([new String('ab'), [new Number(1)]])).toBe('ab 1');
    expect(scanForConfidential({ name: new String('Kestrel Ridge') }, terms)).toEqual({ dealLabel: 'K' });
  });

  it('a clean boxed value stays a miss', () => {
    expect(gate({ a: new Number(12), b: new String('lease renewal'), c: new Boolean(true) })).toBeNull();
  });

  it('a throwing valueOf / toString fails closed (throws, as JSON.stringify would)', () => {
    const n = new Number(5);
    (n as unknown as { valueOf: () => number }).valueOf = () => { throw new Error('valueOf boom'); };
    expect(() => JSON.stringify({ n })).toThrow('valueOf boom');
    expect(() => core({ n })).toThrow('valueOf boom');
    expect(() => collectText({ n })).toThrow('valueOf boom');
    const s = new String('x');
    (s as unknown as { toString: () => string }).toString = () => { throw new Error('toString boom'); };
    expect(() => core({ s })).toThrow('toString boom');
    expect(() => gate({ s })).toThrow('toString boom');
  });

  it('a plain object pretending to be a Number (prototype only) is NOT unboxed', () => {
    const fake = Object.create(Number.prototype) as object;
    expect(JSON.stringify({ fake })).toBe('{"fake":{}}');
    expect(() => core({ fake })).not.toThrow();
  });
});
