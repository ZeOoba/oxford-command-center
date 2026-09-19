// IA decongestion Phase 4a — the Worklist destination: Today · Alerts · Calendar · Renewals
// composed from the four existing modules (stubbed here; each has its own suite).
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

vi.mock('../../src/modules/tasks/TasksModule', () => ({ TasksModule: () => <div>tasks-panel</div> }));
vi.mock('../../src/modules/alerts/AlertsModule', () => ({ AlertsModule: () => <div>alerts-panel</div> }));
vi.mock('../../src/modules/calendar/CalendarModule', () => ({ CalendarModule: () => <div>calendar-panel</div> }));
vi.mock('../../src/modules/renewals/RenewalsModule', () => ({ RenewalsModule: () => <div>renewals-panel</div> }));

const alertCounts = { critical: 0, warning: 0, info: 0, snoozed: 0 };
vi.mock('../../src/data/alerts', () => ({ useAlertView: () => ({ items: [], counts: alertCounts, unread: 0 }) }));

import { WorklistModule } from '../../src/modules/worklist/WorklistModule';
import { tabIsSelected } from './tab-test-utils';

function LocationProbe() {
  const l = useLocation();
  return <output data-testid="loc">{l.pathname + l.search}</output>;
}

function renderWorklist(entry = '/worklist') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <WorklistModule />
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  alertCounts.critical = 0;
  alertCounts.warning = 0;
});
afterEach(cleanup);

describe('Worklist destination', () => {
  it('renders the four tabs in order, Today selected by default', async () => {
    renderWorklist();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Today', 'Alerts', 'Calendar', 'Renewals']);
    expect(tabIsSelected('Today')).toBe(true);
    expect(await screen.findByText('tasks-panel')).toBeTruthy();
    expect(screen.queryByText('alerts-panel')).toBeNull(); // inactive panels unmount
  });

  it('?tab=alerts deep-links to Alerts (what the /alerts alias redirects to)', async () => {
    renderWorklist('/worklist?tab=alerts');
    expect(tabIsSelected('Alerts')).toBe(true);
    expect(await screen.findByText('alerts-panel')).toBeTruthy();
    expect(screen.queryByText('tasks-panel')).toBeNull();
  });

  it.each([
    ['calendar', 'Calendar', 'calendar-panel'],
    ['renewals', 'Renewals', 'renewals-panel'],
    ['today', 'Today', 'tasks-panel'],
  ])('every tab id renders: ?tab=%s', async (id, label, panel) => {
    renderWorklist(`/worklist?tab=${id}`);
    expect(tabIsSelected(new RegExp(`^${label}`))).toBe(true);
    expect(await screen.findByText(panel)).toBeTruthy();
  });

  it('an unknown ?tab= falls back to Today', async () => {
    renderWorklist('/worklist?tab=bogus');
    expect(tabIsSelected('Today')).toBe(true);
    expect(await screen.findByText('tasks-panel')).toBeTruthy();
  });

  it('selecting a tab writes ?tab= with replace (no history growth), keeps other params, and drops it for the default', async () => {
    renderWorklist('/worklist?scenario=Downside&still=1');
    await screen.findByText('tasks-panel');
    fireEvent.click(screen.getByRole('tab', { name: 'Calendar' }));
    expect(await screen.findByText('calendar-panel')).toBeTruthy();
    const q = new URLSearchParams(screen.getByTestId('loc').textContent!.split('?')[1]);
    expect(q.get('tab')).toBe('calendar');
    expect(q.get('scenario')).toBe('Downside');
    expect(q.get('still')).toBe('1');
    fireEvent.click(screen.getByRole('tab', { name: 'Today' }));
    expect(new URLSearchParams(screen.getByTestId('loc').textContent!.split('?')[1]).has('tab')).toBe(false);
  });

  it('shows no badge on Alerts when nothing is critical/warning (R7: the tab itself is never hidden)', () => {
    renderWorklist();
    expect(screen.getByRole('tab', { name: 'Alerts' }).textContent).toBe('Alerts');
  });

  it('R4: a critical alert puts a red count badge on the Alerts tab even though Today is selected', () => {
    alertCounts.critical = 3;
    alertCounts.warning = 5;
    renderWorklist();
    const alerts = screen.getByRole('tab', { name: /Alerts/ });
    expect(within(alerts).getByText('3')).toBeTruthy(); // critical wins over the warning count
    expect(tabIsSelected('Today')).toBe(true);
  });

  it('with only warnings, the badge shows the warning count', () => {
    alertCounts.warning = 4;
    renderWorklist();
    expect(within(screen.getByRole('tab', { name: /Alerts/ })).getByText('4')).toBeTruthy();
  });

  it('caps the badge at 99+', () => {
    alertCounts.critical = 150;
    renderWorklist();
    expect(within(screen.getByRole('tab', { name: /Alerts/ })).getByText('99+')).toBeTruthy();
  });
});
