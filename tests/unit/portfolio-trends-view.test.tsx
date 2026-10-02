// tests/unit/portfolio-trends-view.test.tsx
//
// Portfolio > Trends tab. Fixture idiom mirrors tests/unit/portfolio-module-other-holdings.test.tsx:
// a schema-complete snapshot seeded into the QueryClient cache, real UiContext.Provider, fetch stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as PortfolioTrends from '@analytics/portfolio-trends';
import type * as TrendsHistory from '../../src/modules/portfolio/trends-history';
import type { Lease, PortfolioSnapshot, Property } from '../../src/contracts/index';
import { SNAPSHOT_KEY } from '../../src/data/queries';
import { UiContext, type UiState } from '../../src/brain/ui-context';

// Hoisted toggle so one test can force a trend whose series lacks the as-of month.
const force = vi.hoisted(() => ({ emptyPortfolio: false }));
// Recorded-history hook result: only the fields TrendsView reads.
const hist = vi.hoisted(() => ({ result: { data: undefined, isLoading: false, isError: false, error: null } as { data: unknown; isLoading: boolean; isError: boolean; error: unknown } }));
vi.mock('../../src/modules/portfolio/trends-history', async (orig) => {
  const actual = await orig<typeof TrendsHistory>();
  return { ...actual, useTrendsHistory: () => hist.result };
});
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
  hist.result = { data: undefined, isLoading: false, isError: false, error: null };
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

const vacTile = () => screen.getAllByText('Vacancy (lease-SF basis)').map((e) => e.closest('[class*="rounded"]') as HTMLElement).find((t) => t.textContent?.includes('pts MoM'))!;
/** Captions must sit beneath the KpiStat card, never inside it (its sublabel is a nowrap/truncate flex row). */
const outsideCards = (el: HTMLElement) => {
  expect(el.closest('.truncate')).toBeNull();
  expect(el.closest('[class*="rounded"]')).toBeNull();
};

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
    outsideCards(screen.getByText('reconstructed · excludes departed tenants'));
    outsideCards(screen.getByText('lease-SF basis · may differ from workbook occupancy'));
    expect(within(vacTile()).getByText(/pts MoM/)).toBeTruthy();
  });

  it('renders an empty state, not zero KPIs, when the as-of month is absent from the series', () => {
    force.emptyPortfolio = true;
    renderView();
    expect(screen.getByText('No trend data for the as-of month')).toBeTruthy();
    expect(screen.queryByText('Vacancy (lease-SF basis)')).toBeNull();
  });

  it('treats an unavailable/errored history, loading state and empty points as no recorded history', () => {
    for (const r of [
      { data: undefined, isLoading: false, isError: true, error: new Error('unavailable') },
      { data: undefined, isLoading: true, isError: false, error: null },
      { data: { points: [] }, isLoading: false, isError: false, error: null },
    ]) {
      hist.result = r;
      const { unmount } = renderView();
      expect(screen.getByText('Reconstructed from current leases')).toBeTruthy();
      expect(screen.queryByText(/Recorded:/)).toBeNull();
      expect(screen.queryByText(/YoY/)).toBeNull();
      unmount();
    }
  });
});

// ---- Wave 2: recorded history ----
const rec = (propertyId: string, month: string, over: Record<string, unknown> = {}) => ({
  propertyId, month, capturedThrough: `${month}-28`, totalSf: 10000, leasedSf: 10000, inPlaceRent: 10000, leaseCount: 1, occPct: 1, frozen: false, ...over,
});
const recB = (month: string, over: Record<string, unknown> = {}) => rec('b', month, { leasedSf: 5000, inPlaceRent: 5000, occPct: 0.5, ...over });
const setHist = (points: unknown[]) => { hist.result = { data: { points }, isLoading: false, isError: false, error: null }; };

