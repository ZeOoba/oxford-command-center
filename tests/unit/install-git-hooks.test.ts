import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { WRAPPER } from '../../scripts/install-git-hooks.mjs';

// Regression coverage for the bug an adversarial review caught before this landed (2026-08-16):
// the pre-push wrapper originally `exec`d the advisory-only NOI cross-check script as its last
// statement, so a missing/broken NOI script silently determined the whole hook's exit code and
// blocked every push — defeating the entire "never blocks" design of OI-137/OI-162 fix #1.

describe('install-git-hooks WRAPPER template — structural invariants', () => {
  it('does not exec the advisory NOI stage as the last statement', () => {
    // The NOI invocation must never be the process the shell ultimately exits as.
    expect(WRAPPER).not.toMatch(/exec node ".*prepush-noi-crosscheck\.mjs"/);
  });

  it('guards the NOI stage with a file-existence check and `|| true`', () => {
    expect(WRAPPER).toMatch(/if \[ -f "\$root\/scripts\/prepush-noi-crosscheck\.mjs" \]; then/);
    expect(WRAPPER).toMatch(/prepush-noi-crosscheck\.mjs" \|\| true/);
  });

  it('ends on an unconditional exit 0, not the NOI stage\'s own exit code', () => {
    expect(WRAPPER.trim().split('\n').pop()?.trim()).toBe('exit 0');
  });

  it('still fails closed on the confidentiality scanner', () => {
    expect(WRAPPER).toMatch(/prepush-confidential-scan\.mjs" \|\| exit 1/);
  });
});

describe('install-git-hooks WRAPPER template — live shell behavior', () => {
  let dir: string;
  let scriptsDir: string;

  function setupFixtureRepo() {
    dir = mkdtempSync(join(tmpdir(), 'install-git-hooks-test-'));
    scriptsDir = join(dir, 'scripts'); // WRAPPER expects $root/scripts/*.mjs
    mkdirSync(scriptsDir);
    // WRAPPER resolves $root via `git rev-parse --show-toplevel`, so the fixture must itself
    // be a git repo for that to resolve to `dir` rather than erroring out.
    execSync('git init -q', { cwd: dir });
    const hookPath = join(dir, 'pre-push');
    writeFileSync(hookPath, WRAPPER, { mode: 0o755 });
    return hookPath;
  }

  function runHook(hookPath: string): number {
    try {
      execSync(`sh "${hookPath}"`, { cwd: dir, stdio: 'pipe' });
      return 0;
    } catch (e) {
      // execSync throws an Error carrying the child's exit code on `status` (null when the child
      // was killed by a signal). Narrowed rather than `any` to satisfy no-explicit-any; the `?? 1`
      // keeps the original behaviour for both the null and absent cases.
      return (e as { status?: number | null }).status ?? 1;
    }
  }

  it('hook exits 0 even when the NOI script is entirely missing (the regressed bug)', () => {
    const hookPath = setupFixtureRepo();
    try {
      writeFileSync(join(scriptsDir, 'prepush-confidential-scan.mjs'), 'process.exit(0);\n'); // scanner PASSES
      // Deliberately do NOT write prepush-noi-crosscheck.mjs — simulates an older worktree
      // checkout, or the file having been deleted/renamed.
      expect(runHook(hookPath)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hook exits 0 even when the NOI script throws before printing anything', () => {
    const hookPath = setupFixtureRepo();
    try {
      writeFileSync(join(scriptsDir, 'prepush-confidential-scan.mjs'), 'process.exit(0);\n');
      writeFileSync(
        join(scriptsDir, 'prepush-noi-crosscheck.mjs'),
        'throw new Error("simulated crash before any output");\n'
      );
      expect(runHook(hookPath)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hook exits 0 when the NOI script reports a real (expected, e.g. OI-137) failure', () => {
    const hookPath = setupFixtureRepo();
    try {
      writeFileSync(join(scriptsDir, 'prepush-confidential-scan.mjs'), 'process.exit(0);\n');
      writeFileSync(join(scriptsDir, 'prepush-noi-crosscheck.mjs'), 'console.warn("simulated drift WARN"); process.exit(1);\n');
      expect(runHook(hookPath)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hook still exits non-zero when the confidentiality scanner fails', () => {
    const hookPath = setupFixtureRepo();
    try {
      writeFileSync(join(scriptsDir, 'prepush-confidential-scan.mjs'), 'process.exit(1);\n'); // scanner FAILS
      writeFileSync(join(scriptsDir, 'prepush-noi-crosscheck.mjs'), 'process.exit(0);\n');
      expect(runHook(hookPath)).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
