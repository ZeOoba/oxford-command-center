// Render-level smoke for the UI null path opened by the root-cause cure.
//
// MacroIndicator.value is now z.number().nullable() and fred.ts passes a missing observation
// through as null end-to-end. The Market module reads indicators.find('DGS10')?.value ?? null
// (MarketModule.tsx:20) and passes ind.value (number|null) into KpiStat (which accepts number|null
// and renders '—' on null at KpiStat.tsx:36). This test mounts the module against the cured shape
// and asserts the null path renders the em-dash, no crash, no '0.00%' or 'null%' string leakage.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MacroSnapshot } from '../../src/contracts/index';
import { MarketModule } from '../../src/modules/market/MarketModule';

function macroWithNullDgs10(): MacroSnapshot {
  return {
    asOf: '2026-06-01',
    source: 'fred',
    indicators: [
      { id: 'DGS10', label: '10Y Treasury', value: null, unit: '%', change: null }, // ← cured null
      { id: 'DGS2', label: '2Y Treasury', value: 4.05, unit: '%', change: -0.01 },
      { id: 'SOFR', label: 'SOFR', value: 3.63, unit: '%', change: null },
      { id: 'FEDFUNDS', label: 'Fed Funds (effective)', value: 3.63, unit: '%', change: null },
      { id: 'CPIAUCSL', label: 'CPI (YoY)', value: 3.8, unit: '%', change: null },
    ],
    tenYearHistory: [
      { date: '2025-12-01', value: 4.14 }, { date: '2026-01-01', value: 4.21 },
      { date: '2026-02-01', value: 4.13 }, { date: '2026-03-01', value: 4.25 },
      { date: '2026-04-01', value: 4.32 }, { date: '2026-05-01', value: 4.48 },
    ],
  };
}

function seededClient(macro: MacroSnapshot): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  // useMacro keys on ['macro']; seed it so MarketModule skips the loading skeleton.
  qc.setQueryData(['macro'], macro);
  // useAnalytics depends on useSnapshot. We don't need a snapshot to exercise the macro-null path
  // (MarketModule:21 reads `analytics?.kpis.weightedCapRate.value ?? null`), so leave snapshot
  // unseeded. The fetch stub below absorbs the one network attempt — retry:false caps it.
  return qc;
}

beforeEach(() => {
  // The (unseeded) useSnapshot query will fire fetch once; stub it so the queryClient resolves to
  // isError quickly without a real network call.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
  // jsdom doesn't ship ResizeObserver; AreaChart's useMeasure hook requires it. No-op stub.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Standalone-text matcher: ignores the em-dash that appears inside the longer
 *  "risk-free 10Y — a quick read…" prose. Matches a text node whose sole content (trimmed) is '—'. */
function dashOnly(content: string, node: Element | null): boolean {
  if (!node) return false;
  return content.trim() === '—' && node.children.length === 0;
}

describe('MarketModule — null DGS10 UI path', () => {
  it('shows the em-dash sentinel for the 10Y when MacroIndicator.value is null, with no 0.00% or "null" leak (no crash)', () => {
    const { container } = render(
      <QueryClientProvider client={seededClient(macroWithNullDgs10())}>
        <MarketModule />
      </QueryClientProvider>,
    );
    // KpiStat (value path) and Acquisition Lens 10Y Row (value path) BOTH render '—' on null.
    // Two standalone-em-dash nodes minimum (the spread row also dashes since wtdCap is null here).
    const dashNodes = screen.getAllByText(dashOnly);
    expect(dashNodes.length).toBeGreaterThanOrEqual(2);

    // The label "10Y Treasury" appears twice — once in the KpiStat, once in the Acquisition Lens.
    // Both must be present; the cell still renders, it just shows '—' instead of a number.
    expect(screen.getAllByText('10Y Treasury')).toHaveLength(2);

    // Hard rule: no false zero ('0.00%'), no literal 'null' string leak.
    const bodyText = container.textContent ?? '';
    expect(bodyText).not.toMatch(/0\.00\s*%/);
    expect(bodyText.toLowerCase()).not.toContain('null');

    // Failure must be SCOPED to DGS10 — the other indicators still render their values.
    expect(bodyText).toMatch(/4\.05/); // DGS2
    expect(bodyText).toMatch(/3\.63/); // SOFR / FEDFUNDS
    expect(bodyText).toMatch(/3\.80/); // CPI YoY
  });

  it('renders the real 10Y number when value is present (regression cover for the common live case)', () => {
    const live = macroWithNullDgs10();
    live.indicators = live.indicators.map((i) => (i.id === 'DGS10' ? { ...i, value: 4.47 } : i));
    const { container } = render(
      <QueryClientProvider client={seededClient(live)}>
        <MarketModule />
      </QueryClientProvider>,
    );
    const bodyText = container.textContent ?? '';
    // The 10Y appears in the KpiStat AND the Acquisition Lens — at least one occurrence proves the
    // formatter ran on a real number (useCountUp animates to the target; final frame is 4.47).
    expect(bodyText).toMatch(/4\.47/);
    expect(bodyText.toLowerCase()).not.toContain('null');
  });
});
