// tests/unit/noi-sweep-render.test.tsx
//
// Sweep review L3 (PR #582): render-level pins for the three NOI-reader call sites whose pure helpers
// were tested but whose wiring was not: the Portfolio weighted-cap sublabel, the Market › Acquisition
// Lens, and the Tenants "% Portfolio NOI" cell. Each mounts the real module against a snapshot holding
// one blank workbook NOI row and asserts the "incomplete" text reaches the DOM. Fixtures are synthetic;
// harness mirrors tests/unit/portfolio-module-other-holdings.test.tsx.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Lease, MacroSnapshot, PortfolioSnapshot, Property } from '../../src/contracts/index';
import { SNAPSHOT_KEY } from '../../src/data/queries';
import { UiContext, type UiState } from '../../src/brain/ui-context';
import { GOVERNOR_INPUT_BLANK_FIELD } from '../../src/analytics/governor-inputs';
import { PortfolioModule } from '../../src/modules/portfolio/PortfolioModule';
import { MarketModule } from '../../src/modules/market/MarketModule';
import { TenantsModule } from '../../src/modules/tenants/TenantsModule';

const ASOF = '2026-11-01';

const known: Property = {
  id: 'p1', index: 1, name: 'Alpha Flex', address: '1 Test Way', city: null, state: null, market: 'Columbus OH', type: 'Flex',
  sf: 40_000, tenantCount: 1, occPct: 1, acqDate: null, estValue100: 0, oxfordOwnPct: 1, oxfordValue: 4_000_000, grossIncome: 0, expenses: 0,
  noi: 300_000, noiScenarioAdj: 300_000, debtService: 0, netCashFlow: 0, capRate: 0.075, dscr: null, lender: null, loanBalance: 0, ltv: null,
  valuePerSf: null, rentPerSf: null, equityInvested: 0, cashOnCash: null, holdYrs: null, encumbered: false, flags: [],
} as Property;
const blank: Property = {
  ...known, id: 'p2', index: 2, name: 'Bravo Bay', noi: 0, noiScenarioAdj: 0, capRate: null, oxfordValue: 3_000_000,
  flags: [{ entity: 'p2', field: GOVERNOR_INPUT_BLANK_FIELD, issue: 'blank', rawValue: 'noi', severity: 'warn' }],
} as Property;

const lease = (id: string, propertyId: string, tenant: string, annualRent: number): Lease =>
  ({
    id, propertyKey: propertyId, propertyId, tenantName: tenant, company: tenant, suite: null, sf: 5_000, annualRent,
    monthlyRent: annualRent / 12, leaseStart: '2024-01-01', leaseEnd: '2029-12-31', status: 'Active', flags: [],
  }) as unknown as Lease;

function snapshot(properties: Property[], leases: Lease[] = []): PortfolioSnapshot {
  return {
    meta: { schemaVersion: '1.0.0', asOf: ASOF, generatedAt: `${ASOF}T00:00:00.000Z`, source: 'test', scenario: 'Base' },
    assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: ASOF },
    properties, leases, loans: [],
    cash: { asOf: ASOF, totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
    insurance: [], deals: [], tasks: [], counterparties: [],
    renewalStages: {}, tenantNotes: {}, dealComps: {}, acquisitionInputs: {}, noiBudgets: {}, tenantArrears: {}, arBalances: [],
    quickbooks: null, governors: null, marketRents: {}, workbookTotals: { noi: null, value: null, rent: null }, dataQuality: [],
  } as unknown as PortfolioSnapshot;
}

const macro: MacroSnapshot = {
  asOf: '2026-11-01', source: 'fred',
  indicators: [{ id: 'DGS10', label: '10Y Treasury', value: 4.2, unit: '%', change: null }],
  tenYearHistory: [{ date: '2026-10-01', value: 4.1 }, { date: '2026-11-01', value: 4.2 }],
};

function seededClient(s: PortfolioSnapshot): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  qc.setQueryData(SNAPSHOT_KEY, { snapshot: s, state: { status: 'fresh', source: 'workbook', lastUpdated: ASOF, lastError: null, workbookPath: 'test.xlsx', flagCount: 0 } });
  qc.setQueryData(['macro'], macro);
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

function mount(node: React.ReactNode, s: PortfolioSnapshot) {
  return render(
    <QueryClientProvider client={seededClient(s)}>
      <UiContext.Provider value={ui}>
        <MemoryRouter>{node}</MemoryRouter>
      </UiContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('NOI-reader sweep — render pins for the helper-only call sites (sweep review L3)', () => {
  it('Portfolio: the weighted-cap tile sublabel names the blank row; a complete snapshot shows none', () => {
    mount(<PortfolioModule />, snapshot([known, blank]));
    // The NOI tile carries "Oxford share · …"; the weighted-cap tile carries the bare text.
    expect(screen.getByText('incomplete — blank NOI on Bravo Bay')).toBeTruthy();
    expect(screen.getByText('Oxford share · incomplete — blank NOI on Bravo Bay')).toBeTruthy();
    cleanup();
    mount(<PortfolioModule />, snapshot([known]));
    expect(screen.getByText('Weighted Cap Rate')).toBeTruthy(); // rendered, so the null below is not vacuous
    expect(screen.queryByText(/blank NOI/)).toBeNull();
  });

  it('Market › Acquisition Lens: marks the cap incomplete and withholds the spread', () => {
    mount(<MarketModule />, snapshot([known, blank]));
    expect(screen.getByText(/^\d+\.\d{2}% \(incomplete\)$/)).toBeTruthy();
    expect(screen.getByText('Spread withheld: the weighted cap rate is incomplete (blank NOI on Bravo Bay).')).toBeTruthy();
    expect(screen.queryByText(/\d+ bps$/)).toBeNull();
  });

  it('Market › Acquisition Lens: a complete snapshot shows the spread and no withheld note', () => {
    mount(<MarketModule />, snapshot([known]));
    expect(screen.getByText(/^-?\d+ bps$/)).toBeTruthy();
    expect(screen.queryByText(/Spread withheld/)).toBeNull();
  });

  it('Tenants: the % Portfolio NOI cell reads "(incomplete)" and the table footnote names the blank row', () => {
    mount(<TenantsModule />, snapshot([known, blank], [lease('l1', 'p1', 'Known Co', 120_000), lease('l2', 'p2', 'Blank Co', 90_000)]));
    expect(screen.getByText('100.0% (incomplete)')).toBeTruthy();
    expect(screen.getByText('0.0% (incomplete)')).toBeTruthy();
    expect(screen.getByText(/% Portfolio NOI is incomplete: blank NOI on Bravo Bay is left out of the basis\./)).toBeTruthy();
  });
});
