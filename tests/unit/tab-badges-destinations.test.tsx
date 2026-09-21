// tests/unit/tab-badges-destinations.test.tsx
//
// R4 badge plumbing: `ModuleTabDef.useBadge` is a registry-level declaration, so EVERY destination
// that renders a tab strip must honour it. Before this suite only <Destination> and
// LeaseForecastModule did — Capital / Market / Data / Financials built their specs with
// `TABS.map(({ id, label }) => ({ id, label }))`, silently discarding any declared badge, and Brain
// hand-rolled its own. `useTabSpecs` is the single shared mapping; these tests inject a `useBadge`
// into each destination's real tab declaration and assert the count reaches the tab label — they
// fail for any destination that builds its specs by hand.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ModuleTabDef, TabBadge } from '../../src/shell/tab-types';
// Type-only module aliases so the vi.mock factories below can type `importOriginal` without an
// inline `import()` type annotation (lint: @typescript-eslint/consistent-type-imports).
import type * as CapitalTabs from '../../src/modules/capital/tabs';
import type * as MarketTabs from '../../src/modules/market/tabs';
import type * as DataTabs from '../../src/modules/data/tabs';
import type * as IntelTabs from '../../src/modules/intel/tabs';
import type * as BrainTabs from '../../src/modules/command-brain/tabs';
import type * as IntelHooks from '../../src/modules/intel/hooks';

// Hoisted: the vi.mock factories below run before the module body.
const { badgeOf, withBadge } = vi.hoisted(() => {
  const badgeOf = (count: number) => (): TabBadge => ({ count, tone: 'neutral' });
  /** Injects a `useBadge` onto one real tab, leaving ids/labels/order (and the derived key lists) alone. */
  const withBadge = (tabs: readonly ModuleTabDef[], id: string, count: number): readonly ModuleTabDef[] =>
    tabs.map((t) => (t.id === id ? { ...t, useBadge: badgeOf(count) } : t));
  return { badgeOf, withBadge };
});

// ── The four destinations whose real tab declarations get a badge injected ────────────────────
vi.mock('../../src/modules/capital/tabs', async (io) => {
  const actual = await io<typeof CapitalTabs>();
  return { ...actual, CAPITAL_TABS: withBadge(actual.CAPITAL_TABS, 'pipeline', 7) };
});
vi.mock('../../src/modules/market/tabs', async (io) => {
  const actual = await io<typeof MarketTabs>();
  return { ...actual, MARKET_TABS: withBadge(actual.MARKET_TABS, 'comps', 3) };
});
vi.mock('../../src/modules/data/tabs', async (io) => {
  const actual = await io<typeof DataTabs>();
  return { ...actual, DATA_TABS: withBadge(actual.DATA_TABS, 'quality', 4) };
});
vi.mock('../../src/modules/intel/tabs', async (io) => {
  const actual = await io<typeof IntelTabs>();
  return { ...actual, INTEL_TABS: withBadge(actual.INTEL_TABS, 'benchmarks', 5) };
});
vi.mock('../../src/modules/command-brain/tabs', async (io) => {
  const actual = await io<typeof BrainTabs>();
  return { ...actual, BRAIN_TABS: withBadge(actual.BRAIN_TABS, 'memory', 6) };
});

