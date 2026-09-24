// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { assessFeeds, FEED_MAX_AGE_DAYS } from '../../server/feed-freshness';

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
