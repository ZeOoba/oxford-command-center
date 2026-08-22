import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { execFileSync } from 'node:child_process';

import {
  scanDiffForConfidential,
  scanDiffForContextTerms,
  scanDiffForConfidentialFlag,
  isRegisteredConfidentialRepo,
  currentRepoName,
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
    const roster = loadTerms(tmpHome);
    expect(Array.isArray(roster.alwaysTerms)).toBe(true);
    // Built-in denylist is always present even with no roster file.
    expect(roster.alwaysTerms.length).toBeGreaterThan(0);
    expect(roster.contextGroups).toEqual([]);
  });

  it('extracts always terms and a context group from an ACTIVE deal shaped like the real one', () => {
    const hooksDir = join(tmpHome, '.claude', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    // Synthetic roster mirroring the real per-deal object shape (label/active/string arrays).
    const roster = {
      _meta: { purpose: 'test', matching: 'lowercased substring', policy: 'fail-closed' },
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

    const loaded = loadTerms(tmpHome);
    expect(loaded.alwaysTerms).toContain(FAKE_TERM);
    expect(loaded.alwaysTerms).toContain(FAKE_TERM_2);
    // Context terms are NOT flattened into alwaysTerms — they need the separate gated scan.
    expect(loaded.alwaysTerms).not.toContain('SyntheticCounterparty LLC');
    expect(loaded.contextGroups).toHaveLength(1);
    expect(loaded.contextGroups[0]).toEqual({
      dealKey: 'fake_deal',
      contextTerms: ['SyntheticCounterparty LLC'],
      requiresAny: ['12.5x', 'fake-figure-9999'],
    });
  });

  it('excludes a RETIRED deal (active: false) entirely — both always and context terms', () => {
    // Mirrors the real roster's own documented policy: "Set active=false to retire a deal
    // post-closing" — a retired deal's block stays in the JSON as an audit-trail record but is
    // no longer enforced.
    const hooksDir = join(tmpHome, '.claude', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const roster = {
      _meta: { purpose: 'test' },
      retired_deal: {
        label: 'Retired Deal (synthetic)',
        active: false,
        always: [FAKE_TERM],
        context: ['SyntheticCounterparty LLC'],
        context_requires_any: ['fake-figure-9999'],
      },
    };
    writeFileSync(join(hooksDir, 'confidential-terms.json'), JSON.stringify(roster), 'utf8');

    const loaded = loadTerms(tmpHome);
    expect(loaded.alwaysTerms).not.toContain(FAKE_TERM);
    expect(loaded.contextGroups).toEqual([]);
  });

  it('does not throw on an unparseable roster file and still returns the built-in denylist', () => {
    const hooksDir = join(tmpHome, '.claude', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'confidential-terms.json'), '{ this is not json', 'utf8');

    const loaded = loadTerms(tmpHome);
    expect(Array.isArray(loaded.alwaysTerms)).toBe(true);
    expect(loaded.alwaysTerms.length).toBeGreaterThan(0);
    expect(loaded.contextGroups).toEqual([]);
  });
});

