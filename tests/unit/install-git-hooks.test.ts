import { describe, it, expect, vi } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, mkdirSync, openSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { WRAPPER, COMMIT_MSG_WRAPPER, PY_SCAN_FALLBACK, writeFileAtomic, replaceOrWarn } from '../../scripts/install-git-hooks';
import { PY_SCANNER_SHA256, scannerDigest } from '../../scripts/prepush-confidential-scan.mjs';
import { renameSyncWithRetry } from '../../server/lib/rename-retry';
import type * as RenameRetry from '../../server/lib/rename-retry';

// Merge gate PR 577 round 4: writeFileAtomic's DEFAULT rename path (the one production uses) was never
// observed by a test; every check passed its own seam. The module is wrapped so a test can look at the
// destination at the moment the real default rename runs.
const renameProbe = vi.hoisted(() => ({ at: null as null | ((from: string, to: string) => void) }));
vi.mock('../../server/lib/rename-retry', async (importOriginal) => {
  const real = await importOriginal<typeof RenameRetry>();
  return {
    ...real,
    renameSyncWithRetry: (from: string, to: string) => {
      renameProbe.at?.(from, to);
      real.renameSyncWithRetry(from, to);
    },
  };
});

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
    expect(WRAPPER.trim().split('\n').slice(-2)).toEqual(['exit 0', '}']);
  });

  // Merge gate PR 577 R6-1: an older tree's installer rewrites the hook IN PLACE; a shell reading the
  // script as it goes hit end-of-file mid-hook and exited 0 unscanned. One brace group, opened right
  // after the shebang and closed on the last line, makes the shell parse the whole hook first.
  it('is one brace group from the line after the shebang to the last line', () => {
    const lines = WRAPPER.split('\n');
    expect(lines[0]).toBe('#!/bin/sh');
    expect(lines[1]).toBe('{');
    expect(WRAPPER.endsWith('\n}\n')).toBe(true);
    // No other column-0 lone brace closes the group early (function bodies close with "}" too, but
    // each opens with "name() {" on the same logical block; count opens vs closes).
    const opens = lines.filter((l) => /(^\{$)|(\(\) \{$)/.test(l)).length;
    const closes = lines.filter((l) => l === '}').length;
    expect(closes).toBe(opens);
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
    expect(WRAPPER.indexOf('refs="$("$node_bin"')).toBeLessThan(WRAPPER.indexOf('scan_dir="$("$node_bin"'));
  });

  // Both version skews over the shared .git/hooks (refute runs wf_0df7879e-d79, wf_e0d7368f-0b3): the
  // JS scanner runs the term scan itself, and the wrapper runs it for a tree whose JS predates that.
  // Merge gate PR 577 round 5 (K-501): the Python stage is UNCONDITIONAL. The grep that used to gate
  // it read the tree's JS once and node loaded it again, so a checkout in between ran an old,
  // term-blind JS with no Python stage. The grep now only picks the JS call shape, after Python ran.
  it('runs the Python term scan itself on every push, before the JS, isolated, fail closed', () => {
    expect(WRAPPER).not.toContain('if ! grep');
    expect(WRAPPER).toContain(`if grep -q 'runTermScan' "$scan_js" 2>/dev/null; then`);
    expect(WRAPPER.indexOf('"$py" -I "$scan_dir/scan.py"')).toBeLessThan(WRAPPER.indexOf("grep -q 'runTermScan'"));
    // Not nested in any if/case: the Python call and the one-liner sit at column 0.
    expect(WRAPPER).toMatch(/^printf '%s\\n' "\$refs" \| "\$py" -I "\$scan_dir\/scan\.py" "\$@" \|\| exit 1$/m);
    expect(WRAPPER).toMatch(/^scan_dir="\$\("\$node_bin" -e /m);
    expect(WRAPPER).toMatch(/printf '%s\\n' "\$refs" \| "\$py" -I "\$scan_dir\/scan\.py" "\$@" \|\| exit 1/);
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
    expect(WRAPPER).toMatch(/no Python term scanner copy sits beside the hook[^\n]*\n\s*exit 1/);
    // Merge gate PR 577 rounds 2 and 4: the copy must hash to the pin, and ONE node call reads it,
    // checks the hash and writes the verified bytes that Python then runs (never "$scan_py" itself).
    expect(WRAPPER).toContain(`"$scan_py" "${PY_SCANNER_SHA256}" 2>/dev/null)" || scan_rc=$?`);
    expect(WRAPPER).toContain('3) why="does not match its pinned SHA-256');
    expect(WRAPPER).toMatch(/echo "pre-push BLOCKED \(fail-closed\): the Python term scanner at \$scan_py \$why\." >&2\n\s*exit 1/);
    expect(WRAPPER).not.toMatch(/"\$py" -I "\$scan_py"/);
    expect(WRAPPER.indexOf('|| scan_rc=$?')).toBeLessThan(WRAPPER.indexOf('"$py" -I "$scan_dir/scan.py"'));
    // K-503: the one-liner reads the copy ONCE, and the bytes it hashed (b) are the bytes it writes.
    const oneLiner = WRAPPER.split('\n').find((l) => l.startsWith('scan_dir="$("$node_bin" -e ')) ?? '';
    expect(oneLiner.split('readFileSync').length).toBe(2);
    expect(oneLiner).toContain('fs.writeFileSync(path.join(d,"scan.py"),b,');
    expect(WRAPPER).toMatch(/no Python 3\.8\+ found[^\n]*\n\s*exit 1/);
    expect(WRAPPER.indexOf('"$py" -I "$scan_dir/scan.py"')).toBeLessThan(WRAPPER.indexOf('"$node_bin" "$scan_js"'));
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
    // The wrapper runs the Python copy beside the hook first on every push (merge gate PR 577 r5).
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
      expect(none.stderr).toContain('no Python term scanner copy sits beside the hook');
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

  // Merge gate PR 577 round 4: the wrapper hashed the copy, then Python reopened it by path, so an
  // install that swapped the copy in between ran an unchecked scanner. Python must run a private temp
  // copy of the verified bytes, and that copy must be gone after the hook.
  it('runs a private temp copy of the verified bytes, never the copy beside the hook, and removes it', () => {
    const PY_WHERE = 'import sys\nif __name__ == "__main__":\n    sys.stderr.write("RAN " + __file__ + "\\n")\n    sys.exit(0)\n';
    const hookPath = setupFixtureRepo();
    try {
      placeCopy(hookPath, PY_WHERE);
      writeFileSync(join(scriptsDir, 'prepush-confidential-scan.mjs'), 'process.exit(0);\n');
      const r = spawnSync('sh', [hookPath], { cwd: dir, input: '', encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      const ran = /RAN (.+)/.exec(r.stderr)?.[1]?.trim() ?? '';
      expect(ran).toMatch(/ora-prepush-scan-[^/\\]+[/\\]scan\.py$/);
      expect(ran.replace(/\\/g, '/')).not.toContain(PY_SCAN_FALLBACK);
      expect(existsSync(ran)).toBe(false);
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

  // Merge gate PR 577 round 5 (K-501): a tree whose JS names runTermScan used to skip the wrapper's
  // Python stage, and node loaded that JS again after the grep. A checkout of an older commit in
  // between ran a term-blind JS with no Python stage (3/30 real pushes leaked). The stub here is that
  // swapped-in JS: it names runTermScan (what the grep saw) yet scans nothing. The copy must still run.
  it('a tree whose JS names runTermScan still gets the wrapper\'s Python stage first, and blocks on it', () => {
    const hookPath = setupFixtureRepo();
    try {
      placeCopy(hookPath, PY_FAIL);
      writeFileSync(
        join(scriptsDir, 'prepush-confidential-scan.mjs'),
        `// runTermScan (term-blind stand-in)\n(await import('node:fs')).writeFileSync(${JSON.stringify(join(dir, 'js-ran'))}, 'x'); process.exit(0);\n`,
      );
      const r = spawnSync('sh', [hookPath, 'origin', 'https://example.invalid/r.git'], { cwd: dir, input: '', encoding: 'utf8' });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('stub term hit');
      expect(existsSync(join(dir, 'js-ran'))).toBe(false);
      placeCopy(hookPath, PY_PASS);
      const ok = spawnSync('sh', [hookPath, 'origin', 'https://example.invalid/r.git'], { cwd: dir, input: '', encoding: 'utf8' });
      expect(ok.status, ok.stderr).toBe(0);
      expect(existsSync(join(dir, 'js-ran'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // K-504: each failure of the copy step names its own cause (it used to say "pin mismatch ... run
  // hooks:install" for a missing temp directory too). All of them block.
  it('names why the copy could not be prepared: missing temp directory, unreadable copy', () => {
    const hookPath = setupFixtureRepo();
    try {
      writeFileSync(join(scriptsDir, 'prepush-confidential-scan.mjs'), 'process.exit(0);\n');
      const missingTmp = join(dir, 'no-such-tmp');
      const env = { ...process.env, TMPDIR: missingTmp, TEMP: missingTmp, TMP: missingTmp };
      const tmp = spawnSync('sh', [hookPath], { cwd: dir, input: '', encoding: 'utf8', env });
      expect(tmp.status).not.toBe(0);
      expect(tmp.stderr).toContain('could not be copied into a private temp directory');
      expect(tmp.stderr).not.toContain('pinned SHA-256');
      rmSync(join(dir, PY_SCAN_FALLBACK));
      mkdirSync(join(dir, PY_SCAN_FALLBACK)); // exists, but reading it throws EISDIR
      const unreadable = spawnSync('sh', [hookPath], { cwd: dir, input: '', encoding: 'utf8' });
      expect(unreadable.status).not.toBe(0);
      expect(unreadable.stderr).toContain('could not be read');
      expect(unreadable.stderr).not.toContain('pinned SHA-256');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // K-503: the one-liner must write the bytes it hashed, not re-read the copy. A preload swaps the copy
  // for a blocking scanner right after node's first read of it; the push must run the verified bytes.
  it('runs the bytes it hashed even when the copy is swapped right after the read', () => {
    const hookPath = setupFixtureRepo();
    const preDir = mkdtempSync(join(tmpdir(), 'install-git-hooks-preload-'));
    try {
      writeFileSync(join(scriptsDir, 'prepush-confidential-scan.mjs'), 'process.exit(0);\n');
      const pre = join(preDir, 'swap.cjs');
      writeFileSync(
        pre,
        `const fs = require('fs');\nconst orig = fs.readFileSync;\nfs.readFileSync = function (p, ...rest) {\n  const out = orig.call(fs, p, ...rest);\n  if (typeof p === 'string' && p.endsWith(${JSON.stringify(PY_SCAN_FALLBACK)})) fs.writeFileSync(p, ${JSON.stringify(PY_FAIL)});\n  return out;\n};\n`,
      );
      const env = { ...process.env, NODE_OPTIONS: `--require "${pre.replace(/\\/g, '/')}"` };
      const r = spawnSync('sh', [hookPath], { cwd: dir, input: '', encoding: 'utf8', env });
      expect(readFileSync(join(dir, PY_SCAN_FALLBACK), 'utf8')).toBe(PY_FAIL); // the swap happened
      expect(r.stderr).not.toContain('stub term hit');
      expect(r.status, r.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(preDir, { recursive: true, force: true });
    }
  });

  // R6-1: main's installer rewrites the hook IN PLACE (writeFileSync on the same file) when it
  // differs. Mid-push, the shell used to read past the new, shorter content, hit end-of-file and exit
  // 0 with nothing scanned (9 of 20 real pushes in the gate's race). A preload in the wrapper's node
  // one-liner does that rewrite while the shell is mid-hook; the scan must still run and block.
  it('still scans and blocks when the hook file is rewritten in place mid-push', () => {
    const hookPath = setupFixtureRepo();
    const preDir = mkdtempSync(join(tmpdir(), 'install-git-hooks-preload-'));
    try {
      placeCopy(hookPath, PY_FAIL);
      writeFileSync(join(scriptsDir, 'prepush-confidential-scan.mjs'), 'process.exit(0);\n');
      const shortHook = '#!/bin/sh\n# legacy\n';
      const pre = join(preDir, 'rewrite.cjs');
      writeFileSync(
        pre,
        // Every node call the hook makes is mid-hook (the first is the refs read); rewrite once.
        `const fs = require('fs');\nconst h = ${JSON.stringify(hookPath)};\nif (fs.readFileSync(h, 'utf8') !== ${JSON.stringify(shortHook)}) fs.writeFileSync(h, ${JSON.stringify(shortHook)});\n`,
      );
      const env = { ...process.env, NODE_OPTIONS: `--require "${pre.replace(/\\/g, '/')}"` };
      const r = spawnSync('sh', [hookPath], { cwd: dir, input: '', encoding: 'utf8', env });
      expect(readFileSync(hookPath, 'utf8')).toBe(shortHook); // the in-place rewrite happened mid-hook
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('stub term hit');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(preDir, { recursive: true, force: true });
    }
  });

  // L-601: with TEMP="." node's mkdtemp returned a RELATIVE name with no "/", the case guard missed
  // it, the EXIT trap was never set, the push blocked with "exit 0" as its reason and a scanner copy
  // was left in the worktree root on every push. The one-liner now prints an absolute path.
  it('a relative temp directory still runs the scan, and leaves nothing behind', () => {
    const hookPath = setupFixtureRepo();
    try {
      writeFileSync(join(scriptsDir, 'prepush-confidential-scan.mjs'), 'process.exit(0);\n');
      const env = { ...process.env, TMPDIR: '.', TEMP: '.', TMP: '.' };
      const ok = spawnSync('sh', [hookPath], { cwd: dir, input: '', encoding: 'utf8', env });
      expect(ok.status, ok.stderr).toBe(0);
      placeCopy(hookPath, PY_FAIL);
      const blocked = spawnSync('sh', [hookPath], { cwd: dir, input: '', encoding: 'utf8', env });
      expect(blocked.status).not.toBe(0);
      expect(blocked.stderr).toContain('stub term hit');
      expect(readdirSync(dir).filter((n) => n.startsWith('ora-prepush-scan-'))).toEqual([]);
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
      // Merge gate PR 577 round 3: nothing checked that the HOOK itself is replaced by rename (only the
      // writer was tested directly). A stale hook is rewritten by the real installer as a new file.
      writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\nexit 0\n');
      const staleId = statSync(join(hooks, 'pre-push'), { bigint: true }).ino;
      const again = spawnSync(process.execPath, [tsxCli, installer], { cwd: dir, encoding: 'utf8' });
      expect(again.status, again.stderr).toBe(0);
      expect(readFileSync(join(hooks, 'pre-push'), 'utf8')).toBe(WRAPPER);
      expect(statSync(join(hooks, 'pre-push'), { bigint: true }).ino).not.toBe(staleId);
      if (process.platform !== 'win32') expect(statSync(join(hooks, 'pre-push')).mode & 0o111).toBe(0o111);
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
      // Merge gate PR 577 round 3: a delete-then-rename (or delete-then-write) also changes the file id,
      // but leaves a moment with no hook at all, and git runs no hook then. At the moment of the rename,
      // dest must still be the previous complete file and the temp file the complete new one, already
      // with its mode where modes exist.
      let atRename: { dest: string; tmp: string; tmpExec: number } | null = null;
      const id2 = statSync(dest, { bigint: true }).ino;
      writeFileAtomic(dest, 'newer\n', 0o755, (from, to) => {
        atRename = { dest: readFileSync(to, 'utf8'), tmp: readFileSync(from, 'utf8'), tmpExec: statSync(from).mode & 0o111 };
        renameSyncWithRetry(from, to);
      });
      expect(atRename).not.toBeNull();
      expect(atRename!.dest).toBe('new\n');
      expect(atRename!.tmp).toBe('newer\n');
      if (process.platform !== 'win32') expect(atRename!.tmpExec).toBe(0o111);
      expect(readFileSync(dest, 'utf8')).toBe('newer\n');
      expect(statSync(dest, { bigint: true }).ino).not.toBe(id2);
      // Round 4: the same must hold on the DEFAULT rename path (no seam), the one the installer uses.
      let atDefault: string | null = null;
      renameProbe.at = (_from, to) => {
        atDefault = readFileSync(to, 'utf8');
      };
      try {
        writeFileAtomic(dest, 'newest\n', 0o755);
      } finally {
        renameProbe.at = null;
      }
      expect(atDefault).toBe('newer\n');
      expect(readFileSync(dest, 'utf8')).toBe('newest\n');
      // Round 4: a rename that fails leaves dest as it was and no temp file behind.
      expect(() =>
        writeFileAtomic(dest, 'lost\n', 0o755, () => {
          throw Object.assign(new Error('EPERM: in use'), { code: 'EPERM' });
        }),
      ).toThrow(/EPERM/);
      expect(readFileSync(dest, 'utf8')).toBe('newest\n');
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
      // Merge gate PR 577 round 3: the mode must reach the writer (dropping it renames the hook in
      // without its executable bit).
      const modes: (number | undefined)[] = [];
      expect(replaceOrWarn(dest, 'x\n', 0o755, (_d, _c, m) => void modes.push(m))).toBe(true);
      expect(modes).toEqual([0o755]);
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
    // The wrapper's own Python stage runs first on every push: a passing stub copy, pinned.
    writeFileSync(join(dir, PY_SCAN_FALLBACK), PY_PASS);
    writeFileSync(hookPath, wrapperPinnedTo(PY_PASS), { mode: 0o755 });
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
