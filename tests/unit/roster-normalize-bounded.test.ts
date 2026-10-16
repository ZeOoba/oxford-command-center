// Refute wf_fb340eb2 (P2, hostile-input DoS): roster-core normalised whole strings with unchunked
// ICU NFKC / NFD / NFC. ICU's canonical reordering is quadratic in the length of a combining-mark
// run, and roster-core GLUES strings together (sibling joins, the stream concatenation), so a
// ~44K-character body of combining marks that passes sanitizeAgentInput stalled the event loop for
// 10-18 s on the server (30 s of edge CPU), with main's chunked half finishing in 0.1 s. The
// normaliser is now chunked at exact cut points, a run with no exact cut point longer than the cap
// FAILS CLOSED (ScanBudgetError), and normalised characters are charged to the scan budget.
// SYNTHETIC terms only.
import { describe, expect, it } from 'vitest';
import { sanitizeAgentInput } from '../../server/ai/agent';
import { edgeConfidentialScan } from '../../functions/api/ai';
import type { DealTerms } from '../../server/briefing/confidential';
import {
  matchRosterTerms, normalizeBounded, NORMALIZE_RUN_CAP, normalizeRosterText, ScanBudgetError, scanBudget,
} from '../../server/briefing/roster-core';
import { rosterMatchWithTerms } from '../../server/briefing/roster-match';
import type { PortfolioSnapshot } from '../../src/contracts/index';

const cp = (...n: number[]): string => String.fromCodePoint(...n);
// Combining marks in strictly DESCENDING canonical combining class (maximum reorder work for ICU).
const CLASSES = [0x345, 0x35d, 0x35c, 0x31a, 0x301, 0x316, 0x321, 0x334];

/** The refute's stall body: a sanitizeAgentInput-maximal question + history of one mark run. */
function stallBody(tail = ''): { question: string; history: string[] } {
  const per = Math.floor((44000 - 3) / CLASSES.length);
  const run = 'x-\n' + CLASSES.map((c) => cp(c).repeat(per)).join('');
  const q = run.slice(0, 4000);
  const rest = run.slice(4000);
  const hist: Array<{ role: 'user'; text: string }> = [];
  for (let i = 0; i < rest.length; i += 8000) hist.push({ role: 'user', text: rest.slice(i, i + 8000) });
  if (tail) hist[hist.length - 1] = { role: 'user', text: hist[hist.length - 1]!.text.slice(0, 8000 - tail.length) + tail };
  const san = sanitizeAgentInput({ question: q, history: hist });
  if (!san.ok) throw new Error(`premise: the body must pass sanitizeAgentInput (${san.error})`);
  return { question: san.question, history: san.history.map((h) => h.text) };
}

const TERMS: Record<string, DealTerms> = {
  z: { label: 'Z', active: true, always: ['Zephyrwood Commons'] },
  h: { label: 'H', active: true, always: ['Heronmoor'] },
};
const EDGE = edgeConfidentialScan({
  meta: { asOf: '2026-10-01', scenario: 'base' },
  deals: [{ id: 'd', name: 'Heronmoor', shortName: null, confidential: true }],
} as unknown as PortfolioSnapshot)!;

/** Outcome and wall time of a scan: HIT, miss, or the class of what it threw. */
function timed(fn: () => unknown): { out: string; ms: number } {
  const t0 = performance.now();
  let out: string;
  try {
    out = fn() ? 'HIT' : 'miss';
  } catch (e) {
    out = e instanceof ScanBudgetError ? 'refused' : `THROW(${e instanceof Error ? e.constructor.name : typeof e})`;
  }
  return { out, ms: performance.now() - t0 };
}

describe('P2: the combining-mark stall body is bounded and fails closed', () => {
  it('server union (rosterMatchWithTerms): refuses in bounded time', () => {
    const r = timed(() => rosterMatchWithTerms(stallBody(), TERMS));
    expect(r.out).toBe('refused');
    expect(r.ms).toBeLessThan(3000);
  }, 60_000);
  it('edge union (edgeConfidentialScan): refuses in bounded time', () => {
    const r = timed(() => EDGE(stallBody()));
    expect(r.out).toBe('refused');
    expect(r.ms).toBeLessThan(3000);
  }, 60_000);
  it('a term only roster-core catches, planted AFTER the long mark run: caught or refused, in bounded time', () => {
    // 'Heronmøør': o-slash has no decomposition, main's normaliser misses it, roster-core folds it.
    const v = stallBody(' Bid from Heronmøør');
    for (const scan of [() => rosterMatchWithTerms(v, TERMS), () => EDGE(v), () => matchRosterTerms(v, TERMS)]) {
      const r = timed(scan);
      expect(['HIT', 'refused']).toContain(r.out);
      expect(r.ms).toBeLessThan(3000);
    }
  }, 60_000);
  it('a planted term main catches still HITS (main\'s half runs first and is unaffected)', () => {
    const v = stallBody(' Bid from Zephyrwood Commons');
    expect(rosterMatchWithTerms(v, TERMS)).toEqual({ dealLabel: 'Z' });
  }, 60_000);
});

