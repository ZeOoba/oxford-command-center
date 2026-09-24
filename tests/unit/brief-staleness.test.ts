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
});
