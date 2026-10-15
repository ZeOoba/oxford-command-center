// tests/global-setup.ts - vitest globalSetup (wired in vitest.config.ts).
//
// Runs once in the main process BEFORE the forked workers start, so the redirected TEMP/TMP/TMPDIR is
// inherited by every worker and by every child process a test spawns. See tests/support/temp-run-dir.ts
// for why (the suite leaks mkdtemp warehouses and filled the CI runner's disk).
import { tmpdir } from 'node:os';
import { createRunDir, redirectTmpEnv, removeRunDir, scheduleDeferredRemoval, sweepStaleRunDirs } from './support/temp-run-dir';

export default function setup(): () => void {
  const realRoot = tmpdir();
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };

  const swept = sweepStaleRunDirs(realRoot);
  if (swept > 0) console.warn(`[global-setup] swept ${swept} stale ocr-vitest run dir(s) from ${realRoot}`);

  const runDir = createRunDir(realRoot);
  redirectTmpEnv(runDir);

  return function teardown(): void {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (!removeRunDir(runDir)) {
      // Open SQLite handles can still lock files while workers wind down (Windows). Remove it right after this process exits.
      const deferred = scheduleDeferredRemoval(runDir);
      console.warn(`[global-setup] ${runDir} still locked; ${deferred ? 'removal deferred until this process exits' : 'the next run stale sweep will retry'}`);
    }
  };
}
