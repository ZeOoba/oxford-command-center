// tests/unit/portfolio-module-other-holdings.test.tsx
//
// PortfolioModule's "Portfolio Value" tile must carry the same other-holdings sublabel as the Overview
// KPI strip (src/modules/overview/widgets.tsx): the residence is excluded from the investment value
// (ratified 2026-09-23) and must be REPORTED beside it, never silently dropped. Refute finding on
// Task 20: this was the one headline surface without the disclosure.
//
// Fixture style mirrors tests/unit/overview-kpi-drilldown.test.tsx — a schema-complete snapshot seeded
// into the QueryClient cache (useAnalytics derives the bundle from it), a real UiContext.Provider.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { PortfolioSnapshot, Property } from '../../src/contracts/index';
import { SNAPSHOT_KEY } from '../../src/data/queries';
import { UiContext, type UiState } from '../../src/brain/ui-context';
import { PortfolioModule } from '../../src/modules/portfolio/PortfolioModule';
import { PF_KEYS } from '../../src/modules/property-financials/hooks';
import { TRENDS_HISTORY_KEY } from '../../src/modules/portfolio/trends-history';

const ASOF = '2026-09-23';

const investment: Property = {
  id: 'p1', index: 1, name: '29000 Information Lane, Easton MD', address: '29000 Information Lane', city: null, state: null, market: 'Mid-Atlantic', type: 'Flex',
  sf: 48000, tenantCount: 1, occPct: 1, acqDate: null, estValue100: 0, oxfordOwnPct: 1, oxfordValue: 7_310_000, grossIncome: 0, expenses: 0, noi: 511_000, noiScenarioAdj: 511_000,
  debtService: 0, netCashFlow: 0, capRate: 0.07, dscr: 2.45, lender: 'REDACTED-672', loanBalance: 2_770_000, ltv: 0.38, valuePerSf: null, rentPerSf: null, equityInvested: 1_000_000,
  cashOnCash: null, holdYrs: null, encumbered: true, flags: [],
} as Property;
const residence: Property = {
  ...investment, id: 'res', index: 2, name: '9510 Persimmon Tree Rd, Potomac MD', type: 'Residence', sf: 6700, oxfordValue: 2_000_000, noi: 0, noiScenarioAdj: 0,
  capRate: null, dscr: null, lender: null, loanBalance: 0, ltv: null, equityInvested: 900_000, encumbered: false,
} as Property;

function snapshot(properties: Property[]): PortfolioSnapshot {
  return {
    meta: { schemaVersion: '1.0.0', asOf: ASOF, generatedAt: `${ASOF}T00:00:00.000Z`, source: 'test', scenario: 'Base' },
    assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: ASOF },
    properties,
    leases: [],
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
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderModule(s: PortfolioSnapshot) {
  return render(
    <QueryClientProvider client={seededClient(s)}>
      <UiContext.Provider value={ui}>
        {/* The property table links into /property/:id (roadmap 2.2), so it needs a router. */}
        <MemoryRouter>
          <PortfolioModule />
        </MemoryRouter>
      </UiContext.Provider>
    </QueryClientProvider>,
  );
}

describe('PortfolioModule — Portfolio Value sublabel reports other holdings', () => {
  it('shows the disclosure FIRST, then the correctly-pluralized count, when a residence row exists (same sublabel as the Overview strip)', () => {
    renderModule(snapshot([investment, residence]));
    expect(screen.getByText('+$2.00M other holdings · 1 investment property')).toBeTruthy();
    // The detail table still lists every row — that is a per-row surface, not a KPI.
    expect(screen.getByText('2 properties')).toBeTruthy();
  });

  it('omits the other-holdings clause when there is no residence row, and pluralizes correctly', () => {
    renderModule(snapshot([investment]));
    expect(screen.getByText('1 investment property')).toBeTruthy();
    expect(screen.queryByText(/other holdings/)).toBeNull();
  });
});

describe('PortfolioModule — roadmap 2.4 trend cells', () => {
  const months = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`).slice(0, 9);
  const ledger = [...['2025-10', '2025-11', '2025-12'], ...months];

  function renderWithTrends() {
    const qc = seededClient(snapshot([investment, residence]));
    qc.setQueryData(PF_KEYS.dataset, {
      dataset: { monthly: { E1: Object.fromEntries(ledger.map((m) => [m, { noi: 40_000, revenue: 0, opex: 0, base_rent: 0 }])) } },
      liveSf: { entries: { E1: { canonicalId: 'p1' } } },
    });
    qc.setQueryData(TRENDS_HISTORY_KEY, {
      points: [
        { propertyId: 'p1', month: '2025-09', capturedThrough: '2025-09-30', totalSf: 48000, leasedSf: 43200, inPlaceRent: 0, leaseCount: 1, occPct: 0.9, frozen: true },
        { propertyId: 'p1', month: '2026-09', capturedThrough: '2026-09-30', totalSf: 48000, leasedSf: 48000, inPlaceRent: 0, leaseCount: 1, occPct: 1, frozen: false },
      ],
    });
    return render(
      <QueryClientProvider client={qc}>
        <UiContext.Provider value={ui}>
          <MemoryRouter>
            <PortfolioModule />
          </MemoryRouter>
        </UiContext.Provider>
      </QueryClientProvider>,
    );
  }

  it('labels each new column with its basis and renders the ledger spark and the recorded occupancy change', () => {
    renderWithTrends();
    expect(screen.getByText('NOI 12m · ledger')).toBeTruthy();
    expect(screen.getByText('Occ Δ · recorded')).toBeTruthy();
    expect(screen.getByRole('img', { name: /29000 Information Lane, Easton MD monthly NOI, P&L ledger entity 100%, 12 months to 2026-09/ })).toBeTruthy();
    expect(screen.getByText('+10.0 pp')).toBeTruthy();
    expect(screen.getByText(/· 12 mo/)).toBeTruthy();
  });

  it('shows a dash, not a number, for a row with no ledger entity or recorded history', () => {
    renderWithTrends();
    expect(screen.getAllByTitle('No 12 consecutive P&L-ledger months for this property')).toHaveLength(1);
    expect(screen.getAllByTitle('Fewer than two recorded monthly snapshots — no change shown')).toHaveLength(1);
  });
});
