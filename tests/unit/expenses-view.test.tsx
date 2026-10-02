// tests/unit/expenses-view.test.tsx
//
// Portfolio > Expenses tab. Mocks the expense hook and the snapshot (seeded into the QueryClient) like
// tests/unit/portfolio-trends-view.test.tsx. Heatmap / StackedBarChart are stubbed to expose their props
// (jsdom has no layout, so the real SVG charts draw nothing).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ExpenseMonthPoint, ExpensesMonthlyResponse } from '../../src/contracts/expenses-monthly';
import type { Property, PortfolioSnapshot } from '../../src/contracts/index';
import { SNAPSHOT_KEY } from '../../src/data/queries';
import { UiContext, type UiState } from '../../src/brain/ui-context';
import { WarehouseUnavailableError } from '../../src/modules/intel/hooks';

const hook = vi.hoisted(() => ({
  result: { data: undefined, isLoading: false, isError: false, error: null, refetch: () => {} } as {
    data: unknown; isLoading: boolean; isError: boolean; error: unknown; refetch: () => void;
  },
}));
vi.mock('../../src/modules/portfolio/expenses-hooks', () => ({ useExpensesMonthly: () => hook.result }));
vi.mock('../../src/charts/Heatmap', () => ({
  Heatmap: (p: { rows: string[]; cols: string[]; cells: unknown[]; ariaLabel?: string }) => (
    <div data-testid="heatmap" aria-label={p.ariaLabel} data-rows={JSON.stringify(p.rows)} data-cols={JSON.stringify(p.cols)} data-cells={JSON.stringify(p.cells)} />
  ),
}));
vi.mock('../../src/charts/StackedBarChart', () => ({
  StackedBarChart: (p: { keys: string[]; data: unknown[]; overlay?: unknown[] }) => (
    <div data-testid="stacked" data-keys={JSON.stringify(p.keys)} data-data={JSON.stringify(p.data)} data-overlay={JSON.stringify(p.overlay ?? [])} />
  ),
}));

import { ExpensesView } from '../../src/modules/portfolio/ExpensesView';

const ASOF = '2026-09-23';

const prop = (id: string, name: string, type = 'Flex'): Property =>
  ({
    id, index: 1, name, address: name, city: null, state: null, market: 'Mid-Atlantic', type, sf: 10000, tenantCount: 1, occPct: 1,
    acqDate: null, estValue100: 0, oxfordOwnPct: 1, oxfordValue: 1_000_000, grossIncome: 0, expenses: 0, noi: 0, noiScenarioAdj: 0,
    debtService: 0, netCashFlow: 0, capRate: null, dscr: null, lender: null, loanBalance: 0, ltv: null, valuePerSf: null, rentPerSf: null,
    equityInvested: 0, cashOnCash: null, holdYrs: null, encumbered: false, flags: [],
  }) as Property;

// Deliberately NOT in worst-first order: Beta, Alpha, Gamma, Delta, then a Residence (never counted).
function snapshot(): PortfolioSnapshot {
  return {
    meta: { schemaVersion: '1.0.0', asOf: ASOF, generatedAt: `${ASOF}T00:00:00.000Z`, source: 'test', scenario: 'Base' },
    assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: ASOF },
    properties: [prop('b', 'Beta Park'), prop('a', 'Alpha Commons'), prop('c', 'Gamma Yard'), prop('d', 'Delta Mix'), prop('r', 'Home Residence', 'Residence')],
    leases: [], loans: [],
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
  aiOpen: false, openAi: () => {}, closeAi: () => {},  toggleAi: () => {},
  scenario: 'Base', setScenario: () => {},
  draft: null, openDraft: () => {}, closeDraft: () => {},
};

