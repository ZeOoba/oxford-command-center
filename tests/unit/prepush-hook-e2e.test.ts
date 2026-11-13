import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

import { WRAPPER, PY_SCAN_FALLBACK } from '../../scripts/install-git-hooks';

// End-to-end: the INSTALLED pre-push hook (WRAPPER -> the JS scanner, which runs the vendored Python
// term scanner and then the OCC payload checks) run by a real `git push` into a bare remote. One case per leak shape the refute
// run wf_72500728-83e reproduced against the JS-only gate; each must BLOCK, and a clean push must go
// through. The roster term is SYNTHETIC (never a real deal name, person or address).
//
// PREPUSH_E2E_SRC=<dir> runs the same cases against another tree's hook template and scanners (for
// example a `git archive` of the previous commit), which is how these cases were shown to fail before
// the fix. Unset, the cases run against this checkout.

const TERM = 'Quorvane Blissetter Parcel';

/**
 * The pre-push wrapper origin/main installed before 2026-11-12, verbatim: no Python stage, no "$@",
 * no stdin-read check. .git/hooks is shared by every worktree, and an older worktree's installer
 * rewrites it with this on any `npm install` / `npm test`, so the new scanners must still block
 * through it (refute run wf_0df7879e-d79, high).
 */
const LEGACY_WRAPPER = `#!/bin/sh
root="$(git rev-parse --show-toplevel)"
refs="$(cat)"
printf '%s\\n' "$refs" | node "$root/scripts/prepush-confidential-scan.mjs" || exit 1
if [ -f "$root/scripts/prepush-refute-check.mjs" ]; then
  printf '%s\\n' "$refs" | node "$root/scripts/prepush-refute-check.mjs" || exit 1
fi
if [ -f "$root/scripts/prepush-noi-crosscheck.mjs" ]; then
  node "$root/scripts/prepush-noi-crosscheck.mjs" || true
fi
exit 0
`;
const SRC = process.env['PREPUSH_E2E_SRC'] ?? process.cwd();

/** The pre-push template of the tree under test (the imported WRAPPER for this checkout). */
function wrapperOf(src: string): string {
  if (src === process.cwd()) return WRAPPER;
  // Read the template literal out of the other tree's source instead of importing it: importing an
  // older install-git-hooks.ts would run its installer against the shared hooks directory.
  const text = readFileSync(join(src, 'scripts', 'install-git-hooks.ts'), 'utf8');
  const start = text.indexOf('export const WRAPPER = `') + 'export const WRAPPER = `'.length;
  return text.slice(start, text.indexOf('`;', start)).replace(/\\\\/g, '\\');
}

class Sandbox {
  root = mkdtempSync(join(tmpdir(), 'occ-prepush-e2e-'));
  home = join(this.root, 'home');
  remote = join(this.root, 'remote.git');
  work = join(this.root, 'work');
  env: Record<string, string | undefined>;

