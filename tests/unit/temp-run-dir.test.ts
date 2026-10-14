// tests/unit/temp-run-dir.test.ts
//
// Unit tests for the vitest globalSetup temp-dir helpers (tests/support/temp-run-dir.ts). The suite's
// ~130 test files create mkdtemp warehouses and most never remove them; on the self-hosted CI runner
// (same user, same %TEMP% as the dev session) that filled the disk. globalSetup redirects tmpdir() to
// ONE per-run folder and removes it afterwards; these tests pin the helper's safety rules, above all
// that it can never recursively delete a path that is not one of its own run folders.
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RUN_DIR_PREFIX,
  createRunDir,
  redirectTmpEnv,
  removeRunDir,
  scheduleDeferredRemoval,
  sweepStaleRunDirs,
} from '../support/temp-run-dir';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'trd-test-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const HOUR = 3_600_000;
const age = (path: string, ms: number) => {
  const t = new Date(Date.now() - ms);
  utimesSync(path, t, t);
};

describe('createRunDir', () => {
  it('creates a uniquely named, prefixed directory under the root', () => {
    const a = createRunDir(root);
    const b = createRunDir(root);
    expect(existsSync(a)).toBe(true);
    expect(a.startsWith(join(root, RUN_DIR_PREFIX))).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe('removeRunDir', () => {
  it('removes a run dir and everything inside it', () => {
    const dir = createRunDir(root);
    mkdirSync(join(dir, 'wh-abc123', 'raw'), { recursive: true });
    writeFileSync(join(dir, 'wh-abc123', 'f.sqlite'), 'x');
    expect(removeRunDir(dir)).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it('is a no-op success when the directory is already gone', () => {
    const dir = createRunDir(root);
    rmSync(dir, { recursive: true });
    expect(removeRunDir(dir)).toBe(true);
  });

  it('REFUSES to remove a path that is not one of its own run dirs', () => {
    const other = join(root, 'precious-data');
    mkdirSync(other);
    writeFileSync(join(other, 'keep.txt'), 'x');
    expect(removeRunDir(other)).toBe(false);
    expect(existsSync(join(other, 'keep.txt'))).toBe(true);
  });

  it('REFUSES an empty path and the filesystem root-like inputs', () => {
    expect(removeRunDir('')).toBe(false);
    expect(removeRunDir(root)).toBe(false);
    expect(existsSync(root)).toBe(true);
  });
});

describe('sweepStaleRunDirs', () => {
  it('removes run dirs older than the max age and keeps fresh ones', () => {
    const stale = createRunDir(root);
    const fresh = createRunDir(root);
    age(stale, 7 * HOUR);
    expect(sweepStaleRunDirs(root, Date.now(), 6 * HOUR)).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('never touches old entries that lack the run-dir prefix, or plain files', () => {
    const foreignDir = join(root, 'wh-oldfolder');
    mkdirSync(foreignDir);
    const prefixedFile = join(root, `${RUN_DIR_PREFIX}notadir`);
    writeFileSync(prefixedFile, 'x');
    age(foreignDir, 48 * HOUR);
    age(prefixedFile, 48 * HOUR);
    expect(sweepStaleRunDirs(root, Date.now(), 6 * HOUR)).toBe(0);
    expect(existsSync(foreignDir)).toBe(true);
    expect(existsSync(prefixedFile)).toBe(true);
  });

  it('returns 0 for a root that does not exist', () => {
    expect(sweepStaleRunDirs(join(root, 'missing'), Date.now(), 6 * HOUR)).toBe(0);
  });
});

describe('redirectTmpEnv', () => {
  it('points TEMP, TMP and TMPDIR at the run dir, leaving other vars alone', () => {
    const env: NodeJS.ProcessEnv = { KEEP: 'yes', TEMP: 'old' };
    redirectTmpEnv('/some/run/dir', env);
    expect(env.TEMP).toBe('/some/run/dir');
    expect(env.TMP).toBe('/some/run/dir');
    expect(env.TMPDIR).toBe('/some/run/dir');
    expect(env.KEEP).toBe('yes');
  });
});

// Windows keeps SQLite files locked while the workers wind down, so the in-process removal in teardown can
// fail. The fallback is a detached helper that waits for the vitest process to exit, then removes the dir.
describe('scheduleDeferredRemoval', () => {
  const waitFor = async (cond: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 200)); }
    return cond();
  };

  it('removes the run dir after the watched parent process exits (and not before)', async () => {
    const dir = createRunDir(root);
    writeFileSync(join(dir, 'f.sqlite'), 'x');
    const parent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2500)'], { stdio: 'ignore' });
    expect(scheduleDeferredRemoval(dir, parent.pid!)).toBe(true);
    await new Promise((r) => setTimeout(r, 1000));
    expect(existsSync(dir)).toBe(true); // parent still alive: helper must be waiting
    expect(await waitFor(() => !existsSync(dir), 20_000)).toBe(true);
  }, 40_000);

  it('REFUSES a path that is not a run dir, and spawns nothing', () => {
    const other = join(root, 'precious-data');
    mkdirSync(other);
    expect(scheduleDeferredRemoval(other, process.pid)).toBe(false);
    expect(scheduleDeferredRemoval('', process.pid)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });
});
