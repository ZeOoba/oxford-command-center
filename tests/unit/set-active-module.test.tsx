// Rule H at the rail: `setActiveModule` is what the Sidebar, the AlertBell, the HealthDot, the
// Overview KPI links and the command palette's "Go to <module>" entries all call. It is handed a
// BARE module id, so the `?tab=` / `?view=` already on the URL belong to the destination being
// LEFT — carrying them across is the cross-tab leak Rule H forbids (`/capital?tab=debt&view=scorecard`
// + a "Leasing" rail click must not produce `/leasing?tab=debt&view=scorecard`). Everything else
// (`?scenario=`, `?still=`, …) rides along, and a legacy id still resolves to its destination + tab.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

// The registry imports the tab-badge hooks, which reach the data layer. Never invoked here.
vi.mock('../../src/shell/tab-badges', () => ({
  useAlertsTabBadge: () => undefined,
  useCriticalDatesTabBadge: () => undefined,
  useTabBadges: () => [],
  useTabSpecs: (tabs: ReadonlyArray<{ id: string; label: string }>) => tabs.map((t) => ({ id: t.id, label: t.label })),
}));

import { UiProvider } from '../../src/brain/UiProvider';
import { useUi } from '../../src/brain/ui-context';

const JUMPS = ['leasing', 'alerts', 'debt'] as const;

function Probe() {
  const ui = useUi();
  const loc = useLocation();
  return (
    <>
      <output data-testid="loc">{`${loc.pathname}${loc.search}`}</output>
      {JUMPS.map((id) => (
        <button key={id} onClick={() => ui.setActiveModule(id)}>{`go-${id}`}</button>
      ))}
    </>
  );
}

function renderAt(entry: string) {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <UiProvider>
        <Probe />
      </UiProvider>
    </MemoryRouter>,
  );
  // Non-vacuous precondition: the params we expect to be dropped are actually on the URL.
  expect(screen.getByTestId('loc').textContent).toBe(entry);
}

const loc = () => screen.getByTestId('loc').textContent;

afterEach(cleanup);

describe('setActiveModule — Rule H: ?tab= / ?view= never ride along to another destination', () => {
  it('a rail jump to another destination drops tab AND view, keeping ?scenario=', () => {
    renderAt('/capital?tab=debt&view=scorecard&scenario=Downside');
    fireEvent.click(screen.getByText('go-leasing'));
    expect(loc()).toBe('/leasing?scenario=Downside');
  });

  it('a legacy id still resolves to its destination + its OWN tab, not the stale one', () => {
    renderAt('/capital?tab=debt&view=scorecard&scenario=Downside');
    fireEvent.click(screen.getByText('go-alerts'));
    expect(loc()).toBe('/worklist?scenario=Downside&tab=alerts');
  });

  it('an absorbed id whose destination is the CURRENT one still lands on its own tab, view cleared', () => {
    renderAt('/capital?tab=cash&view=ladder&scenario=Downside');
    fireEvent.click(screen.getByText('go-debt'));
    expect(loc()).toBe('/capital?scenario=Downside&tab=debt');
  });

  it('leaves a clean URL when tab/view were the only params', () => {
    renderAt('/capital?tab=debt&view=scorecard');
    fireEvent.click(screen.getByText('go-leasing'));
    expect(loc()).toBe('/leasing');
  });

  it('preserves every other param (?still=) alongside ?scenario=', () => {
    renderAt('/capital?tab=debt&still=1&scenario=Upside&view=scorecard');
    fireEvent.click(screen.getByText('go-leasing'));
    expect(loc()).toBe('/leasing?still=1&scenario=Upside');
  });
});
