// server/lib/rename-retry.ts
//
// renameSync with a bounded retry for the Windows transient-lock race. Antivirus or the Search
// indexer can briefly hold a handle on a just-written file, so the rename that publishes a
// temp+rename atomic write fails with EPERM/EBUSY/EACCES even though nothing is wrong (gate flake
// 2026-09-23 in the alert inbox store; same family as the warehouse:verify cleanup EPERM fixed
// 2026-07-08). Only those codes are retried, a bounded number of times, then the last error is
// rethrown. The rename itself is unchanged, so a reader still sees either the old file or the new
// one, never a partial write.
//
// renameWithRetry is the async twin for fs/promises writers (server/overlay.ts saveOverlay): same
// codes, attempts and backoff, but it waits on a timer, so a locked rename never stalls the event loop.
// Its optional shouldRetry is asked before every retry; returning false abandons with the last error
// (saveOverlay uses it to stand down when another process has published the target meanwhile).
import { renameSync } from 'node:fs';
import { rename } from 'node:fs/promises';

const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
export const RENAME_MAX_ATTEMPTS = 5;
const RENAME_BACKOFF_MS = 20; // linear: 20, 40, 60, 80 ms between attempts (200 ms worst case)

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isRetryable(err: unknown, attempt: number): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return attempt < RENAME_MAX_ATTEMPTS && !!code && TRANSIENT_RENAME_CODES.has(code);
}

export function renameSyncWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      if (!isRetryable(err, attempt)) throw err;
      sleepSync(RENAME_BACKOFF_MS * attempt);
    }
  }
}

export interface RenameRetryOptions {
  shouldRetry?: () => Promise<boolean>;
}

export async function renameWithRetry(from: string, to: string, opts: RenameRetryOptions = {}): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      if (!isRetryable(err, attempt)) throw err;
      await new Promise((resolve) => setTimeout(resolve, RENAME_BACKOFF_MS * attempt));
      if (opts.shouldRetry && !(await opts.shouldRetry())) throw err;
    }
  }
}