describe('P2: normalizeBounded', () => {
  const FORMS = ['NFC', 'NFD', 'NFKC', 'NFKD'] as const;
  // Ordinary but awkward text: Hangul syllables and conjoining / halfwidth / compatibility jamo (a
  // V or T jamo composes with the preceding L), Thai SARA AM (NFKD starts with a mark), halfwidth
  // katakana voiced marks (non-starters under NFKD), surrogate pairs, short mark runs, ligatures.
  const ALPHABET = [
    'a', 'Z', ' ', '-', '\n', 'é', 'é', 'ᄀ', 'ᅡ', 'ᆨ', '가', 'ㄱ', 'ㅏ',
    'ﾡ', 'ￂ', 'ำ', 'ｶﾞ', 'ﾟ', cp(0x1d400), cp(0x1f600), 'ﬁ', 'Å',
    '̖́ͅ', '̈́', cp(0x16d63, 0x16d67), ' ', '　', 'Ω', 'İ', 'Σ',
  ];
  it('is identical to String.prototype.normalize on long ordinary text (seeded, all four forms)', () => {
    let seed = 20261016;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let n = 0; n < 60; n++) {
      const parts: string[] = [];
      const len = 2000 + Math.floor(rnd() * 6000);
      let total = 0;
      while (total < len) {
        const p = ALPHABET[Math.floor(rnd() * ALPHABET.length)]!;
        // Occasionally a mark run that is long but under the cap, placed anywhere (incl. a chunk edge).
        const piece = rnd() < 0.01 ? 'o' + '̖́'.repeat(300) : p;
        parts.push(piece);
        total += piece.length;
      }
      const s = parts.join('');
      for (const f of FORMS) expect(normalizeBounded(s, f) === s.normalize(f), `case ${n} ${f}`).toBe(true);
    }
  });
  // Refute wf_373225a7 (TEST INTEGRITY): the seeded test above rarely puts a second element exactly
  // at a piece edge, so dropping an entry from UNSAFE_CUT (widening the cut set) survived. These
  // cases place each unsafe-cut code point EXACTLY at the first piece edge (unit 512), right after
  // a first element it composes with, so a cut there changes the output.
  const EDGE_AT = 512;
  /** `first` ends at unit EDGE_AT - 1 and `second` starts at unit EDGE_AT; total > the chunking threshold. */
  const atEdge = (first: string, second: string): string =>
    'x'.repeat(EDGE_AT - first.length) + first + second + ' tail'.repeat(500);
  /** Does normalising `first` and `second` separately differ from normalising them together? */
  const cutChanges = (first: string, second: string): boolean =>
    FORMS.some((f) => (first + second).normalize(f) !== first.normalize(f) + second.normalize(f));
  const expectIdentical = (s: string, label: string): void => {
    expect(s.length).toBeGreaterThan(NORMALIZE_RUN_CAP);
    for (const f of FORMS) expect(normalizeBounded(s, f) === s.normalize(f), `${label} ${f}`).toBe(true);
  };
  const hex = (s: string): string => [...s].map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase()}`).join(' ');
  const expand = (parts: Array<number | [number, number]>): number[] =>
    parts.flatMap((p) => (typeof p === 'number' ? [p] : Array.from({ length: p[1] - p[0] + 1 }, (_, k) => p[0] + k)));

  it('every explicit non-mark UNSAFE_CUT entry, placed at the piece edge after a composing first element (all four forms)', () => {
    // The explicit (non-\p{M}) list in roster-core.ts UNSAFE_CUT, entry by entry.
    const explicit = expand([
      0x0e33, 0x0eb3, [0x1161, 0x1175], [0x11a8, 0x11c2], 0x3133, [0x3135, 0x3136], [0x313a, 0x313f],
      [0x314f, 0x3163], [0xff9e, 0xff9f], 0xffa3, [0xffa5, 0xffa6], [0xffaa, 0xffaf], [0xffc2, 0xffc7],
      [0xffca, 0xffcf], [0xffd2, 0xffd7], [0xffda, 0xffdc], 0x16d67, 0x16d68,
    ]);
    // First elements: L jamo (+ V, or + compatibility / halfwidth vowel under NFKC), LV syllable (+ T,
    // or + compatibility / halfwidth final under NFKC), halfwidth HA (+ halfwidth voiced marks under
    // NFKC), Kirat Rai U+16D63 (+ U+16D67, or + U+16D68 whose NFD starts with U+16D67).
    const FIRSTS = ['ᄀ', '가', 'ﾊ', cp(0x16d63)];
    // Thai / Lao SARA AM (NFKD U+0E4D U+0E32 / U+0ECD U+0EB2) are listed conservatively: their NFKD
    // starts with a mark, but that mark is a starter that composes with nothing, so no first element
    // makes a cut before them observable (an exhaustive 1- and 2-code-point prefix search found none).
    // They are still placed at the edge (identity must hold), they just cannot be discriminating.
    const CONSERVATIVE = new Set([0x0e33, 0x0eb3]);
    let discriminating = 0;
    for (const c of explicit) {
      const second = cp(c);
      const first = FIRSTS.find((f) => cutChanges(f, second));
      if (CONSERVATIVE.has(c)) {
        expect(first, `premise: ${hex(second)} has no discriminating first element`).toBeUndefined();
        expectIdentical(atEdge('ก', second), `ก + ${hex(second)}`);
        continue;
      }
      expect(first, `premise: a cut before ${hex(second)} is observable after some first element`).toBeDefined();
      discriminating++;
      expectIdentical(atEdge(first!, second), `${hex(first!)} + ${hex(second)}`);
    }
    expect(discriminating).toBe(explicit.length - CONSERVATIVE.size);
  });

  it('every ccc-0 second element of a canonical composition (Indic / Sinhala / Myanmar / Balinese / Chakma / Grantha ... vowel signs), at the piece edge', () => {
    // Derived from the running ICU (so an ICU / Unicode bump that adds one is covered): every primary
    // composite q (NFC(q) == q) with a two-code-point NFD [a, b] gives a first element a and a second
    // element b. Many b are combining marks with ccc > 0; the ones that matter most here are the
    // spacing / ccc-0 vowel signs (U+09BE, U+0B3E, U+0BBE, U+0CC2, U+0D3E, U+0DCF, U+102E, U+1B35,
    // U+11127, U+1133E, ...), which only the \p{M} member of UNSAFE_CUT keeps from being a cut point.
    const pairs = new Map<string, string>(); // second -> first
    for (let q = 0x00c0; q <= 0x10ffff; q++) {
      if (q >= 0xd800 && q <= 0xdfff) continue;
      if (q >= 0xac00 && q <= 0xd7a3) continue; // Hangul syllables: covered by the explicit-entry test
      const s = String.fromCodePoint(q);
      const d = s.normalize('NFD');
      if (d === s || s.normalize('NFC') !== s) continue;
      const parts = [...d];
      if (parts.length !== 2) continue;
      if (!pairs.has(parts[1]!)) pairs.set(parts[1]!, parts[0]!);
    }
    const mustCover = [0x09be, 0x09d7, 0x0b3e, 0x0b56, 0x0b57, 0x0bbe, 0x0bd7, 0x0c56, 0x0cc2, 0x0cd5, 0x0cd6,
      0x0d3e, 0x0d57, 0x0dca, 0x0dcf, 0x0ddf, 0x102e, 0x1b35, 0x11127, 0x1133e, 0x11357, 0x16d67];
    for (const c of mustCover) expect(pairs.has(cp(c)), `premise: ${hex(cp(c))} is a composition second element`).toBe(true);
    let n = 0;
    for (const [second, first] of pairs) {
      if (!cutChanges(first, second)) continue;
      n++;
      expectIdentical(atEdge(first, second), `${hex(first)} + ${hex(second)}`);
    }
    expect(n).toBeGreaterThanOrEqual(mustCover.length);
  });

  it('a mark run at the cap is normalised; one longer than the cap throws ScanBudgetError', () => {
    const pad = 'lorem ipsum '.repeat(400);
    const ok = pad + 'a' + '́'.repeat(NORMALIZE_RUN_CAP - 1) + pad;
    expect(normalizeBounded(ok, 'NFKC')).toBe(ok.normalize('NFKC'));
    const bad = pad + 'a' + '́'.repeat(NORMALIZE_RUN_CAP + 2) + pad;
    expect(() => normalizeBounded(bad, 'NFKC')).toThrow(ScanBudgetError);
    expect(() => normalizeRosterText(bad)).toThrow(ScanBudgetError);
  });
  it('charges the characters it normalises to the budget it is given', () => {
    let charged = 0;
    const b = { visit: () => {}, text: (n: number) => { charged += n; } };
    const s = 'é'.repeat(5000);
    normalizeBounded(s, 'NFD', b);
    expect(charged).toBe(5000);
    // A real budget throws once the cap is crossed (the cap is the shared 64M-char scan budget).
    const real = scanBudget();
    expect(() => { for (let i = 0; i < 20; i++) normalizeBounded('x'.repeat(4 * 1024 * 1024), 'NFC', real); }).toThrow(ScanBudgetError);
  });
});

describe('P2: ordinary payloads keep their cost', () => {
  it('1.3 MB of ordinary accented text: matchRosterTerms in a few seconds, and it still matches', () => {
    const para = 'Café résumé naïve — Zürich warehouse, 12,500 SF; ';
    const big = { notes: Array.from({ length: 400 }, (_, i) => para.repeat(70) + ` item ${i}`), tail: 'Bid from Heronmøør' };
    expect(JSON.stringify(big).length).toBeGreaterThan(1_300_000);
    const r = timed(() => matchRosterTerms(big, TERMS));
    expect(r.out).toBe('HIT');
    expect(r.ms).toBeLessThan(15_000);
  }, 60_000);
});
