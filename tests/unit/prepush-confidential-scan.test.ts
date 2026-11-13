import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { execFileSync, spawnSync } from 'node:child_process';

/**
 * The scanner runs the Python term scan first, and a missing roster blocks (fail closed). Fixture
 * homes get an empty roster (no active deal) unless a test writes its own.
 */
function withEmptyRoster(home: string): string {
  const dir = join(home, '.claude', 'hooks');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'confidential-terms.json');
  try {
    writeFileSync(file, '{}\n', { flag: 'wx' });
  } catch {
    // a test's own roster wins
  }
  return home;
}

// The module below is plain .mjs on purpose (the raw .git/hooks/pre-push script invokes it
// with no npm context). Its types come from a GENERATED sibling .d.mts, emitted from that
// script's own JSDoc by `npm run typecheck`'s `pretypecheck` step and gitignored by design --
// see the "//" note in tsconfig.confidential-scan-types.json for why a hand-maintained
// declaration was removed (it drifted from the exports twice, OI-206).
//
// So typecheck with `npm run typecheck`, NOT a bare `npx tsc`: bare tsc skips the npm
// pre-script, the declaration is absent on a fresh clone, and this import degrades to `any`
// -- which cascades into implicit-any `h` params and an "unused @ts-expect-error" below.
// Those errors mean the generator did not run. They do NOT mean this file needs annotating,
// and the @ts-expect-error in the "non-array input" test is load-bearing: it asserts the
// scanner rejects null at the type level. Do not delete it to silence a cascade.
import {
  scanDiffForConfidentialFlag,
  isRegisteredConfidentialRepo,
  currentRepoName,
  parseAddedLines,
  COMMIT_MESSAGE_FILE_PREFIX,
  isBlockedDataFile,
  parseRawLog,
  binaryPathsFor,
  shouldBlockOnDiffError,
  rangeFor,
  destinationBound,
  collectRefScan,
  loadRealDataManifest,
  isRealDataPath,
  parseRealDataPaths,
  realDataPathsFor,
  isCopyOf,
  COPY_MARKER,
  realAmountFingerprints,
  scanAddedLinesForRealAmounts,
  FINGERPRINT_BLOCK_MIN,
  FINGERPRINT_BLOCK_MIN_SYNTHETIC,
  readPushStdin,
  runTermScan,
  findPython,
  scanAddedLinesForWatermarks,
  WATERMARKS,
  resolveOnPath,
} from '../../scripts/prepush-confidential-scan.mjs';

// Every value below is SYNTHETIC. Never put a real deal name, figure or address in this file.
// Confidential TERM matching moved to the vendored Python scanner on 2026-11-12 (refute run
// wf_72500728-83e); its own suite is scripts/test_prepush_confidential_scan.py (run by
// tests/unit/prepush-python-scanner.test.ts) and the whole hook is exercised end to end in
// tests/unit/prepush-hook-e2e.test.ts. This file covers the OCC payload checks the JS scanner keeps.

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

  it('returns only added lines: removed and context lines are not payload', () => {
    const diff = ['@@ -1,3 +1,3 @@', '-"confidential": true,', ' "confidential": true,', '+"clean": 1'].join('\n');
    expect(parseAddedLines(diff).map((a) => a.text)).toEqual(['"clean": 1']);
  });

  // wf_0df7879e-d79 (low): git appends a TAB after a header name containing a space; trimming all
  // whitespace turned 'scripts/install-git-hooks.ts ' into an excluded path.
  it('keeps a trailing space in the file name (strips only git\'s TAB)', () => {
    const diff = ['+++ b/scripts/install-git-hooks.ts \t', '@@ -0,0 +1 @@', '+x'].join('\n');
    expect(parseAddedLines(diff)[0]?.file).toBe('scripts/install-git-hooks.ts ');
  });
});

// cc-audit-army finding confidential-deals-committed-to-git-remote (2026-08-21): the push gate asserts
// structurally that a confidential:true payload only leaves a registered confidential store. The
// 2026-08-21 ruling that let the snapshot carry real records in git is superseded (real firm data is
// never tracked, ruling 2026-11-10; see the real-data describe block below); this check stays as a
// second, payload-shaped line of defense.
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

describe('prepush-confidential-scan / data/ file classification and raw-log parsing', () => {
  it('blocks a data/ file by CONTENT (any NUL byte) or by export extension, never outside data/', () => {
    const nul = Buffer.from([0x41, 0x00, 0x42]);
    const text = Buffer.from('plain text\n');
    expect(isBlockedDataFile('data/ar/processed/aging.bin', nul)).toBe(true);
    expect(isBlockedDataFile('data/tenants.csv', text)).toBe(true);
    expect(isBlockedDataFile('data/report.PDF', text)).toBe(true);
    expect(isBlockedDataFile('data/ok.json', text)).toBe(false);
    expect(isBlockedDataFile('docs/diagram.png', nul)).toBe(false);
    expect(isBlockedDataFile('data\\win\\x.xlsx', text)).toBe(true);
  });

  it('parseRawLog reads -z records verbatim (quote, tab, newline in a path), keeps A/M/T, drops deletions and submodules', () => {
    const marker = 'MARK-';
    const c1 = '1'.repeat(40);
    const blob = (n: number) => String(n).repeat(40);
    const raw = [
      `${marker}${c1}`,
      `\n:000000 100644 ${'0'.repeat(40)} ${blob(2)} A`,
      'data/we"ird\tname\nx.xlsx',
      `:100644 120000 ${blob(3)} ${blob(4)} T`,
      'data/link.csv',
      `:100644 000000 ${blob(5)} ${'0'.repeat(40)} D`,
      'data/gone.xlsx',
      `:000000 160000 ${'0'.repeat(40)} ${blob(6)} A`,
      'vendor/sub',
      '',
    ].join('\0');
    expect(parseRawLog(raw, marker)).toEqual([
      { commit: c1, path: 'data/we"ird\tname\nx.xlsx', blob: blob(2) },
      { commit: c1, path: 'data/link.csv', blob: blob(4) },
    ]);
  });

  it('parseRawLog reads a merge\'s combined (--cc) record and fails closed on anything unrecognised', () => {
    const marker = 'MARK-';
    const m = 'a'.repeat(40);
    const raw = [`${marker}${m}`, `\n::000000 000000 100644 ${'0'.repeat(40)} ${'0'.repeat(40)} ${'b'.repeat(40)} AA`, 'data/evil.bin', ''].join('\0');
    expect(parseRawLog(raw, marker)).toEqual([{ commit: m, path: 'data/evil.bin', blob: 'b'.repeat(40) }]);
    expect(() => parseRawLog(`gpg: Signature made\0`, marker)).toThrow(/unrecognised/);
    expect(() => parseRawLog(`:100644 100644 x A\0p\0`, marker)).toThrow(/before any commit/);
  });
});