describe('TrendsView recorded history (Wave 2)', () => {
  it('shows a recorded badge and relabels the reconstructed badge while reconstructed months remain', () => {
    setHist([rec('a', '2026-09'), recB('2026-09')]);
    renderView();
    expect(screen.getByText('Recorded: 1 month (since 2026-09)')).toBeTruthy();
    expect(screen.getByText('Earlier months reconstructed from current leases')).toBeTruthy();
    expect(screen.queryByText('Reconstructed from current leases')).toBeNull();
    expect(screen.getByText(/NO renewals or re-leasing/)).toBeTruthy();
    expect(screen.getAllByText('Vacancy (lease-SF basis)').length).toBeGreaterThanOrEqual(2);
  });

  it('counts only recorded non-forecast months and drops the reconstructed badge when none remain', () => {
    const months: string[] = [];
    for (let i = -12; i <= 0; i++) {
      const d = new Date(Date.UTC(2026, 8 + i, 1));
      months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    }
    // A recorded row for a forecast month (2026-10) must neither count nor replace.
    setHist([...months, '2026-10'].flatMap((m) => [rec('a', m), recB(m)]));
    renderView();
    expect(screen.getByText('Recorded: 13 months (since 2025-09)')).toBeTruthy();
    expect(screen.queryByText('Reconstructed from current leases')).toBeNull();
    expect(screen.queryByText('Earlier months reconstructed from current leases')).toBeNull();
  });

  it('computes KPI MoM from the merged points', () => {
    // Recorded as-of rent 15000 vs recorded prior month 7500 -> +100%.
    setHist([
      rec('a', '2026-09'), recB('2026-09'),
      rec('a', '2026-08', { inPlaceRent: 5000 }), recB('2026-08', { inPlaceRent: 2500 }),
    ]);
    renderView();
    expect(within(tile(/In-place rent \/ mo/)).getByText('100.0%')).toBeTruthy();
  });

  it('renders the YoY (recorded) tile only when both ends are recorded', () => {
    setHist([
      rec('a', '2026-09'), recB('2026-09'),
      rec('a', '2025-09', { inPlaceRent: 5000 }), recB('2025-09', { inPlaceRent: 2500 }),
    ]);
    renderView();
    expect(within(tile('YoY (recorded)')).getByText('100.0%')).toBeTruthy();
  });

  it('has no YoY tile when only the as-of month is recorded', () => {
    setHist([rec('a', '2026-09'), recB('2026-09')]);
    renderView();
    expect(screen.queryByText(/YoY/)).toBeNull();
  });

  it('shows SF-weighted workbook occupancy (portfolio) and the row occPct (single property)', async () => {
    setHist([rec('a', '2026-09', { totalSf: 10000, occPct: 1 }), recB('2026-09', { totalSf: 30000, occPct: 0.6 })]);
    renderView();
    // (10000*1 + 30000*0.6) / 40000 = 0.7
    expect(screen.getByText('Workbook occupancy: 70.0%')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'b' } });
    await waitFor(() => expect(screen.getByText('Workbook occupancy: 60.0%')).toBeTruthy(), { timeout: 3000 });
  });

  it('skips the workbook occupancy line when any in-scope property lacks occPct or the as-of month is not recorded', () => {
    setHist([rec('a', '2026-09'), recB('2026-09', { occPct: null })]);
    renderView();
    expect(screen.queryByText(/Workbook occupancy:/)).toBeNull();
    cleanup();
    setHist([rec('a', '2026-08'), recB('2026-08')]);
    renderView();
    expect(screen.queryByText(/Workbook occupancy:/)).toBeNull();
  });

  it('scope selector keeps working with merged points', async () => {
    setHist([rec('a', '2026-09'), recB('2026-09')]);
    renderView();
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'b' } });
    await waitFor(() => expect(within(vacTile()).getByText('50.0%')).toBeTruthy(), { timeout: 3000 });
    expect(screen.getByText('Recorded: 1 month (since 2026-09)')).toBeTruthy();
  });

  it('a stale selected scope falls back to the portfolio with merged points', async () => {
    setHist([rec('a', '2026-09'), recB('2026-09')]);
    const qc = seededClient(snapshot());
    const tree = (
      <QueryClientProvider client={qc}><UiContext.Provider value={ui}><TrendsView /></UiContext.Provider></QueryClientProvider>
    );
    const view = render(tree);
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'b' } });
    const s2 = snapshot();
    s2.properties = s2.properties.filter((p) => p.id !== 'b');
    s2.leases = s2.leases.filter((l) => l.propertyId !== 'b');
    act(() => { qc.setQueryData(SNAPSHOT_KEY, { snapshot: s2, state: { status: 'fresh', source: 'workbook', lastUpdated: ASOF, lastError: null, workbookPath: 'test.xlsx', flagCount: 0 } }); });
    view.rerender(tree);
    await waitFor(() => expect((screen.getByLabelText('Scope') as HTMLSelectElement).value).toBe('__portfolio__'));
    expect(screen.queryByRole('option', { name: 'Beta Park' })).toBeNull();
  });
});

