import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';

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

/** Same candidate order and probe as the hook (a WindowsApps `python` stub fails the probe). */
function findPython(): string | null {
  for (const c of ['python', 'python3', 'py']) {
    const r = spawnSync(c, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'], { stdio: 'ignore' });
    if (r.status === 0) return c;
  }
  return null;
}

// Blob ids (`git hash-object`, LF-normalized) of the shared files in ora-skills (branch
// fix/prepush-context-and-urlencode, commit cc51f230; also ZeOoba/ora-pm 8a951c4):
// tools/prepush_confidential_scan.py, tools/test_prepush_confidential_scan.py and tools/hooks/pre-push. Re-vendor all three together and
// update these ids in the same commit; an edit made only here would fork the shared scanner.
const VENDORED = {
  'scripts/prepush_confidential_scan.py': '71e19a76a6f1102f9b62bc2de490c4d5fb17037b',
  'scripts/test_prepush_confidential_scan.py': 'e7e0ddb230f8a23e278efe1ebf1c63dacbc56034',
  'scripts/hooks/pre-push': 'a18f2cd38a45000ea7f6f9fb016487a488310893',
} as const;

describe('vendored Python confidential-term scanner', () => {
  it('is byte-identical to the pinned ora-skills copy', () => {
    for (const [path, blob] of Object.entries(VENDORED)) {
      expect(execFileSync('git', ['hash-object', join(ROOT, path)], { cwd: ROOT, encoding: 'utf8' }).trim(), path).toBe(blob);
    }
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
      });
      expect(r.status, `${r.stdout}\n${r.stderr}`.slice(-4000)).toBe(0);
      expect(r.stderr).toMatch(/\nOK/);
    },
    // Above the suite-wide 60 s budget on purpose (vitest.config.ts forbids only LOWER per-test
    // budgets): ~100 real pushes take about 6.5 min on the Windows laptop runner.
    20 * 60_000,
  );
});
