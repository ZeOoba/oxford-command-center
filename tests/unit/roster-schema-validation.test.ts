// Refute round 5, F3: loadTerms accepted ANY non-'_' object as a roster entry, so a typo'd entry
// ({"x":["..."]}, {"x":{"terms":[...]}}, context with no anchors, {"x":{}}) loaded as readable and
// matched nothing: the deal silently dropped out of every gate. An active entry that cannot match
// now THROWS (fail closed), regardless of the placeholder opt-out. Synthetic roster only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfidentialTerms, scanForConfidential } from '../../server/briefing/confidential';
import { rosterMatch } from '../../server/briefing/roster-match';

let dir: string;
const saved = { path: process.env.CONFIDENTIAL_TERMS_PATH, ph: process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER };
const write = (roster: unknown) => {
  const p = join(dir, 't.json');
  writeFileSync(p, JSON.stringify(roster), 'utf8');
  process.env.CONFIDENTIAL_TERMS_PATH = p;
};
beforeEach(() => {
  delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  dir = mkdtempSync(join(tmpdir(), 'roster-schema-'));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  if (saved.path === undefined) delete process.env.CONFIDENTIAL_TERMS_PATH;
  else process.env.CONFIDENTIAL_TERMS_PATH = saved.path;
  if (saved.ph === undefined) delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  else process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = saved.ph;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const GOOD = { label: 'Good', active: true, always: ['zz good term'] };

describe('loadTerms rejects an active entry that can never match', () => {
  const bad: Array<[string, unknown]> = [
    ['bare array instead of an object', ['Kestrel Ridge']],
    ['unknown field name only', { terms: ['Kestrel Ridge'] }],
    ['context with no anchors', { context: ['Kestrel Ridge'] }],
    ['anchors with no context', { context_requires_any: ['Kestrel Ridge'] }],
    ['empty object', {}],
    ['empty always', { always: [] }],
    ['blank-only always', { always: ['   ', ''] }],
    ['always is a string, not an array', { always: 'Kestrel Ridge' }],
    ['always carries a non-string', { always: ['Kestrel Ridge', 42] }],
    ['context carries a non-string', { always: ['Kestrel Ridge'], context: [null], context_requires_any: ['x'] }],
    ['non-boolean active', { active: 'false', always: ['Kestrel Ridge'] }],
    ['null entry', null],
    ['string entry', 'Kestrel Ridge'],
  ];
  it.each(bad)('%s → throws (even beside a good entry)', (_n, entry) => {
    write({ good: GOOD, x: entry });
    expect(() => loadConfidentialTerms()).toThrow(/roster entry/i);
    expect(() => scanForConfidential('anything')).toThrow();
    expect(() => rosterMatch('anything')).toThrow();
  });
  it.each(bad)('%s → throws even under CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER=1 (a present, malformed roster is not "absent")', (_n, entry) => {
    process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = '1';
    write({ good: GOOD, x: entry });
    expect(() => loadConfidentialTerms()).toThrow(/roster entry/i);
  });
  it('the error names neither the entry key nor any term (label-free, position only)', () => {
    write({ good: GOOD, 'kestrel-ridge': { context: ['Kestrel Ridge'] } });
    let msg = '';
    try { loadConfidentialTerms(); } catch (e) { msg = e instanceof Error ? e.message : String(e); }
    expect(msg).not.toMatch(/kestrel/i);
    expect(msg).toMatch(/#2/);
  });
});

describe('loadTerms still accepts well-formed rosters', () => {
  it('always-only, context+anchors-only, and both', () => {
    write({
      a: { label: 'A', active: true, always: ['zz one'] },
      b: { label: 'B', context: ['zz ctx'], context_requires_any: ['zz anchor'] },
      c: { label: 'C', always: ['zz two'], context: ['zz ctx2'], context_requires_any: ['zz anchor2'], note: 'free text ok' },
      _comment: 'meta keys are skipped',
    });
    expect(Object.keys(loadConfidentialTerms())).toEqual(['a', 'b', 'c']);
    expect(scanForConfidential('zz one')).toEqual({ dealLabel: 'A' });
  });
  it('a retired (active:false) entry is not shape-checked for terms: retiring a deal never breaks the gate', () => {
    write({ good: GOOD, old: { active: false } });
    expect(() => loadConfidentialTerms()).not.toThrow();
  });
  it('an all-retired roster stays valid (no active confidential deals is a legitimate state)', () => {
    write({ old: { label: 'Old', active: false, always: ['zz old'] } });
    expect(() => loadConfidentialTerms()).not.toThrow();
    expect(scanForConfidential('zz old')).toBeNull();
  });
});