  /**
   * @param opts.wrapper - pre-push template to install (default: the tree under test's WRAPPER).
   * @param opts.oldTree - the pushing tree predates runTermScan: its JS scanner is a term-blind stub
   *   (exit 0) and it has no Python scanner, so only the wrapper's own Python stage can catch a term.
   * @param opts.copyBesideHook - place the Python scanner beside the hook, as the installer does.
   * @param opts.oldJs - the old tree's JS scanner source (default: a term-blind `process.exit(0)` stub).
   */
  constructor(opts: { wrapper?: string; oldTree?: boolean; copyBesideHook?: boolean; oldJs?: string } = {}) {
    const { wrapper, oldTree = false, copyBesideHook = false, oldJs = 'process.exit(0);\n' } = opts;
    mkdirSync(join(this.home, '.claude', 'hooks'), { recursive: true });
    writeFileSync(
      join(this.home, '.claude', 'hooks', 'confidential-terms.json'),
      JSON.stringify({ _meta: { purpose: 'test' }, synthetic_deal: { label: 'synthetic', active: true, always: [TERM] } }),
    );
    const gcfg = join(this.root, 'gitconfig');
    writeFileSync(gcfg, '');
    this.env = {
      ...process.env,
      HOME: this.home,
      USERPROFILE: this.home,
      GIT_CONFIG_GLOBAL: gcfg,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
      GIT_TERMINAL_PROMPT: '0',
    };
    for (const k of ['PREPUSH_ALLOW_DIFF_ERROR', 'PREPUSH_ALLOW_NO_ROSTER', 'ORA_PREPUSH_REQUIRE_REFS', 'GIT_DIR', 'GIT_WORK_TREE']) delete this.env[k];
    this.git(this.root, 'init', '-q', '--bare', '-b', 'main', this.remote);
    this.git(this.root, 'init', '-q', '-b', 'main', this.work);
    this.git(this.work, 'remote', 'add', 'origin', this.remote);
    // The scanners the hook runs from "$root/scripts", copied in untracked (and excluded from add -A).
    mkdirSync(join(this.work, 'scripts', 'fixtures'), { recursive: true });
    for (const f of ['prepush-confidential-scan.mjs', 'prepush_confidential_scan.py', 'fixtures/real-data-manifest.json']) {
      if (oldTree && f !== 'fixtures/real-data-manifest.json') continue;
      if (existsSync(join(SRC, 'scripts', f))) copyFileSync(join(SRC, 'scripts', f), join(this.work, 'scripts', f));
    }
    if (oldTree) writeFileSync(join(this.work, 'scripts', 'prepush-confidential-scan.mjs'), oldJs);
    writeFileSync(join(this.work, '.git', 'info', 'exclude'), 'scripts/\n');
    this.commit('README.md', 'seed\n', 'seed');
    this.git(this.work, 'push', '-q', '--no-verify', 'origin', 'main');
    this.git(this.work, 'fetch', '-q', 'origin');
    const hooks = join(this.root, 'hooks');
    mkdirSync(hooks);
    writeFileSync(join(hooks, 'pre-push'), wrapper ?? wrapperOf(SRC), { mode: 0o755 });
    if (copyBesideHook) copyFileSync(join(SRC, 'scripts', 'prepush_confidential_scan.py'), join(hooks, PY_SCAN_FALLBACK));
    this.git(this.work, 'config', 'core.hooksPath', hooks);
  }

