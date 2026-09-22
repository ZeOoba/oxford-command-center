// IA decongestion Phase 4c — the Obligations destination: Insurance · Taxes composed from the two
// existing modules (stubbed here; each has its own suite).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigationType } from 'react-router-dom';

vi.mock('../../src/modules/insurance/InsuranceModule', () => ({ InsuranceModule: () => <div>insurance-panel</div> }));
vi.mock('../../src/modules/taxes/TaxesModule', () => ({ TaxesModule: () => <div>taxes-panel</div> }));

import { ObligationsModule } from '../../src/modules/obligations/ObligationsModule';
import { OBLIGATIONS_TABS } from '../../src/modules/obligations/tabs';
import { tabIsSelected } from './tab-test-utils';

function LocationProbe() {
  const l = useLocation();
  const t = useNavigationType();
  return (
    <>
      <output data-testid="loc">{l.pathname + l.search}</output>
      <output data-testid="nav">{t}</output>
    </>
  );
}

function renderObligations(entry = '/obligations') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <ObligationsModule />
      <LocationProbe />
    </MemoryRouter>,
  );
}

const query = () => new URLSearchParams(screen.getByTestId('loc').textContent!.split('?')[1]);

afterEach(cleanup);

describe('Obligations destination', () => {
  it('declares exactly Insurance · Taxes', () => {
    expect(OBLIGATIONS_TABS.map((t) => [t.id, t.label])).toEqual([['insurance', 'Insurance'], ['taxes', 'Taxes']]);
  });

  it('renders the two tabs in order, Insurance selected by default', async () => {
    renderObligations();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Insurance', 'Taxes']);
    expect(tabIsSelected('Insurance')).toBe(true);
    expect(await screen.findByText('insurance-panel')).toBeTruthy();
    expect(screen.queryByText('taxes-panel')).toBeNull(); // inactive panels unmount
  });

  it('?tab=taxes deep-links to Taxes (what the /taxes alias redirects to)', async () => {
    renderObligations('/obligations?tab=taxes');
    expect(tabIsSelected('Taxes')).toBe(true);
    expect(await screen.findByText('taxes-panel')).toBeTruthy();
    expect(screen.queryByText('insurance-panel')).toBeNull();
  });

  it('an unknown ?tab= falls back to Insurance', async () => {
    renderObligations('/obligations?tab=bogus');
    expect(tabIsSelected('Insurance')).toBe(true);
    expect(await screen.findByText('insurance-panel')).toBeTruthy();
  });

  it('selecting a tab writes ?tab= with replace, keeps other params, and drops it for the default', async () => {
    renderObligations('/obligations?scenario=Downside');
    await screen.findByText('insurance-panel');
    fireEvent.click(screen.getByRole('tab', { name: 'Taxes' }));
    expect(await screen.findByText('taxes-panel')).toBeTruthy();
    expect(query().get('tab')).toBe('taxes');
    expect(query().get('scenario')).toBe('Downside');
    expect(screen.getByTestId('nav').textContent).toBe('REPLACE');
    fireEvent.click(screen.getByRole('tab', { name: 'Insurance' }));
    expect(query().has('tab')).toBe(false);
    expect(query().get('scenario')).toBe('Downside');
  });

  it('Rule H: switching tabs clears a leaked ?view=, keeping other params', async () => {
    renderObligations('/obligations?tab=insurance&view=selfinsure&scenario=Downside');
    await screen.findByText('insurance-panel');
    expect(query().get('view')).toBe('selfinsure'); // precondition: the probe sees the seeded view
    fireEvent.click(screen.getByRole('tab', { name: 'Taxes' }));
    expect(await screen.findByText('taxes-panel')).toBeTruthy();
    expect(query().get('tab')).toBe('taxes');
    expect(query().has('view')).toBe(false);
    expect(query().get('scenario')).toBe('Downside');
  });
});
