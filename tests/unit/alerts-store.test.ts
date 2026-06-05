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