  git(cwd: string, ...args: string[]): string {
    const p = spawnSync('git', args, { cwd, env: this.env, encoding: 'utf8' });
    if (p.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${p.stderr}`);
    return p.stdout.trim();
  }

  commit(name: string, content: string | Buffer, msg = 'change'): string {
    const abs = join(this.work, name);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
    this.git(this.work, 'add', '-A');
    this.git(this.work, 'commit', '-q', '--no-verify', '-m', msg);
    return this.git(this.work, 'rev-parse', 'HEAD');
  }

  hashObject(data: string | Buffer): string {
    const p = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: this.work, env: this.env, input: data, encoding: 'utf8' });
    if (p.status !== 0) throw new Error(p.stderr);
    return p.stdout.trim();
  }

  push(remote: string, ...refspec: string[]): { status: number | null; stderr: string } {
    const p = spawnSync('git', ['push', remote, ...refspec], { cwd: this.work, env: this.env, encoding: 'utf8' });
    return { status: p.status, stderr: p.stderr };
  }

  remoteHas(sha: string, remotePath = this.remote): boolean {
    return spawnSync('git', ['--git-dir', remotePath, 'cat-file', '-e', `${sha}^{commit}`], { env: this.env }).status === 0;
  }

  close(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

describe('installed pre-push hook end to end (Python term scan + JS payload scan)', () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = new Sandbox();
  });
  afterEach(() => sb.close());

  const expectBlocked = (r: { status: number | null; stderr: string }) => {
    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toMatch(/BLOCKED/);
  };

  it('a clean push goes through', () => {
    const sha = sb.commit('notes.md', 'nothing to see\n');
    const r = sb.push('origin', 'main');
    expect(r.status, r.stderr).toBe(0);
    expect(sb.remoteHas(sha)).toBe(true);
  });

  it('BLOCKS a term in a .md hidden by a committed `* -diff` attribute', () => {
    sb.commit('.gitattributes', '* -diff\n', 'attrs');
    const leak = sb.commit('notes.md', `memo about ${TERM}\n`);
    expectBlocked(sb.push('origin', 'main'));
    expect(sb.remoteHas(leak)).toBe(false);
  });

  it('BLOCKS a term in a text file that carries a NUL byte', () => {
    sb.commit('notes.txt', Buffer.concat([Buffer.from([0]), Buffer.from(`memo about ${TERM}\n`)]));
    expectBlocked(sb.push('origin', 'main'));
  });

  it('BLOCKS when `git replace` shows a clean object in place of the one push sends', () => {
    const base = sb.git(sb.work, 'rev-parse', 'HEAD');
    const leak = sb.commit('notes.md', `memo about ${TERM}\n`);
    const clean = sb.git(sb.work, 'commit-tree', `${base}^{tree}`, '-p', base, '-m', 'clean');
    sb.git(sb.work, 'replace', leak, clean);
    expectBlocked(sb.push('origin', 'main'));
    expect(sb.remoteHas(leak)).toBe(false);
  });

  it('BLOCKS a tag that points straight at a blob carrying the term', () => {
    const blob = sb.hashObject(`memo about ${TERM}\n`);
    sb.git(sb.work, 'tag', 'blobtag', blob);
    expectBlocked(sb.push('origin', 'refs/tags/blobtag'));
  });

  it('BLOCKS an annotated tag whose message carries the term', () => {
    sb.commit('notes.md', 'clean content\n');
    sb.git(sb.work, 'push', '-q', '--no-verify', 'origin', 'main');
    sb.git(sb.work, 'tag', '-a', 'v1', '-m', `release notes mention ${TERM}`);
    expectBlocked(sb.push('origin', 'refs/tags/v1'));
  });

  it('BLOCKS a commit the remote dropped (rewound) while the local origin/main still claims it', () => {
    const leak = sb.commit('notes.md', `memo about ${TERM}\n`, 'leak');
    sb.git(sb.work, 'push', '-q', '--no-verify', 'origin', 'main');
    sb.git(sb.work, 'fetch', '-q', 'origin');
    // A history scrub elsewhere rewinds the remote; this clone has not fetched since.
    sb.git(sb.root, '--git-dir', sb.remote, 'update-ref', 'refs/heads/main', `${leak}~1`);
    expect(sb.git(sb.work, 'rev-parse', 'origin/main')).toBe(leak);
    sb.git(sb.work, 'checkout', '-q', '-b', 'feat');
    sb.commit('feature.md', 'clean feature\n');
    // (The rewound remote still stores the object, so only the verdict is asserted here.)
    expectBlocked(sb.push('origin', 'feat'));
  });

  it('BLOCKS a push to a second remote that does not have what origin/main has', () => {
    const leak = sb.commit('notes.md', `memo about ${TERM}\n`, 'leak');
    sb.git(sb.work, 'push', '-q', '--no-verify', 'origin', 'main');
    sb.git(sb.work, 'fetch', '-q', 'origin');
    const mirror = join(sb.root, 'mirror.git');
    sb.git(sb.root, 'init', '-q', '--bare', '-b', 'main', mirror);
    sb.git(sb.work, 'remote', 'add', 'mirror', mirror);
    expectBlocked(sb.push('mirror', 'main'));
    expect(sb.remoteHas(leak, mirror)).toBe(false);
  });

  it('BLOCKS a term through the LEGACY wrapper (no Python stage, no argv) that older worktrees reinstall', () => {
    const legacy = new Sandbox({ wrapper: LEGACY_WRAPPER });
    try {
      const leak = legacy.commit('notes.md', `memo about ${TERM}\n`);
      expectBlocked(legacy.push('origin', 'main'));
      expect(legacy.remoteHas(leak)).toBe(false);
      // ...and a clean push still goes through it.
      legacy.git(legacy.work, 'reset', '-q', '--hard', 'HEAD~1');
      const clean = legacy.commit('notes.md', 'nothing to see\n');
      const r = legacy.push('origin', 'main');
      expect(r.status, r.stderr).toBe(0);
      expect(legacy.remoteHas(clean)).toBe(true);
    } finally {
      legacy.close();
    }
  });

  // The other skew (refute run wf_e0d7368f-0b3, high): the NEW wrapper in the shared hooks dir and a
  // push from a worktree whose tree predates runTermScan. Its JS is modelled as term-blind (exit 0),
  // the worst case, so only the wrapper's Python stage (the copy beside the hook) can block.
  describe('new wrapper + a tree that predates runTermScan', () => {
    const shapes: [string, (o: Sandbox) => void][] = [
      ['a plain .md', (o) => o.commit('notes.md', `memo about ${TERM}\n`)],
      ['a committed `* -diff` attribute', (o) => {
        o.commit('.gitattributes', '* -diff\n', 'attrs');
        o.commit('notes.md', `memo about ${TERM}\n`);
      }],
      ['a term added then removed', (o) => {
        o.commit('notes.md', `memo about ${TERM}\n`, 'add');
        o.commit('notes.md', 'clean\n', 'remove');
      }],
      ['a term only in the commit message', (o) => o.commit('notes.md', 'clean\n', `about ${TERM}`)],
    ];
    for (const [name, make] of shapes) {
      it(`BLOCKS ${name}`, () => {
        const old = new Sandbox({ oldTree: true, copyBesideHook: true });
        try {
          make(old);
          expectBlocked(old.push('origin', 'main'));
        } finally {
          old.close();
        }
      });
    }

    // wf_df157e64-c52 (medium): an old scanner treats ANY '--staged' argv entry as its manual mode,
    // so the new wrapper must call an old tree the legacy way, without git's argv.
    it('does not forward git\'s argv to an old tree (a remote named --staged cannot skip its checks)', () => {
      const old = new Sandbox({
        oldTree: true,
        copyBesideHook: true,
        oldJs: "if (process.argv.includes('--staged')) process.exit(0);\nconsole.error('pre-push BLOCKED: old payload stub');\nprocess.exit(1);\n",
      });
      try {
        old.git(old.work, 'remote', 'add', '--', '--staged', old.remote);
        old.commit('notes.md', 'clean\n');
        const r = old.push('--', '--staged', 'main');
        expect(r.status, r.stderr).not.toBe(0);
        expect(r.stderr).toContain('old payload stub');
      } finally {
        old.close();
      }
    });

    // The same cell against origin/main's REAL scanner (pinned at 9a852473), when this clone has it
    // (a shallow CI checkout does not; the stub case above always runs).
    const LEGACY_COMMIT = '9a852473';
    const legacyJs = (() => {
      try {
        return execFileSync('git', ['show', `${LEGACY_COMMIT}:scripts/prepush-confidential-scan.mjs`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        return null;
      }
    })();
    it.skipIf(legacyJs === null)('origin/main\'s real scanner still BLOCKS a confidential:true payload pushed to a remote named --staged', () => {
      const old = new Sandbox({ oldTree: true, copyBesideHook: true, oldJs: legacyJs ?? '' });
      try {
        old.git(old.work, 'remote', 'add', '--', '--staged', old.remote);
        old.commit('deal.json', '{"name": "x", "confidential": true}\n');
        expectBlocked(old.push('--', '--staged', 'main'));
      } finally {
        old.close();
      }
    });

    it('still lets a clean push through, and BLOCKS when no scanner copy sits beside the hook', () => {
      const ok = new Sandbox({ oldTree: true, copyBesideHook: true });
      try {
        ok.commit('notes.md', 'nothing to see\n');
        const r = ok.push('origin', 'main');
        expect(r.status, r.stderr).toBe(0);
      } finally {
        ok.close();
      }
      const bare = new Sandbox({ oldTree: true });
      try {
        bare.commit('notes.md', 'nothing to see\n');
        expectBlocked(bare.push('origin', 'main'));
      } finally {
        bare.close();
      }
    });
  });

  /**
   * Plant an untracked stand-in for `name` in the worktree root that exits 0 for any arguments (Git's
   * true.exe on Windows, a sh script elsewhere), put '.' FIRST on PATH and unset
   * NoDefaultCurrentDirectoryInExePath, as in a normal terminal. Returns false when it cannot plant.
   */
  const plantInRoot = (box: Sandbox, name: string): boolean => {
    if (process.platform === 'win32') {
      if (!trueExe) return false;
      copyFileSync(trueExe, join(box.work, `${name}.exe`));
    } else {
      writeFileSync(join(box.work, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    writeFileSync(join(box.work, '.git', 'info', 'exclude'), `scripts/\n${name}\n${name}.exe\n`);
    delete box.env['NoDefaultCurrentDirectoryInExePath'];
    const key = Object.keys(box.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    box.env[key] = `.${process.platform === 'win32' ? ';' : ':'}${box.env[key] ?? ''}`;
    return true;
  };

  // wf_954ebd83-729 (medium, reproduced as a real leak): the NEW wrapper's own Python stage for a tree
  // that predates runTermScan found python by a bare name, so '.' on PATH ran a planted python.exe
  // that "passed" the term scan, and the old tree's JS saw only a clean endpoint diff.
  it('new wrapper + old tree: a planted python in the worktree root with "." on PATH cannot pass the term scan', () => {
    const old = new Sandbox({ oldTree: true, copyBesideHook: true });
    try {
      if (!plantInRoot(old, 'python')) return;
      old.commit('notes.md', `memo about ${TERM}\n`, 'add');
      const leak = old.git(old.work, 'rev-parse', 'HEAD');
      old.commit('notes.md', 'clean\n', 'remove');
      expectBlocked(old.push('origin', 'main'));
      expect(old.remoteHas(leak)).toBe(false);
    } finally {
      old.close();
    }
  });

  it('a planted node in the worktree root with "." on PATH cannot stand in for the scanner', () => {
    if (!plantInRoot(sb, 'node')) return;
    const leak = sb.commit('notes.md', `memo about ${TERM}\n`);
    expectBlocked(sb.push('origin', 'main'));
    expect(sb.remoteHas(leak)).toBe(false);
  });

  // wf_df157e64-c52 (medium): with NoDefaultCurrentDirectoryInExePath unset (a normal Windows
  // terminal), a bare 'python' resolved to an untracked python.exe in the worktree root that exits 0.
  const trueExe = (() => {
    if (process.platform !== 'win32') return null;
    try {
      const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
      const p = join(execPath, '..', '..', '..', 'usr', 'bin', 'true.exe');
      return existsSync(p) ? p : null;
    } catch {
      return null;
    }
  })();
  it.skipIf(trueExe === null)('BLOCKS a term when a python.exe that always exits 0 sits in the worktree root', () => {
    copyFileSync(trueExe ?? '', join(sb.work, 'python.exe'));
    writeFileSync(join(sb.work, '.git', 'info', 'exclude'), 'scripts/\npython.exe\n');
    delete sb.env['NoDefaultCurrentDirectoryInExePath'];
    const leak = sb.commit('notes.md', `memo about ${TERM}\n`);
    expectBlocked(sb.push('origin', 'main'));
    expect(sb.remoteHas(leak)).toBe(false);
  });

  it('BLOCKS a binary under data/ (the JS payload stage) even with no term anywhere', () => {
    sb.commit('data/ar/export.bin', Buffer.from([0, 1, 2, 3, 4]));
    const r = sb.push('origin', 'main');
    expectBlocked(r);
    expect(r.stderr).toContain('data/ar/export.bin');
  });
});
