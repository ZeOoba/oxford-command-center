// Reconciliation of the two confidential-roster matchers (merge of origin/main c04bf53b into the
// audit-W1 branch; Hard Invariant 3, fail closed). Neither matcher is a superset of the other, so
// every gate runs BOTH and refuses when EITHER hits: rosterMatchWithTerms is
// `scanForConfidential ?? matchRosterTerms`, and the mirror edge scan is
// `mainEdgeScan ?? matchRosterTerms`. This suite pins the union AT EACH GATE:
//  - a case only main's normalised scanner catches (bidi-reversed text, a superscript inside a word,
//    Error.message / cause, an AggregateError member, a percent-encoded URL) is caught;
//  - a case only roster-core's matcher catches (a private-use character, a PDF line-end hyphen, a
//    letter-spaced single word, an object key, split sibling / nested leaves, a term as one of 200k
//    keys) is caught;
//  - hardening ported INTO main's flatteners (iterative 20k-deep input, boxed primitives, toJSON) is
//    caught by main's scanner itself as well as by the union;
//  - a blank / invisible-only anchor roster loads and leaves its group unanchored (fail closed);
//  - a truly malformed roster still throws RosterSchemaError, and every roster-loading gate throws;
//  - the placeholder roster is refused at egress;
//  - the mirror edge endpoint refuses to egress when it cannot scan.
// SYNTHETIC names, prices and addresses only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runAgentMock = vi.fn(async (opts: { emit: (e: unknown) => unknown }) => {
  await opts.emit({ type: 'done', model: 'stub', refs: [] });
});
vi.mock('../../server/ai/agent', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, runAgent: (opts: { emit: (e: unknown) => unknown }) => runAgentMock(opts) };
});
// The Pages Function validates the baked snapshot with Zod; only the guard is under test here, so
// the parse is a pass-through (affects functions/api/ai.ts's runtime use only).
vi.mock('../../src/contracts/index', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, PortfolioSnapshot: { parse: (x: unknown) => x } };
});

import {
  RosterSchemaError, loadConfidentialTerms, scanForConfidential, type DealTerms,
} from '../../server/briefing/confidential';
import {
  egressRosterMatch, matchRosterTerms, rosterMatch, rosterMatchWithTerms,
} from '../../server/briefing/roster-match';
import { publicationRosterScan } from '../../server/sources/deal-declassification';
import { agentConfidentialScan } from '../../server/ai/egress-scan';
import { CONFIDENTIALITY_GUARD_UNAVAILABLE_MESSAGE } from '../../server/ai/agent';
import {
  MIRROR_SCAN_UNAVAILABLE_MESSAGE, edgeConfidentialScan, onRequestPost, resetRateLimit,
} from '../../functions/api/ai';
import type { PortfolioSnapshot } from '../../src/contracts/index';

const cp = (...n: number[]) => String.fromCodePoint(...n);

const ROSTER: Record<string, DealTerms> = {
  union: { label: 'Union', active: true, always: ['Heronmoor', 'Zephyrine Holdings', '$3,875,000'] },
};