describe('prepush-confidential-scan / scanDiffForContextTerms', () => {
  // Regression coverage for the real-world false positive this function fixes: a generic
  // 3-letter context term ('tce', an environmental-context abbreviation on the real roster)
  // matched as a bare substring inside ordinary code (ExcelJS's `getCell` method — 'ge-tCe-ll')
  // with no identifying companion anywhere in the push. Synthetic equivalent below.
  const GROUP = { dealKey: 'fake_deal', contextTerms: ['xyz'], requiresAny: ['fake-fulton-st'] };

  it('does NOT flag a context term when no context_requires_any companion appears anywhere in the corpus', () => {
    const added = [
      { file: 'src/widget.ts', lineNo: 1, text: 'function getXyzCell() { return 1; }' },
      { file: 'src/other.ts', lineNo: 4, text: 'const unrelated = "nothing to see here";' },
    ];
    expect(scanDiffForContextTerms(added, [GROUP])).toHaveLength(0);
  });

  it('DOES flag a context term once a context_requires_any companion appears anywhere in the same push (not necessarily the same line)', () => {
    const added = [
      { file: 'src/widget.ts', lineNo: 1, text: 'function getXyzCell() { return 1; }' },
      { file: 'src/other.ts', lineNo: 4, text: 'reference to fake-fulton-st appears here' },
    ];
    const hits = scanDiffForContextTerms(added, [GROUP]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.term).toBe('xyz');
    expect(hits[0]?.file).toBe('src/widget.ts');
  });

  it('scopes gating per deal — a companion from deal A does not unlock deal B\'s context terms', () => {
    const groupA = { dealKey: 'deal_a', contextTerms: ['alpha'], requiresAny: ['alpha-companion'] };
    const groupB = { dealKey: 'deal_b', contextTerms: ['beta'], requiresAny: ['beta-companion'] };
    const added = [
      { file: 'a.ts', lineNo: 1, text: 'alpha alpha-companion beta' }, // beta present, but no beta-companion
    ];
    const hits = scanDiffForContextTerms(added, [groupA, groupB]);
    expect(hits.map((h) => h.term)).toEqual(['alpha']);
  });

  it('returns no hits for an empty contextGroups list', () => {
    const added = [{ file: 'a.ts', lineNo: 1, text: 'xyz fake-fulton-st' }];
    expect(scanDiffForContextTerms(added, [])).toHaveLength(0);
  });
});

// cc-audit-army finding confidential-deals-committed-to-git-remote (2026-08-21), resolved per
// Gabriel's ruling: formalize the repo as an intentional in-perimeter confidential store, but
// make the push gate assert that precondition structurally rather than assuming it.
describe('prepush-confidential-scan / scanDiffForConfidentialFlag', () => {
  it('flags a "confidential": true payload', () => {
    const added = [{ file: 'data/snapshots/portfolio.json', lineNo: 42, text: '    "confidential": true,' }];
    const hits = scanDiffForConfidentialFlag(added);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.file).toBe('data/snapshots/portfolio.json');
    expect(hits[0]?.line).toBe(42);
  });

  it('tolerates whitespace variance around the colon', () => {
    const added = [{ file: 'a.json', lineNo: 1, text: '"confidential":true' }];
    expect(scanDiffForConfidentialFlag(added)).toHaveLength(1);
  });

  it('does not flag "confidential": false', () => {
    const added = [{ file: 'a.json', lineNo: 1, text: '"confidential": false,' }];
    expect(scanDiffForConfidentialFlag(added)).toHaveLength(0);
  });

  it('does not flag an unrelated line', () => {
    const added = [{ file: 'a.ts', lineNo: 1, text: 'const x = 1;' }];
    expect(scanDiffForConfidentialFlag(added)).toHaveLength(0);
  });

  it('returns no hits for a non-array input', () => {
    // @ts-expect-error deliberate bad input
    expect(scanDiffForConfidentialFlag(null)).toHaveLength(0);
  });

  // cc-audit-army code-review finding (2026-08-22): the regex used to match ONLY the
  // JSON-quoted-key shape. This codebase's own TS source (src/data/public-deals.ts) and test
  // fixtures construct these records with the unquoted object-literal shape pervasively.
  it('flags the unquoted TS/JS object-literal shape (confidential: true)', () => {
    const added = [{ file: 'src/data/seed-deals.ts', lineNo: 10, text: '  confidential: true,' }];
    expect(scanDiffForConfidentialFlag(added)).toHaveLength(1);
  });

  it('flags the unquoted shape with no space after the colon', () => {
    const added = [{ file: 'a.ts', lineNo: 1, text: 'confidential:true' }];
    expect(scanDiffForConfidentialFlag(added)).toHaveLength(1);
  });

  it('flags a single-quoted key shape too', () => {
    const added = [{ file: 'a.ts', lineNo: 1, text: "'confidential': true" }];
    expect(scanDiffForConfidentialFlag(added)).toHaveLength(1);
  });

  it('does not flag a longer identifier ending in "confidential" (e.g. isConfidential)', () => {
    const added = [{ file: 'a.ts', lineNo: 1, text: 'isConfidential: true,' }];
    expect(scanDiffForConfidentialFlag(added)).toHaveLength(0);
  });

  it('does not flag the unquoted shape when the value is false', () => {
    const added = [{ file: 'a.ts', lineNo: 1, text: 'confidential: false,' }];
    expect(scanDiffForConfidentialFlag(added)).toHaveLength(0);
  });
});