describe('prepush-confidential-scan / binary scan against a real git repo', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
  let repo: string;
  const ZERO = '0000000000000000000000000000000000000000';
  const bin = (n: number) => Buffer.from([0, 1, 2, 3, n]);

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'prepush-binrepo-'));
    git(repo, 'init', '-q', '-b', 'main');
    mkdirSync(join(repo, 'data', 'ar', 'processed'), { recursive: true });
    writeFileSync(join(repo, 'data', 'ar', 'processed', 'old.xlsx'), bin(1));
    writeFileSync(join(repo, 'README.md'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
    git(repo, 'branch', 'older'); // a branch that predates the untrack
    // main later untracks the export
    git(repo, 'rm', '-q', 'data/ar/processed/old.xlsx');
    git(repo, 'commit', '-qm', 'untrack');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));
  // What the push destination advertises (destinationBound): here, main.
  const advertised = () => [git(repo, 'rev-parse', 'main')];

  it('does not false-block an OLDER branch on files main has since removed (the destination already has them)', () => {
    const sha = git(repo, 'rev-parse', 'older');
    expect(binaryPathsFor(ZERO, sha, repo, advertised())).toEqual([]);
  });

  it('flags a binary added under data/ with a non-ASCII (en dash) name, unquoted', () => {
    git(repo, 'checkout', '-q', '-b', 'feat', 'main');
    mkdirSync(join(repo, 'data', 'ar', 'inbox'), { recursive: true });
    writeFileSync(join(repo, 'data', 'ar', 'inbox', 'Rarig – Delinquency 7.15.xlsx'), bin(2));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'add');
    expect(binaryPathsFor(ZERO, git(repo, 'rev-parse', 'HEAD'), repo, advertised())).toEqual(['data/ar/inbox/Rarig – Delinquency 7.15.xlsx']);
  });

  it('flags a binary moved into data/ WITH edits (rename detection must not hide it)', () => {
    git(repo, 'checkout', '-q', '-b', 'feat2', 'main');
    writeFileSync(join(repo, 'report.xlsx'), Buffer.concat([bin(3), Buffer.alloc(200, 7)]));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'add report outside data');
    const outside = git(repo, 'rev-parse', 'HEAD');
    mkdirSync(join(repo, 'data'), { recursive: true });
    git(repo, 'mv', 'report.xlsx', 'data/report.xlsx');
    writeFileSync(join(repo, 'data', 'report.xlsx'), Buffer.concat([bin(3), Buffer.alloc(200, 7), Buffer.from([9])]));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'move into data with edit');
    expect(binaryPathsFor(outside, git(repo, 'rev-parse', 'HEAD'), repo)).toEqual(['data/report.xlsx']);
  });

  it('flags a text-classified export (csv) under data/ and ignores a legit json', () => {
    git(repo, 'checkout', '-q', '-b', 'feat3', 'main');
    mkdirSync(join(repo, 'data'), { recursive: true });
    writeFileSync(join(repo, 'data', 'tenants.csv'), 'name,arrears\nA,10\n');
    writeFileSync(join(repo, 'data', 'ok.json'), '{"a":1}\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'add');
    expect(binaryPathsFor(ZERO, git(repo, 'rev-parse', 'HEAD'), repo, advertised())).toEqual(['data/tenants.csv']);
  });

  it('does not block the deletion of a tracked binary', () => {
    const before = git(repo, 'rev-parse', 'older');
    git(repo, 'checkout', '-q', '-b', 'feat4', 'older');
    git(repo, 'rm', '-q', 'data/ar/processed/old.xlsx');
    git(repo, 'commit', '-qm', 'delete');
    expect(binaryPathsFor(before, git(repo, 'rev-parse', 'HEAD'), repo)).toEqual([]);
  });
});

