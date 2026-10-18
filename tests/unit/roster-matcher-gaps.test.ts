// Refute round 5, F5: matcher misses in server/briefing/roster-match.ts. Synthetic terms only,
// injected directly (no roster file). Every string is built from code points where it carries a
// non-ASCII character, so the source stays ASCII.
//  (a) letters with no Unicode decomposition (l-stroke, o-slash, dotless i, sharp s, ...) and
//      enclosing / spacing combining marks;
//  (b) decimal digits from any script;
//  (c) punctuated short-token roster terms vs the same text with the punctuation dropped;
//  (d) object KEYS;
//  (e) a word split across adjacent sibling string leaves;
//  (f) PDF line-end hyphen: both rejoined and non-rejoined forms, NFKC before the rejoin.
// Accepted and NOT implemented (documented in roster-match.ts): Cyrillic/Greek homoglyph
// confusables, URL- / HTML-entity- / base64-encoded text.
import { describe, it, expect } from 'vitest';
import type { DealTerms } from '../../server/briefing/confidential';
import { matchRosterTerms, rosterMatchWithTerms, normalizeRosterText } from '../../server/briefing/roster-match';

const cp = (...n: number[]) => String.fromCodePoint(...n);

const terms: Record<string, DealTerms> = {
  fold: { label: 'Fold', active: true, always: ['Lakeview Park', 'Nordvik Lofts', 'Kestrel Ridge', 'Hauptstrasse 12', 'Aerie Point', 'Oeuvre Yard', 'Thorn Lofts', 'Dover Flex', 'Gardar Park'] },
  digits: { label: 'Digits', active: true, always: ['9900 Quarry'] },
  punct: { label: 'Punct', active: true, always: [`O'Brannigan Yard`, 'K.C. Kestrel Lofts', 'D&L Kestrel', '1,250 Kestrel Way', 'Unit 4B Kestrel'] },
  bldg: { label: 'Bldg', active: true, always: [], context: ['Bldg 7'], context_requires_any: ['Kestrel Commons'] },
  short: { label: 'Short', active: true, always: ['K.C.', 'Bay 12'] },
  ctx: { label: 'Ctx', active: true, always: [], context: ['park'], context_requires_any: ['oxbow'] },
};
const scan = (v: unknown) => rosterMatchWithTerms(v, terms)?.dealLabel ?? null;

describe('(a) letters with no decomposition, and every combining-mark class, fold to the base form', () => {
  it.each<[string, string, string]>([
    ['l with stroke', `${cp(0x141)}akeview Park`, 'Fold'],
    ['o with stroke', `N${cp(0xf8)}rdvik Lofts`, 'Fold'],
    ['capital O with stroke', `N${cp(0xd8)}RDVIK LOFTS`, 'Fold'],
    ['dotless i', `Kestrel R${cp(0x131)}dge`, 'Fold'],
    ['capital I with dot above', `KESTREL R${cp(0x130)}DGE`, 'Fold'],
    ['sharp s vs ss', `Hauptstra${cp(0xdf)}e 12`, 'Fold'],
    ['capital sharp s', `HAUPTSTRA${cp(0x1e9e)}E 12`, 'Fold'],
    ['ae ligature', `${cp(0xc6)}rie Point`, 'Fold'],
    ['oe ligature', `${cp(0x153)}uvre Yard`, 'Fold'],
    ['thorn', `${cp(0xde)}orn Lofts`, 'Fold'],
    ['d with stroke', `${cp(0x110)}over Flex`, 'Fold'],
    ['eth', `Gar${cp(0xf0)}ar Park`, 'Fold'],
    ['enclosing mark (Me)', `K${cp(0x20dd)}estrel Ridge`, 'Fold'],
    ['spacing combining mark (Mc)', `Kes${cp(0x903)}trel Ridge`, 'Fold'],
  ])('%s', (_n, text, label) => {
    expect(scan(text)).toBe(label);
  });
  it('the fold is symmetric: a roster term carrying the letter matches plain text', () => {
    const t: Record<string, DealTerms> = { x: { label: 'X', active: true, always: [`${cp(0x141)}akeview Park`, `Hauptstra${cp(0xdf)}e 12`] } };
    expect(rosterMatchWithTerms('Lakeview Park', t)?.dealLabel).toBe('X');
    expect(rosterMatchWithTerms('HAUPTSTRASSE 12', t)?.dealLabel).toBe('X');
  });
  it('normalizeRosterText folds them', () => {
    expect(normalizeRosterText(`${cp(0x141)}${cp(0xf8)}${cp(0x131)}${cp(0xdf)}`)).toBe('loiss');
  });
});

