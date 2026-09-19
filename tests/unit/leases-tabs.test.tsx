// tests/unit/leases-tabs.test.tsx
//
// IA decongestion Phase 3 — the single-scroll Leases module is tabbed: Rent roll (default) ·
// Rollover. The KPI strip stays above the strip (R2). Both panels are force-mounted so the rent-roll
// search / filters / sort survive a tab round-trip. The Rollover chart reads `analytics.rollover`
// (portfolio-wide), NOT the rent-roll's filtered rows, so the split loses no linkage (R1).
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type * as Queries from '../../src/data/queries';
import { inactivePanelIsHiddenByClass, isInInactivePanel, selectTab, tabIsSelected } from './tab-test-utils';

const LEASES = [
  { id: 'a', company: 'REDACTED-659', tenantName: 'REDACTED-659', propertyKey: 'P1', unit: '1', sf: 10000, annualRent: 100_000, rentPerSf: 10, leaseStart: '2020-01-01', leaseEnd: '2027-01-01', monthsToExpiry: 12, escalationPct: 0.03, status: 'Active' },
  { id: 'b', company: 'Widgets Inc', tenantName: 'Widgets Inc', propertyKey: 'P2', unit: '2', sf: 5000, annualRent: 60_000, rentPerSf: 12, leaseStart: '2020-01-01', leaseEnd: '2026-01-01', monthsToExpiry: -3, escalationPct: 0.02, status: 'Expired' },
];
const CRITICAL_DATES = [
  { id: 'c1', leaseId: 'b', daysToDate: -20, date: '2026-01-01', kind: 'Expiration', tenant: 'Widgets Inc', propertyKey: 'P2', unit: '2', annualRent: 60_000 },
  { id: 'c2', leaseId: 'a', daysToDate: 40, date: '2026-12-01', kind: 'Notice Deadline', tenant: 'REDACTED-659', propertyKey: 'P1', unit: '1', annualRent: 100_000 },
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

function renderLeases(entry = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={qc}>
        <LeasesModule />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('LeasesModule — Phase 3 tabs', () => {
  it('Rent roll is the default tab, visible with no tab click (keeps the e2e specs valid)', () => {
    renderLeases();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Rent roll', 'Rollover1']);
    expect(tabIsSelected('Rent roll')).toBe(true);
    expect(isInInactivePanel(screen.getByText('Rent Roll'))).toBe(false);
    // REDACTED-659 also appears in the (hidden) Rollover tab's Critical Dates; one match must be visible.
    expect(screen.getAllByText('REDACTED-659').some((el) => !isInInactivePanel(el))).toBe(true);
    // the sortable, labeled rent-roll table header the a11y spec looks for
    expect(document.querySelector('th[aria-sort]')).not.toBeNull();
    expect(isInInactivePanel(document.querySelector('th[aria-sort]')!)).toBe(false);
  });

  it('keeps the KPI strip above the tab strip on every tab', () => {
    renderLeases('/?tab=rollover');
    expect(screen.getByText('WALT').closest('[role="tabpanel"]')).toBeNull();
    expect(isInInactivePanel(screen.getByText('WALT'))).toBe(false);
  });

  it('Rollover and Critical Dates are hidden until the Rollover tab is selected, then reachable', () => {
    renderLeases();
    const chart = screen.getByText('Lease Rollover Schedule');
    const dates = screen.getByText('Critical Dates');
    expect(isInInactivePanel(chart)).toBe(true);
    expect(inactivePanelIsHiddenByClass(dates)).toBe(true);
    selectTab(/^Rollover/);
    expect(isInInactivePanel(chart)).toBe(false);
    expect(isInInactivePanel(dates)).toBe(false);
    expect(isInInactivePanel(screen.getByText('Rent Roll'))).toBe(true);
  });

  it('R4: the overdue-holdover count rides on the non-default Rollover tab label', () => {
    renderLeases();
    // exactly one of the two critical dates is overdue (daysToDate < 0)
    expect(screen.getByRole('tab', { name: /^Rollover/ }).textContent).toBe('Rollover1');
  });

  it('?tab=rollover deep-links to the Rollover tab; an unknown tab falls back to Rent roll', () => {
    renderLeases('/?tab=rollover');
    expect(tabIsSelected(/^Rollover/)).toBe(true);
    expect(isInInactivePanel(screen.getByText('Lease Rollover Schedule'))).toBe(false);
    cleanup();
    renderLeases('/?tab=bogus');
    expect(tabIsSelected('Rent roll')).toBe(true);
  });

  it('state survives a tab round-trip: rent-roll search, status filter and column sort', () => {
    renderLeases();
    const search = screen.getByLabelText('Search leases') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'Euro' } });
    const status = screen.getByLabelText('Filter by status') as HTMLSelectElement;
    fireEvent.change(status, { target: { value: 'Active' } });
    const rentHeader = () => screen.getAllByRole('columnheader', { name: 'Annual Rent' })[0]!;
    fireEvent.click(rentHeader()); // initialSort is rent desc → toggles to asc
    const sortBefore = rentHeader().getAttribute('aria-sort');
    expect(sortBefore).toBe('ascending');

    selectTab(/^Rollover/);
    selectTab('Rent roll');

    expect((screen.getByLabelText('Search leases') as HTMLInputElement).value).toBe('Euro');
    expect((screen.getByLabelText('Filter by status') as HTMLSelectElement).value).toBe('Active');
    expect(rentHeader().getAttribute('aria-sort')).toBe('ascending');
    expect(screen.getByText('1 of 2')).toBeTruthy();
  });
});