// prepush-scan-skips-on-diff-error (audit 2026-11-08): the scanner used to WARN and skip a ref
// whose diff it could not compute (ENOBUFS on a huge push, a remote sha absent locally), so the
// largest, most data-heavy pushes were the ones that went through unscanned. It now fails closed.
describe('prepush-confidential-scan / diff errors fail closed', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
  const ZERO = '0000000000000000000000000000000000000000';
  const MISSING = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  const script = join(process.cwd(), 'scripts', 'prepush-confidential-scan.mjs');
  let repo: string;
  let home: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'prepush-differr-'));
    home = mkdtempSync(join(tmpdir(), 'prepush-differr-home-'));
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), 'base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const commitOnFeature = (file: string, content: string) => {
    git(repo, 'checkout', '-q', '-b', 'feat');
    writeFileSync(join(repo, file), content);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'feat');
    return git(repo, 'rev-parse', 'HEAD');
  };

  const runHook = (stdin: string, extraEnv: Record<string, string> = {}) => {
    const env: Record<string, string | undefined> = { ...process.env, HOME: withEmptyRoster(home), USERPROFILE: home };
    delete env['PREPUSH_ALLOW_DIFF_ERROR'];
    delete env['PREPUSH_ALLOW_NO_ROSTER'];
    Object.assign(env, extraEnv);
    return spawnSync(process.execPath, [script], { cwd: repo, input: stdin, encoding: 'utf8', env });
  };

  it('shouldBlockOnDiffError blocks on any diff error unless PREPUSH_ALLOW_DIFF_ERROR=1', () => {
    const errs = [{ localSha: 'abc', message: 'ENOBUFS' }];
    expect(shouldBlockOnDiffError(errs, {})).toBe(true);
    expect(shouldBlockOnDiffError(errs, { PREPUSH_ALLOW_DIFF_ERROR: '0' })).toBe(true);
    expect(shouldBlockOnDiffError(errs, { PREPUSH_ALLOW_DIFF_ERROR: 'true' })).toBe(true);
    expect(shouldBlockOnDiffError(errs, { PREPUSH_ALLOW_DIFF_ERROR: '1' })).toBe(false);
    expect(shouldBlockOnDiffError([], {})).toBe(false);
  });

  it('rangeFor: a known remote sha bounds the range; an unknown one falls back to the destination bound, never origin/main', () => {
    const main = git(repo, 'rev-parse', 'main');
    git(repo, 'update-ref', 'refs/remotes/origin/main', main); // must be ignored
    const local = commitOnFeature('a.txt', 'zephyr corp\n');
    expect(rangeFor(main, local, repo, ['f'.repeat(40)])).toEqual({ args: [local, `^${main}`], exclude: [] });
    expect(rangeFor(MISSING, local, repo, [main])).toEqual({ args: [local], exclude: [main] });
    expect(rangeFor(ZERO, local, repo, [])).toEqual({ args: [local], exclude: [] });
    expect(rangeFor(ZERO, local, repo)).toEqual({ args: [local], exclude: [] });
  });

  it('collectRefScan records a diff error (never silently skips) when the local sha cannot be read', () => {
    const result = collectRefScan(`refs/heads/x ${MISSING} refs/heads/x ${ZERO}\n`, repo);
    expect(result.diffErrors.map((e) => e.localSha)).toEqual([MISSING]);
    expect(result.diffErrors[0]?.message.split(':')[0]).toBe('object type');
    expect(result.addedByRef).toEqual([]);
  });

  it('a numstat-only failure keeps the text diff that succeeded (its lines are still scanned)', () => {
    const fakeDiff = '+++ b/a.txt\n@@ -0,0 +1 @@\n+zephyr corp\n';
    const result = collectRefScan(`refs/heads/x ${'a'.repeat(40)} refs/heads/x ${ZERO}\n`, repo, {
      peeledType: () => 'commit',
      destinationBound: () => [],
      diffFor: () => fakeDiff,
      binaryPathsFor: () => {
        throw Object.assign(new Error('spawnSync git ENOBUFS'), { code: 'ENOBUFS' });
      },
    });
    expect(result.addedByRef.flat().map((a) => a.text)).toEqual(['zephyr corp']);
    expect(result.diffErrors).toEqual([{ localSha: 'a'.repeat(40), message: 'binary paths: ENOBUFS' }]);
    expect(shouldBlockOnDiffError(result.diffErrors, {})).toBe(true);
  });

  it('a text-diff-only failure still collects the binary paths', () => {
    const result = collectRefScan(`refs/heads/x ${'b'.repeat(40)} refs/heads/x ${ZERO}\n`, repo, {
      peeledType: () => 'commit',
      destinationBound: () => [],
      diffFor: () => {
        throw new Error('fatal: bad object');
      },
      binaryPathsFor: () => ['data/zephyr.xlsx'],
    });
    expect(result.addedByRef).toEqual([]);
    expect(result.binaryHits).toEqual(['data/zephyr.xlsx']);
    expect(result.diffErrors).toEqual([{ localSha: 'b'.repeat(40), message: 'text diff: fatal: bad object' }]);
  });

  it('collectRefScan still scans the added lines when the remote sha is missing locally (full history, no bound)', () => {
    const local = commitOnFeature('a.txt', 'zephyr corp\n');
    const result = collectRefScan(`refs/heads/feat ${local} refs/heads/feat ${MISSING}\n`, repo);
    expect(result.diffErrors).toEqual([]);
    // Commit-message lines ride along as "(commit message <sha>)" entries since 2026-11-12; this
    // test is about the file content, so only a.txt's lines are compared.
    expect(result.addedByRef.flat().filter((a) => a.file === 'a.txt').map((a) => a.text)).toEqual(['zephyr corp']);
  });

  it('the hook EXITS NON-ZERO when it cannot compute the diff for a pushed ref', () => {
    const r = runHook(`refs/heads/x ${MISSING} refs/heads/x ${ZERO}\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('PUSH BLOCKED');
    expect(r.stderr).toContain('PREPUSH_ALLOW_DIFF_ERROR');
  });

  it('the hook exits 0 with a loud warning when PREPUSH_ALLOW_DIFF_ERROR=1 is set for the push', () => {
    const r = runHook(`refs/heads/x ${MISSING} refs/heads/x ${ZERO}\n`, { PREPUSH_ALLOW_DIFF_ERROR: '1' });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/PREPUSH_ALLOW_DIFF_ERROR=1[^\n]*UNSCANNED/);
  });

  it('the opt-out does NOT suppress a real hit on another ref in the same push', () => {
    const local = commitOnFeature('a.json', '{"confidential": true}\n');
    const r = runHook(
      `refs/heads/x ${MISSING} refs/heads/x ${ZERO}\nrefs/heads/feat ${local} refs/heads/feat ${ZERO}\n`,
      { PREPUSH_ALLOW_DIFF_ERROR: '1' },
    );
    expect(r.status).toBe(1);
  });

  it('a clean push with a computable diff still exits 0', () => {
    const local = commitOnFeature('a.txt', 'plain text\n');
    const r = runHook(`refs/heads/feat ${local} refs/heads/feat ${ZERO}\n`);
    expect(r.status).toBe(0);
  });
});

// Real firm data is never tracked (ruling 2026-11-10). scripts/fixtures/real-data-manifest.json names
// every real-data path; a push that adds or modifies one is blocked with no override, while deleting
// (untracking) one and committing the synthetic stand-ins under fixtures/synthetic/ are allowed.
describe('prepush-confidential-scan / real-data paths (ruling 2026-11-10)', () => {
  const manifest = { files: ['data/snapshots/portfolio.json', 'src/data/seed-deals.ts'], dirs: ['data/calibration/'] };

  it('loads the committed manifest, and it covers the snapshot and the seed files', () => {
    const m = loadRealDataManifest();
    expect(m.files).toContain('data/snapshots/portfolio.json');
    expect(m.files).toContain('src/data/seed-deals.ts');
    expect(m.dirs).toContain('data/building-specs/');
  });

  it('fails closed (throws) on a missing or empty manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prepush-manifest-'));
    try {
      expect(() => loadRealDataManifest(join(dir, 'missing.json'))).toThrow();
      writeFileSync(join(dir, 'empty.json'), '{"files":[],"dirs":[]}');
      expect(() => loadRealDataManifest(join(dir, 'empty.json'))).toThrow(/no paths/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('every firm-data .gitignore rule, wildcards included, is covered by the push-time path block (refute rounds 4-5 F7/F5/F9)', () => {
    // A path protected only by .gitignore can still be pushed with `git add -f`; every ignore rule for
    // firm data (or a byte-copy / derived output of it) must also be blocked. Wildcard rules are
    // expanded into a sample path instead of being skipped.
    const m = loadRealDataManifest();
    const sample = (rule: string): string => {
      const r = rule.replace(/^\//, '').replace(/\[ _\(\.~-\]/g, '_').replace(/\*\*\//g, 'x/').replace(/\*/g, 'x');
      return r.endsWith('/') || /^(dist|dist-server)$/.test(r) ? `${r.replace(/\/$/, '')}/x.json` : r;
    };
    const rules = [
      ...readFileSync(join(process.cwd(), '.gitignore'), 'utf8').split(/\r?\n/),
      ...readFileSync(join(process.cwd(), 'scripts/property-financials/.gitignore'), 'utf8').split(/\r?\n/).map((l) => (l.trim() && !l.startsWith('#') ? `scripts/property-financials/${l.trim()}` : l)),
    ]
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
      .filter((l) => /^\/?(data\/|data$|public\/|dist$|dist-server$|config\/local|src\/data\/|scripts\/property-financials\/|scripts\/data\/|docs\/superpowers\/specs\/.*seed|tests\/fixtures\/property-financials\/)/.test(l))
      .filter((l) => !/\.log$/.test(l))
      // Explorer / browser copies of ANY file and folder copies are ignored more broadly than they are
      // blocked (a copy of an unlisted file is not real data); the copy-forms test below covers them.
      .filter((l) => !/ - Copy|\(\?|\]\*\/$/.test(l));
    expect(rules.length).toBeGreaterThan(30);
    expect(rules.some((r) => r.includes('*'))).toBe(true); // wildcard rules are checked, not dropped
    const uncovered = rules.filter((l) => !isRealDataPath(sample(l), m));
    expect(uncovered).toEqual([]);
  });

  it('quarantine, temp and backup copies of every listed file are both gitignored and push-blocked', () => {
    const m = loadRealDataManifest();
    const explicit = [
      'data/ar/review-queue.corrupt-1700000000000.json', // ar-import-headless backupCorruptQueue
      'data/alert-inbox.json.corrupt-2026-11-12T00-00-00-000Z', // alerts/store.ts
      'data/alert-state.json.corrupt-2026-11-12T00-00-00-000Z', // brief/state.ts
      'data/snapshots/portfolio.json.tmp-123-456', // atomic-write temp left by a crash
      'data/ar/review-queue.json.tmp-123',
      'data/overlay.json.tmp-1-2-3',
      'data/property-financials-status.json.123.abc.tmp',
    ];
    const generated = m.files
      .filter((f) => !f.startsWith('fixtures/'))
      .flatMap((f) => {
        const dot = f.lastIndexOf('.');
        const stem = dot > f.lastIndexOf('/') ? f.slice(0, dot) : f;
        const ext = dot > f.lastIndexOf('/') ? f.slice(dot) : '';
        return [`${f}.corrupt-1700000000000`, `${stem}.corrupt-1700000000000${ext}`, `${f}.tmp-1-2`, `${f}.bak`, `${f}.quarantine`];
      });
    const paths = [...explicit, ...generated];
    expect(paths.filter((p) => !isRealDataPath(p, m))).toEqual([]);
    const ignored = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], { input: paths.join('\n'), encoding: 'utf8' }).stdout.split(/\r?\n/).filter(Boolean);
    expect(paths.filter((p) => !ignored.includes(p))).toEqual([]);
    // a legitimate sibling that does not start with the listed stem plus a separator stays allowed
    expect(isRealDataPath('src/data/seed-dealership.ts', m)).toBe(false);
  });

  // Refute round 7: the copy forms are generated here from the manifest alone, never from the
  // .gitignore patterns, so this test cannot pass by construction.
  it('Explorer, browser, editor and archive copies of every listed file, at any depth, are both gitignored and push-blocked', () => {
    const m = loadRealDataManifest();
    const listed = m.files.filter((f) => !f.startsWith('fixtures/'));
    const forms = (f: string): string[] => {
      const slash = f.lastIndexOf('/');
      const dir = slash >= 0 ? f.slice(0, slash + 1) : '';
      const base = f.slice(slash + 1);
      const dot = base.lastIndexOf('.');
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const ext = dot > 0 ? base.slice(dot) : '';
      const folder = dir.replace(/\/$/, '');
      const out = [
        `${dir}${stem} - Copy${ext}`, // Explorer
        `${dir}${stem} - Copy (2)${ext}`,
        `${dir}${stem} (1)${ext}`, // browser download
        `${dir}${stem} (12)${ext}`,
        `${dir}Copy of ${base}`,
        `${dir}${stem}_old${ext}`,
        `${dir}${stem}-old${ext}`,
        `${dir}${stem}.backup${ext}`,
        `${dir}${base}.backup`,
        `${dir}${base}~`, // editor
        `${dir}.${base}.swp`,
        `${dir}${stem}.2026-11-10${ext}`, // date tag
        `${dir}${stem}_2026-11-10${ext}`,
        `${dir}old/${base}`, // nested archive folders
        `${dir}backup/${stem}_old${ext}`,
        `${dir}archive/2026/${base}`,
        `${dir}old/${stem} (1)${ext}`,
      ];
      if (folder) out.push(`${folder} - Copy/${base}`, `${folder}.bak/${base}`, `${folder} (1)/${base}`, `${folder}_old/${base}`);
      return out;
    };
    const paths = listed.flatMap(forms);
    expect(paths.length).toBeGreaterThan(listed.length * 15);
    expect(paths.filter((p) => !isRealDataPath(p, m))).toEqual([]);
    const ignored = new Set(
      spawnSync('git', ['check-ignore', '--no-index', '--stdin'], { input: paths.join('\n'), encoding: 'utf8' }).stdout.split(/\r?\n/).filter(Boolean),
    );
    expect(paths.filter((p) => !ignored.has(p))).toEqual([]);
  });

  it('the copy rule is anchored to the listed stem: ordinary names and other folders are not copies', () => {
    const m = loadRealDataManifest();
    for (const p of [
      'src/data/seed-dealership.ts', // stem followed by a letter
      'src/data/my-seed-deals.ts', // stem mid-word, no copy marker
      'src/data2/seed-deals.ts', // a different folder, not a copy of src/data
      'src/data/queries.ts',
      'scripts/property-financials/config/curated/meta.json',
      'scripts/property-financials/config/curated/sfx.json',
      'tests/fixtures/property-financials/raw-records.synthetic.json',
      'fixtures/synthetic/src/data/seed-deals (1).ts', // synthetic stand-ins never match
    ]) {
      expect(isRealDataPath(p, m), p).toBe(false);
    }
    expect(isCopyOf('src/data/old/seed-deals.ts', 'src/data/seed-deals.ts')).toBe(true);
    expect(isCopyOf('src/data/backup_seed-deals.ts', 'src/data/seed-deals.ts')).toBe(true);
    expect(isCopyOf('src/data/golden_seed-deals.ts', 'src/data/seed-deals.ts')).toBe(false);
  });

  it('COPY_MARKER matches only the declared markers on name-segment boundaries', () => {
    for (const w of ['Copy of ', 'x.bak', 'x_old', 'x-tmp-1', 'x.orig', 'x (copy)', 'x.quarantine', 'x.corrupt-1', 'backup_', 'x.temp']) {
      expect(COPY_MARKER.test(w), w).toBe(true);
    }
    for (const w of ['golden', 'template', 'copyright', 'bold', 'temperature', 'origin', 'tmpfile', 'oldest', 'backups2go']) {
      expect(COPY_MARKER.test(w), w).toBe(false);
    }
  });

  it('copyRuleAllow is reasoned, and no tracked file is flagged by the copy rule', () => {
    const raw = JSON.parse(readFileSync(join(process.cwd(), 'scripts/fixtures/real-data-manifest.json'), 'utf8'));
    for (const [path, reason] of Object.entries(raw.copyRuleAllow ?? {})) {
      expect(typeof reason === 'string' && (reason as string).length > 20, path).toBe(true);
    }
    const m = loadRealDataManifest();
    const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\0').filter(Boolean);
    expect(tracked.length).toBeGreaterThan(500);
    expect(tracked.filter((f) => isRealDataPath(f, m))).toEqual([]);
  });

  describe('content fingerprint (real amounts in a renamed copy or pasted into any file)', () => {
    // All amounts below are SYNTHETIC test values, never real figures.
    let root: string;
    const writeManifest = (r: string) => {
      mkdirSync(join(r, 'scripts', 'fixtures'), { recursive: true });
      writeFileSync(join(r, 'scripts', 'fixtures', 'real-data-manifest.json'), JSON.stringify({ files: ['data/a.json', 'notes/b.md'], dirs: ['data/specs/'] }));
    };
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'prepush-fp-'));
      writeManifest(root);
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('returns null (fail open) when no listed file exists: CI and synthetic checkouts', () => {
      expect(realAmountFingerprints(root)).toBeNull();
    });

    it('returns null when every present file is seeded or byte-identical to its synthetic stand-in', () => {
      mkdirSync(join(root, 'data'), { recursive: true });
      mkdirSync(join(root, 'fixtures', 'synthetic', 'data'), { recursive: true });
      writeFileSync(join(root, 'data', 'a.json'), '{"rent": 123456.78}');
      writeFileSync(join(root, 'fixtures', 'synthetic', 'data', 'a.json'), '{"rent": 123456.78}');
      expect(realAmountFingerprints(root)).toBeNull();
      writeFileSync(join(root, 'data', 'a.json'), '{"rent": 223456.78}');
      writeFileSync(join(root, 'data', '.synthetic-seeded.json'), JSON.stringify({ seeded: ['data/a.json'] }));
      expect(realAmountFingerprints(root)).toBeNull();
    });

    it('collects distinctive money amounts and skips quantities, round thousands and short numbers', () => {
      mkdirSync(join(root, 'data', 'specs'), { recursive: true });
      mkdirSync(join(root, 'notes'), { recursive: true });
      writeFileSync(join(root, 'data', 'a.json'), JSON.stringify({ rent: 123456.78, noi: 987654, sf: 345678, flat: 250000, small: 999, rows: [{ amt: 4567.89 }] }));
      writeFileSync(join(root, 'data', 'specs', 'x.json'), JSON.stringify({ cost: 765432.1 }));
      writeFileSync(join(root, 'notes', 'b.md'), 'Paid $54,321.09 and 123456 units');
      const fp = realAmountFingerprints(root)!;
      expect([...fp].sort()).toEqual(['123456.78', '4567.89', '54321.09', '765432.1', '987654'].sort());
    });

    it(`blocks a file whose added lines carry ${FINGERPRINT_BLOCK_MIN}+ distinct real amounts, in any number format`, () => {
      const fp = new Set(['123456.78', '987654', '4567.89', '765432.1']);
      const hits = scanAddedLinesForRealAmounts(
        [
          { file: 'src/renamed.ts', lineNo: 1, text: 'const a = 123,456.78; const b = $987,654;' },
          { file: 'src/renamed.ts', lineNo: 2, text: 'const c = 4567.89; const d = 4567.89;' },
          { file: 'src/other.ts', lineNo: 1, text: 'const z = 123456.78, y = 987654;' },
        ],
        fp,
      );
      expect(hits).toEqual([{ file: 'src/renamed.ts', count: 3 }]);
    });

    it('holds the committed synthetic fixtures to the higher coincidence threshold', () => {
      const fp = new Set(Array.from({ length: 60 }, (_, i) => String(100001.25 + i)));
      const lines = (file: string, n: number) => [{ file, lineNo: 1, text: [...fp].slice(0, n).join(' ') }];
      expect(scanAddedLinesForRealAmounts(lines('fixtures/synthetic/data/x.json', 10), fp)).toEqual([]);
      expect(scanAddedLinesForRealAmounts(lines('fixtures/synthetic/data/x.json', FINGERPRINT_BLOCK_MIN_SYNTHETIC), fp)).toHaveLength(1);
      expect(scanAddedLinesForRealAmounts(lines('src/x.json', 10), fp)).toHaveLength(1);
    });
  });

  it('neverTrack paths (no synthetic stand-in) are blocked like manifest paths', () => {
    const m = loadRealDataManifest();
    for (const p of ['data/property-financials/monthly-long.csv', 'public/snapshot.json', 'public/warehouse.json', 'data/overlay.json', 'data/warehouse/finance.sqlite', 'data/lease-market/raw.csv', 'PUBLIC/Snapshot.json']) {
      expect(isRealDataPath(p, m), p).toBe(true);
    }
    expect(isRealDataPath('public/index.html', m)).toBe(false);
  });

  it('matches exact files and directory prefixes, either slash style, but never fixtures/synthetic/', () => {
    expect(isRealDataPath('data/snapshots/portfolio.json', manifest)).toBe(true);
    expect(isRealDataPath('data\\calibration\\observations.json', manifest)).toBe(true);
    expect(isRealDataPath('./src/data/seed-deals.ts', manifest)).toBe(true);
    expect(isRealDataPath('fixtures/synthetic/data/snapshots/portfolio.json', manifest)).toBe(false);
    expect(isRealDataPath('fixtures/synthetic/data/calibration/observations.json', manifest)).toBe(false);
    // fail closed: a name that starts with a listed stem plus a separator is treated as a copy
    expect(isRealDataPath('src/data/seed-deals.test.ts', manifest)).toBe(true);
    expect(isRealDataPath('src/data/seed-dealership.ts', manifest)).toBe(false);
    expect(isRealDataPath('data/snapshots/other.json', manifest)).toBe(false);
    expect(isRealDataPath('docs/superpowers/specs/other.md', manifest)).toBe(false);
  });

  it('matches case variants (NTFS / core.ignorecase) and normalizes separators', () => {
    expect(isRealDataPath('data/snapshots/Portfolio.json', manifest)).toBe(true);
    expect(isRealDataPath('DATA/calibration/observations.json', manifest)).toBe(true);
    expect(isRealDataPath('.\\SRC\\data\\seed-deals.ts', manifest)).toBe(true);
    expect(parseRealDataPaths('A\tdata/snapshots/Portfolio.json\nA\tDATA/calibration/observations.json', manifest)).toHaveLength(2);
    expect(isRealDataPath('Fixtures/Synthetic/data/snapshots/portfolio.json', manifest)).toBe(false);
  });

  it('parses --name-status output: added/modified/renamed-to paths hit, deletions do not', () => {
    const text = [
      'A\tdata/snapshots/portfolio.json',
      'M\tdata/calibration/observations.json',
      'D\tsrc/data/seed-deals.ts',
      'R100\tsomewhere/else.ts\tsrc/data/seed-deals.ts',
      'A\tfixtures/synthetic/data/snapshots/portfolio.json',
      'M\tsrc/app.ts',
    ].join('\n');
    expect(parseRealDataPaths(text, manifest)).toEqual([
      'data/snapshots/portfolio.json',
      'data/calibration/observations.json',
      'src/data/seed-deals.ts',
    ]);
  });

  it('collectRefScan collects real-data hits only when given the manifest, and records their errors', () => {
    const sha = 'c'.repeat(40);
    const stdin = `refs/heads/x ${sha} refs/heads/x ${'0'.repeat(40)}\n`;
    const base = { peeledType: () => 'commit', destinationBound: () => [] as string[], diffFor: () => '', binaryPathsFor: () => [] as string[] };
    expect(collectRefScan(stdin, undefined, { ...base, realDataPathsFor: () => ['data/snapshots/portfolio.json'] }).realDataHits).toEqual([]);
    const hit = collectRefScan(stdin, undefined, { ...base, manifest, realDataPathsFor: () => ['data/snapshots/portfolio.json'] });
    expect(hit.realDataHits).toEqual(['data/snapshots/portfolio.json']);
    const err = collectRefScan(stdin, undefined, {
      ...base,
      manifest,
      realDataPathsFor: () => {
        throw new Error('fatal: bad object');
      },
    });
    expect(err.diffErrors).toEqual([{ localSha: sha, message: 'real-data paths: fatal: bad object' }]);
    expect(shouldBlockOnDiffError(err.diffErrors, {})).toBe(true);
  });

  describe('against a real git repo', () => {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
    const ZERO = '0000000000000000000000000000000000000000';
    const script = join(process.cwd(), 'scripts', 'prepush-confidential-scan.mjs');
    let repo: string;
    let home: string;

    let remote: string;

    beforeEach(() => {
      repo = mkdtempSync(join(tmpdir(), 'prepush-realdata-'));
      home = mkdtempSync(join(tmpdir(), 'prepush-realdata-home-'));
      remote = `${repo}-remote.git`;
      git(tmpdir(), 'init', '-q', '--bare', '-b', 'main', remote);
      git(repo, 'init', '-q', '-b', 'main');
      mkdirSync(join(repo, 'data', 'snapshots'), { recursive: true });
      writeFileSync(join(repo, 'data', 'snapshots', 'portfolio.json'), '{"leases":[]}\n');
      writeFileSync(join(repo, 'README.md'), 'base\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-qm', 'base with a tracked snapshot');
      // The destination already has the base commit (from before the untrack ruling).
      git(repo, 'remote', 'add', 'origin', remote);
      git(repo, 'push', '-q', '--no-verify', 'origin', 'main');
    });
    afterEach(() => {
      rmSync(repo, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    });
    const advertised = () => destinationBound('origin', remote, repo);

    const runHook = (stdin: string) => {
      const env: Record<string, string | undefined> = { ...process.env, HOME: withEmptyRoster(home), USERPROFILE: home };
      delete env['PREPUSH_ALLOW_DIFF_ERROR'];
      delete env['PREPUSH_ALLOW_NO_ROSTER'];
      return spawnSync(process.execPath, [script, 'origin', remote], { cwd: repo, input: stdin, encoding: 'utf8', env });
    };

    it('BLOCKS a push that modifies a manifest path', () => {
      git(repo, 'checkout', '-q', '-b', 'feat');
      writeFileSync(join(repo, 'data', 'snapshots', 'portfolio.json'), '{"leases":[1]}\n');
      git(repo, 'commit', '-qam', 'modify snapshot');
      const local = git(repo, 'rev-parse', 'HEAD');
      expect(realDataPathsFor(ZERO, local, loadRealDataManifest(), repo, advertised())).toEqual(['data/snapshots/portfolio.json']);
      const r = runHook(`refs/heads/feat ${local} refs/heads/feat ${ZERO}\n`);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('PUSH BLOCKED');
      expect(r.stderr).toContain('data/snapshots/portfolio.json');
      expect(r.stderr).toContain('real firm data');
    });

    it('BLOCKS a force-added manifest file in a new directory (data/building-specs/)', () => {
      git(repo, 'checkout', '-q', '-b', 'feat');
      mkdirSync(join(repo, 'data', 'building-specs'), { recursive: true });
      writeFileSync(join(repo, 'data', 'building-specs', 'reports.json'), '[]\n');
      git(repo, 'add', '-f', 'data/building-specs/reports.json');
      git(repo, 'commit', '-qm', 'force-add');
      const r = runHook(`refs/heads/feat ${git(repo, 'rev-parse', 'HEAD')} refs/heads/feat ${ZERO}\n`);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('data/building-specs/reports.json');
    });

    it('ALLOWS untracking a manifest path and adding its synthetic stand-in', () => {
      git(repo, 'checkout', '-q', '-b', 'feat');
      git(repo, 'rm', '-q', '--cached', 'data/snapshots/portfolio.json');
      mkdirSync(join(repo, 'fixtures', 'synthetic', 'data', 'snapshots'), { recursive: true });
      writeFileSync(join(repo, 'fixtures', 'synthetic', 'data', 'snapshots', 'portfolio.json'), '{"leases":[]}\n');
      git(repo, 'add', 'fixtures');
      git(repo, 'commit', '-qm', 'untrack + synthetic');
      const local = git(repo, 'rev-parse', 'HEAD');
      expect(realDataPathsFor(ZERO, local, loadRealDataManifest(), repo, advertised())).toEqual([]);
      const r = runHook(`refs/heads/feat ${local} refs/heads/feat ${ZERO}\n`);
      expect(r.status).toBe(0);
    });
  });
});
// Per-commit scanning (2026-11-12). The scan used to diff only the two ENDPOINT trees of a pushed
// range, so a payload added in one commit and removed in a later one was never seen even though the
// first commit's blob still reaches the remote. Every commit is scanned now, every git call that prints
// diff text is pinned against user config (colour, external diff, textconv, prefixes, attributes), and
// the range never trusts a local tracking ref (refute run wf_72500728-83e). Confidential TERMS are the
// Python scanner's job (tests/unit/prepush-hook-e2e.test.ts); these cases use the JS-owned payloads:
// a `confidential: true` record (the temp repo is not a registered confidential store), data/ binaries
// and real-data manifest paths.
describe('prepush-confidential-scan / per-commit payload scan and pinned git output', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
  const ZERO = '0000000000000000000000000000000000000000';
  const PAYLOAD = '{"id": "synthetic-deal", "confidential": true}\n';
  const script = join(process.cwd(), 'scripts', 'prepush-confidential-scan.mjs');
  let root: string;
  let repo: string;
  let remote: string;
  let home: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'prepush-percommit-'));
    repo = join(root, 'work');
    remote = join(root, 'remote.git');
    home = join(root, 'home');
    mkdirSync(home);
    git(root, 'init', '-q', '--bare', '-b', 'main', remote);
    git(root, 'init', '-q', '-b', 'main', repo);
    git(repo, 'remote', 'add', 'origin', remote);
    writeFileSync(join(repo, 'README.md'), 'base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
    git(repo, 'push', '-q', '--no-verify', 'origin', 'main');
    git(repo, 'fetch', '-q', 'origin');
    git(repo, 'checkout', '-q', '-b', 'feat');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const env = (extra: Record<string, string> = {}) => {
    const e: Record<string, string | undefined> = { ...process.env, HOME: withEmptyRoster(home), USERPROFILE: home };
    delete e['PREPUSH_ALLOW_DIFF_ERROR'];
    delete e['PREPUSH_ALLOW_NO_ROSTER'];
    return Object.assign(e, extra);
  };
  // The hook stage as git runs it: argv = remote name + push URL, stdin = the ref lines.
  const runHook = (stdin: string, extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [script, 'origin', remote], { cwd: repo, input: stdin, encoding: 'utf8', env: env(extra) });
  const commit = (file: string, content: string | Buffer | null, msg = 'change') => {
    const abs = join(repo, file);
    if (content === null) git(repo, 'rm', '-q', file);
    else {
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, content);
      git(repo, 'add', '-A');
    }
    git(repo, 'commit', '-qm', msg);
    return git(repo, 'rev-parse', 'HEAD');
  };
  const addThenRemove = () => {
    commit('notes.json', PAYLOAD, 'add');
    return commit('notes.json', '{}\n', 'remove');
  };

  it('BLOCKS a payload added in one commit and removed in a later one (new branch)', () => {
    const local = addThenRemove();
    const r = runHook(`refs/heads/feat ${local} refs/heads/feat ${ZERO}\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('confidential:true record(s) found');
    expect(r.stderr).toContain('notes.json');
  });

  it('BLOCKS the same add-then-remove on an update push (remoteSha..local)', () => {
    git(repo, 'push', '-q', '--no-verify', 'origin', 'feat');
    const remoteSha = git(repo, 'rev-parse', 'HEAD');
    const local = addThenRemove();
    const r = runHook(`refs/heads/feat ${local} refs/heads/feat ${remoteSha}\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('notes.json');
  });

  it('BLOCKS a binary under data/ added in one commit and removed in a later one', () => {
    commit('data/export.bin', Buffer.from([0, 1, 2, 3, 4]), 'add binary');
    const local = commit('data/export.bin', null, 'remove binary');
    expect(binaryPathsFor(ZERO, local, repo, [git(repo, 'rev-parse', 'main')])).toEqual(['data/export.bin']);
    const r = runHook(`refs/heads/feat ${local} refs/heads/feat ${ZERO}\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('data/export.bin');
  });

  it('BLOCKS a real-data manifest path added in one commit and removed in a later one', () => {
    commit('data/snapshots/portfolio.json', '{"leases":[]}\n', 'add snapshot');
    const local = commit('data/snapshots/portfolio.json', null, 'remove snapshot');
    expect(realDataPathsFor(ZERO, local, loadRealDataManifest(), repo, [git(repo, 'rev-parse', 'main')])).toEqual(['data/snapshots/portfolio.json']);
  });

  it('still BLOCKS with color.diff=always, color.ui=always and diff.noprefix=true in the repo config', () => {
    git(repo, 'config', 'color.diff', 'always');
    git(repo, 'config', 'color.ui', 'always');
    git(repo, 'config', 'diff.noprefix', 'true');
    const local = commit('notes.json', PAYLOAD);
    const r = runHook(`refs/heads/feat ${local} refs/heads/feat ${ZERO}\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('notes.json:1');
  });

  it('still BLOCKS with diff.external and a textconv driver that print nothing', () => {
    git(repo, 'config', 'diff.external', 'true');
    git(repo, 'config', 'diff.hide.textconv', 'true');
    writeFileSync(join(repo, '.gitattributes'), '*.json diff=hide\n');
    const local = commit('notes.json', PAYLOAD);
    const r = runHook(`refs/heads/feat ${local} refs/heads/feat ${ZERO}\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('confidential:true record(s) found');
  });

  it('still BLOCKS when a committed or local -diff attribute, or a NUL byte, makes git call the file binary', () => {
    writeFileSync(join(repo, '.gitattributes'), '* -diff\n');
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    writeFileSync(join(repo, '.git', 'info', 'attributes'), '*.json binary\n');
    const local = commit('notes.json', `\0${PAYLOAD}`);
    const r = runHook(`refs/heads/feat ${local} refs/heads/feat ${ZERO}\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('confidential:true record(s) found');
  });

  it('a textconv or text attribute cannot make a binary under data/ look like text', () => {
    git(repo, 'config', 'diff.astext.textconv', 'cat');
    writeFileSync(join(repo, '.gitattributes'), '*.bin diff=astext text\n');
    const local = commit('data/export.bin', Buffer.from([0, 1, 2, 3, 4]));
    expect(binaryPathsFor(ZERO, local, repo, [git(repo, 'rev-parse', 'main')])).toEqual(['data/export.bin']);
  });

  it('BLOCKS a data/ path git would C-quote (double quote, tab)', () => {
    // Plumbing, so the test runs on NTFS too: the path exists only in the index and the commit
    // (core.protectNTFS would otherwise refuse the '"' on Windows; a Linux clone takes it as is).
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: 'not really xlsx\n', encoding: 'utf8' }).trim();
    const weird = 'data/q/we"ird\tname.xlsx';
    git(repo, 'config', 'core.protectNTFS', 'false');
    git(repo, 'update-index', '--add', '--cacheinfo', `100644,${blob},${weird}`);
    git(repo, 'commit', '-qm', 'weird path');
    const local = git(repo, 'rev-parse', 'HEAD');
    expect(binaryPathsFor(ZERO, local, repo, [git(repo, 'rev-parse', 'main')])).toEqual([weird]);
  });

  it('BLOCKS content an evil merge introduces itself (combined diff)', () => {
    commit('side.txt', 'side\n');
    git(repo, 'checkout', '-q', 'main');
    commit('main.txt', 'main\n');
    git(repo, 'merge', '-q', '--no-ff', '--no-commit', 'feat');
    writeFileSync(join(repo, 'evil.json'), PAYLOAD);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'merge');
    const local = git(repo, 'rev-parse', 'HEAD');
    const r = runHook(`refs/heads/main ${local} refs/heads/main ${git(repo, 'rev-parse', 'origin/main')}\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('evil.json');
  });

  it('BLOCKS a binary under data/ that an evil merge introduces itself', () => {
    commit('side.txt', 'side\n');
    git(repo, 'checkout', '-q', 'main');
    commit('main.txt', 'main\n');
    git(repo, 'merge', '-q', '--no-ff', '--no-commit', 'feat');
    mkdirSync(join(repo, 'data'), { recursive: true });
    writeFileSync(join(repo, 'data', 'evil.bin'), Buffer.from([0, 9, 8, 7]));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'merge');
    expect(binaryPathsFor(git(repo, 'rev-parse', 'origin/main'), git(repo, 'rev-parse', 'HEAD'), repo)).toEqual(['data/evil.bin']);
  });

  it('the range never trusts origin/main: a payload the remote dropped (rewound) is scanned again', () => {
    // origin/main locally still points at a commit the remote no longer has.
    git(repo, 'checkout', '-q', 'main');
    commit('leak.json', PAYLOAD, 'leak');
    git(repo, 'push', '-q', '--no-verify', 'origin', 'main');
    git(repo, 'fetch', '-q', 'origin');
    git(remote, 'update-ref', 'refs/heads/main', git(repo, 'rev-parse', 'main~1'));
    git(repo, 'checkout', '-q', 'feat');
    git(repo, 'merge', '-q', '--no-ff', '-m', 'merge main', 'main');
    const local = git(repo, 'rev-parse', 'HEAD');
    const r = runHook(`refs/heads/feat ${local} refs/heads/feat ${ZERO}\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('leak.json');
  });

  it('the destination bound excludes what the remote advertises (no false block on its own history)', () => {
    // The remote already has a commit that tracked then untracked a manifest path.
    git(repo, 'checkout', '-q', 'main');
    commit('data/snapshots/portfolio.json', '{"leases":[]}\n', 'old tracked snapshot');
    commit('data/snapshots/portfolio.json', null, 'untrack');
    git(repo, 'push', '-q', '--no-verify', 'origin', 'main');
    git(repo, 'checkout', '-q', 'feat');
    commit('feature.txt', 'feature\n');
    git(repo, 'merge', '-q', '--no-ff', '-m', 'merge main', 'main');
    const local = git(repo, 'rev-parse', 'HEAD');
    const bound = destinationBound('origin', remote, repo);
    expect(bound).toContain(git(repo, 'rev-parse', 'main'));
    expect(realDataPathsFor(ZERO, local, loadRealDataManifest(), repo, bound)).toEqual([]);
    // Without a usable bound the FULL history is scanned (fail closed): the old snapshot commit shows.
    expect(realDataPathsFor(ZERO, local, loadRealDataManifest(), repo, [])).toEqual(['data/snapshots/portfolio.json']);
    expect(runHook(`refs/heads/feat ${local} refs/heads/feat ${ZERO}\n`).status).toBe(0);
  });

  it('destinationBound refuses a helper transport, an insteadOf-rewritten target and a custom receivepack', () => {
    expect(destinationBound('origin', 'ext::sh -c evil', repo)).toEqual([]);
    expect(destinationBound(undefined, undefined, repo)).toEqual([]);
    git(repo, 'config', 'remote.origin.receivepack', 'git-receive-pack');
    expect(destinationBound('origin', remote, repo)).toEqual([]);
    git(repo, 'config', '--unset', 'remote.origin.receivepack');
    git(repo, 'config', `url.${remote}.insteadOf`, 'alias:');
    expect(destinationBound('origin', 'alias:', repo)).toEqual([]);
  });

  it('git replace cannot show the scan a clean object while push sends the original', () => {
    const leak = commit('notes.json', PAYLOAD, 'leak');
    const cleanTree = git(repo, 'rev-parse', 'HEAD~1^{tree}');
    const clean = git(repo, 'commit-tree', cleanTree, '-p', git(repo, 'rev-parse', 'HEAD~1'), '-m', 'clean');
    git(repo, 'replace', leak, clean);
    const r = runHook(`refs/heads/feat ${leak} refs/heads/feat ${ZERO}\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('notes.json');
  });

  it('a pushed tag that peels to a blob or tree fails closed in the payload scan', () => {
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: PAYLOAD, encoding: 'utf8' }).trim();
    const r = runHook(`refs/tags/b ${blob} refs/tags/b ${ZERO}\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('peels to a blob');
  });

  it('a clean multi-commit push still exits 0', () => {
    commit('a.txt', 'one\n');
    const local = commit('a.txt', 'two\n');
    const r = runHook(`refs/heads/feat ${local} refs/heads/feat ${ZERO}\n`);
    expect(r.status).toBe(0);
  });

  it('an added line whose content starts with "++ " is scanned, not mistaken for a file header', () => {
    const local = commit('notes.json', `++ ${PAYLOAD}`);
    const r = runHook(`refs/heads/feat ${local} refs/heads/feat ${ZERO}\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('notes.json:1');
  });

  it('parseAddedLines reads combined (merge) hunks and commit-message blocks', () => {
    const diff = [
      `commit ${'c'.repeat(40)}`,
      '    subject line',
      '    ',
      '    body diff --git not a header',
      '',
      'diff --cc evil.txt',
      '--- a/evil.txt',
      '+++ b/evil.txt',
      '@@@ -1,1 -1,1 +1,3 @@@',
      '  shared',
      '++new in merge',
      ' +from second parent',
      '- removed vs first',
    ].join('\n');
    const msg = `${COMMIT_MESSAGE_FILE_PREFIX}${'c'.repeat(12)})`;
    expect(parseAddedLines(diff)).toEqual([
      { file: msg, lineNo: 1, text: 'subject line' },
      { file: msg, lineNo: 3, text: 'body diff --git not a header' },
      { file: 'evil.txt', lineNo: 2, text: 'new in merge' },
      { file: 'evil.txt', lineNo: 3, text: 'from second parent' },
    ]);
  });

  describe('pre-push stdin', () => {
    it('readPushStdin returns the text, treats EOF as empty, and reports any other read error', () => {
      expect(readPushStdin(() => 'refs/heads/x a refs/heads/x b\n')).toEqual({ text: 'refs/heads/x a refs/heads/x b\n', error: null });
      const eof = readPushStdin(() => {
        throw Object.assign(new Error('EOF: end of file'), { code: 'EOF' });
      });
      expect(eof).toEqual({ text: '', error: null });
      const bad = readPushStdin(() => {
        throw Object.assign(new Error('EBADF: bad file descriptor, read'), { code: 'EBADF' });
      });
      expect(bad.text).toBe('');
      expect(bad.error).toContain('EBADF');
    });

    // 2026-11-12 (wf_0df7879e-d79): unreadable refs mean the term scan cannot run, so there is no
    // environment opt-out any more (PREPUSH_ALLOW_DIFF_ERROR covers the payload scan only).
    it('BLOCKS when stdin cannot be read (fail closed), even with PREPUSH_ALLOW_DIFF_ERROR=1', () => {
      const wo = join(home, 'write-only.txt');
      writeFileSync(wo, '');
      const fd = openSync(wo, 'w');
      try {
        for (const extra of [{}, { PREPUSH_ALLOW_DIFF_ERROR: '1' }] as Record<string, string>[]) {
          const r = spawnSync(process.execPath, [script], { cwd: repo, stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8', env: env(extra) });
          expect(r.status).toBe(1);
          expect(r.stderr).toContain('PUSH BLOCKED');
          expect(r.stderr).toContain('confidential-term scan cannot run');
        }
      } finally {
        closeSync(fd);
      }
    });

    it('an empty stdin (up-to-date push) still exits 0', () => {
      expect(runHook('').status).toBe(0);
    });
  });

  describe('confidential-term scan run from the JS (wf_0df7879e-d79)', () => {
    const TERM = 'zqxv marsh parcel';
    const writeRoster = (roster: unknown) => {
      mkdirSync(join(home, '.claude', 'hooks'), { recursive: true });
      writeFileSync(join(home, '.claude', 'hooks', 'confidential-terms.json'), JSON.stringify(roster));
    };

    it('BLOCKS a pushed term with no wrapper at all (the scanner runs Python itself), never echoing it', () => {
      writeRoster({ probe: { active: true, always: [TERM] } });
      writeFileSync(join(repo, 'memo.md'), `note: ${TERM}\n`);
      git(repo, 'add', '-A');
      git(repo, 'commit', '-qm', 'memo');
      const local = git(repo, 'rev-parse', 'HEAD');
      const r = runHook(`refs/heads/feat ${local} refs/heads/feat ${ZERO}\n`);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('pre-push BLOCKED');
      expect(r.stderr).toContain('confidentiality term scan exited 1');
      expect(r.stderr).not.toContain(TERM);
    });

    it('BLOCKS with argv absent (a wrapper that predates "$@"): new refs are scanned in full', () => {
      writeRoster({ probe: { active: true, always: [TERM] } });
      writeFileSync(join(repo, 'memo.md'), `note: ${TERM}\n`);
      git(repo, 'add', '-A');
      git(repo, 'commit', '-qm', 'memo');
      const local = git(repo, 'rev-parse', 'HEAD');
      const r = spawnSync(process.execPath, [script], { cwd: repo, input: `refs/heads/feat ${local} refs/heads/feat ${ZERO}\n`, encoding: 'utf8', env: env() });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('confidentiality term scan exited 1');
    });

    it('BLOCKS when the roster is missing, even with PREPUSH_ALLOW_DIFF_ERROR=1', () => {
      const e = env({ PREPUSH_ALLOW_DIFF_ERROR: '1' }); // (env() writes the empty roster; remove it after)
      rmSync(join(home, '.claude'), { recursive: true, force: true });
      const r = spawnSync(process.execPath, [script, 'origin', remote], { cwd: repo, input: '', encoding: 'utf8', env: e });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('roster');
    });

    it('runTermScan fails closed on a missing scanner, no Python, a non-zero exit and a spawn error', () => {
      expect(runTermScan('', [], { scanner: join(home, 'absent.py') })).toMatchObject({ ok: false });
      const py = join(home, 'stub.py');
      writeFileSync(py, 'print(1)\n');
      expect(runTermScan('', [], { scanner: py, python: null })).toMatchObject({ ok: false, message: expect.stringContaining('no Python 3.8+') });
      const fake = (status: number | null, error?: Error) => () => ({ status, error, signal: status === null ? 'SIGKILL' : null }) as never;
      expect(runTermScan('', [], { scanner: py, python: 'python', run: fake(1) })).toMatchObject({ ok: false });
      expect(runTermScan('', [], { scanner: py, python: 'python', run: fake(null) })).toMatchObject({ ok: false });
      expect(runTermScan('', [], { scanner: py, python: 'python', run: fake(0, new Error('ENOENT')) })).toMatchObject({ ok: false });
      expect(runTermScan('', [], { scanner: py, python: 'python', run: fake(0) })).toEqual({ ok: true });
    });

    it('runTermScan runs Python isolated (-I) with git\'s argv and the ref lines on stdin', () => {
      const py = join(home, 'stub.py');
      writeFileSync(py, '');
      /** @type {unknown[]} */
      const calls: unknown[][] = [];
      const run = ((cmd: string, args: string[], opts: { input?: string }) => {
        calls.push([cmd, args, opts.input]);
        return { status: 0 };
      }) as never;
      expect(runTermScan('refs\n', ['origin', 'https://x.invalid/r.git'], { scanner: py, python: 'py', run })).toEqual({ ok: true });
      expect(calls).toEqual([['py', ['-I', py, 'origin', 'https://x.invalid/r.git'], 'refs\n']]);
      calls.length = 0;
      runTermScan('', [undefined, undefined], { scanner: py, python: 'py', run });
      expect(calls[0]?.[1]).toEqual(['-I', py]);
    });

    it('a remote named --staged does not switch the hook into --staged mode', () => {
      writeRoster({ probe: { active: true, always: [TERM] } });
      writeFileSync(join(repo, 'memo.md'), `note: ${TERM}\n`);
      git(repo, 'add', '-A');
      git(repo, 'commit', '-qm', 'memo');
      const local = git(repo, 'rev-parse', 'HEAD');
      const r = spawnSync(process.execPath, [script, '--staged', remote], {
        cwd: repo,
        input: `refs/heads/feat ${local} refs/heads/feat ${ZERO}\n`,
        encoding: 'utf8',
        env: env(),
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('confidentiality term scan exited 1');
    });

    it('BLOCKS a document watermark in an added line (wf_e0d7368f-0b3)', () => {
      expect(scanAddedLinesForWatermarks([{ file: 'a.md', lineNo: 3, text: `x ${WATERMARKS[0]?.toLowerCase()} y` }])).toEqual([{ file: 'a.md', line: 3 }]);
      expect(scanAddedLinesForWatermarks([{ file: 'a.md', lineNo: 1, text: 'confidential' }])).toEqual([]);
      writeFileSync(join(repo, 'memo.md'), `${WATERMARKS[0]}\n`);
      git(repo, 'add', '-A');
      git(repo, 'commit', '-qm', 'memo');
      const local = git(repo, 'rev-parse', 'HEAD');
      const r = runHook(`refs/heads/feat ${local} refs/heads/feat ${ZERO}\n`);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('memo.md:1');
    });

    it('findPython skips candidates that fail the probe (e.g. the Windows Store stub)', () => {
      const tried: string[] = [];
      const run = ((cmd: string) => {
        tried.push(cmd);
        return cmd === 'python3' ? { status: 0 } : { status: 9009 };
      }) as never;
      const byName = (n: string) => [n];
      expect(findPython(run, byName)).toBe('python3');
      expect(tried).toEqual(['python', 'python3']);
      expect(findPython((() => ({ status: 1 })) as never, byName)).toBeNull();
    });

    // wf_df157e64-c52 (medium): a bare 'python' let Windows run a python.exe from the worktree root.
    it('resolveOnPath returns absolute PATH hits only, never from relative entries or the excluded roots', () => {
      const ext = process.platform === 'win32' ? '.exe' : '';
      const good = join(home, 'bin');
      const inRepo = join(repo, 'tools');
      for (const d of [good, inRepo]) {
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, `python${ext}`), '');
      }
      writeFileSync(join(repo, `python${ext}`), '');
      const sep = process.platform === 'win32' ? ';' : ':';
      const path = ['', '.', 'relative/bin', repo, inRepo, good].join(sep);
      expect(resolveOnPath('python', { path, excludeRoots: [repo] })).toEqual([join(good, `python${ext}`)]);
      expect(resolveOnPath('python', { path: ['.', repo].join(sep), excludeRoots: [repo] })).toEqual([]);
    });
  });
});
