import { describe, it, expect, afterEach } from 'vitest';
import { rmSync, existsSync, writeFileSync } from 'node:fs';
import { loadInboxState, saveInboxState, runAlertAction } from '../../server/alerts/store';

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
});
