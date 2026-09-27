// tests/unit/overview-kpi-other-holdings.test.tsx
//
// I-2(c) (2026-09-23 review): the Overview KPI strip's "Portfolio Value" tile must carry the
// other-holdings disclosure, disclosure-first, with the same wording as the Portfolio strip
// (tests/unit/portfolio-module-other-holdings.test.tsx) and the Principal Value tile — all three
// now share src/modules/overview/other-holdings.ts.
//
// Fixture style mirrors tests/unit/overview-kpi-drilldown.test.tsx (schema-complete snapshot
// seeded into the QueryClient cache) and tests/unit/portfolio-module-other-holdings.test.tsx
// (investment + residence Property rows).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PortfolioSnapshot, Property } from '../../src/contracts/index';
import { SNAPSHOT_KEY } from '../../src/data/queries';
import { OVERVIEW_WIDGETS } from '../../src/modules/overview/widgets';

const ASOF = '2026-09-23';

const investment: Property = {
  id: 'p1', index: 1, name: '29000 Information Lane, Easton MD', address: '29000 Information Lane', city: null, state: null, market: 'Mid-Atlantic', type: 'Flex',
  sf: 48000, tenantCount: 1, occPct: 1, acqDate: null, estValue100: 0, oxfordOwnPct: 1, oxfordValue: 7_310_000, grossIncome: 0, expenses: 0, noi: 511_000, noiScenarioAdj: 511_000,
  debtService: 0, netCashFlow: 0, capRate: 0.07, dscr: 2.45, lender: 'Symetra', loanBalance: 2_770_000, ltv: 0.38, valuePerSf: null, rentPerSf: null, equityInvested: 1_000_000,
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

function kpiStripComponent() {
  const def = OVERVIEW_WIDGETS.find((w) => w.id === 'kpis');
  if (!def) throw new Error('widget not registered: kpis');
  return def.Component;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderStrip(s: PortfolioSnapshot) {
  const Component = kpiStripComponent();
  return render(
    <QueryClientProvider client={seededClient(s)}>
      <Component />
    </QueryClientProvider>,
  );
}

describe('Overview KpiStripWidget — Portfolio Value sublabel reports other holdings', () => {
  it('shows the disclosure first, then the correctly-pluralized count, when a residence row exists', () => {
    renderStrip(snapshot([investment, residence]));
    expect(screen.getByText('+$2.00M other holdings · 1 investment property')).toBeTruthy();
  });

  it('omits the clause and pluralizes correctly when there is no residence row', () => {
    renderStrip(snapshot([investment]));
    expect(screen.getByText('1 investment property')).toBeTruthy();
    expect(screen.queryByText(/other holdings/)).toBeNull();
  });

  it('Equity Invested discloses the residence equity as other holdings (ratified 2026-09-24)', () => {
    renderStrip(snapshot([investment, residence]));
    expect(screen.getByText('+$900K other holdings')).toBeTruthy();
  });
});
