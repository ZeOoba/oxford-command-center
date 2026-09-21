// tests/unit/leasing-destination.test.tsx
//
// IA decongestion Phase 4d — the Leasing destination: Rollover · Rent roll · Forecast · Market rents ·
// Tenants. LeaseForecastModule owns the strip; Rent roll (LeasesModule) and Tenants (TenantsModule) are
// lazy-mounted panels (mocked here — each has its own suite).
//   R2  — the expiry-bucket cards sit above the strip and render ONLY on the forecast-backed tabs.
//   Rule G — the forecast offline gate is scoped to those tabs: with the forecast route 503-ing (the
//            static mirror), Rent roll and Tenants must still mount.
//   Rule H — switching a destination tab clears `?view=` (owned by Rent roll's inner SegmentedControl).
// The forecast + snapshot queries are seeded into the QueryClient cache (network-free) except in the
// Rule-G cases, which drive the REAL useLeaseForecast hook into WarehouseUnavailableError via a 503 fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { LeaseForecastModule } from '../../src/modules/leasing/LeaseForecastModule';
import { LEASING_KEYS } from '../../src/modules/leasing/hooks';
import { SNAPSHOT_KEY } from '../../src/data/queries';
import type { LeaseForecastResponse } from '../../src/contracts/lease-forecast';

vi.mock('../../src/modules/leases/LeasesModule', () => ({ LeasesModule: () => <div>leases-panel</div> }));
vi.mock('../../src/modules/tenants/TenantsModule', () => ({ TenantsModule: () => <div>tenants-panel</div> }));

const FORECAST: LeaseForecastResponse = {
  asOf: '2026-09-19',
  signals: [],
  marketGaps: [],
  velocity: [{ propertyId: 'p1', propertyName: 'Rarig Ave', medianDaysToLease: 42, leasingEventsN: 5, slowLeasing: false }],
  bucketTotals: [
    { bucket: '0-6m', count: 7, expiringRent: 250_000, expiringSf: 31_000 },
    { bucket: '6-12m', count: 4, expiringRent: 120_000, expiringSf: 18_000 },
  ],
};

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.search}</div>;
}

function renderModule(entry = '/leasing', { seeded = true }: { seeded?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  if (seeded) {
    qc.setQueryData(LEASING_KEYS.forecast, FORECAST);
    qc.setQueryData(SNAPSHOT_KEY, { snapshot: { marketRents: { 'rarig-ave': 8.5 } } });
  }
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={qc}>
        <LeaseForecastModule />
        <LocationProbe />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const clickTab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));
const selected = (name: string) => screen.getByRole('tab', { name }).getAttribute('aria-selected') === 'true';
const search = () => new URLSearchParams(screen.getByTestId('loc').textContent ?? '');
const BUCKET = '0–6 Months';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Leasing destination — strip + default', () => {
  it('declares the five tabs in order and lands on Rollover (not a big table)', () => {
    renderModule();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Rollover', 'Rent roll', 'Forecast', 'Market rents', 'Tenants']);
    expect(selected('Rollover')).toBe(true);
    expect(screen.getByText('Leasing Velocity')).toBeTruthy();
    expect(screen.queryByText('leases-panel')).toBeNull();
    expect(screen.queryByText('tenants-panel')).toBeNull();
  });

  it('deep-links every tab via ?tab=', async () => {
    renderModule('/leasing?tab=rent-roll');
    expect(selected('Rent roll')).toBe(true);
    expect(await screen.findByText('leases-panel')).toBeTruthy();
    cleanup();
    renderModule('/leasing?tab=tenants');
    expect(selected('Tenants')).toBe(true);
    expect(await screen.findByText('tenants-panel')).toBeTruthy();
    cleanup();
    renderModule('/leasing?tab=bogus');
    expect(selected('Rollover')).toBe(true);
  });

  it('Rent roll and Tenants panels mount lazily on selection', async () => {
    renderModule();
    clickTab('Rent roll');
    expect(await screen.findByText('leases-panel')).toBeTruthy();
    clickTab('Tenants');
    expect(await screen.findByText('tenants-panel')).toBeTruthy();
    expect(screen.queryByText('leases-panel')).toBeNull();
  });

  it('arrow keys move focus without switching tab (manual activation: panels mount their own queries)', () => {
    renderModule();
    const rollover = screen.getByRole('tab', { name: 'Rollover' });
    rollover.focus();
    fireEvent.keyDown(rollover, { key: 'ArrowRight' });
    expect(selected('Rollover')).toBe(true);
  });
});

