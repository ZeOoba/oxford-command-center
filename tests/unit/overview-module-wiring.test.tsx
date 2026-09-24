// tests/unit/overview-module-wiring.test.tsx
//
// I-2(b) (2026-09-23 review): OverviewModule must call useWorkspaces with EVERY widget id
// (ALL_WIDGET_IDS, insights included) as `allIds` — never the filtered DEFAULT_WIDGET_ORDER —
// alongside DEFAULT_HIDDEN_WIDGET_IDS. Getting this wrong two different ways both look fine on a
// fresh load but break differently:
//   - if `allIds` omitted 'insights' entirely, the widget could never be re-added via Edit layout
//     (normalize() only appends an id that's present in `allIds`).
//   - if `defaultHidden` were empty/wrong, the widget would render immediately on a fresh layout
//     instead of starting hidden-but-addable (the ratified "one home per attention list" IA).
// This asserts the resulting BEHAVIOR through the real component (rendering Edit layout is not
// impractical here — WorkspaceBar already renders a plain "+ <title>" button per hidden id), so it
// catches either failure mode without needing to intercept the hook call directly.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { SNAPSHOT_KEY } from '../../src/data/queries';
import { OverviewModule } from '../../src/modules/overview/OverviewModule';

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

beforeEach(() => {
  // useWorkspaces persists to localStorage — start every test from a clean, un-persisted layout
  // so "fresh load" actually means fresh.
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
  // OverviewModule mounts chart widgets (Sparkline/BarChart) that measure via ResizeObserver —
  // jsdom has no native implementation (house pattern, see tests/unit/market-tabs.test.tsx).
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderOverview() {
  return render(
    <QueryClientProvider client={seededClient()}>
      <OverviewModule />
    </QueryClientProvider>,
  );
}

describe('OverviewModule — useWorkspaces gets ALL widget ids + DEFAULT_HIDDEN_WIDGET_IDS', () => {
  it('the Insights & Alerts board is not mounted on a fresh load (defaultHidden took effect)', () => {
    renderOverview();
    expect(screen.queryByText('Insights & Alerts')).toBeNull();
  });

  it('the Insights & Alerts widget is still addable via Edit layout ("insights" survived into allIds)', () => {
    renderOverview();
    // Query by visible text rather than accessible role name — the button also carries a Pencil
    // icon, and this only needs the real click target, not its full a11y name computation.
    const editButton = screen.getByText('Edit layout').closest('button');
    expect(editButton).not.toBeNull();
    fireEvent.click(editButton!);

    // WorkspaceBar renders one "+ <title>" chip per hidden id while in edit mode — the button's
    // own text is "+ Insights & Alerts" (the "+ " and the title are separate JSX text nodes), so
    // match on the substring rather than the exact-normalized-text default.
    expect(screen.getByText(/Insights & Alerts/)).toBeTruthy();
  });
});
