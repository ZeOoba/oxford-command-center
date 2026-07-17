// tests/unit/safe-worktree.test.ts
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonical,
  isOrphanWorktreeDir,
  isReparsePoint,
  parseWorktreePorcelain,
  prune,
  removeDirSafely,
  unlinkReparsePoint,
} from '../../scripts/safe-worktree';

// Reproduces the 2026-06-13 node_modules-junction hazard: a worktree's node_modules was a Windows
// junction into the REAL node_modules; `git worktree remove --force` recursed THROUGH it and deleted
// the real target. The safe primitive must unlink the reparse point WITHOUT touching target contents.
describe('safe-worktree reparse-point handling (node_modules junction wipe hazard)', () => {
  it('unlinks a junction/symlink WITHOUT deleting the target contents', () => {
    const base = mkdtempSync(join(tmpdir(), 'sw-'));
    const target = join(base, 'real-node_modules');
    mkdirSync(target);
    const sentinel = join(target, 'keep.txt');
    writeFileSync(sentinel, 'precious');
    const link = join(base, 'wt-node_modules');
    symlinkSync(target, link, 'junction'); // 'junction' on Windows (no admin); dir-symlink elsewhere

    expect(isReparsePoint(link)).toBe(true);
    expect(isReparsePoint(target)).toBe(false);

    unlinkReparsePoint(link);

    expect(existsSync(link)).toBe(false);                      // the reparse point is gone
    expect(existsSync(target)).toBe(true);                     // the TARGET DIRECTORY is intact
    expect(readFileSync(sentinel, 'utf8')).toBe('precious');   // ...and its CONTENTS — hazard prevented
  });

  it('refuses to unlink a REAL directory (never recurse/delete actual node_modules)', () => {
    const base = mkdtempSync(join(tmpdir(), 'sw-'));
    const realDir = join(base, 'real');
    mkdirSync(realDir);
    writeFileSync(join(realDir, 'f.txt'), 'x');

    expect(isReparsePoint(realDir)).toBe(false);
    expect(() => unlinkReparsePoint(realDir)).toThrow(/not a junction|not a symlink|reparse/i);
    expect(existsSync(join(realDir, 'f.txt'))).toBe(true);     // untouched
  });

  it('isReparsePoint returns false for a non-existent path (no throw)', () => {
    expect(isReparsePoint(join(tmpdir(), 'definitely-does-not-exist-xyz'))).toBe(false);
  });
});

// `prune` cleans ORPHANED worktree dirs that `git worktree remove` can't touch (deregistered leftovers).
// The delete must carry the SAME junction-safety guarantee as `remove` — never recurse through a
// node_modules junction into the real target.
describe('removeDirSafely (junction-safe recursive delete)', () => {
  it('recursively deletes a real nested tree', () => {
    const base = mkdtempSync(join(tmpdir(), 'sw-'));
    const root = join(base, 'wt');
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'a', 'f.txt'), 'x');
    writeFileSync(join(root, 'a', 'b', 'g.txt'), 'y');

    removeDirSafely(root);

    expect(existsSync(root)).toBe(false);
  });

  it('does NOT recurse through a node_modules junction (the wipe hazard)', () => {
    const base = mkdtempSync(join(tmpdir(), 'sw-'));
    const realNM = join(base, 'real-node_modules');
    mkdirSync(realNM);
    writeFileSync(join(realNM, 'keep.txt'), 'precious');
    const orphan = join(base, 'orphan');
    mkdirSync(orphan);
    symlinkSync(realNM, join(orphan, 'node_modules'), 'junction'); // junction on Windows (no admin)

    removeDirSafely(orphan);

    expect(existsSync(orphan)).toBe(false); // the orphan dir (incl. the junction) is gone
    expect(existsSync(realNM)).toBe(true); // ...but the junction TARGET survives
    expect(readFileSync(join(realNM, 'keep.txt'), 'utf8')).toBe('precious'); // ...with its contents
  });

  it('deletes read-only files (clears the bit rather than failing)', () => {
    const base = mkdtempSync(join(tmpdir(), 'sw-'));
    const root = join(base, 'wt');
    mkdirSync(root);
    const f = join(root, 'ro.txt');
    writeFileSync(f, 'x');
    chmodSync(f, 0o444);

    removeDirSafely(root);

    expect(existsSync(root)).toBe(false);
  });

  it('is a no-op for a missing path', () => {
    expect(() => removeDirSafely(join(tmpdir(), 'sw-missing-xyz-123'))).not.toThrow();
  });
});