let dir: string;
const saved = { path: process.env.CONFIDENTIAL_TERMS_PATH, ph: process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER };
const writeRoster = (roster: unknown): void => {
  const p = join(dir, `t-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(roster), 'utf8');
  process.env.CONFIDENTIAL_TERMS_PATH = p;
};
beforeEach(() => {
  delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  dir = mkdtempSync(join(tmpdir(), 'roster-union-'));
  writeRoster(ROSTER);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  resetRateLimit();
  runAgentMock.mockClear();
});
afterEach(() => {
  if (saved.path === undefined) delete process.env.CONFIDENTIAL_TERMS_PATH;
  else process.env.CONFIDENTIAL_TERMS_PATH = saved.path;
  if (saved.ph === undefined) delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  else process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = saved.ph;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** The mirror's snapshot: the same synthetic identities as flagged deals (edge terms are a flagged
 *  deal's name and shortName). */
const EDGE_SNAPSHOT = {
  meta: { asOf: '2026-10-01', scenario: 'base' },
  deals: [
    { id: 'd0', name: 'Heronmoor', shortName: '$3,875,000', confidential: true },
    { id: 'd1', name: 'Zephyrine Holdings', shortName: null, confidential: true },
    { id: 'd2', name: 'Public Yard', shortName: null, confidential: false },
  ],
} as unknown as PortfolioSnapshot;

type Gate = (v: unknown) => { dealLabel: string } | null;
const GATES: Array<[string, () => Gate]> = [
  ['rosterMatch', () => rosterMatch],
  ['rosterMatchWithTerms', () => (v) => rosterMatchWithTerms(v, ROSTER)],
  ['publicationRosterScan', () => publicationRosterScan],
  ['egressRosterMatch', () => egressRosterMatch],
  ['agentConfidentialScan', () => agentConfidentialScan],
  ['edge scan (functions/api/ai.ts)', () => edgeConfidentialScan(EDGE_SNAPSHOT)!],
];

const deep = (depth: number, leaf: unknown, wrap: (v: unknown) => unknown): unknown => {
  let v = leaf;
  for (let i = 0; i < depth; i++) v = wrap(v);
  return v;
};
const manyKeys = (n: number, extra: Record<string, string>): Record<string, string> => {
  const o: Record<string, string> = {};
  for (let i = 0; i < n; i++) o[`k${i}`] = 'x';
  return Object.assign(o, extra);
};

/** Caught ONLY by main's normalised scanner (roster-core's matcher misses each). */
const MAIN_ONLY: Array<[string, () => unknown]> = [
  ['bidi-override run rendering reversed text', () => `${cp(0x202e)}roomnoreH${cp(0x202c)} update`],
  ['superscript digit inside a word', () => `Heron${cp(0xb2)}moor update`],
  ['Error.message', () => ({ e: new Error('Heronmoor deal withdrawn') })],
  ['Error.cause', () => new Error('lookup failed', { cause: 'Heronmoor' })],
  ['AggregateError member', () => new AggregateError([new Error('Heronmoor')], 'several failed')],
  ['percent-encoded URL', () => ({ u: new URL('https://x.test/Zephyrine%20Holdings') })],
];

/** Caught ONLY by roster-core's matcher (main's normalised scanner misses each). */
const BRANCH_ONLY: Array<[string, () => unknown]> = [
  ['private-use character inside the word', () => `Heron${cp(0xe000)}moor update`],
  ['PDF line-end hyphen', () => 'Heron-\nmoor update'],
  ['letter-spaced single word', () => 'H e r o n m o o r'],
  ['term as an object key', () => ({ Heronmoor: 5 })],
  ['split across sibling leaves', () => ['Heron', 'moor']],
  ['split across nesting levels', () => ['Heron', ['moor']]],
  ['term as one of 200k keys', () => manyKeys(200_000, { Heronmoor: 'x' })],
];

/** Hardening ported into main's flatteners by the merge: main's scanner itself now catches these
 *  (before: RangeError on the 20k-deep input; nothing read for a boxed Number or a toJSON object). */
const PORTED: Array<[string, () => unknown]> = [
  ['20k-deep nested arrays', () => deep(20_000, 'Heronmoor', (v) => [v])],
  ['20k-deep nested objects', () => deep(20_000, 'Heronmoor', (v) => ({ c: v }))],
  ['200k-key object, term in a value', () => manyKeys(200_000, { z: 'Heronmoor' })],
  ['boxed Number price', () => ({ price: new Number(3875000) })],
  ['boxed String', () => ({ n: new String('Heronmoor') })],
  ['toJSON returning the term', () => ({ at: { toJSON: () => 'Heronmoor' } })],
];

describe('premises: each case is caught by exactly the scanner claimed', () => {
  it.each(MAIN_ONLY)('main-only: %s', (_n, make) => {
    expect(scanForConfidential(make(), ROSTER)).not.toBeNull();
    expect(matchRosterTerms(make(), ROSTER)).toBeNull();
  });
  it.each(BRANCH_ONLY)('branch-only: %s', (_n, make) => {
    expect(matchRosterTerms(make(), ROSTER)).not.toBeNull();
    expect(scanForConfidential(make(), ROSTER)).toBeNull();
  });
  it.each(PORTED)('ported into main\'s flatteners: %s', (_n, make) => {
    expect(scanForConfidential(make(), ROSTER)).toEqual({ dealLabel: 'Union' });
    expect(matchRosterTerms(make(), ROSTER)).toEqual({ dealLabel: 'Union' });
  });
});

describe.each(GATES)('union at the gate: %s', (_g, gate) => {
  it.each(MAIN_ONLY)('catches a main-only case: %s', (_n, make) => {
    expect(gate()(make())).not.toBeNull();
  });
  it.each(BRANCH_ONLY)('catches a branch-only case: %s', (_n, make) => {
    expect(gate()(make())).not.toBeNull();
  }, 30_000);
  it.each(PORTED)('catches a ported-hardening case: %s', (_n, make) => {
    expect(gate()(make())).not.toBeNull();
  }, 30_000);
  it('passes clean text', () => {
    expect(gate()('Public Yard LOI countersigned; quarterly NOI update')).toBeNull();
  });
  it('an exponentially unfolding DAG throws (budget, fail closed) instead of hanging', () => {
    let v: unknown = 'ab';
    for (let i = 0; i < 24; i++) v = [v, v];
    const t0 = performance.now();
    expect(() => gate()(v)).toThrow();
    expect(performance.now() - t0).toBeLessThan(10_000);
  }, 30_000);
});

describe('blank / invisible-only anchors: the roster loads and the group is UNANCHORED', () => {
  const zw = cp(0x200b);
  it.each<[string, string[]]>([
    ['the only anchor is the empty string', ['']],
    ['the only anchor is zero-width', [zw]],
    ['the only anchor is whitespace', ['   ']],
    ['a blank anchor next to a real one', ['', 'Project Quill']],
  ])('%s', (_n, anchors) => {
    const roster = { ctx: { label: 'Ctx', active: true, always: [], context: ['Harbor Point'], context_requires_any: anchors } };
    writeRoster(roster);
    expect(() => loadConfidentialTerms()).not.toThrow();
    const text = 'Harbor Point update, no anchor anywhere';
    for (const g of [rosterMatch, publicationRosterScan, egressRosterMatch, agentConfidentialScan]) {
      expect(g(text)).toEqual({ dealLabel: 'Ctx' });
    }
    expect(rosterMatchWithTerms(text, roster)).toEqual({ dealLabel: 'Ctx' });
    expect(rosterMatch('quarterly update')).toBeNull();
  });
});

describe('truly malformed rosters still throw RosterSchemaError (every roster-loading gate fails closed)', () => {
  const good = { label: 'Good', active: true, always: ['zz good term'] };
  it.each<[string, unknown]>([
    ['context with an EMPTY anchor array', { context: ['Harbor Point'], context_requires_any: [] }],
    ['context with no anchor field', { context: ['Harbor Point'] }],
    ['anchors that are not an array', { context: ['Harbor Point'], context_requires_any: 'Project Quill' }],
    ['anchors that are not strings', { context: ['Harbor Point'], context_requires_any: [1] }],
    ['an active entry whose only terms are invisible / blank', { always: [cp(0x200b), ' ', cp(0xfeff, 0x200d)] }],
    ['anchors with no context and no always term', { context_requires_any: ['Project Quill'] }],
    ['an always field that is a string', { always: 'Heronmoor' }],
    ['always carrying a non-string', { always: ['Heronmoor', 42] }],
    ['a non-boolean active', { active: 'yes', always: ['Heronmoor'] }],
    ['an unknown match field only', { terms: ['Heronmoor'] }],
    ['an empty entry', {}],
    ['a bare array entry', ['Heronmoor']],
    ['a string entry', 'Heronmoor'],
    ['a null entry', null],
  ])('%s', (_n, entry) => {
    writeRoster({ good, x: entry });
    expect(() => loadConfidentialTerms()).toThrow(RosterSchemaError);
    expect(() => rosterMatch('anything')).toThrow(RosterSchemaError);
    expect(() => publicationRosterScan('anything')).toThrow(RosterSchemaError);
    expect(() => egressRosterMatch('anything')).toThrow(RosterSchemaError);
    expect(() => agentConfidentialScan('anything')).toThrow(CONFIDENTIALITY_GUARD_UNAVAILABLE_MESSAGE);
    // A present, malformed roster is not "absent": the placeholder opt-out cannot mask it.
    process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = '1';
    expect(() => loadConfidentialTerms()).toThrow(RosterSchemaError);
  });
});

// L2 (final refute): what validateEntry counts as usable, and the anchors-without-context shape.
// RULE: a term is usable only if it normalises to something under EITHER matcher (main's tightForm
// or roster-core's normalizeRosterText); an active entry needs a usable `always` term, or usable
// `context` terms with a non-empty anchor array. Usable context terms with no / an empty anchor
// array still throw (a context group that can never fire). Anchors with NO usable context are
// harmless when a usable `always` term covers the deal (both parents and the hook accept the
// shape, and the anchors gate nothing), so that shape now LOADS; with no usable `always` term it
// still throws (the entry matches nothing).
describe('L2: validateEntry usability is judged on the normalised term', () => {
  it('an invisible-only term next to a real one is ignored, the entry loads and matches', () => {
    writeRoster({ a: { label: 'A', active: true, always: [cp(0x200b), 'Heronmoor'] } });
    expect(() => loadConfidentialTerms()).not.toThrow();
    expect(rosterMatch('Heronmoor update')).toEqual({ dealLabel: 'A' });
  });
  it('anchors with no context load when a usable always term covers the deal (parents accept it)', () => {
    writeRoster({ a: { label: 'A', active: true, always: ['Heronmoor'], context: [], context_requires_any: [''] } });
    expect(() => loadConfidentialTerms()).not.toThrow();
    expect(rosterMatch('Heronmoor update')).toEqual({ dealLabel: 'A' });
    writeRoster({ a: { label: 'A', active: true, always: ['Heronmoor'], context_requires_any: ['Project Quill'] } });
    expect(() => loadConfidentialTerms()).not.toThrow();
  });
  it('context terms that are all invisible count as no context: with anchors and no always term it throws', () => {
    writeRoster({ a: { label: 'A', active: true, context: [cp(0x200b)], context_requires_any: ['Project Quill'] } });
    expect(() => loadConfidentialTerms()).toThrow(RosterSchemaError);
  });
});

describe('L1: the edge scan needs a flagged name or shortName of at least 3 characters', () => {
  const snap = (name: string, shortName: string | null) =>
    ({ meta: { asOf: '2026-10-01', scenario: 'base' }, deals: [{ id: 'd', name, shortName, confidential: true }] }) as unknown as PortfolioSnapshot;
  it('a 2-character identity gives no term (scan unavailable), a 3-character one does', () => {
    expect(edgeConfidentialScan(snap('Ab', null))).toBeUndefined();
    expect(edgeConfidentialScan(snap('Ab', 'Cd'))).toBeUndefined();
    const scan3 = edgeConfidentialScan(snap('Abc', null));
    expect(scan3).toBeDefined();
    expect(scan3!('the Abc deal')).toEqual({ dealLabel: 'Abc' });
    expect(edgeConfidentialScan(snap('Ab', 'Xyz'))!('re Xyz')).toEqual({ dealLabel: 'Ab' });
  });
});

describe('the placeholder roster is refused at egress', () => {
  it('egress / publication / agent gates throw; only the local render scan runs on the placeholder', () => {
    process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'missing.json');
    process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = '1';
    expect(() => egressRosterMatch('anything')).toThrow(/placeholder/);
    expect(() => publicationRosterScan('anything')).toThrow(/placeholder/);
    expect(() => agentConfidentialScan('anything')).toThrow(CONFIDENTIALITY_GUARD_UNAVAILABLE_MESSAGE);
    expect(rosterMatch('__ora_confidential_placeholder__')).toEqual({ dealLabel: 'Confidential Deal' });
  });
  it('an unreadable roster with no opt-out throws at every gate', () => {
    process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'missing.json');
    expect(() => rosterMatch('anything')).toThrow(/absent/);
    expect(() => egressRosterMatch('anything')).toThrow(/absent/);
    expect(() => agentConfidentialScan('anything')).toThrow(CONFIDENTIALITY_GUARD_UNAVAILABLE_MESSAGE);
  });
});

describe('the mirror edge endpoint refuses when it cannot scan', () => {
  function ctx(question: string, snapshot: unknown, apiKey?: string) {
    const request = new Request('https://mirror.test/api/ai', { method: 'POST', body: JSON.stringify({ question }) });
    const env = { ANTHROPIC_API_KEY: apiKey, ASSETS: { fetch: async () => new Response(JSON.stringify(snapshot), { status: 200 }) } };
    return { request, env } as unknown as Parameters<typeof onRequestPost>[0];
  }
  it('no flagged deal (redacted bake) + API key: the scan-unavailable refusal, runAgent never called', async () => {
    const snap = { meta: { asOf: '2026-10-01', scenario: 'base' }, deals: [{ id: 'p', name: 'Public Yard', shortName: null, confidential: false }] };
    expect(edgeConfidentialScan(snap as unknown as PortfolioSnapshot)).toBeUndefined();
    const text = await (await onRequestPost(ctx('Heronmoor status', snap, 'sk-test'))).text();
    expect(text).toContain('event: error');
    expect(text).toContain(MIRROR_SCAN_UNAVAILABLE_MESSAGE.slice(0, 40));
    expect(text.toLowerCase()).not.toContain('heronmoor');
    expect(runAgentMock).not.toHaveBeenCalled();
  });
  it('a flagged deal + API key: runAgent runs with the union scan injected', async () => {
    await (await onRequestPost(ctx('portfolio NOI?', EDGE_SNAPSHOT, 'sk-test'))).text();
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    const scan = (runAgentMock.mock.calls[0]![0] as unknown as { confidentialScan: Gate }).confidentialScan;
    expect(scan(`${cp(0x202e)}roomnoreH${cp(0x202c)}`)).not.toBeNull(); // main-only
    expect(scan(`Heron${cp(0xe000)}moor`)).not.toBeNull(); // branch-only
  });
});
