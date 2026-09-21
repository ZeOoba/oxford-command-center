// tests/unit/leases-tabs.test.tsx
//
// IA decongestion Phase 4d — Leases is absorbed into the Leasing destination (Rent roll tab). Its own
// two-way strip (Rent roll · Rollover) can no longer be a tab strip (R5: no nested tab strips), so it
// is a SegmentedControl on `?view=` — "Rent roll" (default) · "Critical dates" (key `rollover`, so old
// `/leases?tab=rollover` deep links keep working). The KPI strip stays above the switch (R2). The
// Rollover chart reads `analytics.rollover` (portfolio-wide), NOT the rent-roll's filtered rows, so the
// split loses no linkage (R1). Filter state lives in the module, so it survives a view round-trip.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type * as Queries from '../../src/data/queries';

const LEASES = [
  { id: 'a', company: 'Eurosort', tenantName: 'Eurosort', propertyKey: 'P1', unit: '1', sf: 10000, annualRent: 100_000, rentPerSf: 10, leaseStart: '2020-01-01', leaseEnd: '2027-01-01', monthsToExpiry: 12, escalationPct: 0.03, status: 'Active' },
  { id: 'b', company: 'Widgets Inc', tenantName: 'Widgets Inc', propertyKey: 'P2', unit: '2', sf: 5000, annualRent: 60_000, rentPerSf: 12, leaseStart: '2020-01-01', leaseEnd: '2026-01-01', monthsToExpiry: -3, escalationPct: 0.02, status: 'Expired' },
];
const CRITICAL_DATES = [
  { id: 'c1', leaseId: 'b', daysToDate: -20, date: '2026-01-01', kind: 'Expiration', tenant: 'Widgets Inc', propertyKey: 'P2', unit: '2', annualRent: 60_000 },
  { id: 'c2', leaseId: 'a', daysToDate: 40, date: '2026-12-01', kind: 'Notice Deadline', tenant: 'Eurosort', propertyKey: 'P1', unit: '1', annualRent: 100_000 },
];

vi.mock('../../src/data/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof Queries>();
  return {
    ...actual,
    useSnapshot: () => ({ data: { snapshot: { leases: LEASES, meta: { asOf: '2026-09-01' } } } }),
    useAnalytics: () => ({
      isLoading: false,
      isError: false,
      analytics: {
        kpis: { walt: { value: 3.2, prov: undefined } },
        revenueAtRisk: { within90dRent: 40_000, expiredRent: 60_000 },
        criticalDates: CRITICAL_DATES,
        rollover: [{ period: '2026', expiringRent: 60_000 }, { period: '2027', expiringRent: 100_000 }],
      },
    }),
  };
});

import { LeasesModule } from '../../src/modules/leases/LeasesModule';

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.search}</div>;
}

function renderLeases(entry = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={qc}>
        <LeasesModule />
        <LocationProbe />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const search = () => screen.getByTestId('loc').textContent;
const radio = (name: string) => screen.getByRole('radio', { name }) as HTMLInputElement;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('LeasesModule — Rent roll / Critical dates SegmentedControl (R5)', () => {
  it('is a radiogroup named "Lease views" with Rent roll + Critical dates, and no nested tab strip', () => {
    renderLeases();
    expect(screen.getByRole('radiogroup', { name: 'Lease views' })).toBeTruthy();
    expect(screen.getAllByRole('radio').map((r) => r.closest('label')?.textContent)).toEqual(['Rent roll', 'Critical dates']);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.queryAllByRole('tablist')).toHaveLength(0);
  });

  it('Rent roll is the default view, visible with no click (keeps the e2e specs valid)', () => {
    renderLeases();
    expect(radio('Rent roll').checked).toBe(true);
    expect(radio('Critical dates').checked).toBe(false);
    expect(screen.getByText('Rent Roll')).toBeTruthy();
    expect(screen.getAllByText('Eurosort').length).toBeGreaterThan(0);
    // the sortable, labeled rent-roll table header the a11y spec looks for
    expect(document.querySelector('th[aria-sort]')).not.toBeNull();
    // the other view is not rendered
    expect(screen.queryByText('Lease Rollover Schedule')).toBeNull();
    expect(screen.queryByText('Critical Dates')).toBeNull();
  });

  it('keeps the KPI strip above the switch on both views (R2)', () => {
    renderLeases();
    expect(screen.getByText('WALT')).toBeTruthy();
    expect(screen.getByText('Holding Over')).toBeTruthy();
    cleanup();
    renderLeases('/?view=rollover');
    expect(screen.getByText('WALT')).toBeTruthy();
    expect(screen.getByText('Holding Over')).toBeTruthy();
  });

  it('?view=rollover deep-links to Critical dates (chart + dates table); an unknown view falls back to Rent roll', () => {
    renderLeases('/?view=rollover');
    expect(radio('Critical dates').checked).toBe(true);
    expect(screen.getByText('Lease Rollover Schedule')).toBeTruthy();
    expect(screen.getByText('Critical Dates')).toBeTruthy();
    expect(screen.queryByText('Rent Roll')).toBeNull();
    cleanup();
    renderLeases('/?view=bogus');
    expect(radio('Rent roll').checked).toBe(true);
  });

  it('R1: the Critical Dates card carries the overdue count (one of the two dates is overdue)', () => {
    renderLeases('/?view=rollover');
    expect(screen.getByText('1 overdue')).toBeTruthy();
    expect(screen.getByText('2 items')).toBeTruthy();
  });

  it('clicking Critical dates writes ?view=rollover; clicking Rent roll (the default) removes it', () => {
    renderLeases('/?scenario=Downside');
    expect(search()).toBe('?scenario=Downside');
    fireEvent.click(radio('Critical dates'));
    expect(new URLSearchParams(search()!).get('view')).toBe('rollover');
    expect(new URLSearchParams(search()!).get('scenario')).toBe('Downside');
    expect(screen.getByText('Lease Rollover Schedule')).toBeTruthy();
    fireEvent.click(radio('Rent roll'));
    expect(new URLSearchParams(search()!).has('view')).toBe(false);
    expect(new URLSearchParams(search()!).get('scenario')).toBe('Downside');
    expect(screen.getByText('Rent Roll')).toBeTruthy();
  });

  it('never touches ?tab= (owned by the Leasing destination strip)', () => {
    renderLeases('/?tab=rent-roll');
    fireEvent.click(radio('Critical dates'));
    expect(new URLSearchParams(search()!).get('tab')).toBe('rent-roll');
  });

  it('rent-roll search and status filter survive a view round-trip', () => {
    renderLeases();
    fireEvent.change(screen.getByLabelText('Search leases'), { target: { value: 'Euro' } });
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'Active' } });
    expect(screen.getByText('1 of 2')).toBeTruthy();

    fireEvent.click(radio('Critical dates'));
    fireEvent.click(radio('Rent roll'));

    expect((screen.getByLabelText('Search leases') as HTMLInputElement).value).toBe('Euro');
    expect((screen.getByLabelText('Filter by status') as HTMLSelectElement).value).toBe('Active');
    expect(screen.getByText('1 of 2')).toBeTruthy();
  });
});
