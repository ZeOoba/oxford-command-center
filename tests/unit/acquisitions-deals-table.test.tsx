// tests/unit/acquisitions-deals-table.test.tsx
//
// Acquisitions pipeline table, from the 2026-10-27 page review:
//  1. "Active Deals" listed all 23 deals including 11 Dead while the KPI said 12 active. The table now
//     defaults to active deals (not Closed/Dead) with a toggle to include the rest.
//  2. Next Action rendered whole Notion logs (up to 3,414 characters per row). It is now clamped to two
//     lines with an in-place more/less toggle.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Deal } from '../../src/contracts/deal';
import { AcquisitionsModule } from '../../src/modules/acquisitions/AcquisitionsModule';

function makeDeal(partial: Partial<Deal> & Pick<Deal, 'id' | 'name' | 'stage'>): Deal {
  return {
    shortName: null, location: null, market: null, sf: null, buildings: null,
    estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null,
    lender: null, status: null, nextAction: null, owner: null, targetCloseDate: null,
    notionDealId: null, confidential: false, estimatedFields: [],
    ...partial,
  };
}

function renderWith(deals: Deal[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  qc.setQueryData(['snapshot'], { snapshot: { deals, acquisitionInputs: {} } as never, state: {} as never });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <AcquisitionsModule />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// Deal names also appear in the Workbench "Prefill from" dropdown, so row assertions are scoped to the
// pipeline table: the only table with a Next Action column.
const pipelineTable = () => within(screen.getByText('Next Action').closest('table') as HTMLElement);

const DEALS = [
  makeDeal({ id: 'a', name: 'Alpha Candidate', stage: 'Candidate' }),
  makeDeal({ id: 'b', name: 'Bravo Diligence', stage: 'Due Diligence' }),
  makeDeal({ id: 'c', name: 'Charlie Closed', stage: 'Closed' }),
  makeDeal({ id: 'd', name: 'Delta Dead', stage: 'Dead' }),
];

describe('Acquisitions deals table — active by default', () => {
  it('lists only active deals, titled Active Deals with the active count', () => {
    renderWith(DEALS);
    expect(pipelineTable().getByText('Alpha Candidate')).toBeTruthy();
    expect(pipelineTable().getByText('Bravo Diligence')).toBeTruthy();
    expect(pipelineTable().queryByText('Charlie Closed')).toBeNull();
    expect(pipelineTable().queryByText('Delta Dead')).toBeNull();
    // "Active Deals" is both the KPI label and the table card title.
    expect(screen.getAllByText('Active Deals')).toHaveLength(2);
    expect(screen.getByText('2 active')).toBeTruthy();
  });

  it('the toggle brings closed and dead deals in (title becomes All Deals) and takes them out again', () => {
    renderWith(DEALS);
    fireEvent.click(screen.getByRole('button', { name: 'Show closed / dead (2)' }));
    expect(pipelineTable().getByText('Charlie Closed')).toBeTruthy();
    expect(pipelineTable().getByText('Delta Dead')).toBeTruthy();
    expect(screen.getByText('All Deals')).toBeTruthy();
    expect(screen.getByText('4 deals')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide closed / dead' }));
    expect(pipelineTable().queryByText('Delta Dead')).toBeNull();
    expect(screen.getByText('2 active')).toBeTruthy();
  });

  it('shows no toggle when every deal is active', () => {
    renderWith(DEALS.slice(0, 2));
    expect(screen.queryByRole('button', { name: /closed \/ dead/ })).toBeNull();
  });

  it('leaves the Active Deals KPI tile alone when the toggle flips (only the table title changes)', () => {
    renderWith(DEALS);
    expect(screen.getByText('4 total')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show closed / dead (2)' }));
    expect(screen.getAllByText('Active Deals')).toHaveLength(1); // KPI label only
    expect(screen.getByText('4 total')).toBeTruthy();
  });
});

describe('Acquisitions deals table — Next Action clamp', () => {
  const LONG = `[2026-08-17 — log] ${'Verified asking price and chased the broker on square footage. '.repeat(8)}`;

  it('clamps a long note to two lines with a more toggle, and expands it in place', () => {
    renderWith([makeDeal({ id: 'a', name: 'Alpha Candidate', stage: 'Candidate', nextAction: LONG })]);
    const toggle = screen.getByRole('button', { name: 'Show full next action' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const text = screen.getByText(LONG.trim(), { exact: false });
    expect(text.className).toContain('line-clamp-2');

    fireEvent.click(toggle);
    const less = screen.getByRole('button', { name: 'Collapse next action' });
    expect(less.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(LONG.trim(), { exact: false }).className).not.toContain('line-clamp-2');
  });

  it('gives a short note no toggle', () => {
    renderWith([makeDeal({ id: 'a', name: 'Alpha Candidate', stage: 'Candidate', nextAction: 'Call broker Friday' })]);
    expect(screen.getByText('Call broker Friday')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show full next action' })).toBeNull();
  });
});
