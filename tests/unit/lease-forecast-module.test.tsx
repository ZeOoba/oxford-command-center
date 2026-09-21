// tests/unit/lease-forecast-module.test.tsx
//
// Render coverage for the forecast-backed tabs of the Leasing destination (LeaseForecastModule) — IA
// decongestion Phase 2, extended in Phase 4d. Layout under test: expiry-bucket cards ABOVE the strip
// (R2, forecast-backed tabs only); Rollover (velocity) · Forecast (rent-forecast scenario + AI narrative
// beneath it) · Market rents (editor). The destination strip / absorbed panels / Rule G live in
// leasing-destination.test.tsx. The forecast query and the snapshot are seeded straight into the
// QueryClient cache so the render is network-free.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { LeaseForecastModule } from '../../src/modules/leasing/LeaseForecastModule';
import { LEASING_KEYS } from '../../src/modules/leasing/hooks';
import { SNAPSHOT_KEY } from '../../src/data/queries';
import type { LeaseForecastResponse } from '../../src/contracts/lease-forecast';

const FORECAST: LeaseForecastResponse = {
  asOf: '2026-09-19',
  signals: [],
  marketGaps: [],
  velocity: [
    { propertyId: 'p1', propertyName: 'Rarig Ave', medianDaysToLease: 42, leasingEventsN: 5, slowLeasing: false },
    { propertyId: 'p2', propertyName: 'Westgate Park', medianDaysToLease: 130, leasingEventsN: 3, slowLeasing: true },
  ],
  bucketTotals: [
    { bucket: '0-6m', count: 7, expiringRent: 250_000, expiringSf: 31_000 },
    { bucket: '6-12m', count: 4, expiringRent: 120_000, expiringSf: 18_000 },
  ],
};

function renderModule(entry = '/leasing') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  qc.setQueryData(LEASING_KEYS.forecast, FORECAST);
  qc.setQueryData(SNAPSHOT_KEY, { snapshot: { marketRents: { 'rarig-ave': 8.5 } } });
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={qc}>
        <LeaseForecastModule />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const clickTab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LeaseForecastModule — tab structure', () => {
  it('lands on Rollover: velocity table visible, other tabs\' content not rendered', () => {
    renderModule();
    expect(screen.getByRole('tab', { name: 'Rollover' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Leasing Velocity')).toBeTruthy();
    expect(screen.getByText('Westgate Park')).toBeTruthy();
    expect(screen.queryByText('Rent Forecast')).toBeNull();
    expect(screen.queryByText('AI Leasing Narrative')).toBeNull();
    expect(screen.queryByLabelText('Property key for market rent')).toBeNull();
  });

  it('keeps the expiry-bucket cards above the strip on the forecast-backed tabs (R2)', () => {
    renderModule();
    expect(screen.getByText('0–6 Months')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
    clickTab('Market rents');
    expect(screen.getByText('0–6 Months')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
  });

  it('Forecast tab holds the scenario selector and the AI narrative beneath it (nothing lost)', () => {
    renderModule();
    clickTab('Forecast');
    expect(screen.getByText('Rent Forecast')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run rent forecast' })).toBeTruthy();
    expect(screen.getByText('AI Leasing Narrative')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Generate leasing narrative' })).toBeTruthy();
    expect(screen.queryByText('Leasing Velocity')).toBeNull();
  });

  it('Market rents tab holds the editor with its existing entries (nothing lost)', () => {
    renderModule();
    clickTab('Market rents');
    expect(screen.getByLabelText('Property key for market rent')).toBeTruthy();
    expect(screen.getByText('rarig-ave')).toBeTruthy();
    expect(screen.getByText('$8.50/SF')).toBeTruthy();
    expect(screen.queryByText('Leasing Velocity')).toBeNull();
  });

  it('deep-links a non-default tab via ?tab=', () => {
    renderModule('/leasing?tab=forecast');
    expect(screen.getByRole('tab', { name: 'Forecast' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Rent Forecast')).toBeTruthy();
    expect(screen.queryByText('Leasing Velocity')).toBeNull();
  });

  it('shows no count badge on any tab (no severity-bearing item lives off the default tab)', () => {
    renderModule();
    for (const name of ['Rollover', 'Rent roll', 'Forecast', 'Market rents', 'Tenants']) {
      expect(screen.getByRole('tab', { name }).textContent).toBe(name);
    }
  });
});

describe('LeaseForecastModule — scenario selector (SegmentedControl, R5)', () => {
  it('is a radiogroup with the three scenarios; Renew at Current is selected by default', () => {
    renderModule('/leasing?tab=forecast');
    const group = screen.getByRole('radiogroup', { name: 'Rent forecast scenario' });
    expect(group).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect((screen.getByRole('radio', { name: 'Renew at Current' }) as HTMLInputElement).checked).toBe(true);
  });

  it('switching scenario is local: selects it, and only Vacancy Haircut reveals the vacancy slider', () => {
    renderModule('/leasing?tab=forecast');
    expect(screen.queryByLabelText('Vacancy percentage')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Vacancy Haircut' }));
    expect((screen.getByRole('radio', { name: 'Vacancy Haircut' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByLabelText('Vacancy percentage')).toBeTruthy();
    // No fetch fired by merely picking a scenario — only the explicit Run press does.
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});