describe('prepush-confidential-scan / currentRepoName', () => {
  let tmpRoot: string;
  let mainRepo: string;
  let worktree: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cc-repo-name-'));
    mainRepo = join(tmpRoot, 'oxford-command-center');
    mkdirSync(mainRepo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: mainRepo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: mainRepo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: mainRepo });
    writeFileSync(join(mainRepo, 'README.md'), 'test', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: mainRepo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: mainRepo });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('resolves the main repo directory name when invoked from the main checkout', () => {
    expect(currentRepoName(mainRepo)).toBe('oxford-command-center');
  });

  // cc-audit-army code-review finding (2026-08-22): --show-toplevel returns the WORKTREE's own
  // directory from inside a linked worktree, not the main repo's. This repo currently runs with
  // several live worktrees whose directory names don't match the registered
  // 'oxford-command-center' -- a push from any of them would false-block under the old
  // resolution. --git-common-dir must resolve to the MAIN repo's name regardless.
  it('resolves the MAIN repo directory name when invoked from a linked worktree with a different directory name', () => {
    worktree = join(tmpRoot, 'totally-different-worktree-name');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'feature-branch', worktree], { cwd: mainRepo });
    expect(currentRepoName(worktree)).toBe('oxford-command-center');
  });

  it('returns an empty string (fail toward blocking) outside any git repo', () => {
    const notARepo = join(tmpRoot, 'not-a-repo');
    mkdirSync(notARepo, { recursive: true });
    expect(currentRepoName(notARepo)).toBe('');
  });
});

describe('prepush-confidential-scan / isRegisteredConfidentialRepo', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'cc-conf-repos-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns false (fail toward blocking) when the roster file is absent', () => {
    expect(isRegisteredConfidentialRepo('oxford-command-center', tmpHome)).toBe(false);
  });

  it('returns false for an empty repo name', () => {
    expect(isRegisteredConfidentialRepo('', tmpHome)).toBe(false);
  });

  it('returns true for a repo name present on confidential_repos', () => {
    const claudeDir = join(tmpHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'confidential-repos.json'),
      JSON.stringify({ confidential_repos: ['oxford-command-center', 'website-canonical'] }),
      'utf8',
    );
    expect(isRegisteredConfidentialRepo('oxford-command-center', tmpHome)).toBe(true);
  });

  it('returns false for a repo name absent from confidential_repos', () => {
    const claudeDir = join(tmpHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'confidential-repos.json'),
      JSON.stringify({ confidential_repos: ['website-canonical'] }),
      'utf8',
    );
    expect(isRegisteredConfidentialRepo('some-other-repo', tmpHome)).toBe(false);
  });

  it('returns false (fail toward blocking), never throws, on an unparseable roster', () => {
    const claudeDir = join(tmpHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'confidential-repos.json'), '{ not json', 'utf8');
    expect(isRegisteredConfidentialRepo('oxford-command-center', tmpHome)).toBe(false);
  });

  it('returns false when confidential_repos is missing or malformed on an otherwise-valid roster', () => {
    const claudeDir = join(tmpHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'confidential-repos.json'), JSON.stringify({ rule: 'no list here' }), 'utf8');
    expect(isRegisteredConfidentialRepo('oxford-command-center', tmpHome)).toBe(false);
  });
});
