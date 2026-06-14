import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  scanDiffForConfidential,
  parseAddedLines,
  loadTerms,
} from '../../scripts/prepush-confidential-scan.mjs';

// All terms below are SYNTHETIC. Never put a real deal name/figure in this file.
const FAKE_TERM = 'ACME-SECRET-DEAL';
const FAKE_TERM_2 = 'fake-deal-xyz';

describe('prepush-confidential-scan / scanDiffForConfidential', () => {
  it('flags an added line that contains a confidential term', () => {
    const added = [{ file: 'src/notes.ts', lineNo: 12, text: `const x = 'ACME-SECRET-DEAL terms';` }];
    const hits = scanDiffForConfidential(added, [FAKE_TERM]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.term).toBe(FAKE_TERM);
    expect(hits[0]?.line).toBe(12);
    expect(hits[0]?.text).toContain('ACME-SECRET-DEAL');
  });

  it('does not flag context/removed lines because the parser feeds only added lines', () => {
    // parseAddedLines keeps only '+' lines (and drops the leading '+').
    const diff = [
      '@@ -1,3 +1,3 @@',
      `-const removed = 'ACME-SECRET-DEAL';`,
      ` const context = 'ACME-SECRET-DEAL';`,
      `+const added = 'clean value';`,
    ].join('\n');
    const added = parseAddedLines(diff);
    const hits = scanDiffForConfidential(added, [FAKE_TERM]);
    expect(hits).toHaveLength(0);
  });

  it('returns no hits when the term is absent from every added line', () => {
    const added = [{ file: 'a.ts', lineNo: 1, text: 'const ok = 1;' }];
    expect(scanDiffForConfidential(added, [FAKE_TERM])).toHaveLength(0);
  });

  it('matches case-insensitively', () => {
    const added = [{ file: 'a.ts', lineNo: 5, text: 'value = acme-secret-deal' }];
    const hits = scanDiffForConfidential(added, [FAKE_TERM]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.term).toBe(FAKE_TERM);
  });

  it('ignores terms of 2 characters or fewer to avoid false positives', () => {
    const added = [{ file: 'a.ts', lineNo: 1, text: 'a ab abc' }];
    expect(scanDiffForConfidential(added, ['a', 'ab'])).toHaveLength(0);
  });

  it('returns clean when the terms list is empty', () => {
    const added = [{ file: 'a.ts', lineNo: 1, text: 'ACME-SECRET-DEAL fake-deal-xyz' }];
    expect(scanDiffForConfidential(added, [])).toHaveLength(0);
  });

  it('reports a hit per offending term on the same line', () => {
    const added = [{ file: 'a.ts', lineNo: 7, text: 'ACME-SECRET-DEAL and fake-deal-xyz together' }];
    const hits = scanDiffForConfidential(added, [FAKE_TERM, FAKE_TERM_2]);
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.term).sort()).toEqual([FAKE_TERM, FAKE_TERM_2].sort());
  });
});

describe('prepush-confidential-scan / parseAddedLines', () => {
  it('extracts +lines with file paths and incrementing line numbers from hunk headers', () => {
    const diff = [
      'diff --git a/foo.ts b/foo.ts',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -10,2 +10,3 @@',
      ' unchanged',
      '+first added',
      '+second added',
    ].join('\n');
    const added = parseAddedLines(diff);
    expect(added).toHaveLength(2);
    expect(added[0]).toEqual({ file: 'foo.ts', lineNo: 11, text: 'first added' });
    expect(added[1]).toEqual({ file: 'foo.ts', lineNo: 12, text: 'second added' });
  });

  it('ignores the +++ file header line (not a content addition)', () => {
    const diff = ['--- a/x.ts', '+++ b/x.ts', '@@ -0,0 +1 @@', '+real add'].join('\n');
    const added = parseAddedLines(diff);
    expect(added).toHaveLength(1);
    expect(added[0]?.text).toBe('real add');
  });
});

describe('prepush-confidential-scan / loadTerms', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'cc-terms-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns the built-in denylist (and does not throw) when the roster file is absent', () => {
    const terms = loadTerms(tmpHome);
    expect(Array.isArray(terms)).toBe(true);
    // Built-in denylist is always present even with no roster file.
    expect(terms.length).toBeGreaterThan(0);
  });

  it('extracts string terms from a roster file shaped like the real one', () => {
    const hooksDir = join(tmpHome, '.claude', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    // Synthetic roster mirroring the real per-deal object shape (label/active/string arrays).
    const roster = {
      _meta: { purpose: 'test', matching: 'whole', policy: 'fail-closed' },
      fake_deal: {
        label: 'Fake Deal (synthetic)',
        active: true,
        note: 'not a real deal',
        always: [FAKE_TERM, FAKE_TERM_2],
        context: ['SyntheticCounterparty LLC'],
        context_requires_any: ['12.5x', 'fake-figure-9999'],
      },
    };
    writeFileSync(join(hooksDir, 'confidential-terms.json'), JSON.stringify(roster), 'utf8');

    const terms = loadTerms(tmpHome);
    expect(terms).toContain(FAKE_TERM);
    expect(terms).toContain(FAKE_TERM_2);
    expect(terms).toContain('SyntheticCounterparty LLC');
    expect(terms).toContain('fake-figure-9999');
  });

  it('does not throw on an unparseable roster file and still returns the built-in denylist', () => {
    const hooksDir = join(tmpHome, '.claude', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'confidential-terms.json'), '{ this is not json', 'utf8');

    const terms = loadTerms(tmpHome);
    expect(Array.isArray(terms)).toBe(true);
    expect(terms.length).toBeGreaterThan(0);
  });
});
