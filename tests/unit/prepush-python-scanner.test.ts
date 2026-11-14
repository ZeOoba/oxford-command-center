import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PY_SCANNER_SHA256, scannerDigest } from '../../scripts/prepush-confidential-scan.mjs';
import { WRAPPER } from '../../scripts/install-git-hooks';

// scripts/prepush_confidential_scan.py is the shared, refute-hardened confidential-TERM scanner that
// the installed pre-push hook runs first (scripts/install-git-hooks.ts). It is VENDORED byte-identical
// from ora-skills (tools/prepush_confidential_scan.py), with its own end-to-end suite
// (scripts/test_prepush_confidential_scan.py) and the ora-skills shim that suite installs
// (scripts/hooks/pre-push, a test fixture here: OCC's real hook is the WRAPPER template).
//
// This file runs that suite inside `npm test`, so the CI gate job (and `npm run gate`) exercises the
// Python scanner with no workflow change. It FAILS, never skips, when no Python 3.8+ is found: the
// hook itself blocks every push without one.

const ROOT = process.cwd();

/** Same candidate order and isolated (-I) probe as the hook (a WindowsApps `python` stub fails it). */
function findPython(): string | null {
  for (const c of ['python', 'python3', 'py']) {
    const r = spawnSync(c, ['-I', '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'], { stdio: 'ignore' });
    if (r.status === 0) return c;
  }
  return null;
}

// Blob ids (`git hash-object`, LF-normalized) of the shared files as on ora-skills main 7b0ebcc
// (ZeOoba/ora-skills#257: duplicate roster keys fail closed; ora-pm main carries the same blobs via
// ZeOoba/ora-pm#102): tools/prepush_confidential_scan.py, tools/test_prepush_confidential_scan.py and
// tools/hooks/pre-push. Re-vendor all three together from ora-skills main and update these ids AND
// PY_SCANNER_SHA256 in the same commit; an edit made only here would fork the shared scanner.
const VENDORED = {
  'scripts/prepush_confidential_scan.py': 'e019a7882ad37961eba008d269ebf6302330eaee',
  'scripts/test_prepush_confidential_scan.py': '73063717f9a4235cda60b9def136abc73aac14ac',
  'scripts/hooks/pre-push': 'a18f2cd38a45000ea7f6f9fb016487a488310893',
} as const;

describe('vendored Python confidential-term scanner', () => {
  it('is byte-identical to the pinned ora-skills copy', () => {
    for (const [path, blob] of Object.entries(VENDORED)) {
      expect(execFileSync('git', ['hash-object', join(ROOT, path)], { cwd: ROOT, encoding: 'utf8' }).trim(), path).toBe(blob);
    }
  });

  // The hook runs only a scanner whose SHA-256 is PY_SCANNER_SHA256 (merge gate PR 577 round 2), so a
  // re-vendor must update that pin in the same commit as the blob id above.
  it('matches the SHA-256 pin the hook checks before running it', () => {
    expect(scannerDigest(readFileSync(join(ROOT, 'scripts', 'prepush_confidential_scan.py')))).toBe(PY_SCANNER_SHA256);
    expect(WRAPPER).toContain(`"${PY_SCANNER_SHA256}"`);
  });

  it(
    'passes its own end-to-end suite (real pushes against a synthetic roster)',
    () => {
      const py = findPython();
      expect(py, 'no Python 3.8+ on PATH: the pre-push hook blocks every push without one').not.toBeNull();
      const r = spawnSync(py as string, [join(ROOT, 'scripts', 'test_prepush_confidential_scan.py')], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        // No scripts/__pycache__ left in the (often shared) checkout.
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      });
      expect(r.status, `${r.stdout}\n${r.stderr}`.slice(-4000)).toBe(0);
      expect(r.stderr).toMatch(/\nOK/);
    },
    // Above the suite-wide 60 s budget on purpose (vitest.config.ts forbids only LOWER per-test
    // budgets): ~100 real pushes take about 6.5 min on the Windows laptop runner.
    20 * 60_000,
  );
});