describe('Leasing destination — expiry-bucket cards are scoped to the forecast-backed tabs (R2 / Rule G)', () => {
  for (const [entry, name] of [['/leasing', 'Rollover'], ['/leasing?tab=forecast', 'Forecast'], ['/leasing?tab=market-rents', 'Market rents']] as const) {
    it(`render above the strip on ${name}`, () => {
      renderModule(entry);
      expect(selected(name)).toBe(true);
      expect(screen.getByText(BUCKET)).toBeTruthy();
      expect(screen.getByText('7')).toBeTruthy();
    });
  }

  for (const [entry, name] of [['/leasing?tab=rent-roll', 'Rent roll'], ['/leasing?tab=tenants', 'Tenants']] as const) {
    it(`do NOT render on ${name}`, () => {
      renderModule(entry);
      expect(selected(name)).toBe(true);
      expect(screen.queryByText(BUCKET)).toBeNull();
      expect(screen.queryByText('6–12 Months')).toBeNull();
    });
  }

  it('follow the tab as it changes', () => {
    renderModule();
    expect(screen.getByText(BUCKET)).toBeTruthy();
    clickTab('Rent roll');
    expect(screen.queryByText(BUCKET)).toBeNull();
    clickTab('Forecast');
    expect(screen.getByText(BUCKET)).toBeTruthy();
  });
});

describe('Leasing destination — Rule G: a 503 forecast route must not blank Rent roll or Tenants', () => {
  const stub503 = () =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'no warehouse' }), { status: 503, headers: { 'content-type': 'application/json' } })));

  it('the forecast tabs show the offline card (and no bucket cards) while the strip stays', async () => {
    stub503();
    renderModule('/leasing', { seeded: false });
    expect(await screen.findByText('Leasing Intelligence Unavailable', {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByText(BUCKET)).toBeNull();
    expect(screen.getAllByRole('tab')).toHaveLength(5);
    clickTab('Forecast');
    expect(screen.getByText('Leasing Intelligence Unavailable')).toBeTruthy();
    clickTab('Market rents');
    // the market-rent editor writes to the overlay, so it stays usable on the mirror
    expect(screen.getByText('Leasing Intelligence Unavailable')).toBeTruthy();
    expect(screen.getByLabelText('Property key for market rent')).toBeTruthy();
  }, 10_000);

  it('Rent roll and Tenants still mount when the forecast query has failed', async () => {
    stub503();
    renderModule('/leasing', { seeded: false });
    await screen.findByText('Leasing Intelligence Unavailable', {}, { timeout: 4000 });

    clickTab('Rent roll');
    expect(await screen.findByText('leases-panel')).toBeTruthy();
    expect(screen.queryByText('Leasing Intelligence Unavailable')).toBeNull();

    clickTab('Tenants');
    expect(await screen.findByText('tenants-panel')).toBeTruthy();
    expect(screen.queryByText('Leasing Intelligence Unavailable')).toBeNull();
  }, 10_000);

  it('a cold deep link straight onto Rent roll never shows the forecast offline gate', async () => {
    stub503();
    renderModule('/leasing?tab=rent-roll', { seeded: false });
    expect(await screen.findByText('leases-panel')).toBeTruthy();
    // give the failed forecast query time to settle, then confirm the gate never appeared
    await new Promise((r) => setTimeout(r, 1500));
    expect(screen.getByText('leases-panel')).toBeTruthy();
    expect(screen.queryByText('Leasing Intelligence Unavailable')).toBeNull();
  }, 10_000);
});

describe('Leasing destination — Rule H: ?view= never leaks across tabs', () => {
  it('switching the destination tab clears ?view= but keeps other params', () => {
    renderModule('/leasing?tab=rent-roll&view=rollover&scenario=Downside');
    expect(search().get('view')).toBe('rollover');
    clickTab('Forecast');
    expect(search().get('tab')).toBe('forecast');
    expect(search().has('view')).toBe(false);
    expect(search().get('scenario')).toBe('Downside');
  });

  it('returning to the default tab drops ?tab= and ?view= together', () => {
    renderModule('/leasing?tab=rent-roll&view=rollover');
    clickTab('Rollover');
    expect(search().has('tab')).toBe(false);
    expect(search().has('view')).toBe(false);
  });
});
