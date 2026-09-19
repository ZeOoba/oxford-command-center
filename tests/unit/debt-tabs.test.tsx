// tests/unit/debt-tabs.test.tsx
//
// IA decongestion Phase 3 — Positions is split: Positions · Maturities · Scorecard. The KPI strip and
// the balloon-watch banner sit above the strip (R2). Positions / Maturities are force-mounted (loan
// table sort survives a tab round-trip); Scorecard stays lazy (fires its own warehouse queries).
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type * as Queries from '../../src/data/queries';
import { inactivePanelIsHiddenByClass, isInInactivePanel, selectTab, tabIsSelected } from './tab-test-utils';

const LOANS = [
  { id: 'l1', name: 'Alpha Loan', counterparty: 'Bank A', direction: 'borrower', absBalance: 1_000_000, rate: 0.06, isDemand: false, maturity: '2027-01-01', monthsToMaturity: 12, ltv: 0.5, balloon: true, status: 'Active' },
  { id: 'l2', name: 'Beta Loan', counterparty: 'Bank B', direction: 'borrower', absBalance: 2_000_000, rate: 0.04, isDemand: false, maturity: '2030-01-01', monthsToMaturity: 60, ltv: 0.4, balloon: false, status: 'Active' },
];

vi.mock('../../src/data/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof Queries>();
  return {
    ...actual,
    useSnapshot: () => ({ data: { snapshot: { loans: LOANS } } }),
    useAnalytics: () => ({
      isLoading: false,
      isError: false,
      analytics: {
        debt: {
          externalDebt: 3_000_000,
          weightedAvgRate: 0.05,
          annualDebtService: 250_000,
          lenderDeployed: 500_000,
          internalOutstanding: 100_000,
          ladder: [{ period: '2027', balance: 1_000_000 }, { period: '2030', balance: 2_000_000 }],
        },
      },
    }),
  };
});

// ScorecardView / LadderView fire their own warehouse queries; stub them so this test pins tab
// mounting behaviour only (their internals are unchanged by the split).
vi.mock('../../src/modules/debt/ScorecardView', () => ({ ScorecardView: () => <div>SCORECARD-STUB</div> }));
vi.mock('../../src/modules/debt/LadderView', () => ({ LadderView: () => <div>LADDER-STUB</div> }));

import { DebtModule } from '../../src/modules/debt/DebtModule';

function renderDebt(entry = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={qc}>
        <DebtModule />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('DebtModule — Phase 3 tab split', () => {
  it('renders three tabs, Positions selected by default with the loan table visible', () => {
    renderDebt();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Positions', 'Maturities', 'Scorecard']);
    expect(tabIsSelected('Positions')).toBe(true);
    expect(isInInactivePanel(screen.getByText('All Loan Positions'))).toBe(false);
    expect(screen.getByText('Alpha Loan')).toBeTruthy();
  });

  it('R1: the loan table keeps Rate / Maturity / Mos / LTV together in one header row', () => {
    renderDebt();
    const table = screen.getByText('All Loan Positions').closest('div')!.parentElement!;
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    for (const col of ['Rate', 'Maturity', 'Mos', 'LTV']) expect(headers).toContain(col);
  });

  it('keeps the KPI strip and the balloon-watch banner above the strip on every tab', () => {
    renderDebt('/?tab=scorecard');
    expect(isInInactivePanel(screen.getByText('External Debt'))).toBe(false);
    expect(isInInactivePanel(screen.getByText('Balloon watch'))).toBe(false);
    // Balloon banner is no longer inside any panel.
    expect(screen.getByText('Balloon watch').closest('[role="tabpanel"]')).toBeNull();
    expect(screen.getByText('External Debt').closest('[role="tabpanel"]')).toBeNull();
  });

  it('Maturities content is hidden until its tab is selected, then reachable', () => {
    renderDebt();
    const ladder = screen.getByText('Maturity Ladder');
    const comp = screen.getByText('Capital Composition');
    expect(isInInactivePanel(ladder)).toBe(true);
    expect(inactivePanelIsHiddenByClass(comp)).toBe(true);
    selectTab('Maturities');
    expect(isInInactivePanel(ladder)).toBe(false);
    expect(isInInactivePanel(comp)).toBe(false);
    expect(isInInactivePanel(screen.getByText('All Loan Positions'))).toBe(true);
  });

  it('Scorecard stays lazy: its content is not rendered until the tab is selected', async () => {
    renderDebt();
    expect(screen.queryByText('SCORECARD-STUB')).toBeNull();
    selectTab('Scorecard');
    expect(await screen.findByText('SCORECARD-STUB')).toBeTruthy();
  });

  it.each([
    ['maturities', 'Capital Composition'],
    ['scorecard', 'SCORECARD-STUB'],
  ])('?tab=%s deep-links to that tab', async (key, marker) => {
    renderDebt(`/?tab=${key}`);
    expect(screen.getByRole('tab', { name: new RegExp(`^${key}$`, 'i') }).getAttribute('aria-selected')).toBe('true');
    expect(isInInactivePanel(await screen.findByText(marker))).toBe(false);
  });

  it('state survives a tab round-trip: the loan-table sort', () => {
    renderDebt();
    const rate = () => screen.getByRole('columnheader', { name: 'Rate' });
    expect(rate().getAttribute('aria-sort')).toBe('none');
    fireEvent.click(rate());
    expect(rate().getAttribute('aria-sort')).toBe('descending');
    selectTab('Maturities');
    selectTab('Scorecard');
    selectTab('Positions');
    expect(rate().getAttribute('aria-sort')).toBe('descending');
  });
});
