// I-2 (2026-09-23 review): HealthModule's /api/health fetch ran once on mount (effect deps []).
// Opened during startup — port bound before refresh (Task 7) — snapshot/cash/AR/docIndex could
// show a permanent "never" false alarm with no way to clear it short of a manual reload. The fix
// re-fetches whenever the brain state's status changes (not on lastUpdated-only write-backs).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import type { BrainState } from '../../src/contracts/brain';

const snap: { data: unknown } = { data: undefined };
const brain: { state: BrainState | null } = { state: null };
vi.mock('../../src/data/queries', () => ({ useSnapshot: () => snap }));
vi.mock('../../src/data/brain-context', () => ({ useBrain: () => brain }));

import { HealthModule } from '../../src/modules/health/HealthModule';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function fetchStub() {
  return vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ feeds: [] }) });
}

const idle: BrainState = { status: 'idle', source: 'none', lastUpdated: null, lastError: null, workbookPath: '', flagCount: 0 };
const fresh: BrainState = { status: 'fresh', source: 'workbook', lastUpdated: '2026-09-23T12:00:00Z', lastError: null, workbookPath: '', flagCount: 0 };

describe('HealthModule — /api/health re-fetch keyed on brain state (I-2)', () => {
  it('re-fetches once the brain state advances past the initial mount', async () => {
    brain.state = idle;
    const fetchMock = fetchStub();
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(<HealthModule />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    brain.state = fresh; // the brain server finished its first real refresh
    rerender(<HealthModule />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('does not re-fetch on a re-render where status/lastUpdated are unchanged', async () => {
    brain.state = fresh;
    const fetchMock = fetchStub();
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(<HealthModule />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender(<HealthModule />); // same status/lastUpdated — must not trigger another fetch
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not re-fetch when only lastUpdated moves (a UI write-back, not a refresh)', async () => {
    brain.state = fresh;
    const fetchMock = fetchStub();
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(<HealthModule />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    brain.state = { ...fresh, lastUpdated: '2026-09-23T12:05:00Z' }; // rederive() after e.g. setDealStage
    rerender(<HealthModule />);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// M5 (2026-09-23 review): the Data Feeds header badge must read red when any feed is missing
// (worse than merely stale), amber when only stale, green otherwise — not just amber/green.
describe('HealthModule — Data Feeds header badge tone (M5)', () => {
  const freshFeed = { id: 'snapshot', label: 'Workbook snapshot', lastAt: '2026-09-23T00:00:00Z', ageDays: 0, maxAgeDays: 2, status: 'fresh' as const, fix: 'x' };
  const staleFeed = { ...freshFeed, id: 'cashHistory', status: 'stale' as const };
  const missingFeed = { ...freshFeed, id: 'leaseMarket', lastAt: null, ageDays: null, status: 'missing' as const };

  it('is red when any feed is missing, even if others are merely stale', async () => {
    brain.state = fresh;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ feeds: [staleFeed, missingFeed] }) }));
    render(<HealthModule />);
    const badge = await screen.findByText(/need attention/);
    await waitFor(() => expect((badge.closest('span') as HTMLElement).getAttribute('style')).toContain('--text-neg'));
  });

  it('is amber when feeds are stale but none is missing', async () => {
    brain.state = fresh;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ feeds: [staleFeed, freshFeed] }) }));
    render(<HealthModule />);
    const badge = await screen.findByText(/need attention/);
    await waitFor(() => expect((badge.closest('span') as HTMLElement).getAttribute('style')).toContain('--text-warn'));
  });

  it('is green when every feed is fresh', async () => {
    brain.state = fresh;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ feeds: [freshFeed] }) }));
    render(<HealthModule />);
    const badge = await screen.findByText(/need attention/);
    await waitFor(() => expect((badge.closest('span') as HTMLElement).getAttribute('style')).toContain('--text-pos'));
  });
});
