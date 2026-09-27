// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { assessFeeds, arFeedInput, FEED_MAX_AGE_DAYS } from '../../server/feed-freshness';

const NOW = Date.parse('2026-09-23T12:00:00Z');

describe('assessFeeds', () => {
  it('grades each feed against its own max age and reports missing feeds', () => {
    const feeds = assessFeeds({
      snapshot: '2026-09-22T14:38:33Z',
      cashHistory: '2026-07-10',
      ar: '2026-07-15',
      dailyBrief: '2026-07-09T11:00:00Z',
      leaseMarket: null,
      docIndex: '2026-06-06T15:54:00Z',
    }, NOW);
    const by = Object.fromEntries(feeds.map((f) => [f.id, f]));
    expect(by.snapshot!.status).toBe('fresh');
    expect(by.cashHistory!.status).toBe('stale');
    expect(by.ar!.status).toBe('stale');
    expect(by.dailyBrief!.status).toBe('stale');
    expect(by.dailyBrief!.ageDays).toBe(76);
    expect(by.leaseMarket!.status).toBe('missing');
    expect(by.docIndex!.status).toBe('stale');
    expect(feeds.every((f) => f.fix.length > 0)).toBe(true);
    expect(FEED_MAX_AGE_DAYS.dailyBrief).toBe(1.5);
  });

  // I-3 (2026-09-23 review): the Data Feeds row's dailyBrief budget (1.5 days) must agree with the
  // card badge's BRIEF_STALE_HOURS = 36 (src/lib/freshness.ts) to the millisecond, not just the day.
  it('dailyBrief boundary: exactly 36h old is fresh, 36h + 1min old is stale', () => {
    const exactly36h = new Date(NOW - 36 * 60 * 60 * 1000).toISOString();
    const over36h = new Date(NOW - (36 * 60 * 60 * 1000 + 60 * 1000)).toISOString();
    const feedsAt = assessFeeds({
      snapshot: null, cashHistory: null, ar: null, leaseMarket: null, docIndex: null,
      dailyBrief: exactly36h,
    }, NOW);
    const feedsOver = assessFeeds({
      snapshot: null, cashHistory: null, ar: null, leaseMarket: null, docIndex: null,
      dailyBrief: over36h,
    }, NOW);
    expect(feedsAt.find((f) => f.id === 'dailyBrief')!.status).toBe('fresh');
    expect(feedsOver.find((f) => f.id === 'dailyBrief')!.status).toBe('stale');
  });

  it('a feed exactly at its own maxAgeDays boundary is fresh (ms-exact comparison, not floor-then-compare)', () => {
    const exactlyAtMax = new Date(NOW - FEED_MAX_AGE_DAYS.leaseMarket * 24 * 60 * 60 * 1000).toISOString();
    const feeds = assessFeeds({
      snapshot: null, cashHistory: null, ar: null, dailyBrief: null, docIndex: null,
      leaseMarket: exactlyAtMax,
    }, NOW);
    expect(feeds.find((f) => f.id === 'leaseMarket')!.status).toBe('fresh');
  });
});

describe('arFeedInput — newest import drives freshness; stale per-lease records ride as a note (ratified 2026-09-24)', () => {
  const NOW2 = Date.parse('2026-09-24T12:00:00Z');
  const none = { snapshot: null, cashHistory: null, dailyBrief: null, leaseMarket: null, docIndex: null };

  it('live shape: 37 records from 2026-08-21 + 7 from 2026-07-15 → fresh at 34d with "7 leases with stale AR"', () => {
    const arrears: Record<string, { asOfDate?: Date | null }> = {};
    for (let i = 0; i < 37; i++) arrears[`f${i}`] = { asOfDate: new Date('2026-08-21T00:00:00.000Z') };
    for (let i = 0; i < 7; i++) arrears[`s${i}`] = { asOfDate: new Date('2026-07-15T00:00:00.000Z') };
    const ar = arFeedInput(arrears, NOW2);
    expect(ar).toEqual({ lastAt: '2026-08-21T00:00:00.000Z', staleLeaseCount: 7, note: '7 leases with stale AR' });
    const feed = assessFeeds({ ...none, ar: ar.lastAt }, NOW2, { ar: ar.note }).find((f) => f.id === 'ar')!;
    expect(feed).toMatchObject({ status: 'fresh', ageDays: 34, note: '7 leases with stale AR' });
  });
  it('accepts ISO strings (a JSON-loaded snapshot) as well as Dates', () => {
    const ar = arFeedInput({ a: { asOfDate: '2026-09-20T00:00:00.000Z' } }, NOW2);
    expect(ar).toEqual({ lastAt: '2026-09-20T00:00:00.000Z', staleLeaseCount: 0, note: undefined });
  });
  it('a null asOfDate is stale but never the newest import; singular note', () => {
    const ar = arFeedInput({ a: { asOfDate: null }, b: { asOfDate: new Date('2026-09-20T00:00:00.000Z') } }, NOW2);
    expect(ar).toEqual({ lastAt: '2026-09-20T00:00:00.000Z', staleLeaseCount: 1, note: '1 lease with stale AR' });
  });
  it('legacy records with no asOfDate field are neither dated nor stale; empty → missing', () => {
    expect(arFeedInput({ a: {} }, NOW2)).toEqual({ lastAt: null, staleLeaseCount: 0, note: undefined });
    expect(arFeedInput({}, NOW2)).toEqual({ lastAt: null, staleLeaseCount: 0, note: undefined });
  });
  it('assessFeeds without notes adds no note key (backward compatible)', () => {
    const feed = assessFeeds({ ...none, ar: '2026-09-20T00:00:00.000Z' }, NOW2).find((f) => f.id === 'ar')!;
    expect('note' in feed).toBe(false);
  });
});
