// tests/unit/leasing-mtm-rent-roll.test.tsx
//
// Rent roll status label. A lease whose end date has passed but whose workbook status still reads
// "Active" is a month-to-month tenancy (Tenant 038 LLC, Tenant 059 LLC: lease end Sep 2024), not an
// expired one. The badge says so; the status FILTER and CSV keep the raw workbook status.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type * as Queries from '../../src/data/queries';

const LEASES = [
  { id: 'a', company: 'Tenant 038 LLC', tenantName: 'Tenant 038 LLC', propertyKey: 'P1', unit: '1', sf: 1000, annualRent: 7_215, rentPerSf: 8.5, leaseStart: '2020-01-01', leaseEnd: '2024-09-01', monthsToExpiry: -26, escalationPct: 0.03, status: 'Active' },
  { id: 'b', company: 'Fixture Countertops', tenantName: 'Fixture Countertops', propertyKey: 'P2', unit: '2', sf: 1000, annualRent: 0, rentPerSf: null, leaseStart: '2020-01-01', leaseEnd: '2026-07-31', monthsToExpiry: -3, escalationPct: null, status: 'Expired' },
  { id: 'c', company: 'Tenant 155 LLC', tenantName: 'Tenant 155 LLC', propertyKey: 'P3', unit: '3', sf: 10000, annualRent: 100_000, rentPerSf: 10, leaseStart: '2020-01-01', leaseEnd: '2027-12-31', monthsToExpiry: 14, escalationPct: 0.03, status: 'Active' },
];

vi.mock('../../src/data/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof Queries>();
  return {
    ...actual,
    useSnapshot: () => ({ data: { snapshot: { leases: LEASES, meta: { asOf: '2026-10-27' } } }, isLoading: false, isError: false, refetch: vi.fn() }),
    useAnalytics: () => ({
      isLoading: false,
      isError: false,
      analytics: {
        kpis: { walt: { value: 3.2, prov: undefined } },
        revenueAtRisk: { within90dRent: 0, expiredRent: 0 },
        criticalDates: [],
        rollover: [],
      },
    }),
  };
});

import { LeasesModule } from '../../src/modules/leases/LeasesModule';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderLeases() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={['/']}>
      <QueryClientProvider client={qc}>
        <LeasesModule />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const rowOf = (name: string) => screen.getAllByText(name)[0]!.closest('tr') as HTMLElement;

describe('Rent roll status label', () => {
  it('labels a past-end Active lease Month-to-month, leaves Expired and current leases as they were', () => {
    renderLeases();
    expect(within(rowOf('Tenant 038 LLC')).getByText('Month-to-month')).toBeTruthy();
    expect(within(rowOf('Tenant 038 LLC')).queryByText('Active')).toBeNull();
    expect(within(rowOf('Fixture Countertops')).getByText('Expired')).toBeTruthy();
    expect(within(rowOf('Tenant 155 LLC')).getByText('Active')).toBeTruthy();
  });

  it('keeps the raw workbook status in the status filter (no Month-to-month option)', () => {
    renderLeases();
    const filter = screen.getByLabelText('Filter by status');
    const options = within(filter).getAllByRole('option').map((o) => o.textContent);
    expect(options).toContain('Active');
    expect(options).not.toContain('Month-to-month');
  });
});
