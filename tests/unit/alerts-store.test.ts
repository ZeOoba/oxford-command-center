import { describe, it, expect, afterEach, vi } from 'vitest';
import { rmSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import type * as NodeFs from 'node:fs';
import { loadInboxState, saveInboxState, runAlertAction } from '../../server/alerts/store';
import { RENAME_MAX_ATTEMPTS } from '../../server/lib/rename-retry';

// Pass-through spy: every test uses the real rename unless it injects a failure. The spy is set
// on `default` too: the module under test reaches its named node:fs import through the builtin's
// default export, so patching only the named export leaves it on the real renameSync.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  const renameSync = vi.fn(actual.renameSync);
  return { ...actual, renameSync, default: { ...actual, renameSync } };
});
const realRenameSync = (await vi.importActual<typeof NodeFs>('node:fs')).renameSync;
const mockRename = vi.mocked(renameSync);

const TMP = 'data/__test-alert-inbox.json';
afterEach(() => { if (existsSync(TMP)) rmSync(TMP); });

describe('inbox store', () => {
  it('returns empty state when the file is absent', () => {
    expect(loadInboxState(TMP)).toEqual({ read: [], snoozed: {} });
  });

  it('round-trips a saved state', () => {
    saveInboxState({ read: ['x'], snoozed: {} }, TMP);
    expect(loadInboxState(TMP).read).toEqual(['x']);
  });

  it('applies an action and persists it', () => {
    const next = runAlertAction({ alertId: 'a', action: 'read' }, TMP);
    expect(next.read).toEqual(['a']);
    expect(loadInboxState(TMP).read).toEqual(['a']);
  });

  it('tolerates a corrupt file by returning empty state', () => {
    saveInboxState({ read: ['x'], snoozed: {} }, TMP);
    writeFileSync(TMP, '{ not json');
    expect(loadInboxState(TMP)).toEqual({ read: [], snoozed: {} });
  });
});

// Atomic write fix (audit finding: saveInboxState used a direct writeFileSync which leaves a
// torn / partially-written file visible to concurrent readers during the write. Fix: write to
// a .tmp file then rename — rename is atomic on all major FS, so readers never see a half-write).
describe('saveInboxState — atomic write (temp+rename)', () => {
  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP);
    if (existsSync(`${TMP}.tmp`)) rmSync(`${TMP}.tmp`);
  });

  it('no stale .tmp file remains after a successful write', () => {
    saveInboxState({ read: ['clean'], snoozed: {} }, TMP);
    expect(existsSync(`${TMP}.tmp`)).toBe(false);
    expect(loadInboxState(TMP).read).toEqual(['clean']);
  });

  it('overwrites a stale .tmp left by a previous crashed write', () => {
    // Simulate a prior run that crashed after writeFileSync but before renameSync,
    // leaving a corrupt .tmp on disk. The next write must still succeed and leave
    // no .tmp behind (renameSync replaces any existing file atomically).
    writeFileSync(`${TMP}.tmp`, '{ stale garbage }');
    saveInboxState({ read: ['fresh'], snoozed: {} }, TMP);
    expect(loadInboxState(TMP).read).toEqual(['fresh']);
    expect(existsSync(`${TMP}.tmp`)).toBe(false);
  });

  it('overwrites an existing target file atomically', () => {
    // Common case: update an already-existing inbox state file (e.g. user marks an alert read).
    // The rename must replace the prior file; no .tmp must survive.
    saveInboxState({ read: ['initial'], snoozed: {} }, TMP);
    expect(loadInboxState(TMP).read).toEqual(['initial']);
    saveInboxState({ read: ['updated'], snoozed: {} }, TMP);
    expect(loadInboxState(TMP).read).toEqual(['updated']);
    expect(existsSync(`${TMP}.tmp`)).toBe(false);
  });
});

// Transient-lock retry (gate flake 2026-09-23: EPERM on the rename in the test above, Windows
// antivirus/indexer holding the just-written .tmp). The rename is retried on EPERM/EBUSY/EACCES
// only, a bounded number of times, then the last error is rethrown.
describe('saveInboxState — transient rename lock retry', () => {
  const errno = (code: string) => Object.assign(new Error(`${code}: simulated`), { code });

  afterEach(() => {
    mockRename.mockReset();
    mockRename.mockImplementation(realRenameSync);
    if (existsSync(TMP)) rmSync(TMP);
    if (existsSync(`${TMP}.tmp`)) rmSync(`${TMP}.tmp`);
  });

  it.each(['EPERM', 'EBUSY', 'EACCES'])('succeeds after transient %s failures', (code) => {
    saveInboxState({ read: ['initial'], snoozed: {} }, TMP);
    mockRename.mockClear();
    mockRename
      .mockImplementationOnce(() => { throw errno(code); })
      .mockImplementationOnce(() => { throw errno(code); });
    saveInboxState({ read: ['updated'], snoozed: {} }, TMP);
    expect(mockRename).toHaveBeenCalledTimes(3);
    expect(loadInboxState(TMP).read).toEqual(['updated']);
    expect(existsSync(`${TMP}.tmp`)).toBe(false);
  });

  it('rethrows the last error after max attempts and leaves the prior file intact', () => {
    saveInboxState({ read: ['initial'], snoozed: {} }, TMP);
    mockRename.mockClear();
    mockRename.mockImplementation(() => { throw errno('EPERM'); });
    expect(() => saveInboxState({ read: ['updated'], snoozed: {} }, TMP)).toThrow(/EPERM/);
    expect(mockRename).toHaveBeenCalledTimes(RENAME_MAX_ATTEMPTS);
    expect(loadInboxState(TMP).read).toEqual(['initial']);
  });

  it('does not retry a non-transient error', () => {
    mockRename.mockClear();
    mockRename.mockImplementation(() => { throw errno('ENOENT'); });
    expect(() => saveInboxState({ read: ['x'], snoozed: {} }, TMP)).toThrow(/ENOENT/);
    expect(mockRename).toHaveBeenCalledTimes(1);
  });
});
