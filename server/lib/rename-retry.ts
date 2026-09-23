// server/lib/rename-retry.ts
//
// renameSync with a bounded retry for the Windows transient-lock race. Antivirus or the Search
// indexer can briefly hold a handle on a just-written file, so the rename that publishes a
// temp+rename atomic write fails with EPERM/EBUSY/EACCES even though nothing is wrong (gate flake
// 2026-09-23 in the alert inbox store; same family as the warehouse:verify cleanup EPERM fixed
// 2026-07-08). Only those codes are retried, a bounded number of times, then the last error is
// rethrown. The rename itself is unchanged, so a reader still sees either the old file or the new
// one, never a partial write.
import { renameSync } from 'node:fs';

const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
export const RENAME_MAX_ATTEMPTS = 5;
const RENAME_BACKOFF_MS = 20; // linear: 20, 40, 60, 80 ms between attempts (200 ms worst case)

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function renameSyncWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (attempt >= RENAME_MAX_ATTEMPTS || !code || !TRANSIENT_RENAME_CODES.has(code)) throw err;
      sleepSync(RENAME_BACKOFF_MS * attempt);
    }
  }
}
