// tests/unit/debt-tabs.test.tsx
//
// IA decongestion Phase 4b (rule R5) — Debt is the "Debt" tab of the Capital destination, so
// DebtModule's own strip is a SegmentedControl on `?view=` (Positions · Maturities · Scorecard), never
// a nested tab strip. The KPI strip and the balloon-watch banner sit above the switch (R2). Only the
// selected view is mounted (Scorecard fires its own warehouse queries, so it must stay lazy).
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation, useNavigationType } from 'react-router-dom';
import type * as Queries from '../../src/data/queries';

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

// ScorecardView / LadderView fire their own warehouse queries; stub them so this test pins view
// mounting behaviour only (their internals are unchanged by the split).
vi.mock('../../src/modules/debt/ScorecardView', () => ({ ScorecardView: () => <div>SCORECARD-STUB</div> }));
vi.mock('../../src/modules/debt/LadderView', () => ({ LadderView: () => <div>LADDER-STUB</div> }));

import { DebtModule } from '../../src/modules/debt/DebtModule';

function LocationProbe() {
  const location = useLocation();
  const navType = useNavigationType();
  return (
    <>
      <span data-testid="search">{location.search}</span>
      <span data-testid="nav-type">{navType}</span>
    </>
  );
}

function renderDebt(entry = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={qc}>
        <DebtModule />
        <LocationProbe />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const radioChecked = (name: string) => (screen.getByRole('radio', { name }) as HTMLInputElement).checked;

describe('DebtModule — inner switch is a SegmentedControl on ?view= (IA Phase 4b, R5)', () => {
  it('renders a "Debt views" radiogroup with Positions · Maturities · Scorecard and no tab strip', () => {
    renderDebt();
    expect(screen.getByRole('radiogroup', { name: 'Debt views' })).toBeTruthy();
    expect(screen.getAllByRole('radio').map((r) => r.closest('label')?.textContent)).toEqual(['Positions', 'Maturities', 'Scorecard']);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });

  it('defaults to Positions with the loan table visible and the other views unmounted', () => {
    renderDebt();
    expect(radioChecked('Positions')).toBe(true);
    expect(screen.getByText('All Loan Positions')).toBeTruthy();
    expect(screen.getByText('Alpha Loan')).toBeTruthy();
    expect(screen.queryByText('Capital Composition')).toBeNull();
    expect(screen.queryByText('SCORECARD-STUB')).toBeNull();
  });

  it('R1: the loan table keeps Rate / Maturity / Mos / LTV together in one header row', () => {
    renderDebt();
    const table = screen.getByText('All Loan Positions').closest('div')!.parentElement!;
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    for (const col of ['Rate', 'Maturity', 'Mos', 'LTV']) expect(headers).toContain(col);
  });

  it('keeps the KPI strip and the balloon-watch banner above the switch on every view', () => {
    renderDebt('/?view=scorecard');
    expect(screen.getByText('External Debt')).toBeTruthy();
    expect(screen.getByText('Balloon watch')).toBeTruthy();
    expect(screen.getByText(/Alpha Loan — \$1,000,000 due/)).toBeTruthy();
  });

  it('?view=maturities deep-links: ladder + composition render, positions and scorecard do not', () => {
    renderDebt('/?view=maturities');
    expect(radioChecked('Maturities')).toBe(true);
    expect(screen.getByText('Maturity Ladder')).toBeTruthy();
    expect(screen.getByText('Capital Composition')).toBeTruthy();
    expect(screen.queryByText('All Loan Positions')).toBeNull();
    expect(screen.queryByText('SCORECARD-STUB')).toBeNull();
  });

  it('?view=scorecard deep-links: scorecard + ladder mocks render, positions and maturities do not', () => {
    renderDebt('/?view=scorecard');
    expect(radioChecked('Scorecard')).toBe(true);
    expect(screen.getByText('SCORECARD-STUB')).toBeTruthy();
    expect(screen.getByText('LADDER-STUB')).toBeTruthy();
    expect(screen.queryByText('All Loan Positions')).toBeNull();
    expect(screen.queryByText('Capital Composition')).toBeNull();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });

  it('selecting a radio writes ?view= with replace semantics; the default view removes it', () => {
    renderDebt();
    expect(screen.getByTestId('search').textContent).toBe('');
    fireEvent.click(screen.getByRole('radio', { name: 'Scorecard' }));
    expect(screen.getByTestId('search').textContent).toBe('?view=scorecard');
    expect(screen.getByTestId('nav-type').textContent).toBe('REPLACE');
    expect(screen.getByText('SCORECARD-STUB')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Maturities' }));
    expect(screen.getByTestId('search').textContent).toBe('?view=maturities');
    expect(screen.getByText('Capital Composition')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Positions' }));
    expect(screen.getByTestId('search').textContent).toBe('');
    expect(screen.getByText('All Loan Positions')).toBeTruthy();
  });

  it('preserves other query params (scenario, the destination ?tab=) when switching views', () => {
    renderDebt('/?tab=debt&scenario=downside');
    fireEvent.click(screen.getByRole('radio', { name: 'Maturities' }));
    const params = new URLSearchParams(screen.getByTestId('search').textContent ?? '');
    expect(params.get('view')).toBe('maturities');
    expect(params.get('scenario')).toBe('downside');
    expect(params.get('tab')).toBe('debt');
  });

  it('the outer ?tab= param does not select a view (only ?view= does)', () => {
    renderDebt('/?tab=scorecard');
    expect(radioChecked('Positions')).toBe(true);
    expect(screen.queryByText('SCORECARD-STUB')).toBeNull();
  });
});