describe('(b) decimal digits from any script map to ASCII', () => {
  it.each<[string, string]>([
    ['Arabic-Indic', `${cp(0x669, 0x669, 0x660, 0x660)} Quarry Rd`],
    ['Extended Arabic-Indic', `${cp(0x6f9, 0x6f9, 0x6f0, 0x6f0)} Quarry Rd`],
    ['Devanagari', `${cp(0x96f, 0x96f, 0x966, 0x966)} Quarry`],
    ['Bengali', `${cp(0x9ef, 0x9ef, 0x9e6, 0x9e6)} Quarry`],
    ['Thai', `${cp(0xe59, 0xe59, 0xe50, 0xe50)} Quarry`],
    ['mixed scripts', `9${cp(0x669)}0${cp(0x966)} Quarry`],
  ])('%s', (_n, text) => {
    expect(scan(text)).toBe('Digits');
  });
  it('digit values are exact (no off-by-one across a block)', () => {
    expect(normalizeRosterText(cp(0x660, 0x661, 0x662, 0x663, 0x664, 0x665, 0x666, 0x667, 0x668, 0x669))).toBe('0123456789');
    expect(normalizeRosterText(cp(0x1d7ce, 0x1d7d8, 0x1d7e2))).toBe('000'); // math digits (NFKC)
  });
});

describe('(c) punctuated short-token roster terms vs the bare text', () => {
  it.each<[string, string, string]>([
    ['apostrophe dropped', 'OBrannigan Yard', 'Punct'],
    ['modifier-letter apostrophe', `O${cp(0x2bc)}Brannigan Yard`, 'Punct'],
    ['initials undotted', 'KC Kestrel Lofts', 'Punct'],
    ['ampersand dropped', 'DL Kestrel', 'Punct'],
    ['thousands separator dropped', '1250 Kestrel Way', 'Punct'],
    ['short token run together', 'Unit4B Kestrel', 'Punct'],
    ['context short term run together', 'Kestrel Commons, Bldg7', 'Bldg'],
  ])('%s', (_n, text, label) => {
    expect(scan(text)).toBe(label);
  });
  // The raw pass is plain substring and only over-matches (F6), so each negative below is written so
  // that the raw pass cannot decide it: the normalised / compact passes are what is under test.
  it.each<[string, string]>([
    // The token-boundary false positives fixed in refute round 3 (U2) and 4 (W1) stay fixed.
    ['K.C. vs "Back carriage"', 'Back carriage house'],
    ['K.C. vs "backcarriage"', 'backcarriage'],
    ['Bay 12 vs "Bay-120" (raw pass cannot decide it)', 'Bay-120 dock'],
    ['Bay 12 vs "bay120"', 'bay120'],
    ['Bldg 7 vs "Bldg-70" (anchor present)', 'Kestrel Commons, Bldg-70'],
    ['Bldg 7 vs "Bldg70" (anchor present)', 'Kestrel Commons, Bldg70'],
    // 'Unit 4 BKestrel' (a split moved inside 'Unit 4B Kestrel') was a negative here until refute
    // round 6, G1: it is now a POSITIVE (tests/unit/roster-short-token-breaks.test.ts).
    ['D&L vs a longer token', 'Ardl Kestrel'],
  ])('negative: %s', (_n, text) => {
    expect(scan(text)).toBeNull();
  });
  it('the W1 cross-field / cross-word negatives stay negative with the new short-token compact pass', () => {
    const w1: Record<string, DealTerms> = { c: { label: 'C', active: true, always: ['$4,250,000', 'Suite #10', 'Bldg #1'] } };
    for (const v of ['Building 42, 50,000 SF', { sf: 42, rentPsf: 50, price: 0, note: '000 noted' }, 'Suite 100', 'Bldg 10 roof', 'BLDG10']) {
      expect(rosterMatchWithTerms(v, w1)).toBeNull();
    }
    expect(rosterMatchWithTerms('priced at 4250000', w1)?.dealLabel).toBe('C');
    expect(rosterMatchWithTerms('Suite10 lease', w1)?.dealLabel).toBe('C');
  });
});

describe('(d) object keys are scanned', () => {
  it.each<[string, unknown]>([
    ['top-level key', { 'Kestrel Ridge': 5 }],
    ['nested key', { a: { b: { 'Kestrel Ridge': { x: 1 } } } }],
    ['key inside an array item', [{ 'kestrel-ridge': true }]],
    ['key with a normalised variant', { [`Kestrel${cp(0xa0)}Ridge`]: null }],
  ])('%s', (_n, v) => {
    expect(scan(v)).toBe('Fold');
  });
});

