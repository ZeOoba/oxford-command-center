import { describe, expect, it } from 'vitest';
import { isBriefStale, BRIEF_STALE_HOURS } from '../../src/lib/freshness';

describe('isBriefStale', () => {
  const now = Date.parse('2026-09-23T12:00:00Z');
  it('a brief that last ran 76 days ago is stale, even with zero failures', () => {
    expect(isBriefStale('2026-07-09T11:00:00Z', now)).toBe(true);
  });
  it('this morning’s brief is fresh', () => {
    expect(isBriefStale('2026-09-23T10:45:00Z', now)).toBe(false);
    expect(BRIEF_STALE_HOURS).toBe(36);
  });
  // I-3 (2026-09-23 review): the card badge (this function) and the Data Feeds row
  // (server/feed-freshness.ts) must agree at the exact 36h boundary.
  it('exactly 36h old is fresh, 36h + 1ms old is stale', () => {
    const exactly36h = now - 36 * 3_600_000;
    const over36h = now - (36 * 3_600_000 + 1);
    expect(isBriefStale(new Date(exactly36h).toISOString(), now)).toBe(false);
    expect(isBriefStale(new Date(over36h).toISOString(), now)).toBe(true);
  });
  it('an invalid/unparseable ranAt is treated as stale (fail-closed)', () => {
    expect(isBriefStale('not-a-date', now)).toBe(true);
  });
});
