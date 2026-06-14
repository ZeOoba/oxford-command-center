// tests/unit/safe-worktree.test.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isReparsePoint, unlinkReparsePoint } from '../../scripts/safe-worktree';

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