describe('TrendsView source labels (Wave 2 follow-up)', () => {
  const allMonths = () => {
    const out: string[] = [];
    for (let i = -12; i <= 0; i++) {
      const d = new Date(Date.UTC(2026, 8 + i, 1));
      out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    }
    return out;
  };

  it('mixed history: caption and rent sublabel are accurate for a recorded/reconstructed mix', () => {
    setHist([rec('a', '2026-09'), recB('2026-09')]);
    renderView();
    expect(screen.queryByText(/history is reconstructed from current leases only/)).toBeNull();
    expect(screen.getByText(/Months before 2026-09 are reconstructed from current leases; 2026-09 onward are recorded\./)).toBeTruthy();
    outsideCards(screen.getByText('reconstructed history excludes departed tenants'));
    expect(screen.queryByText('reconstructed · excludes departed tenants')).toBeNull();
    expect(screen.getByText(/NO renewals or re-leasing/)).toBeTruthy();
  });

  it('fully recorded history drops all reconstructed wording', () => {
    setHist(allMonths().flatMap((m) => [rec('a', m), recB(m)]));
    renderView();
    expect(screen.queryByText(/reconstructed/i)).toBeNull();
    expect(screen.getByText(/NO renewals or re-leasing/)).toBeTruthy();
  });

  it('no recorded history keeps the Wave 1 wording', () => {
    renderView();
    expect(screen.getByText(/history is reconstructed from current leases only/)).toBeTruthy();
    expect(screen.getByText('reconstructed · excludes departed tenants')).toBeTruthy();
  });

  it('workbook occupancy renders in full, outside any truncating element', () => {
    setHist([rec('a', '2026-09'), recB('2026-09')]);
    renderView();
    outsideCards(screen.getByText('Workbook occupancy: 75.0%'));
    expect(within(vacTile()).queryByText(/Workbook occupancy:/)).toBeNull();
    // Caption order: basis note first, then the occupancy value.
    const note = screen.getByText('lease-SF basis · may differ from workbook occupancy');
    expect(note.compareDocumentPosition(screen.getByText('Workbook occupancy: 75.0%')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('TrendsView rent-change bar provenance', () => {
  const barNote = (re: RegExp) => screen.queryByText(re);

  it('no recorded history: no bar provenance note (Wave 1)', () => {
    renderView();
    expect(barNote(/Bars before/)).toBeNull();
    expect(barNote(/^Recorded months$/)).toBeNull();
  });

  it('partial recorded history discloses where bars switch from reconstructed to recorded', () => {
    setHist([rec('a', '2026-08'), recB('2026-08'), rec('a', '2026-09'), recB('2026-09')]);
    renderView();
    expect(screen.getByText('Bars before 2026-09 reconstructed from current leases; recorded from 2026-09')).toBeTruthy();
  });

  it('only a single recorded month (no recorded predecessor) keeps every bar reconstructed', () => {
    setHist([rec('a', '2026-09'), recB('2026-09')]);
    renderView();
    expect(barNote(/Bars before/)).toBeNull();
  });

  it('fully recorded history labels the bars "Recorded months"', () => {
    const months: string[] = [];
    for (let i = -12; i <= 0; i++) {
      const d = new Date(Date.UTC(2026, 8 + i, 1));
      months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    }
    setHist(months.flatMap((m) => [rec('a', m), recB(m)]));
    renderView();
    expect(screen.getByText('Recorded months')).toBeTruthy();
    expect(barNote(/Bars before/)).toBeNull();
  });
});