// 14 consecutive months 2025-08 .. 2026-09.
const MONTHS = (() => {
  const out: string[] = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(Date.UTC(2025, 7 + i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
})();
const LATEST = '2026-09';

const pt = (propertyId: string, month: string, category: string, amount: number, basis: 'cash' | 'accrual' = 'cash'): ExpenseMonthPoint =>
  ({ propertyId, month, category, amount, basis, sourceSystem: 'quickbooks' });

/**
 * a (cash): Utilities 100 (160 in 2026-09) + Taxes 200            -> 300 (360 latest); variance +20.0%
 * b (cash): Utilities 50 (40 in 2026-09)                          -> 50 (40 latest);   variance -20.0%
 * c (accrual): Utilities 10, last 3 months only                   -> variance null
 * d (cash AND accrual in the same property): 1000 + 1000          -> excluded everywhere
 * r (Residence): 9999                                             -> never counted
 * Portfolio (a,b,c): 2026-09 = 410; 2026-08 = 360; 2025-09 = 350; T12 mean = 4280/12.
 */
function fixture(opts: { withAccrual?: boolean; withMixedProperty?: boolean } = {}): ExpensesMonthlyResponse {
  const { withAccrual = true, withMixedProperty = true } = opts;
  const points: ExpenseMonthPoint[] = [];
  for (const m of MONTHS) {
    points.push(pt('a', m, 'Utilities', m === LATEST ? 160 : 100), pt('a', m, 'Taxes', 200), pt('b', m, 'Utilities', m === LATEST ? 40 : 50));
    if (withMixedProperty) points.push(pt('d', m, 'Taxes', 1000, 'cash'), pt('d', m, 'Utilities', 1000, 'accrual'));
    points.push(pt('r', m, 'Taxes', 9999));
  }
  if (withAccrual) for (const m of ['2026-07', '2026-08', '2026-09']) points.push(pt('c', m, 'Utilities', 10, 'accrual'));
  return { points, coverage: { propertiesLoaded: 4, propertiesExpected: 6, firstMonth: '2025-08', lastMonth: LATEST } };
}

function setData(data: ExpensesMonthlyResponse | undefined, extra: Partial<typeof hook.result> = {}) {
  hook.result = { data, isLoading: false, isError: false, error: null, refetch: () => {}, ...extra };
}

beforeEach(() => {
  setData(fixture());
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function tree(qc: QueryClient) {
  return <QueryClientProvider client={qc}><UiContext.Provider value={ui}><ExpensesView /></UiContext.Provider></QueryClientProvider>;
}
const renderView = () => render(tree(seededClient(snapshot())));

const tile = (label: string | RegExp) => screen.getByText(label).closest('[class*="rounded"]') as HTMLElement;
const outsideCards = (el: HTMLElement) => {
  expect(el.closest('.truncate')).toBeNull();
  expect(el.closest('[class*="rounded"]')).toBeNull();
};
const attr = (testId: string, name: string) => JSON.parse(screen.getByTestId(testId).getAttribute(name)!);

describe('ExpensesView empty / error states', () => {
  const NOT_LOADED = /Monthly P&L data has not been loaded yet/;

  it('points: [] renders the single explanatory Card and no charts', () => {
    setData({ points: [], coverage: { propertiesLoaded: 0, propertiesExpected: 6, firstMonth: null, lastMonth: null } });
    renderView();
    expect(screen.getAllByText(NOT_LOADED)).toHaveLength(1);
    expect(screen.getByText(/exports have to be ingested/i)).toBeTruthy();
    expect(screen.queryByTestId('stacked')).toBeNull();
    expect(screen.queryByTestId('heatmap')).toBeNull();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    expect(screen.queryByText(/\$0\b/)).toBeNull();
  });

  it('a warehouse-unavailable error renders the same explanatory Card, not an error banner', () => {
    setData(undefined, { isError: true, error: new WarehouseUnavailableError('no warehouse') });
    renderView();
    expect(screen.getAllByText(NOT_LOADED)).toHaveLength(1);
    expect(screen.queryByText(/no warehouse/)).toBeNull();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    expect(screen.queryByTestId('stacked')).toBeNull();
  });

  it('any other error renders a neutral error Card with the message and a working Retry', () => {
    const refetch = vi.fn();
    setData(undefined, { isError: true, error: new Error('boom 500'), refetch });
    renderView();
    expect(screen.getByText(/boom 500/)).toBeTruthy();
    expect(screen.queryByText(NOT_LOADED)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('loading renders a skeleton, not the empty-state text', () => {
    setData(undefined, { isLoading: true });
    renderView();
    expect(screen.getByTestId('expenses-loading')).toBeTruthy();
    expect(screen.queryByText(NOT_LOADED)).toBeNull();
  });
});

describe('ExpensesView coverage and basis badges', () => {
  it('partial coverage shows "N of M entities loaded" and the loaded-only caption', () => {
    renderView();
    expect(screen.getByText('4 of 6 entities loaded')).toBeTruthy();
    expect(screen.getAllByText(/Totals cover loaded entities only/).length).toBeGreaterThanOrEqual(1);
  });

  it('full coverage shows no partial badge', () => {
    const f = fixture();
    f.coverage = { ...f.coverage, propertiesLoaded: 6, propertiesExpected: 6 };
    setData(f);
    renderView();
    expect(screen.queryByText(/entities loaded/)).toBeNull();
    expect(screen.queryByText(/Totals cover loaded entities only/)).toBeNull();
  });

  it('shows the Mixed basis badge with the per-basis entity counts when both bases are present', () => {
    renderView();
    expect(screen.getByText('Mixed basis (cash + accrual)')).toBeTruthy();
    expect(screen.getByText(/2 entities on cash, 1 on accrual/)).toBeTruthy();
  });

  it('shows no Mixed basis badge when every entity is on one basis', () => {
    setData(fixture({ withAccrual: false }));
    renderView();
    expect(screen.queryByText('Mixed basis (cash + accrual)')).toBeNull();
  });
});

describe('ExpensesView KPI strip', () => {
  it('shows latest-month opex, MoM, YoY and trailing-12 mean (mixed-basis property and Residence excluded)', () => {
    renderView();
    expect(within(tile('Latest opex')).getByText('$410')).toBeTruthy(); // 360 + 40 + 10
    expect(within(tile('MoM change')).getByText('+13.9%')).toBeTruthy(); // 50 / 360
    expect(within(tile('YoY (same month)')).getByText('+17.1%')).toBeTruthy(); // 60 / 350
    expect(within(tile('Trailing-12 avg')).getByText('$357')).toBeTruthy(); // 4280 / 12
  });

  it('missing comparatives render an em dash, never 0', () => {
    // Only the latest 2 months exist: no same-month-last-year, no 12-month window.
    const f = fixture({ withAccrual: false, withMixedProperty: false });
    f.points = f.points.filter((p) => p.month >= '2026-08' && p.propertyId !== 'r');
    setData(f);
    renderView();
    expect(within(tile('Latest opex')).getByText('$400')).toBeTruthy(); // 360 + 40
    expect(within(tile('MoM change')).getByText('+14.3%')).toBeTruthy(); // 50 / 350
    expect(within(tile('YoY (same month)')).getByText('—')).toBeTruthy();
    expect(within(tile('Trailing-12 avg')).getByText('—')).toBeTruthy();
    expect(within(tile('YoY (same month)')).queryByText(/^\$?0(\.0)?%?$/)).toBeNull();
  });
});

describe('ExpensesView KPI captions', () => {
  it('captions live beneath the KpiStat cards, never inside a card or a .truncate element', () => {
    renderView();
    for (const re of [/^Sep '26 ·/, /vs Aug '26/, /vs Sep '25/, /mean of 12 months to Sep '26/]) {
      outsideCards(within(screen.getByTestId('kpi-grid')).getByText(re));
    }
  });

  it('uses the items-start grid so tiles do not stretch', () => {
    renderView();
    const grid = tile('Latest opex').parentElement!.parentElement!;
    expect(grid.className).toMatch(/items-start/);
  });
});

describe('ExpensesView charts', () => {
  it('stacked chart gets top-5 categories plus Other, with a matching legend and prior-year overlay', () => {
    const points: ExpenseMonthPoint[] = [];
    const cats: Array<[string, number]> = [['Taxes', 700], ['Insurance', 600], ['Payroll', 500], ['Utilities', 400], ['Repairs', 300], ['Landscaping', 200], ['Snow', 100]];
    for (const m of MONTHS) for (const [c, v] of cats) points.push(pt('a', m, c, v));
    setData({ points, coverage: { propertiesLoaded: 1, propertiesExpected: 1, firstMonth: '2025-08', lastMonth: LATEST } });
    renderView();
    expect(attr('stacked', 'data-keys')).toEqual(['Taxes', 'Insurance', 'Payroll', 'Utilities', 'Repairs', 'Other']);
    const legend = screen.getByTestId('expense-legend');
    expect(within(legend).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Taxes', 'Insurance', 'Payroll', 'Utilities', 'Repairs', 'Other']);
    expect(within(legend).queryByText('Landscaping')).toBeNull();
    const data = attr('stacked', 'data-data') as Array<{ label: string; segments: Array<{ key: string; value: number }> }>;
    expect(data).toHaveLength(12); // last 12 months only
    expect(data[0]!.segments.at(-1)).toEqual({ key: 'Other', value: 300 }); // Landscaping 200 + Snow 100
    expect((attr('stacked', 'data-overlay') as unknown[]).length).toBeGreaterThan(0);
  });

  it('heatmap rows are sorted worst-first (largest positive variance first, null last); mixed-basis and Residence excluded', () => {
    renderView();
    expect(attr('heatmap', 'data-rows')).toEqual(['Alpha Commons', 'Beta Park', 'Gamma Yard']);
    expect(attr('heatmap', 'data-cols')).toHaveLength(12);
    expect(screen.getByTestId('heatmap').getAttribute('aria-label')).toBeTruthy();
    const cells = attr('heatmap', 'data-cells') as Array<{ row: string; col: string; value: number | null }>;
    const alpha = cells.find((c) => c.row === 'Alpha Commons' && c.col === 'Sep')!;
    expect(alpha.value).toBeCloseTo(0.2, 6);
    const beta = cells.find((c) => c.row === 'Beta Park' && c.col === 'Sep')!;
    expect(beta.value).toBeCloseTo(-0.2, 6);
    expect(cells.find((c) => c.row === 'Gamma Yard' && c.col === 'Sep')!.value).toBeNull();
  });

  it('small-multiples are ordered worst-first and the mixed-basis entity is "unavailable — mixed basis"', () => {
    renderView();
    const cards = screen.getAllByTestId('spark-card');
    expect(cards.map((c) => c.getAttribute('data-property'))).toEqual(['a', 'b', 'c', 'd']);
    expect(within(cards[0]!).getByText('Alpha Commons')).toBeTruthy();
    expect(within(cards[0]!).getByText('$360')).toBeTruthy();
    expect(within(cards[0]!).getByText(/\+2[0-9]\.[0-9]%|\+20\.0%/)).toBeTruthy();
    expect(within(cards[3]!).getByText(/unavailable — mixed basis/)).toBeTruthy();
    expect(within(cards[3]!).queryByText(/\$/)).toBeNull();
  });

  it('top movers lists at most 5 sentences from the selected scope', () => {
    renderView();
    const items = within(screen.getByTestId('movers')).getAllByRole('listitem');
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(5);
    expect(items[0]!.textContent).toBe('Utilities at Alpha Commons +$60 (+60.0%) vs trailing 12 mo');
    expect(items[1]!.textContent).toBe('Utilities at Beta Park −$10 (−20.0%) vs trailing 12 mo');
  });
});

describe('ExpensesView narrow heatmap', () => {
  it('uses unique month NUMBERS as column labels when the card is narrow (names clip at 375px)', () => {
    vi.stubGlobal('ResizeObserver', class {
      #cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) { this.#cb = cb; }
      observe() { this.#cb([{ contentRect: { width: 300 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver); }
      unobserve() {}
      disconnect() {}
    });
    renderView();
    expect(attr('heatmap', 'data-cols')).toEqual(['10', '11', '12', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
    const cells = attr('heatmap', 'data-cells') as Array<{ row: string; col: string; value: number | null }>;
    expect(cells.find((c) => c.row === 'Alpha Commons' && c.col === '9')!.value).toBeCloseTo(0.2, 6);
    expect(screen.getByText(/Columns are months/)).toBeTruthy();
  });
});

describe('ExpensesView scope selector', () => {
  it('lists investment properties only', () => {
    renderView();
    expect(screen.getByRole('option', { name: 'Alpha Commons' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Home Residence' })).toBeNull();
  });

  it('a single property hides heatmap and small-multiples and shows its own KPIs, categories and movers', async () => {
    renderView();
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'a' } });
    expect(screen.queryByTestId('heatmap')).toBeNull();
    expect(screen.queryAllByTestId('spark-card')).toHaveLength(0);
    await waitFor(() => expect(within(tile('Latest opex')).getByText('$360')).toBeTruthy(), { timeout: 10000 });
    expect(attr('stacked', 'data-keys')).toEqual(['Taxes', 'Utilities']); // no Other when nothing falls outside the top 5
    const items = within(screen.getByTestId('movers')).getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual(['Utilities at Alpha Commons +$60 (+60.0%) vs trailing 12 mo']);
  });

  it('a single mixed-basis property renders unavailable, with no KPI values', () => {
    renderView();
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'd' } });
    expect(screen.getByText(/unavailable — mixed basis/)).toBeTruthy();
    expect(screen.queryByTestId('stacked')).toBeNull();
  });

  it('a stale selected scope falls back to the portfolio', () => {
    const qc = seededClient(snapshot());
    const view = render(tree(qc));
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'a' } });
    expect(screen.queryByTestId('heatmap')).toBeNull();
    const s2 = snapshot();
    s2.properties = s2.properties.filter((p) => p.id !== 'a');
    act(() => { qc.setQueryData(SNAPSHOT_KEY, { snapshot: s2, state: { status: 'fresh', source: 'workbook', lastUpdated: ASOF, lastError: null, workbookPath: 'test.xlsx', flagCount: 0 } }); });
    view.rerender(tree(qc));
    expect((screen.getByLabelText('Scope') as HTMLSelectElement).value).toBe('__portfolio__');
    expect(screen.getByTestId('heatmap')).toBeTruthy();
  });
});
