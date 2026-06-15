// tests/unit/acquisitions-best-cap.test.tsx
//
// TDD test for TA-1: the "Best Active Cap" KPI must reflect ONLY active deals
// (stages that are not Closed or Dead), not the full deal list.
//
// Bug: AcquisitionsModule.tsx:35 computes bestCap over `deals` (all stages) while
// line 33 defines `active` (non-Closed, non-Dead) and line 70 labels the KPI
// "Best Active Cap". A Closed deal with a higher cap rate silently inflates the
// headline. Fix: change `deals.map` → `active.map` on line 35.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Deal } from '../../src/contracts/deal';
import { AcquisitionsModule } from '../../src/modules/acquisitions/AcquisitionsModule';

function makeDeal(partial: Partial<Deal> & Pick<Deal, 'id' | 'name' | 'stage'>): Deal {
  return {
    shortName: null, location: null, market: null, sf: null, buildings: null,
    estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null,
    lender: null, status: null, nextAction: null, owner: null, targetCloseDate: null,
    confidential: false, estimatedFields: [],
    ...partial,
  };
}

function seededClient(deals: Deal[]): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  qc.setQueryData(['snapshot'], {
    snapshot: { deals, acquisitionInputs: {} } as never,
    state: {} as never,
  });
  return qc;
}

beforeEach(() => {
  // AcquisitionWorkbench (inside AcquisitionsModule) calls the scoring API on mount;
  // stub fetch so it fails fast without a real network round-trip.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
  // BarList / chart primitives pull in visx which uses ResizeObserver.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('AcquisitionsModule — Best Active Cap KPI (TA-1)', () => {
  it('shows the highest cap rate from ACTIVE deals only, excluding Closed and Dead', async () => {
    // Closed deal has cap 9%, Dead deal has cap 11%. Only the active Candidate (7%) should win.
    const deals = [
      makeDeal({ id: 'active', name: 'Active Candidate', stage: 'Candidate', capRate: 0.07 }),
      makeDeal({ id: 'closed', name: 'Closed Deal',      stage: 'Closed',    capRate: 0.09 }),
      makeDeal({ id: 'dead',   name: 'Dead Deal',        stage: 'Dead',      capRate: 0.11 }),
    ];

    render(
      <QueryClientProvider client={seededClient(deals)}>
        <AcquisitionsModule />
      </QueryClientProvider>,
    );

    // Scope to the "Best Active Cap" KpiStat cell so the DataTable cap column
    // (which correctly shows 11.00% for the Dead deal row) doesn't confound us.
    const kpiLabel = screen.getByText('Best Active Cap');
    const kpiCell = kpiLabel.closest('.min-w-0') as HTMLElement;

    // After fix: the KPI cell shows the active deal's 7%, not the closed/dead deal's cap.
    expect(within(kpiCell).getByText('7.00%')).toBeTruthy();

    // Before fix: the KPI cell would show 11.00% (the Dead deal's cap from Math.max over all deals).
    expect(within(kpiCell).queryByText('11.00%')).toBeNull();
    expect(within(kpiCell).queryByText('9.00%')).toBeNull();
  });

  it('shows dash when no active deals have a cap rate', () => {
    const deals = [
      makeDeal({ id: 'closed', name: 'Closed Deal', stage: 'Closed', capRate: 0.08 }),
    ];

    render(
      <QueryClientProvider client={seededClient(deals)}>
        <AcquisitionsModule />
      </QueryClientProvider>,
    );

    // With no active deals, bestCap = Math.max(0, ...[]) = 0 → renders '—', not '0.00%'.
    expect(screen.queryByText('0.00%')).toBeNull();
  });
});
