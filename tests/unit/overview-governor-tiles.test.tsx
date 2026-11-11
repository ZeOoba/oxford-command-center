// tests/unit/overview-governor-tiles.test.tsx
//
// Design review 2026-10-31 finding 9: the Overview KPI strip carries three governor bullet tiles
// (DSCR vs the 1.25x floor, aggregate LTV vs the 40% ceiling, total cash vs the $1.5M firm floor).
// Each tile is neutral until breached, and each bullet graph has a text alternative that states the
// value, the governor and the basis. Fixture style mirrors tests/unit/overview-kpi-other-holdings.test.tsx.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PortfolioSnapshot, Property } from '../../src/contracts/index';
import { SNAPSHOT_KEY } from '../../src/data/queries';
import { OVERVIEW_WIDGETS } from '../../src/modules/overview/widgets';

const ASOF = '2026-11-02';

const levered: Property = {
  id: 'p1', index: 1, name: 'Alpha Industrial', address: '1 Alpha Way', city: null, state: null, market: 'Columbus OH', type: 'Flex',
  sf: 40_000, tenantCount: 3, occPct: 1, acqDate: null, estValue100: 0, oxfordOwnPct: 1, oxfordValue: 5_000_000,
  grossIncome: 0, expenses: 0, noi: 400_000, noiScenarioAdj: 400_000, debtService: 200_000, netCashFlow: 0,
  capRate: 0.08, dscr: 2.0, lender: 'Firm 03', loanBalance: 1_500_000, ltv: 0.3, valuePerSf: null, rentPerSf: null,
  equityInvested: 0, cashOnCash: null, holdYrs: null, encumbered: true, flags: [],
} as Property;
const thin: Property = {
  ...levered, id: 'p2', index: 2, name: 'Bravo Flex', noi: 110_000, noiScenarioAdj: 110_000, debtService: 100_000, dscr: 1.1,
  oxfordValue: 1_000_000, loanBalance: 700_000, ltv: 0.7,
} as Property;

const cashEntity = (entity: string, id: string, currentBalance: number) => ({
  entity, id, currentBalance, priorBalance: null, deltaDollar: null, deltaPct: null, avg3: null, minAllTime: null, maxAllTime: null,
  bal12moAgo: null, growth12Dollar: null, growth12Pct: null, pctOfPortfolio: null, trend: 'flat' as const, flags: [],
});

/** `oxfordCash` = the firm ("Oxford") entity balance; null omits that entity. `totalCash` defaults to it. */
function snapshot(properties: Property[], oxfordCash: number | null, totalCash: number = oxfordCash ?? 0): PortfolioSnapshot {
  return {
    meta: { schemaVersion: '1.0.0', asOf: ASOF, generatedAt: `${ASOF}T00:00:00.000Z`, source: 'test', scenario: 'Base' },
    assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: ASOF },
    properties,
    leases: [],
    loans: [],
    cash: { asOf: ASOF, totalCash, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: oxfordCash === null ? [] : [cashEntity('Oxford', 'oxford', oxfordCash)], history: [] },
    insurance: [], deals: [], tasks: [], counterparties: [],
    renewalStages: {}, tenantNotes: {}, dealComps: {}, acquisitionInputs: {}, noiBudgets: {}, tenantArrears: {}, arBalances: [],
    quickbooks: null, governors: null, marketRents: {}, workbookTotals: { noi: null, value: null, rent: null }, dataQuality: [],
  } as unknown as PortfolioSnapshot;
}

function renderStrip(s: PortfolioSnapshot) {
  const def = OVERVIEW_WIDGETS.find((w) => w.id === 'kpis');
  if (!def) throw new Error('widget not registered: kpis');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  qc.setQueryData(SNAPSHOT_KEY, { snapshot: s, state: { status: 'fresh', source: 'workbook', lastUpdated: ASOF, lastError: null, workbookPath: 'test.xlsx', flagCount: 0 } });
  const Component = def.Component;
  return render(
    <QueryClientProvider client={qc}>
      <Component />
    </QueryClientProvider>,
  );
}

