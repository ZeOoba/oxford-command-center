import { describe, expect, it } from 'vitest';
import { feedRowTone, feedRowValue, feedsBadge } from '../../src/modules/health/feed-row';
import type { FeedHealth } from '../../src/lib/feed-health';

const f = (o: Partial<FeedHealth>): FeedHealth => ({ id: 'ar', label: 'AR aging (QuickBooks)', lastAt: null, ageDays: 34, maxAgeDays: 35, status: 'fresh', fix: 'Run the QuickBooks AR export + ar-import-headless', ...o });

describe('feed-row', () => {
  it('a note leads the value and turns a fresh row amber', () => {
    const row = f({ note: '7 leases with stale AR' });
    expect(feedRowValue(row)).toBe('7 leases with stale AR · 34d old');
    expect(feedRowTone(row)).toBe('warn');
  });
  it('unchanged wording for fresh / stale / missing without a note', () => {
    expect(feedRowValue(f({}))).toBe('34d old');
    expect(feedRowTone(f({}))).toBe('ok');
    expect(feedRowValue(f({ status: 'stale', ageDays: 71 }))).toBe('71d old (max 35d) — Run the QuickBooks AR export + ar-import-headless');
    expect(feedRowValue(f({ status: 'missing', ageDays: null }))).toBe('never — Run the QuickBooks AR export + ar-import-headless');
    expect(feedRowTone(f({ status: 'missing' }))).toBe('error');
  });
  it('badge: red on missing, amber on stale or a note, green otherwise; counts every non-ok row', () => {
    expect(feedsBadge([f({}), f({ status: 'missing' })])).toEqual({ tone: 'red', label: '1 need attention' });
    expect(feedsBadge([f({ note: 'x' }), f({ status: 'stale' })])).toEqual({ tone: 'amber', label: '2 need attention' });
    expect(feedsBadge([f({})])).toEqual({ tone: 'green', label: '0 need attention' });
  });
});
