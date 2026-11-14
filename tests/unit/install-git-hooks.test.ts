import { describe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, mkdirSync, openSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { WRAPPER, COMMIT_MSG_WRAPPER, PY_SCAN_FALLBACK, writeFileAtomic, replaceOrWarn } from '../../scripts/install-git-hooks';
import { PY_SCANNER_SHA256, scannerDigest } from '../../scripts/prepush-confidential-scan.mjs';

/** Stand-ins for the Python term scanner copy beside the hook (the wrapper runs it for a stub JS
 * scanner that lacks runTermScan, i.e. a tree that predates it). */
const PY_PASS = 'import sys\nif __name__ == "__main__":\n    sys.exit(0)\n';
const PY_FAIL = 'import sys\nif __name__ == "__main__":\n    sys.stderr.write("pre-push BLOCKED: stub term hit\\n")\n    sys.exit(1)\n';

/** WRAPPER with its scanner pin swapped for `py`'s digest, so a stub copy beside the hook can run.
 * Only the pin changes; every other line is the real template. */
function wrapperPinnedTo(py: string): string {
  expect(WRAPPER.split(PY_SCANNER_SHA256).length).toBe(2);
  return WRAPPER.replace(PY_SCANNER_SHA256, scannerDigest(Buffer.from(py, 'utf8')));
}

/** The real vendored scanner (as checked out), for tests that run the unmodified WRAPPER pin. */
const REAL_PY = readFileSync(join(__dirname, '../../scripts/prepush_confidential_scan.py'));

/** process.env minus `name` in EVERY casing: Windows env names are case-insensitive, and inside vitest
 * the key can be stored as NODEFAULTCURRENTDIRECTORYINEXEPATH, so a plain delete removed nothing and
 * the variable still reached the hook (merge gate PR 577 round 1). */
export function envWithout(name: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (k.toLowerCase() !== name.toLowerCase()) env[k] = v;
  return env;
}

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
    expect(WRAPPER).toContain('scan_js="$root/scripts/prepush-confidential-scan.mjs"');
    expect(WRAPPER).toMatch(/"\$node_bin" "\$scan_js" "\$@" \|\| exit 1/);
  });

  it('fails closed when buffering the pre-push stdin fails, before any stage runs', () => {
    // Read by node, never cat: cat's exit status on an unreadable stdin varies by implementation.
    expect(WRAPPER).not.toMatch(/\$\(cat\)/);
    expect(WRAPPER).toMatch(/^\{ :; \} 2>\/dev\/null 3<&0 \|\| stdin_fail$/m);
    expect(WRAPPER).toMatch(/^refs="\$\("\$node_bin" -e '[^\n]*'\)" \|\| stdin_fail$/m);
    expect(WRAPPER).toMatch(/stdin_fail\(\) \{\n\s*echo "pre-push: could not read push refs from stdin" >&2\n\s*exit 1\n\}/);
    expect(WRAPPER.indexOf('refs="$("$node_bin"')).toBeGreaterThan(WRAPPER.indexOf('node_bin="$(safe_exe node'));
    expect(WRAPPER.indexOf('refs="$("$node_bin"')).toBeLessThan(WRAPPER.indexOf("if ! grep -q 'runTermScan'"));
  });

  // Both version skews over the shared .git/hooks (refute runs wf_0df7879e-d79, wf_e0d7368f-0b3): the
  // JS scanner runs the term scan itself, and the wrapper runs it for a tree whose JS predates that.
  it('runs the Python term scan itself only for a tree whose scanner lacks runTermScan, isolated, fail closed', () => {
    expect(WRAPPER).toContain(`if ! grep -q 'runTermScan' "$scan_js" 2>/dev/null; then`);
    expect(WRAPPER).toMatch(/printf '%s\\n' "\$refs" \| "\$py" -I "\$scan_py" "\$@" \|\| exit 1/);
    expect(WRAPPER).toContain(`/${PY_SCAN_FALLBACK}"`);
    expect(WRAPPER).toContain('"$cand" -I -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)"');
    // wf_954ebd83-729: interpreters come from safe_exe (absolute PATH entries outside the worktree),
    // never from a bare-name lookup, and every child gets NoDefaultCurrentDirectoryInExePath.
    expect(WRAPPER).not.toMatch(/command -v/);
    expect(WRAPPER).toContain('safe_exe "$c" | while IFS= read -r cand; do');
    expect(WRAPPER).toContain('node_bin="$(safe_exe node | head -n 1)"');
    // wf_a50bf4bb-d1a: PATH is rebuilt with built-ins before ANY external command runs.
    expect(WRAPPER).toContain('if [ "$_p" -ef "$here" ]; then _in=1; break; fi');
    expect(WRAPPER).toContain('case "$_d" in /*) ;; *) continue ;; esac');
    const firstExternal = Math.min(...['root="$(git', 'refs="$("$node_bin"', 'safe_exe node | head'].map((t) => WRAPPER.indexOf(t)));
    expect(WRAPPER.indexOf('export PATH')).toBeGreaterThan(-1);
    expect(WRAPPER.indexOf('export PATH')).toBeLessThan(firstExternal);
    const code = WRAPPER.split('\n').filter((l) => !l.startsWith('#')).join('\n');
    expect(code).not.toMatch(/(^|[|;&]\s*)node /m);
    expect(WRAPPER.indexOf('export NoDefaultCurrentDirectoryInExePath')).toBeGreaterThan(-1);
    expect(WRAPPER.indexOf('export NoDefaultCurrentDirectoryInExePath')).toBeLessThan(WRAPPER.indexOf('root="$(git rev-parse'));
    expect(WRAPPER).toMatch(/no scanner copy sits beside the hook[^\n]*\n\s*exit 1/);
    // Merge gate PR 577 round 2: the copy must hash to the pin, checked before Python runs it.
    expect(WRAPPER).toContain(`if [ "$got" != "${PY_SCANNER_SHA256}" ]; then`);
    expect(WRAPPER).toMatch(/does not match its pinned SHA-256[^\n]*\n\s*exit 1/);
    expect(WRAPPER.indexOf('[ "$got" != ')).toBeLessThan(WRAPPER.indexOf('"$py" -I "$scan_py"'));
    expect(WRAPPER).toMatch(/no Python 3\.8\+ found[^\n]*\n\s*exit 1/);
    expect(WRAPPER.indexOf('"$py" -I "$scan_py"')).toBeLessThan(WRAPPER.indexOf('"$node_bin" "$scan_js"'));
    expect(WRAPPER).toMatch(/printf '%s\\n' "\$refs" \| "\$node_bin" "\$scan_js" "\$@" \|\| exit 1/);
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
    // The stub scanners below lack runTermScan, so the wrapper runs the Python copy beside it first.
    const hookPath = join(dir, 'pre-push');
    placeCopy(hookPath, PY_PASS);
    return hookPath;
  }

  /** Place `py` beside the hook and reinstall the hook pinned to it. */
  function placeCopy(hookPath: string, py: string) {
    writeFileSync(join(dir, PY_SCAN_FALLBACK), py);
    writeFileSync(hookPath, wrapperPinnedTo(py), { mode: 0o755 });
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

  // Residual gap 1 of the per-commit scan fix (2026-11-12): the wrapper buffers stdin before any
  // stage runs. When that read failed, the scanner received an empty ref list, scanned nothing and
  // allowed the push. The buffering step must fail closed itself. It used `refs="$(cat)"`, which
  // failed open on the ubuntu-26.04 CI runner (its cat returned 0 on a write-only stdin), so the
  // read is now node's; the stub-cat case reproduces that runner on any platform.
  function expectStdinBlock(mode: 'write-only' | 'cat-swallows-errors' | 'closed') {
    const hookPath = setupFixtureRepo();
    const wo = join(dir, 'write-only.txt');
    writeFileSync(wo, '');
    const fd = openSync(wo, 'w'); // reading a write-only fd fails (EBADF)
    const stubDir = mkdtempSync(join(tmpdir(), 'install-git-hooks-stubcat-'));
    try {
      // The scanner PASSES and leaves a marker: if it runs at all, the hook did not stop at stdin.
      writeFileSync(
        join(scriptsDir, 'prepush-confidential-scan.mjs'),
        `(await import('node:fs')).writeFileSync(${JSON.stringify(join(dir, 'scanner-ran'))}, 'x'); process.exit(0);\n`,
      );
      writeFileSync(join(scriptsDir, 'prepush-noi-crosscheck.mjs'), 'process.exit(0);\n');
      writeFileSync(join(stubDir, 'cat'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const env = mode === 'cat-swallows-errors' ? { ...process.env, PATH: `${stubDir}${delimiter}${process.env.PATH ?? ''}` } : process.env;
      const r =
        mode === 'closed'
          ? spawnSync('sh', ['-c', 'exec sh "$0" 0<&-', hookPath], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' })
          : spawnSync('sh', [hookPath], { cwd: dir, env, stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8' });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('could not read push refs from stdin');
      expect(existsSync(join(dir, 'scanner-ran'))).toBe(false);
    } finally {
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
      rmSync(stubDir, { recursive: true, force: true });
    }
  }

  it('hook exits non-zero, before running the scanner, when buffering stdin fails', () => {
    expectStdinBlock('write-only');
  });

  it('hook still blocks an unreadable stdin when the cat on PATH swallows read errors', () => {
    expectStdinBlock('cat-swallows-errors');
  });

  it('hook blocks a closed stdin (node would otherwise reopen fd 0 as /dev/null)', () => {
    expectStdinBlock('closed');
  });

  it('hook still exits 0 and runs the scanner on an empty stdin (up-to-date push)', () => {
    const hookPath = setupFixtureRepo();
    try {
      writeFileSync(
        join(scriptsDir, 'prepush-confidential-scan.mjs'),
        `(await import('node:fs')).writeFileSync(${JSON.stringify(join(dir, 'scanner-ran'))}, 'x'); process.exit(0);\n`,
      );
      writeFileSync(join(scriptsDir, 'prepush-noi-crosscheck.mjs'), 'process.exit(0);\n');
      const r = spawnSync('sh', [hookPath], { cwd: dir, input: '', encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(existsSync(join(dir, 'scanner-ran'))).toBe(true);
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

  it('hook passes git\'s argv and the ref lines to the confidentiality scanner', () => {
    const hookPath = setupFixtureRepo();
    try {
      const log = join(dir, 'js-args.json');
      writeFileSync(
        join(scriptsDir, 'prepush-confidential-scan.mjs'),
        `// runTermScan (a current tree)\nconst fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), stdin: fs.readFileSync(0, 'utf8') })); process.exit(0);\n`,
      );
      const refs = `refs/heads/x ${'a'.repeat(40)} refs/heads/x ${'0'.repeat(40)}`;
      const r = spawnSync('sh', [hookPath, 'origin', 'https://example.invalid/r.git'], { cwd: dir, input: `${refs}\n`, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      const got = JSON.parse(readFileSync(log, 'utf8')) as { argv: string[]; stdin: string };
      expect(got.argv).toEqual(['origin', 'https://example.invalid/r.git']);
      expect(got.stdin.trim()).toBe(refs);
      // An old tree (no runTermScan) gets the legacy call shape: refs on stdin, NO argv
      // (refute run wf_df157e64-c52: an old scanner reads any '--staged' argv as its manual mode).
      writeFileSync(
        join(scriptsDir, 'prepush-confidential-scan.mjs'),
        `const fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), stdin: fs.readFileSync(0, 'utf8') })); process.exit(0);\n`,
      );
      const old = spawnSync('sh', [hookPath, '--staged', 'https://example.invalid/r.git'], { cwd: dir, input: `${refs}\n`, encoding: 'utf8' });
      expect(old.status, old.stderr).toBe(0);
      const gotOld = JSON.parse(readFileSync(log, 'utf8')) as { argv: string[]; stdin: string };
      expect(gotOld.argv).toEqual([]);
      expect(gotOld.stdin.trim()).toBe(refs);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a tree that predates runTermScan: the wrapper runs the Python term scan first and blocks on it', () => {
    const hookPath = setupFixtureRepo();
    try {
      placeCopy(hookPath, PY_FAIL);
      writeFileSync(
        join(scriptsDir, 'prepush-confidential-scan.mjs'),
        `(await import('node:fs')).writeFileSync(${JSON.stringify(join(dir, 'js-ran'))}, 'x'); process.exit(0);\n`,
      );
      const r = spawnSync('sh', [hookPath], { cwd: dir, input: '', encoding: 'utf8' });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('stub term hit');
      expect(existsSync(join(dir, 'js-ran'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an old tree runs only the copy beside the hook, and BLOCKS when there is none', () => {
    const hookPath = setupFixtureRepo();
    try {
      writeFileSync(join(scriptsDir, 'prepush-confidential-scan.mjs'), 'process.exit(0);\n');
      // The tree's own scanner file is not used (it could be any version); only the pinned copy is.
      writeFileSync(join(scriptsDir, 'prepush_confidential_scan.py'), PY_FAIL);
      expect(spawnSync('sh', [hookPath], { cwd: dir, input: '', encoding: 'utf8' }).status).toBe(0);
      rmSync(join(dir, PY_SCAN_FALLBACK));
      const none = spawnSync('sh', [hookPath], { cwd: dir, input: '', encoding: 'utf8' });
      expect(none.status).not.toBe(0);
      expect(none.stderr).toContain('no scanner copy sits beside the hook');
      placeCopy(hookPath, PY_FAIL);
      const viaCopy = spawnSync('sh', [hookPath], { cwd: dir, input: '', encoding: 'utf8' });
      expect(viaCopy.status).not.toBe(0);
      expect(viaCopy.stderr).toContain('stub term hit');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Merge gate PR 577 rounds 1 and 2: an empty or cut-short copy (round 1: left mid-write by a
  // non-atomic install; round 2: cut inside its __main__ block) ran under Python, exited 0 and skipped
  // the term scan. The copy must now hash to the wrapper's pin; CRLF line endings still match.
  it('BLOCKS a copy beside the hook that does not hash to the pin (empty, cut short, appended to)', () => {
    const hookPath = setupFixtureRepo();
    try {
      writeFileSync(join(scriptsDir, 'prepush-confidential-scan.mjs'), 'process.exit(0);\n');
      const cutInMain = PY_PASS.slice(0, PY_PASS.indexOf('sys.exit(0)') + 'sys'.length);
      for (const broken of ['', 'import sys\n', PY_PASS.slice(0, PY_PASS.indexOf('if __name__')), cutInMain, `${PY_PASS}x = 1\n`]) {
        writeFileSync(join(dir, PY_SCAN_FALLBACK), broken);
        const r = spawnSync('sh', [hookPath], { cwd: dir, input: '', encoding: 'utf8' });
        expect(r.status, JSON.stringify(broken)).not.toBe(0);
        expect(r.stderr).toContain('does not match its pinned SHA-256');
      }
      writeFileSync(join(dir, PY_SCAN_FALLBACK), PY_PASS.replace(/\n/g, '\r\n'));
      const crlf = spawnSync('sh', [hookPath], { cwd: dir, input: '', encoding: 'utf8' });
      expect(crlf.status, crlf.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the unmodified WRAPPER accepts the real vendored scanner and BLOCKS it cut inside __main__', () => {
    const hookPath = setupFixtureRepo();
    try {
      writeFileSync(hookPath, WRAPPER, { mode: 0o755 });
      writeFileSync(join(scriptsDir, 'prepush-confidential-scan.mjs'), 'process.exit(0);\n');
      const text = REAL_PY.toString('utf8');
      const main = text.lastIndexOf('if __name__ == "__main__":');
      expect(main).toBeGreaterThan(0);
      writeFileSync(join(dir, PY_SCAN_FALLBACK), text.slice(0, text.indexOf('sys', main) + 'sys'.length));
      const cut = spawnSync('sh', [hookPath], { cwd: dir, input: '', encoding: 'utf8' });
      expect(cut.status).not.toBe(0);
      expect(cut.stderr).toContain('does not match its pinned SHA-256');
      writeFileSync(join(dir, PY_SCAN_FALLBACK), REAL_PY);
      const whole = spawnSync('sh', [hookPath], { cwd: dir, input: '', encoding: 'utf8' });
      expect(whole.stderr).not.toContain('does not match its pinned SHA-256');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exports NoDefaultCurrentDirectoryInExePath=1 to the scanner', () => {
    const hookPath = setupFixtureRepo();
    try {
      const log = join(dir, 'env.txt');
      writeFileSync(
        join(scriptsDir, 'prepush-confidential-scan.mjs'),
        `// runTermScan\n(await import('node:fs')).writeFileSync(${JSON.stringify(log)}, String(process.env.NoDefaultCurrentDirectoryInExePath)); process.exit(0);\n`,
      );
      const env = envWithout('NoDefaultCurrentDirectoryInExePath');
      const r = spawnSync('sh', [hookPath], { cwd: dir, input: '', encoding: 'utf8', env });
      expect(r.status, r.stderr).toBe(0);
      expect(readFileSync(log, 'utf8')).toBe('1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a tree whose scanner has runTermScan skips the wrapper\'s Python stage (the scanner runs it)', () => {
    const hookPath = setupFixtureRepo();
    try {
      writeFileSync(join(scriptsDir, 'prepush_confidential_scan.py'), PY_FAIL);
      writeFileSync(join(scriptsDir, 'prepush-confidential-scan.mjs'), '// runTermScan (stub)\nprocess.exit(0);\n');
      const r = spawnSync('sh', [hookPath], { cwd: dir, input: '', encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('install-git-hooks installer — runs only as a script, never on import', () => {
  const installer = join(process.cwd(), 'scripts', 'install-git-hooks.ts');
  const tsxCli = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');

  it('importing the module (as the tests do) installs nothing; running it installs the hooks and the Python copy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'install-git-hooks-import-'));
    try {
      execSync('git init -q', { cwd: dir });
      const hooks = join(dir, '.git', 'hooks');
      const imp = spawnSync(process.execPath, [tsxCli, '-e', `import(${JSON.stringify(pathToFileURL(installer).href)}).then(() => console.log('imported'))`], { cwd: dir, encoding: 'utf8' });
      expect(imp.status, imp.stderr).toBe(0);
      expect(existsSync(join(hooks, 'pre-push'))).toBe(false);
      mkdirSync(join(dir, 'scripts'));
      // A scanner that does not match the pin is never copied beside the hook.
      writeFileSync(join(dir, 'scripts', 'prepush_confidential_scan.py'), 'print("scanner")\r\n');
      const bad = spawnSync(process.execPath, [tsxCli, installer], { cwd: dir, encoding: 'utf8' });
      expect(bad.status, bad.stderr).toBe(0);
      expect(bad.stderr).toContain('does not match its pinned SHA-256');
      expect(readFileSync(join(hooks, 'pre-push'), 'utf8')).toBe(WRAPPER);
      expect(existsSync(join(hooks, PY_SCAN_FALLBACK))).toBe(false);
      // The real scanner (CRLF, as a Windows checkout has it) is copied with LF line endings.
      const lf = REAL_PY.toString('utf8').replace(/\r\n/g, '\n');
      writeFileSync(join(dir, 'scripts', 'prepush_confidential_scan.py'), lf.replace(/\n/g, '\r\n'));
      const run = spawnSync(process.execPath, [tsxCli, installer], { cwd: dir, encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
      expect(readFileSync(join(hooks, PY_SCAN_FALLBACK), 'utf8')).toBe(lf);
      expect(scannerDigest(readFileSync(join(hooks, PY_SCAN_FALLBACK)))).toBe(PY_SCANNER_SHA256);
      expect(readdirSync(hooks).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Merge gate PR 577 round 1 (HIGH): writeFileSync truncates before it writes, so a push from another
  // worktree could run an EMPTY scanner copy. Every hooks-dir write now goes temp file + rename.
  it('writes the hook and the Python copy atomically (temp file + rename), leaving no temp file', () => {
    const src = readFileSync(installer, 'utf8');
    const body = src.slice(src.indexOf('function installHook'), src.indexOf('function main'));
    expect(body).not.toMatch(/writeFileSync\(/);
    expect(body.match(/replaceOrWarn\(/g)?.length).toBe(2);
    const dir = mkdtempSync(join(tmpdir(), 'install-git-hooks-atomic-'));
    try {
      const dest = join(dir, 'f.py');
      writeFileSync(dest, 'old\n');
      // Merge gate PR 577 round 2: the content check alone passed an in-place write. A rename puts a
      // NEW file at dest, so its file id changes; an in-place rewrite keeps it.
      const before = statSync(dest, { bigint: true }).ino;
      expect(before).not.toBe(0n);
      writeFileAtomic(dest, 'new\n');
      expect(readFileSync(dest, 'utf8')).toBe('new\n');
      expect(statSync(dest, { bigint: true }).ino).not.toBe(before);
      writeFileAtomic(join(dir, 'g.py'), 'fresh\n');
      expect(readdirSync(dir).sort()).toEqual(['f.py', 'g.py']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Merge gate PR 577 round 2: chmod after the rename left a window where the new hook was in place
  // without its executable bit, and git on Linux/macOS skips a non-executable hook.
  it('sets the hook\'s mode on the temp file, before the rename', () => {
    const src = readFileSync(installer, 'utf8');
    const fn = src.slice(src.indexOf('export function writeFileAtomic'), src.indexOf('const IN_USE'));
    // Guarded by `mode` alone (a stray extra condition would skip it); the behavioural check below
    // runs where file modes exist (the Linux CI runner).
    expect(fn).toMatch(/if \(mode !== undefined\) \{\s*try \{\s*chmodSync\(tmp, mode\);/);
    expect(fn.indexOf('chmodSync(tmp, mode)')).toBeLessThan(fn.indexOf('renameSyncWithRetry(tmp, dest)'));
    expect(src).toContain("replaceOrWarn(hookPath, contents, 0o755)");
    if (process.platform !== 'win32') {
      const dir = mkdtempSync(join(tmpdir(), 'install-git-hooks-mode-'));
      try {
        writeFileAtomic(join(dir, 'h'), '#!/bin/sh\n', 0o755);
        expect(statSync(join(dir, 'h')).mode & 0o111).toBe(0o111);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // Merge gate PR 577 round 2: a push holding the hook open made npm ci / prepare fail with EPERM.
  it('leaves an in-use EXISTING file in place with a warning, but never skips a missing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'install-git-hooks-inuse-'));
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (m: string) => warnings.push(m);
    try {
      const busy = (code: string) => () => {
        throw Object.assign(new Error(`${code}: in use`), { code });
      };
      const dest = join(dir, 'pre-push');
      writeFileSync(dest, 'old\n');
      for (const code of ['EPERM', 'EBUSY', 'EACCES']) expect(replaceOrWarn(dest, 'new\n', 0o755, busy(code))).toBe(false);
      expect(readFileSync(dest, 'utf8')).toBe('old\n');
      expect(warnings.join('\n')).toContain('Rerun npm run hooks:install');
      expect(() => replaceOrWarn(join(dir, 'absent'), 'new\n', 0o755, busy('EPERM'))).toThrow(/EPERM/);
      expect(() => replaceOrWarn(dest, 'new\n', 0o755, busy('ENOSPC'))).toThrow(/ENOSPC/);
      expect(replaceOrWarn(dest, 'new\n')).toBe(true);
      expect(readFileSync(dest, 'utf8')).toBe('new\n');
    } finally {
      console.warn = warn;
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
    // A current-tree stub (it names runTermScan), so the wrapper hands the push straight to it.
    writeFileSync(join(dir, 'scripts', 'prepush-confidential-scan.mjs'), '// runTermScan (stub)\nprocess.exit(0);\n');
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
        `// runTermScan (stub)
import { readFileSync, writeFileSync } from 'node:fs';
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
    const scan = WRAPPER.indexOf('"$node_bin" "$scan_js" "$@" || exit 1');
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
