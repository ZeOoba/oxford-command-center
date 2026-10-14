// tests/support/temp-run-dir.ts
//
// Helpers for the vitest globalSetup (tests/global-setup.ts) that gives each test run ONE private temp
// root. ~130 test files create `mkdtemp` warehouses and most never remove them; on the self-hosted CI
// runner (same user and same %TEMP% as the dev session) that grew to ~700K folders and filled the disk,
// failing the `gate` job with "not enough space on the disk". Redirecting os.tmpdir() to a per-run folder
// and removing it at the end fixes every current and future test without touching them.
//
// SAFETY: removeRunDir/sweepStaleRunDirs only ever delete directories whose OWN name starts with
// RUN_DIR_PREFIX. A bad argument can never recursively delete anything else.
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export const RUN_DIR_PREFIX = 'ocr-vitest-';
/** Run dirs older than this are assumed orphaned by a crashed or killed run and swept on the next start. */
export const STALE_AFTER_MS = 6 * 3_600_000;

/** Create a uniquely named run dir under `root`. */
export function createRunDir(root: string): string {
  return mkdtempSync(join(root, RUN_DIR_PREFIX));
}

/** Point every variable os.tmpdir() reads at `dir` (Windows reads TEMP/TMP, POSIX reads TMPDIR). */
export function redirectTmpEnv(dir: string, env: NodeJS.ProcessEnv = process.env): void {
  env.TEMP = dir;
  env.TMP = dir;
  env.TMPDIR = dir;
}

/**
 * Recursively remove a run dir. Returns true when it is gone (including already gone), false when the
 * path is not one of ours (refused) or removal failed. Never throws: an unclosed SQLite handle can hold
 * a file open on Windows, and a teardown problem must not fail the test run - the next start sweeps it.
 */
export function removeRunDir(dir: string): boolean {
  if (!dir || !basename(dir).startsWith(RUN_DIR_PREFIX)) return false;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detached helper script (run via `node -e`): waits for the watched process to exit, then removes the dir.
 * Windows keeps SQLite files locked while vitest's workers wind down, so teardown's in-process removal can
 * fail; once the process has exited the locks are released and the removal succeeds. The prefix check is
 * repeated here so the helper is safe on its own. Gives up quietly: the next start's stale sweep is the backstop.
 */
const DEFERRED_REMOVAL_SCRIPT = `
const fs = require('fs'), path = require('path');
const [dir, pid, prefix] = process.argv.slice(1);
if (!dir || !path.basename(dir).startsWith(prefix)) process.exit(2);
const alive = () => { try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; } };
let waits = 0;
(function wait() {
  if (alive() && waits++ < 600) return setTimeout(wait, 500);
  let tries = 0;
  (function rm() {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch (e) { if (++tries < 20) setTimeout(rm, 1000); }
  })();
})();
`;

/**
 * Fallback for a failed removeRunDir: spawn a detached helper that removes `dir` once process `parentPid`
 * has exited. Returns false (spawning nothing) for a path that is not one of our run dirs.
 */
export function scheduleDeferredRemoval(dir: string, parentPid: number = process.pid): boolean {
  if (!dir || !basename(dir).startsWith(RUN_DIR_PREFIX)) return false;
  try {
    const child = spawn(process.execPath, ['-e', DEFERRED_REMOVAL_SCRIPT, dir, String(parentPid), RUN_DIR_PREFIX], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Remove run dirs under `root` whose mtime is older than `maxAgeMs`. Returns how many were removed. */
export function sweepStaleRunDirs(root: string, now: number = Date.now(), maxAgeMs: number = STALE_AFTER_MS): number {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return 0; // root missing or unreadable: nothing to sweep
  }
  let removed = 0;
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(RUN_DIR_PREFIX)) continue;
    const path = join(root, e.name);
    try {
      if (now - statSync(path).mtimeMs <= maxAgeMs) continue;
    } catch {
      continue; // vanished between readdir and stat (another run's teardown)
    }
    if (removeRunDir(path)) removed += 1;
  }
  return removed;
}
