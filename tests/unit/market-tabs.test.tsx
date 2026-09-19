// tests/unit/market-tabs.test.tsx
//
// IA decongestion Phase 3 — Macro is split: Macro · Scorecards · Comps. The Macro tab keeps the FRED
// badge + KPI grid + 10Y chart + Acquisition Lens together (a same-glance group, R1). Macro /
// Scorecards are force-mounted (they were one scroll before the split); Comps stays lazy.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { MacroSnapshot } from '../../src/contracts/index';
import { inactivePanelIsHiddenByClass, isInInactivePanel, selectTab, tabIsSelected } from './tab-test-utils';

const intel = vi.hoisted(() => ({
  value: { data: undefined as unknown, isLoading: false, error: null as unknown },
}));
vi.mock('../../src/modules/market/hooks', () => ({ useMarketIntel: () => intel.value }));
// MarketScorecard / CompsView internals are unchanged by the split; stub them so this test pins tab
// mounting behaviour only (CompsView also fires a fresh warehouse query on mount — it must stay lazy).
vi.mock('../../src/modules/market/MarketScorecard', () => ({
  MarketScorecard: ({ signal }: { signal: { cluster: string } }) => <div>SCORECARD-{signal.cluster}</div>,
}));
vi.mock('../../src/modules/market/CompsView', () => ({ CompsView: () => <div>COMPS-STUB</div> }));

import { MarketModule } from '../../src/modules/market/MarketModule';

const MACRO: MacroSnapshot = {
  asOf: '2026-06-01',
  source: 'fred',
  indicators: [
    { id: 'DGS10', label: '10Y Treasury', value: 4.47, unit: '%', change: 0.02 },
    { id: 'DGS2', label: '2Y Treasury', value: 4.05, unit: '%', change: -0.01 },
    { id: 'SOFR', label: 'SOFR', value: 3.63, unit: '%', change: null },
    { id: 'FEDFUNDS', label: 'Fed Funds (effective)', value: 3.63, unit: '%', change: null },
    { id: 'CPIAUCSL', label: 'CPI (YoY)', value: 3.8, unit: '%', change: null },
  ],
  tenYearHistory: [{ date: '2026-04-01', value: 4.32 }, { date: '2026-05-01', value: 4.48 }],
};

function renderMarket(entry = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  qc.setQueryData(['macro'], MACRO);
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={qc}>
        <MarketModule />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  intel.value = { data: [{ cluster: 'Columbus' }, { cluster: 'Cincinnati' }], isLoading: false, error: null };
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('MarketModule — Phase 3 tab split', () => {
  it('renders three tabs, Macro selected by default', () => {
    renderMarket();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Macro', 'Scorecards', 'Comps']);
    expect(tabIsSelected('Macro')).toBe(true);
  });

  it('R1: FRED badge, KPI grid, 10Y chart and Acquisition Lens all sit on the default Macro tab', () => {
    renderMarket();
    for (const marker of [/FRED · live/, '2Y Treasury', '10-Year Treasury — 12-Month Path', 'Acquisition Lens']) {
      expect(isInInactivePanel(screen.getByText(marker))).toBe(false);
    }
  });

  it('Scorecards are hidden until their tab is selected, then reachable', () => {
    renderMarket();
    const header = screen.getByText('Market Intelligence');
    const card = screen.getByText('SCORECARD-Columbus');
    expect(isInInactivePanel(header)).toBe(true);
    expect(inactivePanelIsHiddenByClass(card)).toBe(true);
    selectTab('Scorecards');
    expect(isInInactivePanel(header)).toBe(false);
    expect(isInInactivePanel(card)).toBe(false);
    expect(isInInactivePanel(screen.getByText('SCORECARD-Cincinnati'))).toBe(false);
    expect(isInInactivePanel(screen.getByText('Acquisition Lens'))).toBe(true);
  });

  it('Comps stays lazy: its content is not rendered until the tab is selected', () => {
    renderMarket();
    expect(screen.queryByText('COMPS-STUB')).toBeNull();
    selectTab('Comps');
    expect(screen.getByText('COMPS-STUB')).toBeTruthy();
  });

  it.each([
    ['scorecards', 'SCORECARD-Columbus'],
    ['comps', 'COMPS-STUB'],
  ])('?tab=%s deep-links to that tab', (key, marker) => {
    renderMarket(`/?tab=${key}`);
    expect(screen.getByRole('tab', { name: new RegExp(`^${key}$`, 'i') }).getAttribute('aria-selected')).toBe('true');
    expect(isInInactivePanel(screen.getByText(marker))).toBe(false);
  });

  it('R7: an empty or unavailable Scorecards tab still renders, with an explanatory empty state', () => {
    intel.value = { data: [], isLoading: false, error: null };
    renderMarket('/?tab=scorecards');
    expect(screen.getByText(/No market intelligence scorecards yet/)).toBeTruthy();
    cleanup();

    intel.value = { data: undefined, isLoading: false, error: new Error('offline') };
    renderMarket('/?tab=scorecards');
    expect(screen.getByText(/scorecards are unavailable right now/)).toBeTruthy();
    expect(isInInactivePanel(screen.getByText(/scorecards are unavailable right now/))).toBe(false);
  });
});