// ── Scaffolding: keep each destination's panels out of the way; the strip is what's under test ──
vi.mock('../../src/brain/ui-context', () => ({
  useUi: () => ({ intelPropertyId: null, openIntelProperty: vi.fn(), openEntity: vi.fn() }),
}));
const EMPTY = { data: [], isLoading: false, error: null };
vi.mock('../../src/modules/intel/hooks', async (io) => {
  const actual = await io<typeof IntelHooks>();
  return {
    ...actual,
    useNoiMatrix: () => EMPTY,
    useWarehouseImports: () => EMPTY,
    useWarehouseIssues: () => EMPTY,
    useWarehouseLive: () => true,
    useWarehouseFreshness: () => ({ detail: null }),
  };
});
vi.mock('../../src/modules/intel/OwnershipView', () => ({ OwnershipView: () => <div>ownership-panel</div> }));
vi.mock('../../src/modules/market/hooks', () => ({ useMarketIntel: () => ({ data: [], isLoading: false, error: null }) }));
vi.mock('../../src/modules/market/MarketScorecard', () => ({ MarketScorecard: () => <div>scorecard</div> }));
vi.mock('../../src/modules/market/CompsView', () => ({ CompsView: () => <div>comps-panel</div> }));
vi.mock('../../src/modules/debt/DebtModule', () => ({ DebtModule: () => <div>debt-panel</div> }));
vi.mock('../../src/modules/cash/CashModule', () => ({ CashModule: () => <div>cash-panel</div> }));
vi.mock('../../src/modules/close/CloseModule', () => ({ CloseModule: () => <div>close-panel</div> }));
vi.mock('../../src/modules/principal/PrincipalModule', () => ({ PrincipalModule: () => <div>digest-panel</div> }));
vi.mock('../../src/modules/insights/InsightsModule', () => ({ InsightsModule: () => <div>insights-panel</div> }));

import { Destination } from '../../src/shell/Destination';
import { useTabSpecs } from '../../src/shell/tab-badges';
import { CapitalModule } from '../../src/modules/capital/CapitalModule';
import { MarketModule } from '../../src/modules/market/MarketModule';
import { DataModule } from '../../src/modules/data/DataModule';
import { IntelModule } from '../../src/modules/intel/IntelModule';
import { CommandBrainModule } from '../../src/modules/command-brain/CommandBrainModule';
import { ToastProvider } from '../../src/primitives/Toast';

function renderModule(node: React.ReactNode, entry = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={qc}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

// The badge is a sibling <span> inside the tab, so textContent concatenates label + count ("Pipeline7").
const tabNames = () => screen.getAllByRole('tab').map((t) => t.textContent);

afterEach(cleanup);

describe('useTabSpecs — the one mapping from ModuleTabDef to TabSpec', () => {
  function Probe({ tabs }: { tabs: readonly ModuleTabDef[] }) {
    return <output data-testid="specs">{JSON.stringify(useTabSpecs(tabs))}</output>;
  }
  it('carries a declared badge through and omits the key entirely when there is none', () => {
    render(
      <Probe
        tabs={[
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B', useBadge: badgeOf(9) },
          { id: 'c', label: 'C', useBadge: () => undefined },
        ]}
      />,
    );
    expect(JSON.parse(screen.getByTestId('specs').textContent!)).toEqual([
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B', badge: { count: 9, tone: 'neutral' } },
      { id: 'c', label: 'C' },
    ]);
  });
});

describe('every destination honours ModuleTabDef.useBadge', () => {
  it('Destination (Worklist / Obligations)', () => {
    renderModule(
      <Destination
        id="x"
        label="X"
        tabs={[
          { id: 'one', label: 'One' },
          { id: 'two', label: 'Two', useBadge: badgeOf(2) },
        ]}
      />,
    );
    expect(tabNames()).toEqual(['One', 'Two2']);
  });

  it('CapitalModule', () => {
    renderModule(<CapitalModule />);
    expect(tabNames()).toEqual(['Allocation', 'Pipeline7', 'Debt', 'Cash', 'Close']);
  });

  it('MarketModule', () => {
    renderModule(<MarketModule />);
    expect(tabNames()).toEqual(['Macro', 'Scorecards', 'Comps3', 'Demand']);
  });

  it('DataModule', () => {
    renderModule(<DataModule />);
    expect(tabNames()).toEqual(['Imports', 'Quality4', 'Mappings', 'Calibration', 'Documents']);
  });

  it('IntelModule (Financials)', () => {
    renderModule(<IntelModule />);
    expect(tabNames()).toEqual(['Ownership', 'Property', 'Lease Run', 'Benchmarks5', 'Managers']);
  });

  it('CommandBrainModule', () => {
    renderModule(<CommandBrainModule />);
    expect(tabNames()).toEqual(['Digest', 'Insights', 'Track record', 'Feedback', 'Memory6']);
  });
});
