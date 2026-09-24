// @vitest-environment node
//
// saveOverlay (server/overlay.ts) publishes overlay.json -- the canonical store for every UI
// write-back and the headless AR feed -- through renameWithRetry, so a Windows antivirus / indexer /
// OneDrive transient lock (EPERM/EBUSY/EACCES) on the rename is retried instead of dropping the
// write (same race as the 2026-09-23 gate flake; PRs #365/#367). The retry behaviour itself is
// covered in rename-retry-async.test.ts; this file pins the call site and saveOverlay's contract.
//
// Every test points OVERLAY_PATH at a throwaway temp dir and awaits before restoring it, so the real
// data/overlay.json is never touched.
import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { rename as fsRename } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as RenameRetryModule from '../../server/lib/rename-retry';

// Pass-through spies on both layers: the helper (call-site wiring, delayed publishes) and the raw
// fs/promises rename underneath it (injected lock errors, so the helper's real retry loop runs).
vi.mock('../../server/lib/rename-retry', async (importOriginal) => {
  const actual = await importOriginal<typeof RenameRetryModule>();
  return { ...actual, renameWithRetry: vi.fn(actual.renameWithRetry) };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const rename = vi.fn(actual.rename);
  return { ...actual, rename, default: { ...actual, rename } };
});

const { renameWithRetry } = await import('../../server/lib/rename-retry');
const { saveOverlay, EMPTY_OVERLAY } = await import('../../server/overlay');
const actualRenameWithRetry = (await vi.importActual<typeof RenameRetryModule>('../../server/lib/rename-retry')).renameWithRetry;
const mockRename = vi.mocked(renameWithRetry);
const mockFsRename = vi.mocked(fsRename);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const root = mkdtempSync(join(tmpdir(), 'overlay-rename-retry-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function withTmpOverlay(name: string, fn: (path: string) => Promise<void>): Promise<void> {
  const path = join(root, name, 'overlay.json');
  const prev = process.env.OVERLAY_PATH;
  process.env.OVERLAY_PATH = path;
  try {
    await fn(path);
  } finally {
    if (prev === undefined) delete process.env.OVERLAY_PATH;
    else process.env.OVERLAY_PATH = prev;
  }
}

const notesIn = (path: string) =>
  (JSON.parse(readFileSync(path, 'utf8')) as { tenantNotes: Record<string, string> }).tenantNotes;

describe('saveOverlay — transient-lock rename retry', () => {
  it('publishes overlay.json through the retry', async () => {
    await withTmpOverlay('ok', async (path) => {
      mockRename.mockClear();
      expect(await saveOverlay({ ...EMPTY_OVERLAY, tenantNotes: { t1: 'note' } })).toBe(true);
      expect(mockRename).toHaveBeenCalledWith(expect.stringContaining(`${path}.tmp-`), path, expect.anything());
      expect(notesIn(path)).toEqual({ t1: 'note' });
    });
  });

  it('still returns false, and leaves the prior overlay intact, once the retry is exhausted', async () => {
    await withTmpOverlay('exhausted', async (path) => {
      expect(await saveOverlay({ ...EMPTY_OVERLAY, tenantNotes: { t1: 'before' } })).toBe(true);
      mockRename.mockRejectedValueOnce(Object.assign(new Error('EPERM: simulated exhausted retry'), { code: 'EPERM' }));
      expect(await saveOverlay({ ...EMPTY_OVERLAY, tenantNotes: { t1: 'after' } })).toBe(false);
      expect(notesIn(path)).toEqual({ t1: 'before' });
    });
  });

  // Refute finding (2026-09-23): with a retry in the rename, an OLDER save whose rename hits a lock
  // could land up to ~200 ms later on top of a NEWER save, and both report true. saveOverlay now runs
  // saves one at a time, in call order, so a retrying save holds the next one back instead of racing it.
  it('concurrent saves land in call order even when the first one is slow to publish', async () => {
    await withTmpOverlay('ordered', async (path) => {
      mockRename.mockImplementationOnce(async (from, to, opts) => {
        await delay(80); // the first save's publish is stuck behind a lock for a while
        return actualRenameWithRetry(from, to, opts);
      });
      const first = saveOverlay({ ...EMPTY_OVERLAY, tenantNotes: { t1: 'older' } });
      const second = saveOverlay({ ...EMPTY_OVERLAY, tenantNotes: { t1: 'newer' } });
      expect(await Promise.all([first, second])).toEqual([true, true]);
      expect(notesIn(path)).toEqual({ t1: 'newer' });
    });
  });

  // Cross-process half of the same finding: the headless AR feed and the server are separate
  // processes, so in-process ordering cannot help. If another writer publishes overlay.json while this
  // save is waiting to retry, the retry is abandoned and saveOverlay returns false -- what the
  // pre-retry code did when its single rename failed -- rather than clobbering the newer file.
  it('abandons the retry, and returns false, when another writer publishes in the meantime', async () => {
    await withTmpOverlay('cross-process', async (path) => {
      expect(await saveOverlay({ ...EMPTY_OVERLAY, tenantNotes: { t1: 'base' } })).toBe(true);
      mockFsRename.mockImplementationOnce(async () => {
        // another process publishes its own overlay.json (temp + rename), then our rename hits a lock
        writeFileSync(`${path}.other`, JSON.stringify({ ...EMPTY_OVERLAY, tenantNotes: { t1: 'other-process' } }));
        renameSync(`${path}.other`, path);
        throw Object.assign(new Error('EPERM: simulated lock'), { code: 'EPERM' });
      });
      expect(await saveOverlay({ ...EMPTY_OVERLAY, tenantNotes: { t1: 'ours' } })).toBe(false);
      expect(notesIn(path)).toEqual({ t1: 'other-process' });
    });
  });

  it('still retries through a lock when nobody else has published', async () => {
    await withTmpOverlay('lock-only', async (path) => {
      expect(await saveOverlay({ ...EMPTY_OVERLAY, tenantNotes: { t1: 'base' } })).toBe(true);
      mockFsRename.mockClear();
      mockFsRename.mockRejectedValueOnce(Object.assign(new Error('EBUSY: simulated lock'), { code: 'EBUSY' }));
      expect(await saveOverlay({ ...EMPTY_OVERLAY, tenantNotes: { t1: 'ours' } })).toBe(true);
      expect(mockFsRename).toHaveBeenCalledTimes(2);
      expect(notesIn(path)).toEqual({ t1: 'ours' });
    });
  });
});
