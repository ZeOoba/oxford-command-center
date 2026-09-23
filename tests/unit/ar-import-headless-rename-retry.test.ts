// @vitest-environment node
//
// Every rename in scripts/ar-import-headless.ts goes through renameSyncWithRetry (server/lib/
// rename-retry.ts), so a Windows antivirus / indexer / OneDrive transient lock (EPERM/EBUSY/EACCES)
// on the snapshot, the review queue or an inbox PDF is retried instead of failing the weekly sweep
// (gate flake 2026-09-23 on the same temp+rename pattern in the alert inbox store). The retry
// behaviour itself is covered in alerts-store.test.ts; this file pins the four call sites to it.
//
// All paths live in a throwaway temp dir: AR_INBOX is set before the script is imported (its path
// constants are read at module load) and SNAPSHOT_PATH is mocked -- the real data/ar/* and
// portfolio.json are never touched.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as RenameRetryModule from '../../server/lib/rename-retry';

const root = mkdtempSync(join(tmpdir(), 'ar-rename-retry-'));
const inbox = join(root, 'ar', 'inbox');
const arRoot = join(root, 'ar');
const reviewQueue = join(arRoot, 'review-queue.json');
const snapshotPath = join(root, 'portfolio.json');
process.env.AR_INBOX = inbox;

vi.mock('../../server/config', () => ({ SNAPSHOT_PATH: snapshotPath }));

// Pass-through spy on the helper: the real retrying rename runs unless a test injects a failure.
vi.mock('../../server/lib/rename-retry', async (importOriginal) => {
  const actual = await importOriginal<typeof RenameRetryModule>();
  return { ...actual, renameSyncWithRetry: vi.fn(actual.renameSyncWithRetry) };
});

const { renameSyncWithRetry } = await import('../../server/lib/rename-retry');
const { patchSnapshot, appendReviewQueue, moveInto } = await import('../../scripts/ar-import-headless');
type QueuedReview = Parameters<typeof appendReviewQueue>[0][number];
const mockRename = vi.mocked(renameSyncWithRetry);

// appendReviewQueue is a no-op for an empty batch, so the queue tests need one real row.
const ROW: QueuedReview = {
  tenant: 'Zzz Nomatch Corp',
  property: null,
  d30: 1,
  d60: 0,
  d90: 0,
  d90plus: 0,
  proposedLeaseId: null,
  proposedCandidate: null,
  confidence: 'none',
  ambiguous: false,
  reason: 'no match — human must map',
  sourceFile: 'aging.pdf',
  queuedAt: '2026-09-23T00:00:00.000Z',
};

beforeEach(() => {
  rmSync(arRoot, { recursive: true, force: true });
  rmSync(snapshotPath, { force: true });
  mkdirSync(inbox, { recursive: true });
  mockRename.mockClear();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('ar-import-headless — every rename goes through the transient-lock retry', () => {
  it('patchSnapshot publishes portfolio.json via the retry', () => {
    writeFileSync(snapshotPath, JSON.stringify({ leases: [], tenantArrears: {} }));
    patchSnapshot({ 'lease-1': { d30: 100, d60: 0, d90: 0, d90plus: 0 } });
    expect(mockRename).toHaveBeenCalledWith(expect.stringContaining('.tmp-'), snapshotPath);
    const written = JSON.parse(readFileSync(snapshotPath, 'utf8')) as { tenantArrears: Record<string, unknown> };
    expect(Object.keys(written.tenantArrears)).toEqual(['lease-1']);
  });

  it('appendReviewQueue publishes the queue via the retry', () => {
    appendReviewQueue([ROW]);
    expect(mockRename).toHaveBeenCalledWith(`${reviewQueue}.tmp-${process.pid}`, reviewQueue);
    expect(JSON.parse(readFileSync(reviewQueue, 'utf8'))).toEqual([ROW]);
  });

  it('a corrupt queue is backed up aside via the retry', () => {
    writeFileSync(reviewQueue, '{ not json');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    appendReviewQueue([ROW]);
    errSpy.mockRestore();
    expect(mockRename).toHaveBeenCalledWith(reviewQueue, expect.stringMatching(/review-queue\.corrupt-\d+\.json$/));
    expect(readdirSync(arRoot).some((f) => /^review-queue\.corrupt-\d+\.json$/.test(f))).toBe(true);
  });

  it('moveInto moves the PDF via the retry', () => {
    const pdf = join(inbox, 'aging.pdf');
    writeFileSync(pdf, '%PDF-1.4');
    const processed = join(arRoot, 'processed');
    moveInto(pdf, processed);
    expect(mockRename).toHaveBeenCalledWith(pdf, join(processed, 'aging.pdf'));
    expect(existsSync(join(processed, 'aging.pdf'))).toBe(true);
    expect(existsSync(pdf)).toBe(false);
  });

  it('moveInto still leaves the PDF in place (no throw) once the retry is exhausted', () => {
    const pdf = join(inbox, 'locked.pdf');
    writeFileSync(pdf, '%PDF-1.4');
    mockRename.mockImplementationOnce(() => {
      throw Object.assign(new Error('EPERM: simulated exhausted retry'), { code: 'EPERM' });
    });
    expect(() => moveInto(pdf, join(arRoot, 'processed'))).not.toThrow();
    expect(existsSync(pdf)).toBe(true);
  });
});
