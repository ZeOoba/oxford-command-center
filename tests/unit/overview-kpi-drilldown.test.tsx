// tests/unit/overview-kpi-drilldown.test.tsx
//
// Verifies KpiStripWidget (src/modules/overview/widgets.tsx, registry id 'kpis') wires its
// drill-down navigation: each mapped KPI's corner action control calls useUi().setActiveModule(id)
// with the correct target module. Equity Invested has no mapping and stays non-interactive.
//
// Fixture style mirrors tests/unit/overview-banner.test.tsx: a schema-complete PortfolioSnapshot
// seeded directly into the QueryClient cache (deterministic, no network — useAnalytics derives its
// bundle from that seeded snapshot via buildAnalytics). useUi() is supplied through a real
// UiContext.Provider carrying a spied setActiveModule — matching this repo's real-provider testing
// pattern (the banner test wraps widgets in live providers rather than vi.mock-ing the data hooks).
//
// Task 4 moved KPI clickability off the whole card and onto a small, separately-focusable corner
// control: a native <button aria-label={`View ${label}`}> (Provenance already owns a focusable
// tooltip span, so wrapping the card would nest interactive content). These tests therefore target
// the named button (getByRole('button', { name: /view .../i })), never a card-level click.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { SNAPSHOT_KEY } from '../../src/data/queries';
import { UiContext, type UiState } from '../../src/brain/ui-context';
import { OVERVIEW_WIDGETS } from '../../src/modules/overview/widgets';

const ASOF = '2026-07-06';

function emptySnapshot(): PortfolioSnapshot {
  return {
    meta: { schemaVersion: '1.0.0', asOf: ASOF, generatedAt: '2026-07-06T00:00:00.000Z', source: 'test', scenario: 'Base' },
    assumptions: {
      activeScenario: 'Base',
      revenueFactor: 1,
      vacancyFactor: 1,
      exitCapFactor: 1,
      thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 },
      asOf: ASOF,
    },
    properties: [],
    leases: [],
    loans: [],
    cash: { asOf: ASOF, totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
    insurance: [],
    deals: [],
    tasks: [],
    counterparties: [],
    renewalStages: {},
    tenantNotes: {},
    dealComps: {},
    acquisitionInputs: {},
    noiBudgets: {},
    tenantArrears: {},
    arBalances: [],
    quickbooks: null,
    governors: null,
    marketRents: {},
    workbookTotals: { noi: null, value: null, rent: null },
    dataQuality: [],
  };
}

function seededClient(): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  qc.setQueryData(SNAPSHOT_KEY, { snapshot: emptySnapshot(), state: { status: 'fresh', source: 'workbook', lastUpdated: ASOF, lastError: null, workbookPath: 'test.xlsx', flagCount: 0 } });
  return qc;
}

// A complete UiState with a spied setActiveModule; every other member is an inert default (the
// widget only reads setActiveModule, and useAnalytics reads scenario === 'Base').
function uiValue(setActiveModule: (id: string) => void): UiState {
  return {
    activeModuleId: 'overview',
    setActiveModule,
    openTab: () => {},
    paletteOpen: false,
    openPalette: () => {},
    closePalette: () => {},
    togglePalette: () => {},
    selected: null,
    openEntity: () => {},
    closeEntity: () => {},
    intelPropertyId: null,
    openIntelProperty: () => {},
    aiOpen: false,
    openAi: () => {},
    closeAi: () => {},
    toggleAi: () => {},
    scenario: 'Base',
    setScenario: () => {},
    draft: null,
    openDraft: () => {},
    closeDraft: () => {},
  };
}

function kpiStripComponent() {
  const def = OVERVIEW_WIDGETS.find((w) => w.id === 'kpis');
  if (!def) throw new Error('widget not registered: kpis');
  return def.Component;
}

beforeEach(() => {
  // Defensive stub matching the house pattern — absorbs any background refetch so an unexpected
  // network call can't destabilize the test.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderStrip(setActiveModule: (id: string) => void) {
  const Component = kpiStripComponent();
  return render(
    <QueryClientProvider client={seededClient()}>
      <UiContext.Provider value={uiValue(setActiveModule)}>
        <Component />
      </UiContext.Provider>
    </QueryClientProvider>,
  );
}

describe('KpiStripWidget drill-down', () => {
  it('clicking the Portfolio Value KPI action navigates to the portfolio module', () => {
    const setActiveModule = vi.fn();
    renderStrip(setActiveModule);

    fireEvent.click(screen.getByRole('button', { name: /view portfolio value/i }));

    expect(setActiveModule).toHaveBeenCalledWith('portfolio');
    expect(setActiveModule).toHaveBeenCalledTimes(1);
  });

  it('maps each interactive KPI to its target module (Value+SF→portfolio, WALT+Occupancy→leases)', () => {
    const setActiveModule = vi.fn();
    renderStrip(setActiveModule);

    const cases: Array<[RegExp, string]> = [
      [/view portfolio value/i, 'portfolio'],
      [/view net operating income/i, 'intel'],
      [/view portfolio sf/i, 'portfolio'],
      [/view occupancy/i, 'leases'],
      [/view walt/i, 'leases'],
      [/view total debt/i, 'debt'],
      [/view total cash/i, 'cash'],
    ];

    for (const [name, moduleId] of cases) {
      setActiveModule.mockClear();
      fireEvent.click(screen.getByRole('button', { name }));
      expect(setActiveModule).toHaveBeenCalledWith(moduleId);
    }
  });

  it('leaves Equity Invested non-interactive (no action control rendered)', () => {
    const setActiveModule = vi.fn();
    renderStrip(setActiveModule);

    expect(screen.queryByRole('button', { name: /view equity invested/i })).toBeNull();
  });
});
