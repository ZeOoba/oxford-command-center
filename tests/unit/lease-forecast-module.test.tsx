// tests/unit/lease-forecast-module.test.tsx
//
// Render coverage for the forecast-backed tabs of the Leasing destination (LeaseForecastModule) — IA
// decongestion Phase 2, extended in Phase 4d. Layout under test: expiry-bucket cards ABOVE the strip
// (R2, forecast-backed tabs only); Rollover (velocity) · Forecast (rent-forecast scenario + AI narrative
// beneath it) · Market rents (editor). The destination strip / absorbed panels / Rule G live in
// leasing-destination.test.tsx. The forecast query and the snapshot are seeded straight into the
// QueryClient cache so the render is network-free.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { LeaseForecastModule } from '../../src/modules/leasing/LeaseForecastModule';
import { LEASING_KEYS } from '../../src/modules/leasing/hooks';
import { SNAPSHOT_KEY } from '../../src/data/queries';
import type { LeaseForecastResponse } from '../../src/contracts/lease-forecast';
import type * as Queries from '../../src/data/queries';

// Rent roll's R4 badge is the overdue critical-date count, read off the same Spine-A analytics hook the
// absorbed LeasesModule uses. Only useAnalytics is overridden; useSnapshot stays real (cache-seeded).
let mockCriticalDates: Array<{ id: string; daysToDate: number }> = [];
vi.mock('../../src/data/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof Queries>();
  return {
    ...actual,
    useAnalytics: () => ({ isLoading: false, isError: false, analytics: { criticalDates: mockCriticalDates, rollover: [] } }),
  };
});

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

function renderModule(
  entry = '/leasing',
  over: { forecast?: Partial<LeaseForecastResponse>; marketRents?: Record<string, number> } = {},
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  qc.setQueryData(LEASING_KEYS.forecast, { ...FORECAST, ...over.forecast });
  qc.setQueryData(SNAPSHOT_KEY, { snapshot: { marketRents: over.marketRents ?? { 'rarig-ave': 8.5 } } });
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
  mockCriticalDates = [];
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
  // Rollover tab now mounts RolloverChart (BarChart), which measures via ResizeObserver —
  // jsdom has no native implementation (house pattern, see tests/unit/market-tabs.test.tsx).
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
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

  it('carries no count badge on the four non-severity tabs', () => {
    mockCriticalDates = [{ id: 'c1', daysToDate: -20 }];
    renderModule();
    for (const name of ['Rollover', 'Forecast', 'Market rents', 'Tenants']) {
      expect(screen.getByRole('tab', { name }).textContent).toBe(name);
    }
  });

  it('Rent roll shows the red overdue critical-date count (daysToDate < 0 only) (R4)', () => {
    mockCriticalDates = [
      { id: 'c1', daysToDate: -20 },
      { id: 'c2', daysToDate: -1 },
      { id: 'c3', daysToDate: 0 },
      { id: 'c4', daysToDate: 40 },
    ];
    renderModule();
    const tab = screen.getByRole('tab', { name: /^Rent roll/ });
    expect(tab.textContent).toBe('Rent roll2');
    // red tone == Badge's --text-neg foreground (the module-level tone map has no data attribute)
    const pill = within(tab).getByText('2');
    expect((pill as HTMLElement).getAttribute('style')).toContain('--text-neg');
  });

  it('Rent roll shows no badge when nothing is overdue', () => {
    mockCriticalDates = [{ id: 'c2', daysToDate: 0 }, { id: 'c4', daysToDate: 40 }];
    renderModule();
    expect(screen.getByRole('tab', { name: 'Rent roll' }).textContent).toBe('Rent roll');
  });
});

describe('LeaseForecastModule — leases outside the four buckets', () => {
  const sig = (leaseId: string, expiryBucket: string, monthToMonth: boolean, annualRent: number) => ({
    leaseId, tenantName: leaseId, propertyId: 'p', propertyKey: 'P', annualRent, sf: 0, leaseEnd: null,
    monthsToExpiry: null, expiryBucket, tenureMonths: null, renewalStage: null, arrearsUsd: 0, monthToMonth,
    likelihood: 'uncertain', rationale: '',
  });

  it('footnotes the leases the four cards leave out, so the cards visibly reconcile to the rent roll', () => {
    renderModule('/leasing', {
      forecast: {
        signals: [
          sig('a', 'expired', true, REDACTED-AMT),
          sig('b', 'expired', true, REDACTED-AMT),
          sig('c', 'expired', false, 0),
          sig('d', 'unknown', false, 600),
        ] as unknown as LeaseForecastResponse['signals'],
      },
    });
    expect(
      screen.getByText('4 leases not in a bucket: 2 month-to-month past end date ($13K/yr), 1 expired ($0/yr), 1 with no end date ($600/yr).'),
    ).toBeTruthy();
  });

  it('shows no footnote when every lease is bucketed', () => {
    renderModule();
    expect(screen.queryByText(/not in a bucket/)).toBeNull();
  });
});

describe('LeaseForecastModule — empty states', () => {
  it('Leasing Velocity explains what source data is missing instead of naming a table', () => {
    renderModule('/leasing', { forecast: { velocity: [] } });
    expect(screen.queryByText(/populate lease_events/)).toBeNull();
    expect(screen.getByText(/vacancy-to-lease history/)).toBeTruthy();
  });

  it('Market rents shows a banner when none are entered, and none when some are', () => {
    renderModule('/leasing?tab=market-rents', { marketRents: {} });
    expect(screen.getByText(/No market rents entered/)).toBeTruthy();
    cleanup();
    renderModule('/leasing?tab=market-rents');
    expect(screen.queryByText(/No market rents entered/)).toBeNull();
  });

  it('offers feed-derived asking rents as unconfirmed suggestions; accepting one saves it (human-confirmed)', async () => {
    const gap = {
      leaseId: 'l1', tenantName: 'T', propertyKey: '1100 Rarig', currentRentPsf: 8, marketRentPsf: 9.5,
      gapPsf: 1.5, gapAnnualUsd: 1_500, underMarket: true, provenance: 'derived-asking',
    };
    renderModule('/leasing?tab=market-rents', {
      marketRents: {},
      forecast: { marketGaps: [gap] as unknown as LeaseForecastResponse['marketGaps'] },
    });
    expect(screen.getByText(/unconfirmed/i)).toBeTruthy();
    expect(screen.getByText('$9.50/SF')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept asking-rent estimate for 1100 Rarig' }));
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    // The mutation fires on a microtask, so wait for the POST rather than asserting synchronously.
    await waitFor(() => expect(calls.some(([url]) => String(url).includes('market-rent'))).toBe(true));
    const post = calls.find(([url]) => String(url).includes('market-rent'));
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({ key: '1100 Rarig', rentPsf: 9.5 });
  });

  it('shows no suggestions block when the feed has nothing', () => {
    renderModule('/leasing?tab=market-rents', { marketRents: {} });
    expect(screen.queryByText(/unconfirmed/i)).toBeNull();
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
