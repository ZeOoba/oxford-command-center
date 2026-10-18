// Refute wf_fb340eb2 (Hard Invariant 3), the low findings. SYNTHETIC terms and rosters only.
//  P3: the branch parent (484ad726) ran a RAW lowercase substring test over its values-joined text;
//      the merge kept only main's normalised test over it, which is not a superset of the raw one
//      (NFKD of a compatibility character after a capital sigma flips the sigma's final form).
//  P4: an anchor list made only of private-use / unassigned / noncharacter code points loaded, but
//      roster-core strips such an anchor, so the context group relied on a literal code point.
//  P5: isUsableTerm is "usable under EITHER matcher"; both one-matcher-only halves are pinned.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConfidentialTerms, RosterSchemaError, scanForConfidential, type DealTerms,
} from '../../server/briefing/confidential';
import { scanTexts, tightForm } from '../../server/briefing/confidential-normalize';
import { matchRosterTerms } from '../../server/briefing/roster-core';
import { normalizeRosterText, rosterMatch, rosterMatchWithTerms } from '../../server/briefing/roster-match';

let dir: string;
const saved = { path: process.env.CONFIDENTIAL_TERMS_PATH, ph: process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER };
const write = (roster: unknown): void => {
  const p = join(dir, 't.json');
  writeFileSync(p, JSON.stringify(roster), 'utf8');
  process.env.CONFIDENTIAL_TERMS_PATH = p;
};
beforeEach(() => {
  delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  dir = mkdtempSync(join(tmpdir(), 'roster-fb340eb2-'));
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

const cp = (...n: number[]): string => String.fromCodePoint(...n);

describe('P3: the branch parent\'s raw lowercase-substring view is restored', () => {
  const SIGMA: Record<string, DealTerms> = { d1: { label: 'Sigma', active: true, always: [`Kappa ${cp(0x39f, 0x394, 0x39f, 0x3a3)}`] } };
  const value = () => ({ a: 'Kappa', b: `${cp(0x39f, 0x394, 0x39f, 0x3a3)}${cp(0x33a1)}` });
  it('premise: the raw view of the values-joined text carries the term, the normalised one does not', () => {
    const joined = 'Kappa ' + value().b;
    expect(joined.toLowerCase().includes(SIGMA.d1!.always![0]!.toLowerCase())).toBe(true);
    expect(tightForm(joined).includes(tightForm(SIGMA.d1!.always![0]!))).toBe(false);
  });
  it('HIT at scanForConfidential, rosterMatchWithTerms and rosterMatch', () => {
    write(SIGMA);
    expect(scanForConfidential(value(), SIGMA)).toEqual({ dealLabel: 'Sigma' });
    expect(rosterMatchWithTerms(value(), SIGMA)).toEqual({ dealLabel: 'Sigma' });
    expect(rosterMatch(value())).toEqual({ dealLabel: 'Sigma' });
  });
  it('the raw view also serves anchors and context terms', () => {
    const t: Record<string, DealTerms> = {
      c: { label: 'Ctx', active: true, context: [`Kappa ${cp(0x39f, 0x394, 0x39f, 0x3a3)}`], context_requires_any: ['Project Quill'] },
    };
    expect(rosterMatchWithTerms({ q: 'Project Quill', ...value() }, t)).toEqual({ dealLabel: 'Ctx' });
    expect(rosterMatchWithTerms(value(), t)).toBeNull();
  });
  // Refute wf_373225a7 (TEST INTEGRITY): the rows above use plain strings, so the raw pass running
  // over main's legacy text alone was indistinguishable from running it over every scanned text.
  // 484ad726 ran it over its UNBOXED values-joined text; here the term reaches the raw view ONLY
  // through a boxed String or a toJSON result (unboxed / hardened walks), never main's two views.
  // The Map makes main's legacy and extended texts distinct, so neither "legacy only" nor "main's
  // two views only" can satisfy these rows.
  const TAIL = `${cp(0x39f, 0x394, 0x39f, 0x3a3)}${cp(0x33a1)}`;
  const hidden: Array<[string, () => unknown]> = [
    ['a boxed String', () => ({ a: 'Kappa', b: new String(TAIL), m: new Map([['k', 'v']]) })],
    ['a toJSON result', () => ({ a: 'Kappa', b: { toJSON: () => TAIL }, m: new Map([['k', 'v']]) })],
  ];
  it.each(hidden)('premise (%s): only a non-main, raw (unnormalised) view carries the term', (_n, make) => {
    const term = SIGMA.d1!.always![0]!;
    const texts = scanTexts(make());
    const rawHas = texts.map((t) => t.toLowerCase().includes(term.toLowerCase()));
    expect(texts.length).toBeGreaterThanOrEqual(3);
    expect(rawHas.slice(0, 2)).toEqual([false, false]); // main's legacy and original extended views
    expect(rawHas.slice(2)).toContain(true);
    expect(texts.some((t) => tightForm(t).includes(tightForm(term)))).toBe(false);
    expect(matchRosterTerms(make(), SIGMA)).toBeNull();
  });
  it.each(hidden)('term carried only by %s: HIT at scanForConfidential, rosterMatchWithTerms and rosterMatch', (_n, make) => {
    write(SIGMA);
    expect(scanForConfidential(make(), SIGMA)).toEqual({ dealLabel: 'Sigma' });
    expect(rosterMatchWithTerms(make(), SIGMA)).toEqual({ dealLabel: 'Sigma' });
    expect(rosterMatch(make())).toEqual({ dealLabel: 'Sigma' });
  });
});

describe('P4: an anchor list of only private-use / unassigned / noncharacter code points', () => {
  const dead: Array<[string, string]> = [
    ['U+E000 (private use)', cp(0xe000)],
    ['U+F0000 (plane-15 private use)', cp(0xf0000)],
    ['U+0378 (unassigned)', cp(0x378)],
    ['U+FFFF (noncharacter)', cp(0xffff)],
    ['U+10FFFF (noncharacter)', cp(0x10ffff)],
    ['U+FDD0 (noncharacter) with spaces', ` ${cp(0xfdd0)} `],
    ['two private-use code points', cp(0xe000, 0xe001)],
  ];
  it.each(dead)('premise (%s): main keeps it, roster-core strips it', (_n, a) => {
    expect(tightForm(a)).not.toBe('');
    expect(normalizeRosterText(a)).toBe('');
  });
  it.each(dead)('context gated only by %s -> RosterSchemaError', (_n, a) => {
    write({ d: { label: 'D', context: ['Acme Lane'], context_requires_any: [a] } });
    expect(() => loadConfidentialTerms()).toThrow(RosterSchemaError);
    expect(() => rosterMatch('Acme Lane at the corner')).toThrow(RosterSchemaError);
  });
  it.each(dead)('%s next to a dead twin -> still RosterSchemaError', (_n, a) => {
    write({ d: { label: 'D', context: ['Acme Lane'], context_requires_any: [a, cp(0xe123)] } });
    expect(() => loadConfidentialTerms()).toThrow(RosterSchemaError);
  });
  it.each(dead)('%s plus a usable anchor -> loads and the usable anchor gates the context', (_n, a) => {
    write({ d: { label: 'D', context: ['Acme Lane'], context_requires_any: [a, 'Project Quill'] } });
    expect(() => loadConfidentialTerms()).not.toThrow();
    expect(rosterMatch('Project Quill: Acme Lane')).toEqual({ dealLabel: 'D' });
    expect(rosterMatch('Acme Lane at the corner')).toBeNull();
  });
  it.each(dead)('%s plus a blank anchor (unanchored, fail closed) -> loads and context is always active', (_n, a) => {
    write({ d: { label: 'D', context: ['Acme Lane'], context_requires_any: [a, cp(0x200b)] } });
    expect(() => loadConfidentialTerms()).not.toThrow();
    expect(rosterMatch('Acme Lane at the corner')).toEqual({ dealLabel: 'D' });
  });
  it.each(dead)('%s anchors with no context term but a usable always term -> loads (the entry does not rely on them)', (_n, a) => {
    write({ d: { label: 'D', always: ['Kestrel Ridge'], context_requires_any: [a] } });
    expect(() => loadConfidentialTerms()).not.toThrow();
    expect(rosterMatch('Kestrel Ridge')).toEqual({ dealLabel: 'D' });
  });
  it('a retired entry with dead anchors still loads (retiring never breaks the gate)', () => {
    write({ d: { label: 'D', active: false, context: ['Acme Lane'], context_requires_any: [cp(0xe000)] }, g: { always: ['zz good'] } });
    expect(() => loadConfidentialTerms()).not.toThrow();
  });
  it('a punctuation-only anchor is NOT dead (both matchers can match it literally): loads', () => {
    write({ d: { label: 'D', context: ['Acme Lane'], context_requires_any: ['#'] } });
    expect(() => loadConfidentialTerms()).not.toThrow();
  });
});

describe('P5: the unusable-term rule is "usable under EITHER matcher"', () => {
  // Main's tightForm keeps a private-use code point, roster-core strips it.
  const mainOnly = cp(0xe000);
  // Main's tightForm deletes a superscript digit, roster-core's NFKC folds it to '2'.
  const coreOnly = cp(0xb2);
  it('premise: each term normalises to something under exactly one matcher', () => {
    expect([tightForm(mainOnly) !== '', normalizeRosterText(mainOnly) !== '']).toEqual([true, false]);
    expect([tightForm(coreOnly) !== '', normalizeRosterText(coreOnly) !== '']).toEqual([false, true]);
  });
  it('an entry whose only always term only main can match loads', () => {
    write({ d: { label: 'D', always: [mainOnly] } });
    expect(() => loadConfidentialTerms()).not.toThrow();
    expect(rosterMatch(`x${mainOnly}y`)).toEqual({ dealLabel: 'D' });
  });
  it('an entry whose only always term only roster-core can match loads', () => {
    write({ d: { label: 'D', always: [coreOnly] } });
    expect(() => loadConfidentialTerms()).not.toThrow();
    expect(rosterMatch('Suite 2')).toEqual({ dealLabel: 'D' });
  });
  it('the same holds for a context term (with a usable anchor)', () => {
    write({ a: { context: [mainOnly], context_requires_any: ['Project Quill'] }, b: { context: [coreOnly], context_requires_any: ['Project Quill'] } });
    expect(() => loadConfidentialTerms()).not.toThrow();
  });
});