const tile = (name: string) => screen.getByRole('group', { name });

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Overview KpiStripWidget — governor bullet tiles', () => {
  it('renders all three tiles neutral when every governor is within bounds', () => {
    renderStrip(snapshot([levered], 2_400_000));
    expect(tile('DSCR vs governor').getAttribute('data-state')).toBe('ok');
    expect(tile('LTV vs governor').getAttribute('data-state')).toBe('ok');
    expect(tile('Cash vs floor').getAttribute('data-state')).toBe('ok');
  });

  it('gives each bullet graph a text alternative naming value, governor and state', () => {
    renderStrip(snapshot([levered], 2_400_000));
    expect(screen.getByRole('img', { name: /DSCR 2\.00x against the 1\.25x floor, within governor/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /LTV 30\.0% against the 40\.0% ceiling, within governor/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /Firm cash \$2\.40M against the \$1\.50M floor, within floor\. Basis: Oxford entity balance, interim proxy/ })).toBeTruthy();
  });

  it('labels the basis on each tile', () => {
    renderStrip(snapshot([levered], 2_400_000));
    expect(screen.getByText(/1 levered property · affiliate notes included/)).toBeTruthy();
    expect(screen.getByText(/aggregate · affiliate notes excluded/)).toBeTruthy();
    expect(screen.getByText('+$900K over floor')).toBeTruthy();
    expect(screen.getByText(/all entities \$2\.40M · context, not the floor basis/)).toBeTruthy();
  });

  it('marks only the breached governors abnormal and names the weakest property', () => {
    // Σ NOI 510k / Σ DS 300k = 1.70x aggregate (ok); Bravo 1.10x is below the floor (watch).
    // LTV = 2.2M / 6.0M = 36.7% (ok). Cash 1.2M < 1.5M (breach).
    renderStrip(snapshot([levered, thin], 1_200_000));
    expect(tile('DSCR vs governor').getAttribute('data-state')).toBe('watch');
    expect(screen.getByText(/weakest Bravo Flex 1\.10x/)).toBeTruthy();
    expect(tile('LTV vs governor').getAttribute('data-state')).toBe('ok');
    expect(tile('Cash vs floor').getAttribute('data-state')).toBe('breach');
    expect(screen.getByRole('img', { name: /Firm cash \$1\.20M against the \$1\.50M floor, below floor by \$300K/ })).toBeTruthy();
  });

  it('breaches DSCR on the aggregate and LTV above the ceiling', () => {
    renderStrip(snapshot([thin], 2_000_000));
    expect(tile('DSCR vs governor').getAttribute('data-state')).toBe('breach');
    expect(tile('LTV vs governor').getAttribute('data-state')).toBe('breach');
    expect(screen.getByRole('img', { name: /LTV 70\.0% against the 40\.0% ceiling, above ceiling/ })).toBeTruthy();
  });

  it('reports unknown (not OK) when nothing is levered, and for a missing LTV', () => {
    renderStrip(snapshot([{ ...levered, debtService: 0, dscr: null, loanBalance: 0, ltv: null, lender: null } as Property], 2_000_000));
    expect(tile('DSCR vs governor').getAttribute('data-state')).toBe('unknown');
    cleanup();
    // No investment value at all → kpis.ltv is null.
    renderStrip(snapshot([], 2_000_000));
    expect(tile('LTV vs governor').getAttribute('data-state')).toBe('unknown');
    expect(screen.getByRole('img', { name: /LTV not available/ })).toBeTruthy();
    cleanup();
    renderStrip(snapshot([{ ...levered, debtService: 0, dscr: null, loanBalance: 0, ltv: null, lender: null } as Property], 2_000_000));
    expect(screen.getByRole('img', { name: /DSCR not available — no levered properties/ })).toBeTruthy();
  });

  it('treats an empty Cash Balances feed as unknown: never a breach, never OK', () => {
    renderStrip(snapshot([levered], null, 0));
    expect(tile('Cash vs floor').getAttribute('data-state')).toBe('unknown');
    expect(screen.getByRole('img', { name: /Firm cash unknown — no single Oxford entity/ })).toBeTruthy();
  });

  it('governs the floor on the Oxford entity (interim sweepable-cash proxy, 2026-11-02), not the all-entity total', () => {
    // $1.0M firm cash inside an $8.0M all-entity total: the floor is breached.
    renderStrip(snapshot([levered], 1_000_000, 8_000_000));
    expect(tile('Cash vs floor').getAttribute('data-state')).toBe('breach');
    expect(screen.getByRole('img', { name: /Firm cash \$1\.00M against the \$1\.50M floor, below floor by \$500K.*All entities total \$8\.00M, context only/ })).toBeTruthy();
  });

  it('shows unknown when no entity is exactly "Oxford", even with a large total', () => {
    const s = snapshot([levered], null, 8_000_000);
    s.cash.entities = [cashEntity('Oxford Capital', 'oxford-capital', 5_000_000), cashEntity('Fairground Village Center', 'fairground-village-center', 3_000_000)];
    renderStrip(s);
    expect(tile('Cash vs floor').getAttribute('data-state')).toBe('unknown');
  });

  it('prints an exact two-decimal breaching DSCR as-is (no float-error overshoot)', () => {
    // 1.15 * 100 = 114.99999999999999 in IEEE-754: a plain Math.floor would print "1.14x".
    renderStrip(snapshot([{ ...levered, noi: 115_000, noiScenarioAdj: 115_000, debtService: 100_000, dscr: 1.15 } as Property], 2_000_000));
    expect(screen.getByRole('img', { name: /DSCR 1\.15x against the 1\.25x floor, below floor\. Weakest property Alpha Industrial 1\.15x/ })).toBeTruthy();
  });

  it('never displays a breaching value as the boundary itself', () => {
    // DSCR 1.2496x, LTV 40.04%, cash $1,499,999 would round to "1.25x" / "40.0%" / "$1.50M".
    const edge = { ...levered, noi: 124_960, noiScenarioAdj: 124_960, debtService: 100_000, dscr: 1.2496, oxfordValue: 1_000_000, loanBalance: 400_400 } as Property;
    renderStrip(snapshot([edge], 1_499_999));
    expect(screen.getByRole('img', { name: /DSCR 1\.24x against the 1\.25x floor, below floor/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /LTV 40\.1% against the 40\.0% ceiling, above ceiling/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /Firm cash \$1\.49M against the \$1\.50M floor, below floor/ })).toBeTruthy();
  });
});
