import { describe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { WRAPPER, COMMIT_MSG_WRAPPER } from '../../scripts/install-git-hooks';

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

describe('install-git-hooks WRAPPER — refute-trailer stage', () => {
  const REFUTE_SCRIPT = readFileSync(join(__dirname, '../../scripts/prepush-refute-check.mjs'), 'utf8');
  const SHA_A = 'a'.repeat(40);
  const SHA_B = 'b'.repeat(40);
  let dir: string;

  /** Fixture repo with the real refute stage, a stub scanner, and a fake tsx that logs its args. */
  function setup(opts: { tsxExit?: number; withTsx?: boolean; tsxMessage?: string; originMain?: boolean; shallow?: boolean } = {}) {
    dir = mkdtempSync(join(tmpdir(), 'prepush-refute-test-'));
    mkdirSync(join(dir, 'scripts'));
    execSync('git init -q', { cwd: dir });
    if (opts.originMain !== false) {
      // The stage skips (fails open) when origin/main does not resolve or the clone is shallow,
      // so the fixture needs a real origin/main commit.
      execSync('git -c user.name=t -c user.email=t@t commit -q --allow-empty -m base', { cwd: dir });
      execSync('git update-ref refs/remotes/origin/main HEAD', { cwd: dir });
      if (opts.shallow) {
        writeFileSync(join(dir, '.git', 'shallow'), `${execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim()}\n`);
      }
    }
    writeFileSync(join(dir, 'scripts', 'prepush-confidential-scan.mjs'), 'process.exit(0);\n');
    writeFileSync(join(dir, 'scripts', 'prepush-refute-check.mjs'), REFUTE_SCRIPT);
    writeFileSync(join(dir, 'scripts', 'check-refute-required.ts'), '// stub\n');
    if (opts.withTsx !== false) {
      mkdirSync(join(dir, 'node_modules', 'tsx', 'dist'), { recursive: true });
      writeFileSync(
        join(dir, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(join(dir, 'tsx-calls.log'))}, process.argv.slice(2).join(' ') + '\\n');
if (${opts.tsxExit ?? 0} === 1) console.error(${JSON.stringify(opts.tsxMessage ?? 'check:refute — 1 of 1 commit(s) changing financial-decision source are unattested:')});
process.exit(${opts.tsxExit ?? 0});
`,
      );
    }
    const hookPath = join(dir, 'pre-push');
    writeFileSync(hookPath, WRAPPER, { mode: 0o755 });
    return hookPath;
  }

  function run(hookPath: string, stdin: string): { status: number; out: string } {
    const r = spawnSync('sh', [hookPath], { cwd: dir, input: stdin, encoding: 'utf8' });
    return { status: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
  }
  const calls = () => (existsSync(join(dir, 'tsx-calls.log')) ? readFileSync(join(dir, 'tsx-calls.log'), 'utf8') : '');
  const cleanup = () => rmSync(dir, { recursive: true, force: true });

  it('template runs the refute stage and fails closed on it', () => {
    expect(WRAPPER).toMatch(/prepush-refute-check\.mjs" \|\| exit 1/);
  });

  it('blocks the push when the gate reports a violation, and names the pushed head', () => {
    const hook = setup({ tsxExit: 1 });
    try {
      const r = run(hook, `refs/heads/f ${SHA_A} refs/heads/f ${'0'.repeat(40)}\n`);
      expect(r.status).not.toBe(0);
      expect(r.out).toContain('PUSH BLOCKED');
      expect(calls()).toBe(`${join(dir, 'scripts', 'check-refute-required.ts')} --strict --base=origin/main --head=${SHA_A}\n`);
    } finally {
      cleanup();
    }
  });

  it('allows the push when the gate passes, one run per distinct pushed head', () => {
    const hook = setup({ tsxExit: 0 });
    try {
      const r = run(
        hook,
        `refs/heads/f ${SHA_A} refs/heads/f ${'0'.repeat(40)}\nrefs/heads/g ${SHA_B} refs/heads/g ${'0'.repeat(40)}\nrefs/heads/h ${SHA_A} refs/heads/h ${'0'.repeat(40)}\n`,
      );
      expect(r.status).toBe(0);
      expect(calls().trim().split('\n')).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  it('skips deletions and tags without running the gate', () => {
    const hook = setup({ tsxExit: 1 });
    try {
      const zero = '0'.repeat(40);
      const r = run(hook, `(delete) ${zero} refs/heads/old ${SHA_A}\nrefs/tags/v1 ${SHA_B} refs/tags/v1 ${zero}\n`);
      expect(r.status).toBe(0);
      expect(calls()).toBe('');
    } finally {
      cleanup();
    }
  });

  it('fails OPEN with a warning when tsx is not installed in the checkout', () => {
    const hook = setup({ withTsx: false });
    try {
      const r = run(hook, `refs/heads/f ${SHA_A} refs/heads/f ${'0'.repeat(40)}\n`);
      expect(r.status).toBe(0);
      expect(r.out).toContain('skipped');
    } finally {
      cleanup();
    }
  });

  it('fails OPEN when the checker exits 1 without the unattested verdict (a crash or a tsx error)', () => {
    const hook = setup({ tsxExit: 1, tsxMessage: 'SyntaxError: Unexpected token' });
    try {
      const r = run(hook, `refs/heads/f ${SHA_A} refs/heads/f ${'0'.repeat(40)}
`);
      expect(r.status).toBe(0);
      expect(r.out).toContain('without an unattested-commits verdict');
    } finally {
      cleanup();
    }
  });

  it('fails OPEN when the strict checker FAILED CLOSED on a git tooling gap', () => {
    const hook = setup({ tsxExit: 1, tsxMessage: "check:refute — FAILED CLOSED (--strict): check:refute — skipped: base 'origin/main' does not resolve." });
    try {
      expect(run(hook, `refs/heads/f ${SHA_A} refs/heads/f ${'0'.repeat(40)}
`).status).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('fails OPEN on any other non-zero status', () => {
    const hook = setup({ tsxExit: 2 });
    try {
      expect(run(hook, `refs/heads/f ${SHA_A} refs/heads/f ${'0'.repeat(40)}
`).status).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('skips without running the checker when origin/main does not resolve, even if it would block', () => {
    const hook = setup({ tsxExit: 1, originMain: false });
    try {
      const r = run(hook, `refs/heads/f ${SHA_A} refs/heads/f ${'0'.repeat(40)}
`);
      expect(r.status).toBe(0);
      expect(r.out).toContain("base 'origin/main' does not resolve");
      expect(calls()).toBe('');
    } finally {
      cleanup();
    }
  });

  it('skips without running the checker in a shallow clone, even if it would block', () => {
    const hook = setup({ tsxExit: 1, shallow: true });
    try {
      const r = run(hook, `refs/heads/f ${SHA_A} refs/heads/f ${'0'.repeat(40)}
`);
      expect(r.status).toBe(0);
      expect(r.out).toContain('shallow clone');
      expect(calls()).toBe('');
    } finally {
      cleanup();
    }
  });

  it('still blocks on the confidentiality scanner even when the refute gate passes', () => {
    const hook = setup({ tsxExit: 0 });
    try {
      writeFileSync(join(dir, 'scripts', 'prepush-confidential-scan.mjs'), 'process.exit(1);\n');
      expect(run(hook, `refs/heads/f ${SHA_A} refs/heads/f ${'0'.repeat(40)}\n`).status).not.toBe(0);
    } finally {
      cleanup();
    }
  });

  it('hands the scanner the full ref list on stdin (stdin is buffered once, not consumed)', () => {
    const hook = setup({ tsxExit: 0 });
    try {
      writeFileSync(
        join(dir, 'scripts', 'prepush-confidential-scan.mjs'),
        `import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(dir, 'scan-stdin.txt'))}, readFileSync(0, 'utf8'));
`,
      );
      const zero = '0'.repeat(40);
      const lines = [
        `refs/heads/f ${SHA_A} refs/heads/f ${zero}`,
        `refs/heads/g ${SHA_B} refs/heads/g ${zero}`,
        `refs/tags/t ${SHA_A} refs/tags/t ${zero}`,
      ];
      run(hook, `${lines.join('\n')}\n`);
      expect(readFileSync(join(dir, 'scan-stdin.txt'), 'utf8')).toBe(`${lines.join('\n')}\n`);
    } finally {
      cleanup();
    }
  });

  it('runs the confidentiality scanner before the refute stage', () => {
    const scan = WRAPPER.indexOf('prepush-confidential-scan.mjs" || exit 1');
    const refute = WRAPPER.indexOf('prepush-refute-check.mjs" || exit 1');
    expect(scan).toBeGreaterThan(-1);
    expect(scan).toBeLessThan(refute);
  });
});

// Regression coverage for the new commit-msg guard (commitmsg-trailer-guard.mjs): a malformed
// AI Co-Authored-By trailer should be caught at commit time, cheaper than at push time.
describe('install-git-hooks COMMIT_MSG_WRAPPER template — structural invariants', () => {
  it('invokes the commit-msg trailer guard, blocking on a non-zero exit', () => {
    expect(COMMIT_MSG_WRAPPER).toMatch(/prepush-noi-crosscheck|commitmsg-trailer-guard\.mjs" "\$1" \|\| exit 1/);
  });

  it('passes through the commit-msg file argument git provides', () => {
    expect(COMMIT_MSG_WRAPPER).toMatch(/commitmsg-trailer-guard\.mjs"\s+"\$1"/);
  });
});

describe('install-git-hooks COMMIT_MSG_WRAPPER template — live shell behavior', () => {
  let dir: string;
  let scriptsDir: string;

  function setupFixtureRepo() {
    dir = mkdtempSync(join(tmpdir(), 'install-git-hooks-commitmsg-test-'));
    scriptsDir = join(dir, 'scripts');
    mkdirSync(scriptsDir);
    execSync('git init -q', { cwd: dir });
    const hookPath = join(dir, 'commit-msg');
    writeFileSync(hookPath, COMMIT_MSG_WRAPPER, { mode: 0o755 });
    return hookPath;
  }

  function runHook(hookPath: string, msgFile: string): number {
    try {
      execSync(`sh "${hookPath}" "${msgFile}"`, { cwd: dir, stdio: 'pipe' });
      return 0;
    } catch (e) {
      return (e as { status?: number | null }).status ?? 1;
    }
  }

  it('blocks when the guard script exits non-zero', () => {
    const hookPath = setupFixtureRepo();
    const msgFile = join(dir, 'MSG');
    try {
      writeFileSync(msgFile, 'bad message');
      writeFileSync(join(scriptsDir, 'commitmsg-trailer-guard.mjs'), 'process.exit(1);\n');
      expect(runHook(hookPath, msgFile)).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes when the guard script exits zero', () => {
    const hookPath = setupFixtureRepo();
    const msgFile = join(dir, 'MSG');
    try {
      writeFileSync(msgFile, 'good message');
      writeFileSync(join(scriptsDir, 'commitmsg-trailer-guard.mjs'), 'process.exit(0);\n');
      expect(runHook(hookPath, msgFile)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
