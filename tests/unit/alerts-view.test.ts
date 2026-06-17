import { describe, it, expect, vi } from 'vitest';
import { AlertInboxState, EMPTY_INBOX_STATE } from '../../src/contracts/alerts';
import { applyAlertAction, buildAlertView } from '../../src/brain/alerts-view';
import { anomaliesToInsights } from '../../src/brain/anomaly-insights';
import type { AnomalyFlag } from '../../src/contracts/warehouse';
import type { Insight } from '../../src/analytics/types';

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

const ins = (id: string, severity: Insight['severity']): Insight => ({
  id, severity, category: 'debt', title: id, detail: id,
});
const NOW = Date.parse('2026-06-04T12:00:00.000Z');
const DAY = 86_400_000;

describe('applyAlertAction', () => {
  const base: AlertInboxState = { read: [], snoozed: {} };

  it('marks read and unread', () => {
    const r = applyAlertAction(base, { alertId: 'a', action: 'read' }, NOW);
    expect(r.read).toEqual(['a']);
    const u = applyAlertAction(r, { alertId: 'a', action: 'unread' }, NOW);
    expect(u.read).toEqual([]);
  });

  it('snoozes for 7 or 30 days with the current severity recorded', () => {
    const r = applyAlertAction(base, { alertId: 'a', action: 'snooze', days: 30, severity: 'warning' }, NOW);
    expect(r.snoozed['a']!.severityAtSnooze).toBe('warning');
    expect(Date.parse(r.snoozed['a']!.until)).toBe(NOW + 30 * DAY);
  });

  it('defaults snooze to 7 days and info severity when omitted', () => {
    const r = applyAlertAction(base, { alertId: 'a', action: 'snooze' }, NOW);
    expect(Date.parse(r.snoozed['a']!.until)).toBe(NOW + 7 * DAY);
    expect(r.snoozed['a']!.severityAtSnooze).toBe('info');
  });
});

describe('buildAlertView', () => {
  it('groups by severity, counts, and computes unread', () => {
    const insights = [ins('a', 'info'), ins('b', 'critical'), ins('c', 'warning')];
    const v = buildAlertView(insights, { read: ['c'], snoozed: {} }, NOW);
    expect(v.items.map((i) => i.insight.id)).toEqual(['b', 'c', 'a']); // critical → warning → info
    expect(v.counts).toEqual({ critical: 1, warning: 1, info: 1, snoozed: 0 });
    expect(v.unread).toBe(2); // a + b unread; c is read
  });

  it('hides a still-snoozed alert and counts it as snoozed', () => {
    const state: AlertInboxState = {
      read: [],
      snoozed: { a: { until: new Date(NOW + DAY).toISOString(), severityAtSnooze: 'warning' } },
    };
    const v = buildAlertView([ins('a', 'warning')], state, NOW);
    expect(v.items).toHaveLength(0);
    expect(v.counts.snoozed).toBe(1);
  });

  it('re-shows a snoozed alert once its severity escalates', () => {
    const state: AlertInboxState = {
      read: [],
      snoozed: { a: { until: new Date(NOW + DAY).toISOString(), severityAtSnooze: 'warning' } },
    };
    const v = buildAlertView([ins('a', 'critical')], state, NOW); // escalated warning → critical
    expect(v.items).toHaveLength(1);
    expect(v.counts.snoozed).toBe(0);
  });

  it('re-shows a snoozed alert after the window expires and nulls snoozedUntil', () => {
    const state: AlertInboxState = {
      read: [],
      snoozed: { a: { until: new Date(NOW - DAY).toISOString(), severityAtSnooze: 'warning' } },
    };
    const v = buildAlertView([ins('a', 'warning')], state, NOW);
    expect(v.items).toHaveLength(1);
    expect(v.items[0]!.snoozedUntil).toBeNull(); // expired snooze must not report a stale timestamp
  });

  it('returns an empty view for no insights', () => {
    const v = buildAlertView([], { read: [], snoozed: {} }, NOW);
    expect(v.items).toEqual([]);
    expect(v.counts).toEqual({ critical: 0, warning: 0, info: 0, snoozed: 0 });
    expect(v.unread).toBe(0);
  });

  it('fails open (shows the alert) when a snooze timestamp is malformed', () => {
    const state: AlertInboxState = {
      read: [],
      snoozed: { a: { until: 'not-a-date', severityAtSnooze: 'warning' } },
    };
    const v = buildAlertView([ins('a', 'warning')], state, NOW);
    expect(v.items).toHaveLength(1);
    expect(v.items[0]!.snoozedUntil).toBeNull();
    expect(v.counts.snoozed).toBe(0);
  });

  it('two co-occurring same-kind anomalies keep independent read state (refute F1 regression)', () => {
    // The exact bug class refute F1 fixed: before the subkey, both these category-spikes shared one
    // id, so reading the Taxes alert silently marked the Utilities alert read too. With the subkey in
    // the id they are distinct, and marking one read must leave the other unread.
    const flags: AnomalyFlag[] = [
      { propertyId: 'p1', period: '2025', kind: 'category-spike', subkey: 'Taxes', severity: 'critical', detail: 'Taxes spiked 61.0%', metricValue: 0.61 },
      { propertyId: 'p1', period: '2025', kind: 'category-spike', subkey: 'Utilities', severity: 'high', detail: 'Utilities spiked 42.0%', metricValue: 0.42 },
    ];
    const insights = anomaliesToInsights(flags);
    expect(new Set(insights.map((i) => i.id)).size).toBe(2);
    const taxesId = insights.find((i) => i.detail.includes('Taxes'))!.id;
    const v = buildAlertView(insights, { read: [taxesId], snoozed: {} }, NOW);
    const utilities = v.items.find((it) => it.insight.detail.includes('Utilities'))!;
    expect(utilities.read).toBe(false);
    expect(v.unread).toBe(1);
  });

  it('warns (loudly, once) when two insights share an id — duplicate-id backstop (#5)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    buildAlertView([ins('dup', 'critical'), ins('dup', 'warning')], { read: [], snoozed: {} }, NOW);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dup'));
    warn.mockRestore();
  });
  it('is silent when all insight ids are unique (no noise in correct operation)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    buildAlertView([ins('a', 'critical'), ins('b', 'warning')], { read: [], snoozed: {} }, NOW);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
