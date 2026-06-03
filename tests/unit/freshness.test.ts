import { describe, it, expect } from 'vitest';
import type { BrainState } from '../../src/contracts/index';
import { computeFreshness, formatAge, STALENESS_HOURS } from '../../src/lib/freshness';

const base = (over: Partial<BrainState>): BrainState => ({
  status: 'fresh',
  source: 'workbook',
  lastUpdated: null,
  lastError: null,
  workbookPath: '(test)',
  flagCount: 0,
  ...over,
});

const NOW = Date.parse('2026-06-03T18:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

describe('computeFreshness', () => {
  it('a live workbook feed is "live" and never stale', () => {
    const f = computeFreshness(base({ status: 'fresh', source: 'workbook', lastUpdated: hoursAgo(0) }), NOW);
    expect(f.kind).toBe('live');
    expect(f.isStale).toBe(false);
    expect(f.label).toBe('Live');
  });

  it('a recent static bake is "static", NOT live (Defect 5 regression)', () => {
    const f = computeFreshness(
      base({ status: 'static', source: 'snapshot-fallback', lastUpdated: hoursAgo(6) }),
      NOW,
    );
    expect(f.kind).toBe('static');
    expect(f.label).toBe('Static');
    expect(f.isStale).toBe(false);
    expect(f.detail).toBe('baked 6h ago');
    // The cosmetic lie must be impossible: a bake never reads as "Live".
    expect(f.label).not.toBe('Live');
  });

  it('a static bake older than STALENESS_HOURS is "stale"', () => {
    const f = computeFreshness(
      base({ status: 'static', source: 'snapshot-fallback', lastUpdated: hoursAgo(STALENESS_HOURS + 6) }),
      NOW,
    );
    expect(f.kind).toBe('stale');
    expect(f.isStale).toBe(true);
    expect(f.label).toBe('Stale');
  });

  it('null state is "connecting"; refreshing and error map through', () => {
    expect(computeFreshness(null, NOW).kind).toBe('connecting');
    expect(computeFreshness(base({ status: 'refreshing' }), NOW).kind).toBe('refreshing');
    expect(computeFreshness(base({ status: 'error', source: 'none' }), NOW).kind).toBe('offline');
  });
});

describe('formatAge', () => {
  it('renders compact ages', () => {
    expect(formatAge(3_000)).toBe('just now');
    expect(formatAge(30_000)).toBe('30s ago');
    expect(formatAge(6 * 3_600_000)).toBe('6h ago');
    expect(formatAge(30 * 3_600_000)).toBe('1d ago');
  });
});