describe('parseWorktreePorcelain', () => {
  it('extracts only worktree paths, ignoring HEAD/branch/detached/blank lines', () => {
    const out = [
      'worktree C:/repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree C:/repo/.claude/worktrees/foo',
      'HEAD def456',
      'detached',
      '',
    ].join('\n');

    expect(parseWorktreePorcelain(out)).toEqual(['C:/repo', 'C:/repo/.claude/worktrees/foo']);
  });

  it('tolerates CRLF line endings and empty input', () => {
    expect(parseWorktreePorcelain('worktree /a\r\nHEAD x\r\n')).toEqual(['/a']);
    expect(parseWorktreePorcelain('')).toEqual([]);
  });
});

describe('canonical', () => {
  it('is idempotent and separator-insensitive on the host platform', () => {
    const p = join(tmpdir(), 'A', 'B');
    expect(canonical(canonical(p))).toBe(canonical(p));
    expect(canonical(p)).toBe(canonical(p.replace(/[\\/]/g, '/')));
  });
});

describe('isOrphanWorktreeDir', () => {
  it('true for a dir absent from the registry and without a .git link', () => {
    const base = mkdtempSync(join(tmpdir(), 'sw-'));
    const d = join(base, 'orphan');
    mkdirSync(d);

    expect(isOrphanWorktreeDir(d, new Set())).toBe(true);
  });

  it('false when the dir is a registered worktree (canonical match)', () => {
    const base = mkdtempSync(join(tmpdir(), 'sw-'));
    const d = join(base, 'live');
    mkdirSync(d);

    expect(isOrphanWorktreeDir(d, new Set([canonical(d)]))).toBe(false);
  });

  it('false when a .git worktree link is present (never delete a live worktree)', () => {
    const base = mkdtempSync(join(tmpdir(), 'sw-'));
    const d = join(base, 'linked');
    mkdirSync(d);
    writeFileSync(join(d, '.git'), 'gitdir: ../../.git/worktrees/linked');

    expect(isOrphanWorktreeDir(d, new Set())).toBe(false);
  });
});

// End-to-end orchestration against a REAL throwaway git repo — exercises the git calls and, critically,
// asserts --dry-run is side-effect-free (the deletion path is covered separately by removeDirSafely).
describe('prune (orchestration, real temp git repo)', () => {
  function initRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), 'sw-repo-'));
    const g = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    g(['init']);
    g(['config', 'user.email', 'test@example.com']);
    g(['config', 'user.name', 'test']);
    g(['commit', '--allow-empty', '-m', 'init']); // give worktree list a normal HEAD
    return repo;
  }

  it('--dry-run reports orphans but deletes nothing on disk', () => {
    const repo = initRepo();
    const orphan = join(repo, '.claude', 'worktrees', 'orphan1');
    mkdirSync(join(orphan, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(orphan, 'node_modules', 'pkg', 'index.js'), 'x');

    const reported = prune(repo, { dryRun: true });

    expect(reported).toEqual([orphan]); // reported...
    expect(existsSync(orphan)).toBe(true); // ...but left intact
  });

  it('deletes orphan dirs including their nested node_modules', () => {
    const repo = initRepo();
    const orphan = join(repo, '.claude-worktrees', 'orphan2');
    mkdirSync(join(orphan, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(orphan, 'src.txt'), 'y');

    const pruned = prune(repo);

    expect(pruned).toEqual([orphan]);
    expect(existsSync(orphan)).toBe(false);
  });

  it('reports nothing to do when the roots are absent or empty', () => {
    const repo = initRepo();
    expect(prune(repo)).toEqual([]);
  });
});
