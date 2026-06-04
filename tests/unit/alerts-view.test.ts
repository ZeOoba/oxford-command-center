import { describe, it, expect } from 'vitest';
import { AlertInboxState, EMPTY_INBOX_STATE } from '../../src/contracts/alerts';

describe('AlertInboxState contract', () => {
  it('defaults missing fields to empty', () => {
    const s = AlertInboxState.parse({});
    expect(s).toEqual({ read: [], snoozed: {} });
  });

  it('parses a populated state', () => {
    const s = AlertInboxState.parse({
      read: ['balloon-l1'],
      snoozed: { 'cash-concentration': { until: '2026-07-01T00:00:00.000Z', severityAtSnooze: 'info' } },
    });
    expect(s.read).toContain('balloon-l1');
    expect(s.snoozed['cash-concentration']!.severityAtSnooze).toBe('info');
  });

  it('exposes a frozen-ish EMPTY_INBOX_STATE default', () => {
    expect(EMPTY_INBOX_STATE).toEqual({ read: [], snoozed: {} });
  });
});
