// @vitest-environment node
//
// renameWithRetry (server/lib/rename-retry.ts): the async twin of renameSyncWithRetry, for writers
// that publish through node:fs/promises rename (server/overlay.ts saveOverlay). Same contract --
// retry EPERM/EBUSY/EACCES only, RENAME_MAX_ATTEMPTS attempts, then reject with the last error --
// but the backoff is a timer, so a locked rename never stalls the event loop.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { rename } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { renameWithRetry, RENAME_MAX_ATTEMPTS } from '../../server/lib/rename-retry';

// Every call is injected per test; the helper never touches the real filesystem here. `default` is
// patched for parity with the node:fs mocks elsewhere (required there, harmless here).
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const rename = vi.fn();
  return { ...actual, rename, default: { ...actual, rename } };
});
const mockRename = vi.mocked(rename);
const errno = (code: string) => Object.assign(new Error(`${code}: simulated`), { code });

afterEach(() => {
  mockRename.mockReset();
});

describe('renameWithRetry', () => {
  it.each(['EPERM', 'EBUSY', 'EACCES'])('resolves after transient %s failures', async (code) => {
    mockRename
      .mockRejectedValueOnce(errno(code))
      .mockRejectedValueOnce(errno(code))
      .mockResolvedValueOnce(undefined);
    await expect(renameWithRetry('a.tmp', 'a')).resolves.toBeUndefined();
    expect(mockRename).toHaveBeenCalledTimes(3);
    expect(mockRename).toHaveBeenLastCalledWith('a.tmp', 'a');
  });

  it('rejects with the last error after max attempts', async () => {
    mockRename.mockRejectedValue(errno('EPERM'));
    await expect(renameWithRetry('a.tmp', 'a')).rejects.toThrow(/EPERM/);
    expect(mockRename).toHaveBeenCalledTimes(RENAME_MAX_ATTEMPTS);
  });

  it('does not retry a non-transient error', async () => {
    mockRename.mockRejectedValue(errno('ENOENT'));
    await expect(renameWithRetry('a.tmp', 'a')).rejects.toThrow(/ENOENT/);
    expect(mockRename).toHaveBeenCalledTimes(1);
  });

  it('consults shouldRetry before every retry', async () => {
    const shouldRetry = vi.fn(async () => true);
    mockRename
      .mockRejectedValueOnce(errno('EPERM'))
      .mockRejectedValueOnce(errno('EPERM'))
      .mockResolvedValueOnce(undefined);
    await expect(renameWithRetry('a.tmp', 'a', { shouldRetry })).resolves.toBeUndefined();
    expect(shouldRetry).toHaveBeenCalledTimes(2);
    expect(mockRename).toHaveBeenCalledTimes(3);
  });

  it('abandons with the last error when shouldRetry says no', async () => {
    const lastError = errno('EPERM');
    mockRename.mockRejectedValueOnce(lastError);
    await expect(renameWithRetry('a.tmp', 'a', { shouldRetry: async () => false })).rejects.toBe(lastError);
    expect(mockRename).toHaveBeenCalledTimes(1);
  });

  it('does not block the event loop while backing off', async () => {
    const events: string[] = [];
    mockRename
      .mockImplementationOnce(async () => {
        events.push('fail');
        throw errno('EBUSY');
      })
      .mockImplementationOnce(async () => {
        events.push('rename');
      });
    const pending = renameWithRetry('a.tmp', 'a');
    setImmediate(() => events.push('tick'));
    await pending;
    expect(events).toEqual(['fail', 'tick', 'rename']);
  });
});
