// Direct unit coverage for server/briefing/confidential.ts — previously only exercised indirectly
// through briefing.test.ts. Covers the 2026-07-06 audit fix: this is a confidentiality gate, so it
// must fail CLOSED (throw) when confidential-terms.json is absent/unreadable/empty, and the ONLY way
// to get reduced (placeholder-only) coverage is the explicit CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER=1
// opt-out -- never an automatic, silent fallback.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scanForConfidential,
  assertNoConfidential,
  collectText,
  normalizeForScan,
  normalizationTablesSha256,
  mentionsAnyTerm,
} from '../../server/briefing/confidential';

let priorTermsPath: string | undefined;
let priorAllowPlaceholder: string | undefined;
let tmpDir: string | undefined;

beforeEach(() => {
  priorTermsPath = process.env.CONFIDENTIAL_TERMS_PATH;
  priorAllowPlaceholder = process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
});

afterEach(() => {
  if (priorTermsPath === undefined) delete process.env.CONFIDENTIAL_TERMS_PATH;
  else process.env.CONFIDENTIAL_TERMS_PATH = priorTermsPath;
  if (priorAllowPlaceholder === undefined) delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  else process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = priorAllowPlaceholder;
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('loadTerms (via scanForConfidential) — fails closed on a missing/unreadable file', () => {
  it('throws when CONFIDENTIAL_TERMS_PATH points at a nonexistent file and no opt-out is set', () => {
    delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
    process.env.CONFIDENTIAL_TERMS_PATH = join(tmpdir(), 'zzz-does-not-exist-confidential-terms.json');
    expect(() => scanForConfidential('anything')).toThrow(/confidential-terms\.json is absent/);
  });

  it('throws when the file exists but is unparseable JSON, and no opt-out is set', () => {
    delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
    tmpDir = mkdtempSync(join(tmpdir(), 'confidential-test-'));
    const file = join(tmpDir, 'terms.json');
    writeFileSync(file, '{ not valid json ', 'utf8');
    process.env.CONFIDENTIAL_TERMS_PATH = file;
    expect(() => scanForConfidential('anything')).toThrow(/confidential-terms\.json is absent/);
  });

  it('throws when the file parses but has no non-underscore keys, and no opt-out is set', () => {
    delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
    tmpDir = mkdtempSync(join(tmpdir(), 'confidential-test-'));
    const file = join(tmpDir, 'terms.json');
    writeFileSync(file, JSON.stringify({ _comment: 'empty on purpose' }), 'utf8');
    process.env.CONFIDENTIAL_TERMS_PATH = file;
    expect(() => scanForConfidential('anything')).toThrow(/confidential-terms\.json is absent/);
  });

  it('falls back to placeholder-only scanning WITHOUT throwing when the opt-out is explicitly set', () => {
    process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = '1';
    process.env.CONFIDENTIAL_TERMS_PATH = join(tmpdir(), 'zzz-does-not-exist-confidential-terms.json');
    expect(() => scanForConfidential('ordinary text with no confidential markers')).not.toThrow();
    // The placeholder term is the only thing it can catch in this mode.
    expect(scanForConfidential('__ora_confidential_placeholder__')?.dealLabel).toBe('Confidential Deal');
  });

  it('the opt-out does not mask a hit when placeholder-only text is present', () => {
    process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = '1';
    process.env.CONFIDENTIAL_TERMS_PATH = join(tmpdir(), 'zzz-does-not-exist-confidential-terms.json');
    expect(() => assertNoConfidential('contains __ora_confidential_placeholder__ here')).toThrow(
      /refusing to render/,
    );
  });
});

describe('scanForConfidential — matching semantics against a real terms file', () => {
  it('matches an "always" term case-insensitively as a substring', () => {
    delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
    tmpDir = mkdtempSync(join(tmpdir(), 'confidential-test-'));
    const file = join(tmpDir, 'terms.json');
    writeFileSync(
      file,
      JSON.stringify({
        'deal-x': { label: 'Deal X', active: true, always: ['ZzzUniqueTrigger123'], context: [], context_requires_any: [] },
      }),
      'utf8',
    );
    process.env.CONFIDENTIAL_TERMS_PATH = file;
    expect(scanForConfidential('some text mentioning zzzuniquetrigger123 in passing')?.dealLabel).toBe('Deal X');
  });

  it('does not match a context term unless its context_requires_any anchor is also present', () => {
    delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
    tmpDir = mkdtempSync(join(tmpdir(), 'confidential-test-'));
    const file = join(tmpDir, 'terms.json');
    writeFileSync(
      file,
      JSON.stringify({
        'deal-y': {
          label: 'Deal Y',
          active: true,
          always: [],
          context: ['zzz-context-term'],
          context_requires_any: ['zzz-anchor-term'],
        },
      }),
      'utf8',
    );
    process.env.CONFIDENTIAL_TERMS_PATH = file;
    expect(scanForConfidential('zzz-context-term appears alone')).toBeNull();
    expect(scanForConfidential('zzz-anchor-term and zzz-context-term appear together')?.dealLabel).toBe('Deal Y');
  });

  it('skips inactive deals', () => {
    delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
    tmpDir = mkdtempSync(join(tmpdir(), 'confidential-test-'));
    const file = join(tmpDir, 'terms.json');
    writeFileSync(
      file,
      JSON.stringify({
        'deal-z': { label: 'Deal Z', active: false, always: ['zzz-inactive-term'], context: [], context_requires_any: [] },
      }),
      'utf8',
    );
    process.env.CONFIDENTIAL_TERMS_PATH = file;
    expect(scanForConfidential('zzz-inactive-term present')).toBeNull();
  });
});

describe('collectText — flattens nested structures for scanning', () => {
  it('flattens arrays and objects into a single space-joined string', () => {
    expect(collectText({ a: ['x', 'y'], b: { c: 'z' } })).toBe('x y z');
  });
  it('returns empty string for null/undefined', () => {
    expect(collectText(null)).toBe('');
    expect(collectText(undefined)).toBe('');
  });
});

// ---------------------------------------------------------------------------------------------
// Normalization (refute wf_d42a89c6-fe5 on PR #457). The scanner used to be a bare lowercase
// substring match, so an invisible or look-alike character inside a term evaded EVERY caller at
// once (rosterClaimsDeal, isDeclassified, the comps/OM/narrative scans, the bake residue sweep).
// SYNTHETIC roster only -- no real deal identifier appears anywhere in this file. The same vectors
// are mirrored in ~/.claude/hooks/tests/test-confidentiality-guard.py; keep the two in step.
// ---------------------------------------------------------------------------------------------
const cp = (...codes: number[]): string => String.fromCodePoint(...codes);
const ZWSP = cp(0x200b);
const ZWNJ = cp(0x200c);
const ZWJ = cp(0x200d);
const WORD_JOINER = cp(0x2060);
const SOFT_HYPHEN = cp(0x00ad);
const BOM = cp(0xfeff);
const LRM = cp(0x200e);
const NBSP = cp(0x00a0);
const THIN = cp(0x2009);
const NNBSP = cp(0x202f);
const IDEOGRAPHIC_SPACE = cp(0x3000);
const CURLY_APOS = cp(0x2019);
const EN_DASH = cp(0x2013);
const COMBINING_LOW_LINE = cp(0x0332);

describe('scanForConfidential — normalization (synthetic roster)', () => {
  const NAME = 'Zephyrine Holdings';
  const PLAZA = "O'Malley-Brandt Plaza";
  const PRICE = '4250000';

  function useRoster(extra: Record<string, unknown> = {}): void {
    delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
    tmpDir = mkdtempSync(join(tmpdir(), 'confidential-test-'));
    const file = join(tmpDir, 'terms.json');
    writeFileSync(
      file,
      JSON.stringify({
        'deal-n': {
          label: 'Deal N',
          active: true,
          always: [NAME, PLAZA, PRICE],
          context: ['harbor point'],
          context_requires_any: ['project quill'],
        },
        ...extra,
      }),
      'utf8',
    );
    process.env.CONFIDENTIAL_TERMS_PATH = file;
  }
  const hit = (v: unknown) => scanForConfidential(v)?.dealLabel ?? null;

  it('baseline: the plain term hits and unrelated text does not', () => {
    useRoster();
    expect(hit(`Bid from ${NAME} accepted`)).toBe('Deal N');
    expect(hit('A quarterly update on industrial leasing in Columbus')).toBeNull();
  });

  describe.each([
    ['zero-width space mid-word', `Zeph${ZWSP}yrine Holdings`],
    ['zero-width non-joiner', `Zephyrine Hold${ZWNJ}ings`],
    ['zero-width joiner', `Z${ZWJ}ephyrine Holdings`],
    ['word joiner', `Zephyrine${WORD_JOINER} Holdings`],
    ['soft hyphen', `Zephy${SOFT_HYPHEN}rine Holdings`],
    ['BOM / zero-width no-break space', `${BOM}Zephyrine Holdings`],
    ['directional mark', `Zephyrine${LRM} Holdings`],
    ['zero-width space AS the separator', `Zephyrine${ZWSP}Holdings`],
    ['zero-width space padded around the separator', `Zephyrine${ZWSP} ${ZWSP}Holdings`],
    ['combining low line', `Zeph${COMBINING_LOW_LINE}yrine Holdings`],
    ['no-break space', `Zephyrine${NBSP}Holdings`],
    ['thin space', `Zephyrine${THIN}Holdings`],
    ['narrow no-break space', `Zephyrine${NNBSP}Holdings`],
    ['ideographic space', `Zephyrine${IDEOGRAPHIC_SPACE}Holdings`],
    ['tab / newline / run of spaces', 'Zephyrine\t\n   Holdings'],
    ['fullwidth letters', 'Ｚｅｐｈｙｒｉｎｅ Ｈｏｌｄｉｎｇｓ'],
    ['mathematical bold capital', `${cp(0x1d419)}ephyrine Holdings`],
    ['mixed case', 'zEPHYRINE hOLDINGS'],
    ['a long run of zero-width padding between every letter', [...NAME].join(ZWSP.repeat(60))],
  ])('%s', (_label, text) => {
    it('is caught as a bare string', () => {
      useRoster();
      expect(hit(text)).toBe('Deal N');
    });
    it('is caught nested inside an object / array payload', () => {
      useRoster();
      expect(hit({ deals: [{ title: `Re: ${text} — update`, n: 3 }] })).toBe('Deal N');
    });
  });

  it('folds curly apostrophes and typographic dashes', () => {
    useRoster();
    expect(hit(`O${CURLY_APOS}Malley${EN_DASH}Brandt Plaza`)).toBe('Deal N');
    expect(hit(`O${cp(0x00b4)}Malley${cp(0x2014)}Brandt${NBSP}Plaza`)).toBe('Deal N');
    expect(hit(`O${cp(0x02bc)}Malley${cp(0x2212)}Brandt Plaza`)).toBe('Deal N');
  });

  it('normalizes the ROSTER side too (a term stored with NBSP / curly quotes / fullwidth matches plain text)', () => {
    useRoster({
      'deal-m': {
        label: 'Deal M',
        active: true,
        always: [`Quillon${NBSP}Yard`, `St${CURLY_APOS}s Landing`, 'Ｖｅｓｐｅｒ Ｇａｔｅ'],
        context: [],
        context_requires_any: [],
      },
    });
    expect(hit('the quillon yard lease')).toBe('Deal M');
    expect(hit("st's landing")).toBe('Deal M');
    expect(hit('Vesper Gate parcel')).toBe('Deal M');
  });

  describe('numeric terms vs number formatting', () => {
    it.each([
      ['plain', '4250000'],
      ['US commas', '$4,250,000'],
      ['US commas, no symbol', '4,250,000'],
      ['de-DE dots', '4.250.000'],
      ['spaces', '4 250 000'],
      ['NBSP groups (sv-SE)', `4${NBSP}250${NBSP}000`],
      ['narrow NBSP groups (fr-FR)', `4${NNBSP}250${NNBSP}000`],
      ['curly-apostrophe groups (de-CH)', `4${CURLY_APOS}250${CURLY_APOS}000`],
      ['underscores', '4_250_000'],
      ['zero-width space inside a number', `4,250,${ZWSP}000`],
      ['toLocaleString en-US', (4250000).toLocaleString('en-US')],
      ['toLocaleString de-DE', (4250000).toLocaleString('de-DE')],
      ['inside a sentence', 'Purchase price of $4,250,000 (all cash).'],
    ])('catches %s', (_l, text) => {
      useRoster();
      expect(hit(text)).toBe('Deal N');
    });

    it('a roster term written WITH separators matches the unformatted number', () => {
      useRoster({
        'deal-p': { label: 'Deal P', active: true, always: ['$1,875,000'], context: [], context_requires_any: [] },
      });
      expect(hit('closing at 1875000')).toBe('Deal P');
      expect(hit('closing at 1.875.000')).toBe('Deal P');
    });

    it('does NOT hit on other numbers that merely share digits (whole-number match in the digits form)', () => {
      // 'deal-n' is dropped by using a fresh roster file with only this numeric term.
      delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
      tmpDir = mkdtempSync(join(tmpdir(), 'confidential-test-'));
      const file = join(tmpDir, 'terms.json');
      writeFileSync(
        file,
        JSON.stringify({
          'deal-p': { label: 'Deal P', active: true, always: ['250000'], context: [], context_requires_any: [] },
        }),
        'utf8',
      );
      process.env.CONFIDENTIAL_TERMS_PATH = file;
      expect(hit('$4,250,000')).toBeNull();
      expect(hit('$2,500,000')).toBeNull();
      expect(hit('$1,250,000 and $250,001')).toBeNull();
      expect(hit('$250,000')).toBe('Deal P');
    });
  });

  describe('false positives on ordinary public text', () => {
    it.each([
      'A zephyr is a gentle breeze; Holdings Inc. reported earnings.',
      'Holdings Zephyrine',
      'The plaza on O’Malley Street and the Brandt building',
      '$14,250,000 and $42,500,000 and $4,250 per month',
      'Rent is $12.50 per SF NNN; 1,234.56 sq ft; suite 4 100',
      'Café Müller naïve résumé — Columbus, Ohio — industrial/flex 4,250 SF',
      'Call 614-555-0142 or 513.555.0199 on 2026-10-13',
      'Quarterly occupancy 94.2%, WALT 3.7 yrs, DSCR 1.31x, LTV 38%',
      '',
      `${ZWSP}${NBSP}${BOM}`,
    ])('stays clean: %j', (text) => {
      useRoster();
      expect(hit(text)).toBeNull();
    });

    it('does not let the zero-width-as-separator variant bridge unrelated words', () => {
      useRoster();
      expect(hit(`Zephyrine${ZWSP}${ZWSP}Properties`)).toBeNull();
      expect(hit(`Holdings${ZWSP}Zephyrine`)).toBeNull();
    });
  });

  describe('context terms keep their anchor gating under normalization', () => {
    it('hits when an obfuscated anchor and an obfuscated context term are both present', () => {
      useRoster();
      expect(hit(`proj${ZWSP}ect${NBSP}quill: harbor${THIN}point`)).toBe('Deal N');
    });
    it('stays clean for the context term alone, obfuscated or not', () => {
      useRoster();
      expect(hit('harbor point')).toBeNull();
      expect(hit(`harbor${NBSP}po${ZWSP}int`)).toBeNull();
    });
  });

  it('still skips inactive deals when the text is obfuscated', () => {
    useRoster({
      'deal-off': { label: 'Deal Off', active: false, always: ['Inert Name'], context: [], context_requires_any: [] },
    });
    expect(hit(`Inert${ZWSP} Name`)).toBeNull();
  });

  it('normalizeForScan exposes the canonical forms (tight / spaced / digits)', () => {
    const f = normalizeForScan(`Zephyrine${ZWSP}Holdings  $4,250,000`);
    expect(f.text).toEqual(['zephyrineholdings $4,250,000', 'zephyrine holdings $4,250,000']);
    expect(f.digits).toEqual(['zephyrineholdings $4250000', 'zephyrine holdings $4250000']);
  });
});

// Round-2 vectors (adversarial review of 2026-10-13): invisible/control chars, bidi, accents, dashes,
// digit scripts, superscripts, and the fixed-table pin. Mirrors test-confidentiality-guard.py.
describe('scanForConfidential — normalization round 2 (synthetic roster)', () => {
  const NAME = 'Zephyrine Holdings';
  const PLAZA = "O'Malley-Brandt Plaza";
  function useRoster(): void {
    delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
    tmpDir = mkdtempSync(join(tmpdir(), 'confidential-test-'));
    const file = join(tmpDir, 'terms.json');
    writeFileSync(
      file,
      JSON.stringify({
        'deal-n': { label: 'Deal N', active: true, always: [NAME, PLAZA, '4250000'], context: [], context_requires_any: [] },
      }),
      'utf8',
    );
    process.env.CONFIDENTIAL_TERMS_PATH = file;
  }
  const hit = (v: unknown) => scanForConfidential(v)?.dealLabel ?? null;
  const chars = (...codes: number[]) => String.fromCodePoint(...codes);

  it('pins the fixed Unicode table (must equal the hook twin)', () => {
    expect(normalizationTablesSha256()).toBe('5899947863b6aafde85357d8f0f52f3e81b0c03169edd8d601eea675cad3b149');
  });

  it.each([
    ['NUL inside the term', `Zephy${chars(0)}rine Holdings`],
    ['SOH / DEL / C1 controls', `Zeph${chars(1, 0x7f, 0x80, 0x9f)}yrine Holdings`],
    ['unassigned default-ignorable U+2065', `Zephyrine${chars(0x2065)} Holdings`],
    ['unassigned default-ignorable U+FFF0', `Zephyr${chars(0xfff0)}ine Holdings`],
    ['tag character', `Zephyrine${chars(0xe0041)} Holdings`],
    ['variation selector', `Zephyrine${chars(0xfe0f)} Holdings`],
    ['hangul filler', `Zephyrine${chars(0x3164)} Holdings`],
    ['halfwidth voiced mark', `Zeph${chars(0xff9e)}yrine Holdings`],
    ['right-to-left override (reversed run)', `${chars(0x202e)}${[...NAME].reverse().join('')}${chars(0x202c)}`],
    ['acute accent on e', `Z${chars(0xe9)}phyrine Holdings`],
    ['combining acute after a zero-width space', `Ze${chars(0x200b, 0x301)}phyrine Holdings`],
    ['diaeresis padding as a separator', `Zephyrine${chars(0xa8).repeat(200)}Holdings`],
    ['armenian hyphen', `O${chars(0x2019)}Malley${chars(0x58a)}Brandt Plaza`],
    ['supplemental punctuation dash', `O${chars(0x2019)}Malley${chars(0x2e3a)}Brandt Plaza`],
    ['price with a footnote superscript', `$4,250,000${chars(0xb9)}`],
    ['price in Arabic-Indic digits', [...'4250000'].map((d) => chars(0x660 + Number(d))).join('')],
    ['price in fullwidth digits', [...'4250000'].map((d) => chars(0xff10 + Number(d))).join('')],
  ])('catches %s', (_l, text) => {
    useRoster();
    expect(hit(text)).toBe('Deal N');
  });

  it.each([
    ['DEL alone, in otherwise pure-ASCII text', `memo Zephy${chars(0x7f)}rine Holdings`],
    ['ASCII control (BEL) in pure-ASCII text', `Zephy${chars(7)}rine Holdings`],
    ['fullwidth grave accent as the apostrophe', `O${chars(0xff40)}Malley-Brandt Plaza`],
    ['greek varia as the apostrophe', `O${chars(0x1fef)}Malley-Brandt Plaza`],
    ['ASCII backtick as the apostrophe', 'O`Malley-Brandt Plaza'],
  ])('catches %s', (_l, text) => {
    useRoster();
    expect(hit(text)).toBe('Deal N');
  });

  it.each([
    [`Bel${chars(0xe9)}anger and caf${chars(0xe9)} menus`],
    [`x${chars(0xb2)} area, 12${chars(0xb3)} volume`],
    [`Zephyrine${chars(0xa8).repeat(5)}Properties`],
    [`${chars(0x202e)}gnirtsrednu${chars(0x202c)}`],
  ])('stays clean: %j', (text) => {
    useRoster();
    expect(hit(text)).toBeNull();
  });
});

describe('scanForConfidential — long inputs / chunked NFKD (synthetic roster)', () => {
  function useRoster(): void {
    delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
    tmpDir = mkdtempSync(join(tmpdir(), 'confidential-test-'));
    const file = join(tmpDir, 'terms.json');
    writeFileSync(
      file,
      JSON.stringify({ 'deal-n': { label: 'Deal N', active: true, always: ['Zephyrine Holdings'], context: [], context_requires_any: [] } }),
      'utf8',
    );
    process.env.CONFIDENTIAL_TERMS_PATH = file;
  }
  const hit = (v: unknown) => scanForConfidential(v)?.dealLabel ?? null;
  const cp2 = (...codes: number[]) => String.fromCodePoint(...codes);
  const term = `Zeph${cp2(0x200b)}yrine Holdings`;

  it.each([
    ['a long run of the expanding combining mark U+0344', `a${cp2(0x344).repeat(5000)} ${term}`],
    ['a term after 5000 ordinary characters', `${'lorem ipsum '.repeat(500)}${term}`],
    ['a term after astral characters (pieces must not split surrogate pairs)', `${cp2(0x1d15e).repeat(3000)} ${term}`],
    ['a term whose letters are separated by long mark runs', [...'Zephyrine Holdings'].join(cp2(0x301).repeat(2100))],
  ])('catches %s', (_l, text) => {
    useRoster();
    expect(hit(text)).toBe('Deal N');
  });

  it('stays clean on a long combining-mark run with no term', () => {
    useRoster();
    expect(hit(`a${cp2(0x344).repeat(20000)} nothing to see`)).toBeNull();
  });
});

describe('nfkdChunked — surrogate pairs and reorder-inversion runs (synthetic roster)', () => {
  function useRoster(): void {
    delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
    tmpDir = mkdtempSync(join(tmpdir(), 'confidential-test-'));
    const file = join(tmpDir, 'terms.json');
    writeFileSync(
      file,
      JSON.stringify({ 'deal-n': { label: 'Deal N', active: true, always: ['Zephyrine Holdings'], context: [], context_requires_any: [] } }),
      'utf8',
    );
    process.env.CONFIDENTIAL_TERMS_PATH = file;
  }
  const cp3 = (...codes: number[]) => String.fromCodePoint(...codes);
  const mathBold = (s: string): string =>
    [...s]
      .map((c) => (c === ' ' ? ' ' : c >= 'A' && c <= 'Z' ? cp3(0x1d400 + c.charCodeAt(0) - 65) : cp3(0x1d41a + c.charCodeAt(0) - 97)))
      .join('');

  // Input must exceed 2048 units for chunking to engage. A 512-unit cut lands between UTF-16 units
  // 511 and 512, 1023/1024, 1535/1536: offsets 511, 1023, 1535 put a surrogate pair exactly there.
  it.each([511, 1023, 1535, 100])(
    'catches a mathematical-bold spelling at offset %i in a >2048-unit text (a cut must never split a surrogate pair)',
    (offset) => {
      useRoster();
      const text = `${'x'.repeat(offset)}${mathBold('Zephyrine Holdings')}${'y'.repeat(3000)}`;
      expect(text.length).toBeGreaterThan(2048);
      expect(scanForConfidential(text)?.dealLabel).toBe('Deal N');
    },
  );

  it('normalizes a long reorder-inversion mark run in bounded pieces (unchunked ICU NFKD is quadratic here)', () => {
    const sizes: number[] = [];
    const orig = String.prototype.normalize;
    const spy = vi.spyOn(String.prototype, 'normalize').mockImplementation(function (this: string, form?: string) {
      sizes.push(this.length);
      return orig.call(this, form);
    });
    try {
      normalizeForScan('a' + (cp3(0x301).repeat(1024) + cp3(0x334).repeat(1024)).repeat(20));
    } finally {
      spy.mockRestore();
    }
    expect(sizes.length).toBeGreaterThan(5);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(2048 + 512);
  });
});

// ---------------------------------------------------------------------------------------------
// Refute wf_d43de08e-49f on PR #461: grouped numbers merged with an adjacent short number, mixed
// invisible-in-word + invisible-as-separator, empty-after-normalization anchors, and the residue
// sweeps that still used a bare substring match. SYNTHETIC roster only. Mirrored in the hook tests.
// ---------------------------------------------------------------------------------------------
describe('scanForConfidential — refute round (synthetic roster)', () => {
  function useRoster(): void {
    delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
    tmpDir = mkdtempSync(join(tmpdir(), 'confidential-test-'));
    const file = join(tmpDir, 'terms.json');
    writeFileSync(
      file,
      JSON.stringify({
        'deal-n': {
          label: 'Deal N',
          active: true,
          always: ['Zephyrine Holdings', '4250000', 'Quillon Yard Associates'],
          context: [],
          context_requires_any: [],
        },
        'deal-p': { label: 'Deal P', active: true, always: ['250000'], context: [], context_requires_any: [] },
        'deal-e': {
          label: 'Deal E',
          active: true,
          always: [],
          context: ['inert lagoon'],
          context_requires_any: [String.fromCodePoint(0x200b)],
        },
        'deal-s': { label: 'Deal S', active: true, always: ['ice co'], context: [], context_requires_any: [] },
      }),
      'utf8',
    );
    process.env.CONFIDENTIAL_TERMS_PATH = file;
  }
  const hit = (v: unknown) => scanForConfidential(v)?.dealLabel ?? null;
  const zw = String.fromCodePoint(0x200b);

  it.each([
    ['grouped price followed by a percentage', '$4,250,000 100% leased', 'Deal N'],
    ['space-grouped price followed by a count', 'closing 4 250 000 100 units', 'Deal N'],
    ['price with cents', 'price $4,250,000.50 all cash', 'Deal N'],
    ['grouped price then another figure', 'Unit 12: 4,250,000 and 100 more', 'Deal N'],
    ['trailing group of a short number', 'Suite 7 250,000', 'Deal P'],
    ['structured payload, short number first', { units: 3, price: '250,000' }, 'Deal P'],
    ['structured payload, short number last', { price: '250,000', note: 'x' }, 'Deal P'],
  ])('catches %s', (_l, v, want) => {
    useRoster();
    expect(hit(v)).toBe(want);
  });

  it.each([
    ['inside a larger grouped number', '$1,250,000'],
    ['inside a billion-scale number', '$4,250,000,000'],
    ['next to extra digits', '$14,250,000 100%'],
    ['a trailing digit', '$4,250,0001'],
  ])('does not hit a bare numeric term %s', (_l, text) => {
    useRoster();
    expect(hit(text)).toBeNull();
  });

  it('catches an invisible char inside a word AND an invisible char used as a separator', () => {
    useRoster();
    expect(hit(`Zeph${zw}yrine${zw}Holdings`)).toBe('Deal N');
    expect(hit(`Quillon${zw}Yard Assoc${zw}iates`)).toBe('Deal N');
  });

  it('does not apply the whitespace-insensitive match to short terms', () => {
    useRoster();
    expect(hit('iceco')).toBeNull();
  });

  it('treats a group whose anchors all normalize to nothing as unanchored (context terms stay active)', () => {
    useRoster();
    expect(hit('notes on the inert lagoon parcel')).toBe('Deal E');
  });

  it('mentionsAnyTerm applies the same normalization to residue sweeps', () => {
    expect(mentionsAnyTerm(`see Zeph${zw}yrine Holdings`, ['Zephyrine Holdings'])).toBe(true);
    expect(mentionsAnyTerm(`Zephyrine${String.fromCodePoint(0xa0)}Holdings`, ['zephyrine holdings'])).toBe(true);
    expect(mentionsAnyTerm('nothing relevant', ['Zephyrine Holdings'])).toBe(false);
    expect(mentionsAnyTerm(null, ['Zephyrine Holdings'])).toBe(false);
    expect(mentionsAnyTerm('x', [''])).toBe(false);
  });
});

// Review ab2d0abb05d69ce38: terms that MIX words and a number, bidi + whitespace-insensitive match, and a
// roster whose only anchor is the empty string. SYNTHETIC roster only. Mirrored in the hook tests.
describe('scanForConfidential — mixed word/number terms, bidi compact, empty anchors (synthetic roster)', () => {
  function useRoster(): void {
    delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
    tmpDir = mkdtempSync(join(tmpdir(), 'confidential-test-'));
    const file = join(tmpDir, 'terms.json');
    writeFileSync(
      file,
      JSON.stringify({
        'deal-m': { label: 'Deal M', active: true, always: ['250000 sf'], context: [], context_requires_any: [] },
        'deal-c': { label: 'Deal C', active: true, always: ['250,000 sf'], context: [], context_requires_any: [] },
        'deal-n': { label: 'Deal N', active: true, always: ['Zephyrine Holdings'], context: [], context_requires_any: [] },
        'deal-q': { label: 'Deal Q', active: true, always: [], context: ['quiet marsh'], context_requires_any: [''] },
      }),
      'utf8',
    );
    process.env.CONFIDENTIAL_TERMS_PATH = file;
  }
  const hit = (v: unknown) => scanForConfidential(v)?.dealLabel ?? null;
  const zw = String.fromCodePoint(0x200b);

  it.each([
    ['a short number glued on before a grouped one', 'Lot 3 250,000 sf', 'Deal M'],
    ['dotted grouping with a short number before it', 'Building 2 250.000 sf', 'Deal M'],
    ['a comma-written term against dotted text', 'Unit 12 250.000 sf', 'Deal M'],
    ['a term WRITTEN with commas against plain digits', 'about 250000 sf total', 'Deal M'],
  ])('catches %s', (_l, text, want) => {
    useRoster();
    // deal-m / deal-c are two spellings of the same figure; either label is a correct block.
    expect(['Deal M', 'Deal C']).toContain(hit(text));
    expect(want).toBe('Deal M');
  });

  it('catches a bidi-override run that renders as a term with an invisible separator', () => {
    useRoster();
    const reversed = [...`Zephyrine${zw}Holdings`].reverse().join('');
    expect(hit(`${String.fromCodePoint(0x202e)}${reversed}${String.fromCodePoint(0x202c)}`)).toBe('Deal N');
  });

  it('keeps context terms active when the only anchor is the empty string (fail closed)', () => {
    useRoster();
    expect(hit('notes on the quiet marsh parcel')).toBe('Deal Q');
  });
});

// Refute wf_d730e33a-63b on 7e27407: a MIXED anchor list (one blank anchor + one real one) used to be
// always-active; a term that mixes words and a number depended on its neighbours; '$ 4,250,000'; and
// collectText on Map/Set/BigInt. SYNTHETIC roster only. Mirrored in the hook tests.
describe('scanForConfidential — anchors, term digit forms, odd value types (synthetic roster)', () => {
  function useRoster(extra: Record<string, unknown> = {}): void {
    delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
    tmpDir = mkdtempSync(join(tmpdir(), 'confidential-test-'));
    const file = join(tmpDir, 'terms.json');
    writeFileSync(file, JSON.stringify(extra), 'utf8');
    process.env.CONFIDENTIAL_TERMS_PATH = file;
  }
  const hit = (v: unknown) => scanForConfidential(v)?.dealLabel ?? null;
  const zw = String.fromCodePoint(0x200b);

  it.each([
    ['an empty anchor plus a real one', ['', 'marsh holdings']],
    ['a zero-width-only anchor plus a real one', [zw, 'marsh holdings']],
    ['a space-only anchor plus a real one', [' ', 'marsh holdings']],
  ])('a mixed anchor list stays always-active: %s', (_l, anchors) => {
    useRoster({ 'deal-q': { label: 'Deal Q', active: true, always: [], context: ['quiet marsh'], context_requires_any: anchors } });
    expect(hit('quiet marsh update')).toBe('Deal Q');
  });

  it('a normal anchor list still gates its context terms', () => {
    useRoster({ 'deal-q': { label: 'Deal Q', active: true, always: [], context: ['quiet marsh'], context_requires_any: ['marsh holdings'] } });
    expect(hit('quiet marsh update')).toBeNull();
    expect(hit('quiet marsh update from marsh holdings')).toBe('Deal Q');
  });

  it.each([
    ['space-grouped haystack', 'Unit 12 125 000 SF'],
    ['dotted haystack', 'Unit 12 125.000 SF'],
    ['comma haystack', 'Unit 12 125,000 SF'],
    ['plain-digit haystack', 'Unit 12 125000 SF'],
  ])('a term that mixes words and a number does not depend on its neighbours: %s', (_l, text) => {
    useRoster({ 'deal-u': { label: 'Deal U', active: true, always: ['Unit 12 125,000 SF'], context: [], context_requires_any: [] } });
    expect(hit(text)).toBe('Deal U');
  });

  it('a numeric term written with a space after the currency sign still matches', () => {
    useRoster({ 'deal-d': { label: 'Deal D', active: true, always: ['$ 4,250,000'], context: [], context_requires_any: [] } });
    expect(hit('price $4,250,000 cash')).toBe('Deal D');
    expect(hit('price 4250000 cash')).toBe('Deal D');
  });

  it('scans Map / Set / BigInt / Date values instead of silently skipping them', () => {
    useRoster({ 'deal-n': { label: 'Deal N', active: true, always: ['Zephyrine Holdings', '4250000'], context: [], context_requires_any: [] } });
    expect(hit(new Map([['k', 'Zephyrine Holdings']]))).toBe('Deal N');
    expect(hit(new Set(['Zephyrine Holdings']))).toBe('Deal N');
    expect(hit({ price: 4250000n })).toBe('Deal N');
    expect(collectText(new Date(Date.UTC(2026, 9, 14)))).toContain('2026-10-14');
  });
});

// Refute wf_34b9b0ce-815 on 6067c75 (all LOW): numeric terms vs lakh grouping, and collectText on Error / URL /
// self-referencing values. SYNTHETIC roster only. Mirrored (numeric part) in the hook tests.
describe('scanForConfidential — lakh grouping and odd value types (synthetic roster)', () => {
  function useRoster(): void {
    delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
    tmpDir = mkdtempSync(join(tmpdir(), 'confidential-test-'));
    const file = join(tmpDir, 'terms.json');
    writeFileSync(
      file,
      JSON.stringify({
        'deal-n': { label: 'Deal N', active: true, always: ['Zephyrine Holdings', '4250000'], context: [], context_requires_any: [] },
        'deal-p': { label: 'Deal P', active: true, always: ['250000'], context: [], context_requires_any: [] },
      }),
      'utf8',
    );
    process.env.CONFIDENTIAL_TERMS_PATH = file;
  }
  const hit = (v: unknown) => scanForConfidential(v)?.dealLabel ?? null;

  it.each([
    ['Indian lakh grouping', 'price Rs 42,50,000 total', 'Deal N'],
    ['lakh grouping of the shorter figure', 'fee 2,50,000 due', 'Deal P'],
    ['pair-grouped with spaces', 'sum 25 00 00 only', 'Deal P'],
  ])('a bare numeric term is not dodged by %s', (_l, text, want) => {
    useRoster();
    expect(hit(text)).toBe(want);
  });

  it('still does not hit a bigger number that merely contains the digits', () => {
    useRoster();
    expect(hit('total 12,250,000 and 1,250,000')).toBeNull();
  });

  it('reads Error, URL and nested cause values instead of skipping them', () => {
    useRoster();
    expect(hit({ err: new Error('Zephyrine Holdings LOI withdrawn') })).toBe('Deal N');
    expect(hit(new Error('outer', { cause: new Error('Zephyrine Holdings') }))).toBe('Deal N');
    expect(hit({ link: new URL('https://example.com/Zephyrine%20Holdings?q=Zephyrine Holdings') })).toBe('Deal N');
  });

  it('cuts a self-referencing Map / Set / object instead of overflowing the stack', () => {
    useRoster();
    const m = new Map<string, unknown>([['k', 'Zephyrine Holdings']]);
    m.set('self', m);
    const s = new Set<unknown>(['Zephyrine Holdings']);
    s.add(s);
    const o: Record<string, unknown> = { note: 'Zephyrine Holdings' };
    o.me = o;
    expect(hit(m)).toBe('Deal N');
    expect(hit(s)).toBe('Deal N');
    expect(hit(o)).toBe('Deal N');
    expect(() => collectText(m)).not.toThrow();
  });
});

// Refute wf_e166bbe6-5f9 on 0d92c11: collectText must read a SUPERSET of what origin/main read (own enumerable
// properties of every object) and must not blank a shared object. SYNTHETIC roster only.
describe('collectText — superset of main, shared objects, lenient URL decoding (synthetic roster)', () => {
  function useRoster(): void {
    delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
    tmpDir = mkdtempSync(join(tmpdir(), 'confidential-test-'));
    const file = join(tmpDir, 'terms.json');
    writeFileSync(
      file,
      JSON.stringify({
        'deal-n': { label: 'Deal N', active: true, always: ['Zephyrine Holdings', 'Zephyr Corp'], context: [], context_requires_any: [] },
      }),
      'utf8',
    );
    process.env.CONFIDENTIAL_TERMS_PATH = file;
  }
  const hit = (v: unknown) => scanForConfidential(v)?.dealLabel ?? null;
  const withProp = <T extends object>(o: T, k: string, v: unknown): T => {
    (o as Record<string, unknown>)[k] = v;
    return o;
  };

  it.each([
    ['an Error with an enumerable field', () => withProp(new Error('lookup failed'), 'deal', 'Zephyrine Holdings')],
    ['the same Error nested in an object', () => ({ err: withProp(new Error('lookup failed'), 'deal', 'Zephyrine Holdings') })],
    ['an AggregateError member', () => new AggregateError([new Error('Zephyrine Holdings')], 'many failed')],
    ['a Date with an own property', () => withProp(new Date(Date.UTC(2026, 9, 14)), 'note', 'Zephyrine Holdings')],
    ['a URL with an own property', () => withProp(new URL('https://example.com/a'), 'note', 'Zephyrine Holdings')],
    ['a Map with an own property', () => withProp(new Map([['k', 'x']]), 'note', 'Zephyrine Holdings')],
    ['a Set with an own property', () => withProp(new Set(['x']), 'note', 'Zephyrine Holdings')],
  ])('reads %s (everything origin/main read)', (_l, make) => {
    useRoster();
    expect(hit(make())).toBe('Deal N');
  });

  it('does not blank an object that is legitimately shared (a DAG, not a cycle)', () => {
    useRoster();
    const p = { n: 'Corp' };
    expect(hit([p, 'Zephyr', p])).toBe('Deal N'); // 'Corp Zephyr Corp'
  });

  it('still cuts a real cycle', () => {
    useRoster();
    const o: Record<string, unknown> = { note: 'Zephyrine Holdings' };
    o.me = o;
    expect(hit(o)).toBe('Deal N');
    expect(() => collectText(o)).not.toThrow();
  });

  it('decodes a URL leniently: one malformed escape does not stop the rest', () => {
    useRoster();
    expect(hit(new URL('https://example.com/Zephyrine%20Holdings%ZZ'))).toBe('Deal N');
  });
});

// Refute wf_d91cb0ff-8f9 on a7c3f58 (LOW): the superset must hold by ADJACENCY too (a term spanning the
// boundary between an object's extra text and its neighbours), and a URL with an invalid byte in a
// percent-escape run. SYNTHETIC roster only.
describe('scanForConfidential — adjacency superset and byte-by-byte percent-encoding (synthetic roster)', () => {
  function useRoster(): void {
    delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
    tmpDir = mkdtempSync(join(tmpdir(), 'confidential-test-'));
    const file = join(tmpDir, 'terms.json');
    writeFileSync(
      file,
      JSON.stringify({
        'deal-n': { label: 'Deal N', active: true, always: ['Zephyr Corp', 'Zephyrine'], context: [], context_requires_any: [] },
      }),
      'utf8',
    );
    process.env.CONFIDENTIAL_TERMS_PATH = file;
  }
  const hit = (v: unknown) => scanForConfidential(v)?.dealLabel ?? null;
  const withProp = <T extends object>(o: T, k: string, v: unknown): T => {
    (o as Record<string, unknown>)[k] = v;
    return o;
  };

  it.each([
    ['an Error with an enumerable field, after a neighbour', () => ['Zephyr', withProp(new Error('x'), 'n', 'Corp')]],
    ['a RegExp match array followed by a sibling', () => ['Zephyr x'.match(/Zephyr/), 'Corp']],
    ['a Date with an own property', () => ['Zephyr', withProp(new Date(0), 'n', 'Corp')]],
    ['a Map with an own property', () => ['Zephyr', withProp(new Map([['k', 'x']]), 'n', 'Corp')]],
    ['a Set with an own property', () => ['Zephyr', withProp(new Set(['x']), 'n', 'Corp')]],
  ])('a term spanning a neighbour and %s still hits, as on main', (_l, make) => {
    useRoster();
    expect(hit(make())).toBe('Deal N');
  });

  it('decodes ASCII percent-escapes byte by byte even when the run holds an invalid UTF-8 byte', () => {
    useRoster();
    expect(hit(new URL('https://x.test/?q=%5A%65%70%68%79%72%69%6E%65%FF'))).toBe('Deal N');
  });
});