describe('(e) a word split across adjacent sibling string leaves', () => {
  it.each<[string, unknown]>([
    ['array, two leaves', ['Kest', 'rel Ridge']],
    ['array, three leaves', ['Kes', 'trel Ri', 'dge']],
    ['object values', { a: 'Kest', b: 'rel Ridge' }],
    ['nested container', { rows: [{ note: ['Kestrel R', 'idge'] }] }],
    ['split inside a short-token term', ['O', 'Brannigan Yard']],
  ])('%s', (_n, v) => {
    expect(scan(v)).not.toBeNull();
  });
  it('separate words in sibling leaves still do not merge into an unrelated term', () => {
    const t: Record<string, DealTerms> = { a: { label: 'A', active: true, always: ['Westport'] } };
    expect(rosterMatchWithTerms(['Midwest', 'Port Clinton'], t)).toBeNull();
    expect(rosterMatchWithTerms(['Mid', 'west portfolio'], t)).toBeNull();
    expect(rosterMatchWithTerms(['West Corp', 'port authority'], t)).toBeNull();
  });
  it('numbers are not joined (cross-field numbers vs a price term stay negative)', () => {
    const t: Record<string, DealTerms> = { c: { label: 'C', active: true, always: ['$4,250,000'] } };
    expect(rosterMatchWithTerms({ sf: 42, rent: 50, price: 0 }, t)).toBeNull();
    // CHANGED by the merge with origin/main (c04bf53b), was `expect(rosterMatchWithTerms({ sf: '42', price: '50,000' }, t)).toBeNull()`:
    // rosterMatchWithTerms is now the OR of main's normalised scanForConfidential and roster-core's
    // matcher. Main folds digits into a canonical digit-run form (any separator between two digits
    // dropped, term and haystack alike), so the flattened '42 50,000' reads as '4250000' and the union
    // HITS. ACCEPTED fail-closed over-match (availability cost: two figures that concatenate to a
    // roster price block the payload), never a leak. roster-core alone still keeps the negative.
    expect(matchRosterTerms({ sf: '42', price: '50,000' }, t)).toBeNull();
    expect(rosterMatchWithTerms({ sf: '42', price: '50,000' }, t)?.dealLabel).toBe('C');
  });
});

describe('(f) line-end hyphen: rejoined OR non-rejoined, NFKC before the rejoin', () => {
  it.each<[string, string, string]>([
    ['compound broken at a line end (needs the NON-rejoined form)', `Ex-${cp(10)}K. C. staff`, 'Short'],
    ['context anchor after a line-end compound hyphen', `the park near Pre-${cp(10)}Ox${cp(0x200b)}bow`, 'Ctx'],
    ['full-width hyphen at a line end (NFKC first, then rejoin)', `Ba${cp(0xff0d)}${cp(10)}y 12`, 'Short'],
    ['small hyphen-minus at a line end', `Ba${cp(0xfe63)}${cp(10)}y 12`, 'Short'],
    ['soft hyphen at a line end', `Ba${cp(0xad)}${cp(10)}y 12`, 'Short'],
    ['plain hyphenation still rejoins', `Ba-${cp(10)}y 12`, 'Short'],
  ])('%s', (_n, text, label) => {
    expect(scan(text)).toBe(label);
  });
});

describe('perf: the new passes stay linear', () => {
  // Refute round 6, G5: the absolute 'under two seconds' bounds flaked under load. Each check now
  // compares the cost at 1x and 4x the input (min of two runs each): linear is ~4x, quadratic ~16x,
  // so a 10x bound catches a real quadratic without depending on machine speed. A loose absolute
  // ceiling on the large run stays as a backstop against a pathological constant factor.
  const minTime = (f: () => void) => {
    let best = Infinity;
    for (let i = 0; i < 2; i++) {
      const t0 = performance.now();
      f();
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  };
  const expectLinear = (small: () => void, large: () => void) => {
    const ts = minTime(small);
    const tl = minTime(large);
    expect(tl / Math.max(ts, 5)).toBeLessThan(10);
    expect(tl).toBeLessThan(20_000);
  };
  const rowsOf = (n: number) => {
    const rows: Record<string, string[]> = {};
    for (let i = 0; i < n; i++) rows[`tenant-${i}-note`] = ['Lease renewal - 22,000 SF', 'clear height 24 ft; ', '-'.repeat(20) + '\n'];
    return rows;
  };
  it('many keys and many sibling leaves (~3 MB at 4x) scale linearly, and a split term is still found', () => {
    const small = rowsOf(7_500);
    const large = rowsOf(30_000);
    expectLinear(() => expect(scan(small)).toBeNull(), () => expect(scan(large)).toBeNull());
    large['tenant-x'] = ['Kest', 'rel Ridge'];
    expect(scan(large)).toBe('Fold');
  });
  it('a string of non-ASCII digits, folded letters and marks (~3 MB at 4x) scales linearly', () => {
    const chunk = `${cp(0x669, 0x660)} ${cp(0x141)}ake ${cp(0xdf)} K${cp(0x20dd)} - ${cp(0x966)}${cp(10)}`;
    const of = (bytes: number) => chunk.repeat(Math.ceil(bytes / chunk.length));
    const small = of(768 * 1024);
    const large = of(3 * 1024 * 1024);
    expectLinear(() => expect(scan(small)).toBeNull(), () => expect(scan(large)).toBeNull());
  });
});
