// @vitest-environment node
//
// F1 matrix (spec §9): fresh / exactly-7 / 8-day / mtime-newer-than-pulled / mtime-older /
// future mtime (clock skew → stale, ageDays clamped ≥ 0).
import { describe, expect, it } from 'vitest';
import { edgeFreshness } from '../../server/edge/freshness';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const ms = (iso: string) => Date.parse(iso);

describe('edgeFreshness', () => {
  it('spec example: pulled 2026-07-14 → 80 days old, STALE', () => {
    const f = edgeFreshness('2026-07-14', ms('2026-07-14T18:38:00.000Z'), NOW);
    expect(f).toEqual({
      metaPulled: '2026-07-14', fileMtime: '2026-07-14T18:38:00.000Z', asOf: '2026-07-14',
      ageDays: 80, staleAfterDays: 7, stale: true,
    });
  });

  it('fresh: same day → 0 days, not stale', () => {
    const f = edgeFreshness('2026-10-02', ms('2026-10-02T08:00:00Z'), NOW);
    expect(f.ageDays).toBe(0);
    expect(f.stale).toBe(false);
  });

  it('exactly 7 days → not stale', () => {
    const f = edgeFreshness('2026-09-25', ms('2026-09-25T10:00:00Z'), NOW);
    expect(f.ageDays).toBe(7);
    expect(f.stale).toBe(false);
  });

  it('8 days → stale', () => {
    const f = edgeFreshness('2026-09-24', ms('2026-09-24T10:00:00Z'), NOW);
    expect(f.ageDays).toBe(8);
    expect(f.stale).toBe(true);
  });

  it('mtime newer than pulled (OneDrive re-sync) never makes old data read fresh', () => {
    const f = edgeFreshness('2026-07-14', ms('2026-10-01T10:00:00Z'), NOW);
    expect(f.asOf).toBe('2026-07-14');
    expect(f.ageDays).toBe(80);
    expect(f.stale).toBe(true);
  });

  it('mtime older than pulled → asOf is the mtime date', () => {
    const f = edgeFreshness('2026-09-30', ms('2026-07-14T18:38:00Z'), NOW);
    expect(f.asOf).toBe('2026-07-14');
    expect(f.stale).toBe(true);
  });

  it('future mtime (clock skew) → stale even when the pulled date is recent', () => {
    const f = edgeFreshness('2026-10-01', ms('2026-10-05T00:00:00Z'), NOW);
    expect(f.asOf).toBe('2026-10-01');
    expect(f.ageDays).toBe(1);
    expect(f.stale).toBe(true);
  });

  it('future pulled + future mtime → ageDays clamped to 0 and stale', () => {
    const f = edgeFreshness('2026-10-04', ms('2026-10-05T00:00:00Z'), NOW);
    expect(f.ageDays).toBe(0);
    expect(f.stale).toBe(true);
  });
});
