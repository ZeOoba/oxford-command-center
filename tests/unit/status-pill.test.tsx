// tests/unit/status-pill.test.tsx
//
// 2026-09-23 review I-3: StatusPill hid the freshness detail below 2xl with display:none, so the
// common 1280–1535px laptop band showed only "LIVE"/"STALE" with the age left to a tooltip on a
// non-focusable div. An actionable state (a static/stale bake, offline) must keep its detail inline at
// every width; only a healthy live feed's "updated Ns ago" may drop to screen-reader-only below 2xl.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { BrainState } from '../../src/contracts/index';

const h = vi.hoisted(() => ({
  state: null as BrainState | null,
  now: Date.parse('2026-06-03T18:00:00.000Z'),
}));
vi.mock('../../src/data/brain-context', () => ({ useBrain: () => ({ state: h.state, refresh: vi.fn(), refreshing: false }) }));
vi.mock('../../src/lib/useNow', () => ({ useNow: () => h.now }));
vi.mock('../../src/lib/stillMode', () => ({ isStill: () => true }));

import { StatusPill } from '../../src/primitives/StatusPill';

const base = (over: Partial<BrainState>): BrainState => ({
  status: 'fresh',
  source: 'workbook',
  lastUpdated: null,
  lastError: null,
  workbookPath: '(test)',
  flagCount: 0,
  ...over,
});
const hoursAgo = (hrs: number) => new Date(h.now - hrs * 3_600_000).toISOString();

afterEach(() => cleanup());

describe('StatusPill freshness detail', () => {
  it('a STALE bake keeps its age inline at every width (no hidden / sr-only class)', () => {
    h.state = base({ source: 'snapshot-fallback', lastUpdated: hoursAgo(48) });
    render(<StatusPill />);
    expect(screen.getByText('Stale')).toBeTruthy();
    const detail = screen.getByText(/baked 2d ago/);
    expect(detail.className).not.toMatch(/\bhidden\b/);
    expect(detail.className).not.toMatch(/sr-only/);
  });

  it('a STATIC (not yet stale) bake also keeps its age inline — a bake age is always actionable', () => {
    h.state = base({ source: 'snapshot-fallback', lastUpdated: hoursAgo(6) });
    render(<StatusPill />);
    expect(screen.getByText('Static')).toBeTruthy();
    const detail = screen.getByText(/baked 6h ago/);
    expect(detail.className).not.toMatch(/\bhidden\b/);
    expect(detail.className).not.toMatch(/sr-only/);
  });

  it('a LIVE feed keeps its detail for screen readers below 2xl and shows it inline from 2xl up', () => {
    h.state = base({ source: 'workbook', lastUpdated: hoursAgo(0) });
    render(<StatusPill />);
    expect(screen.getByText('Live')).toBeTruthy();
    const detail = screen.getByText(/updated just now/);
    expect(detail.className).toContain('sr-only');
    expect(detail.className).toContain('2xl:not-sr-only');
    expect(detail.className).not.toMatch(/\bhidden\b/);
  });
});
