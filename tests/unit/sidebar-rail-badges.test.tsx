// The rail used to be silent: a badge existed only on a tab, so you had to open Worklist to learn it
// held critical alerts. The rail now reuses each destination's existing tab-badge hooks (same data,
// no new request) and shows the worst one next to the destination name.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ViewProfileProvider } from '../../src/brain/view-profile';

vi.mock('../../src/data/alerts', () => ({
  useAlertView: () => ({ counts: { critical: 2, warning: 5 } }),
}));
vi.mock('../../src/data/queries', () => ({
  useAnalytics: () => ({ analytics: { criticalDates: [{ daysToDate: -1 }, { daysToDate: -3 }, { daysToDate: 4 }] } }),
}));
vi.mock('../../src/modules/command-brain/hooks', () => ({
  useBrainReport: () => ({ error: null, data: { openQuestions: [1, 2, 3, 4] } }),
  isWarehouseUnavailable: () => false,
}));

import { Sidebar } from '../../src/shell/Sidebar';

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

function renderRail(collapsed = false) {
  render(
    <ViewProfileProvider>
      <Sidebar activeId="overview" onSelect={vi.fn()} collapsed={collapsed} onToggle={vi.fn()} mobileOpen={false} onMobileClose={vi.fn()} />
    </ViewProfileProvider>,
  );
}

const railItem = (label: string) => screen.getByRole('button', { name: new RegExp(`^${label}`) });

describe('Sidebar rail badges', () => {
  it('shows the critical alert count on Worklist (critical outranks the 5 warnings)', () => {
    renderRail();
    expect(railItem('Worklist').textContent).toBe('Worklist2');
  });

  it('shows overdue critical dates on Leasing and open questions on Brain', () => {
    renderRail();
    expect(railItem('Leasing').textContent).toBe('Leasing2');
    expect(railItem('Brain').textContent).toBe('Brain4');
  });

  it('shows no badge on a destination whose tabs declare none', () => {
    renderRail();
    expect(railItem('Portfolio').textContent).toBe('Portfolio');
  });

  it('keeps the count visible when the rail is collapsed', () => {
    renderRail(true);
    expect(railItem('Worklist').textContent).toBe('2');
  });

  it('names the count for assistive tech and collapsed hover', () => {
    renderRail(true);
    expect(railItem('Worklist').getAttribute('title')).toBe('Worklist (2)');
  });
});
