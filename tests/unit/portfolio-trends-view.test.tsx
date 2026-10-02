// tests/unit/portfolio-trends-view.test.tsx
//
// Portfolio > Trends tab. Fixture idiom mirrors tests/unit/portfolio-module-other-holdings.test.tsx:
// a schema-complete snapshot seeded into the QueryClient cache, real UiContext.Provider, fetch stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as PortfolioTrends from '@analytics/portfolio-trends';
import type { Lease, PortfolioSnapshot, Property } from '../../src/contracts/index';
import { SNAPSHOT_KEY } from '../../src/data/queries';
import { UiContext, type UiState } from '../../src/brain/ui-context';

// Hoisted toggle so one test can force a trend whose series lacks the as-of month.
const force = vi.hoisted(() => ({ emptyPortfolio: false }));
vi.mock('@analytics/portfolio-trends', async (orig) => {
  const actual = await orig<typeof PortfolioTrends>();
  return {
    ...actual,
    buildPortfolioTrend: (...args: Parameters<typeof actual.buildPortfolioTrend>) => {
      const t = actual.buildPortfolioTrend(...args);
      return force.emptyPortfolio ? { ...t, portfolio: [], byProperty: {}, bridge: [] } : t;
    },
  };
});

import { TrendsView } from '../../src/modules/portfolio/TrendsView';

const ASOF = '2026-09-23';

const prop = (id: string, name: string): Property =>
  ({
    id, index: 1, name, address: name, city: null, state: null, market: 'Mid-Atlantic', type: 'Flex', sf: 10000, tenantCount: 1, occPct: 1,
    acqDate: null, estValue100: 0, oxfordOwnPct: 1, oxfordValue: 1_000_000, grossIncome: 0, expenses: 0, noi: 0, noiScenarioAdj: 0,
    debtService: 0, netCashFlow: 0, capRate: null, dscr: null, lender: null, loanBalance: 0, ltv: null, valuePerSf: null, rentPerSf: null,
    equityInvested: 0, cashOnCash: null, holdYrs: null, encumbered: false, flags: [],
  }) as Property;

const lease = (id: string, propertyId: string, sf: number, rent: number): Lease =>
  ({
    id, propertyKey: propertyId, propertyId, tenantName: id, unit: 'A', company: id, sf, monthlyRent: rent, rentPerSf: 12,
    leaseStart: '2025-01-01', leaseEnd: '2028-12-31', escalationDate: null, escalationPct: null, status: 'Active',
    annualRent: rent * 12, monthsToExpiry: 27, flags: [],
  }) as Lease;

function snapshot(): PortfolioSnapshot {
  return {
    meta: { schemaVersion: '1.0.0', asOf: ASOF, generatedAt: `${ASOF}T00:00:00.000Z`, source: 'test', scenario: 'Base' },
    assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: ASOF },
    // Alpha 100% leased (0% vacancy); Beta 50% leased (50% vacancy); portfolio 25% vacancy.
    properties: [prop('a', 'Alpha Commons'), prop('b', 'Beta Park')],
    leases: [lease('l1', 'a', 10000, 10000), lease('l2', 'b', 5000, 5000)],
    loans: [],
    cash: { asOf: ASOF, totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
    insurance: [], deals: [], tasks: [], counterparties: [],
    renewalStages: {}, tenantNotes: {}, dealComps: {}, acquisitionInputs: {}, noiBudgets: {}, tenantArrears: {}, arBalances: [],
    quickbooks: null, governors: null, marketRents: {}, workbookTotals: { noi: null, value: null, rent: null }, dataQuality: [],
  } as unknown as PortfolioSnapshot;
}

function seededClient(s: PortfolioSnapshot): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  qc.setQueryData(SNAPSHOT_KEY, { snapshot: s, state: { status: 'fresh', source: 'workbook', lastUpdated: ASOF, lastError: null, workbookPath: 'test.xlsx', flagCount: 0 } });
  return qc;
}

const ui: UiState = {
  activeModuleId: 'portfolio', setActiveModule: () => {}, openTab: () => {},
  paletteOpen: false, openPalette: () => {}, closePalette: () => {}, togglePalette: () => {},
  selected: null, openEntity: () => {}, closeEntity: () => {},
  intelPropertyId: null, openIntelProperty: () => {},
  aiOpen: false, openAi: () => {}, closeAi: () => {}, toggleAi: () => {},
  scenario: 'Base', setScenario: () => {},
  draft: null, openDraft: () => {}, closeDraft: () => {},
};

beforeEach(() => {
  force.emptyPortfolio = false;
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
  // visx charts measure via ResizeObserver (jsdom lacks it).
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderView() {
  return render(
    <QueryClientProvider client={seededClient(snapshot())}>
      <UiContext.Provider value={ui}>
        <TrendsView />
      </UiContext.Provider>
    </QueryClientProvider>,
  );
}

/** The KPI tile whose label is `label` — scopes value assertions away from chart axis ticks. */
const tile = (label: string | RegExp) => screen.getByText(label).closest('[class*="rounded"]') as HTMLElement;

const vacTile = () => screen.getAllByText('Vacancy (lease-SF basis)').map((e) => e.closest('[class*="rounded"]') as HTMLElement).find((t) => t.textContent?.includes('workbook occupancy'))!;

describe('TrendsView', () => {
  it('renders the KPI labels and the reconstructed-history badge', () => {
    renderView();
    expect(screen.getByText(/In-place rent \/ mo/)).toBeTruthy();
    expect(screen.getAllByText('Vacancy (lease-SF basis)').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Reconstructed from current leases')).toBeTruthy();
    expect(within(vacTile()).getByText('25.0%')).toBeTruthy();
  });

  it('lists each investment property in the scope selector', () => {
    renderView();
    expect(screen.getByRole('option', { name: 'Alpha Commons' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Beta Park' })).toBeTruthy();
  });

  it("selecting a property swaps the KPIs to that property's series", async () => {
    renderView();
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'b' } });
    await waitFor(() => expect(within(vacTile()).getByText('50.0%')).toBeTruthy(), { timeout: 3000 });
  });

  it('labels forward months as contractual roll-off, never forecast', () => {
    renderView();
    expect(screen.getAllByText('Contractual roll-off after 2026-09 · no renewals assumed').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/forecast/i)).toBeNull();
    expect(screen.getByText(/NO renewals or re-leasing/)).toBeTruthy();
    expect(screen.getByText(/reconstructed from current leases only/)).toBeTruthy();
  });

  it('drops the YoY tile and annotates the rent and vacancy tiles', () => {
    renderView();
    expect(screen.queryByText(/YoY/)).toBeNull();
    expect(within(tile(/In-place rent \/ mo/)).getByText('reconstructed · excludes departed tenants')).toBeTruthy();
    expect(within(vacTile()).getByText(/may differ from workbook occupancy/)).toBeTruthy();
  });

  it('renders an empty state, not zero KPIs, when the as-of month is absent from the series', () => {
    force.emptyPortfolio = true;
    renderView();
    expect(screen.getByText('No trend data for the as-of month')).toBeTruthy();
    expect(screen.queryByText('Vacancy (lease-SF basis)')).toBeNull();
  });
});
