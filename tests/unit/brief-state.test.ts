import { describe, it, expect } from 'vitest';
import { diffCriticalAlerts, shouldSendBrief, etNow, type AlertState } from '../../server/brief/state';

const emptyState: AlertState = { alertedCriticalIds: [], lastBriefDate: null, dealStages: {} };

describe('diffCriticalAlerts', () => {
  it('alerts only newly-appeared critical ids', () => {
    const r = diffCriticalAlerts(['a', 'b'], { ...emptyState, alertedCriticalIds: ['a'] });
    expect(r.toAlert).toEqual(['b']);
  });
  it('drops resolved ids so a recurrence re-alerts later', () => {
    const r = diffCriticalAlerts(['b'], { ...emptyState, alertedCriticalIds: ['a', 'b'] });
    expect(r.nextAlerted).toEqual(['b']); // 'a' resolved → cleared
  });
  it('no re-alert when nothing changed', () => {
    const r = diffCriticalAlerts(['a'], { ...emptyState, alertedCriticalIds: ['a'] });
    expect(r.toAlert).toEqual([]);
  });
});

describe('shouldSendBrief (06:45 ET, once per ET day)', () => {
  it('fires at/after 06:45 when not yet sent today', () => {
    expect(shouldSendBrief({ ...emptyState, lastBriefDate: '2026-06-03' }, { date: '2026-06-04', minutes: 405 })).toBe(true);
  });
  it('does not fire before 06:45', () => {
    expect(shouldSendBrief({ ...emptyState, lastBriefDate: '2026-06-03' }, { date: '2026-06-04', minutes: 404 })).toBe(false);
  });
  it('does not fire twice the same ET day', () => {
    expect(shouldSendBrief({ ...emptyState, lastBriefDate: '2026-06-04' }, { date: '2026-06-04', minutes: 600 })).toBe(false);
  });
});

describe('etNow', () => {
  it('returns an ET YYYY-MM-DD date and minutes-since-midnight', () => {
    const r = etNow(new Date('2026-06-04T12:00:00Z')); // noon UTC = 08:00 ET (EDT)
    expect(r.date).toBe('2026-06-04');
    expect(r.minutes).toBe(8 * 60);
  });
});
