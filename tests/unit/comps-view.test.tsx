// tests/unit/comps-view.test.tsx
//
// IMPLEMENTATION_PLAN.md task 7.3 — Comps surface (Market module tab).
//
// Covers the acceptance criteria: "renders every stored CompSet with source + date; benchmark
// table matches capital module figures."
//
// Section 1 (Sale & Rent Comps) reads snapshot.dealComps + snapshot.deals (Spine-A overlay,
// queryKey ['snapshot'] — same key AcquisitionsModule/DealDrawer already use).
// Section 2 (Submarket Cap Rate Benchmarks) reads the SAME queryKey as CapitalModule's local
// useCapitalAllocationReport() hook: ['warehouse', 'capital-allocation', 'report'] — see
// tests/unit/capital-module.test.tsx, which seeds the identical key. Seeding that one cache
// entry here and asserting the rendered figures against the input fixture proves the two
// modules read one shared source of truth rather than two parallel computations.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Deal, CompSet } from '../../src/contracts/index';
import type { CapitalAllocationReport } from '../../src/contracts/capital-allocation';
import { MarketModule } from '../../src/modules/market/MarketModule';
import { CompsView } from '../../src/modules/market/CompsView';

function makeDeal(partial: Partial<Deal> & Pick<Deal, 'id' | 'name' | 'stage'>): Deal {
  return {
    shortName: null, location: null, market: null, sf: null, buildings: null,
    estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null,
    lender: null, status: null, nextAction: null, owner: null, targetCloseDate: null,
    notionDealId: null, confidential: false, estimatedFields: [],
    ...partial,
  };
}

function makeCompSet(partial: Partial<CompSet> = {}): CompSet {
  return {
    saleComps: [],
    rentComps: [],
    submarketStats: [],
    summary: null,
    sources: [],
    sourcedAt: '2026-06-01T12:00:00.000Z',
    ...partial,
  };
}

function capitalAllocationReport(partial: Partial<CapitalAllocationReport> = {}): CapitalAllocationReport {
  return {
    asOf: '2026-07-06',
    propertyCount: 0,
    entries: [],
    portfolioNoi: 0,
    portfolioNoBasis: 'spine-a',
    investCount: 0,
    holdCount: 0,
    monitorCount: 0,
    dispositionCount: 0,
    macro: { tenYearRate: 4.1, cpi: 3.1, source: 'fred', asOf: '2026-07-01' },
    marketBenchmarks: { available: true, source: 'fred', asOf: '2026-07-01' },
    regionalMacro: null,
    ...partial,
  };
}

function seededClient(opts: {
  deals?: Deal[];
  dealComps?: Record<string, CompSet>;
  report?: CapitalAllocationReport;
} = {}): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  qc.setQueryData(['snapshot'], {
    snapshot: { deals: opts.deals ?? [], dealComps: opts.dealComps ?? {} } as never,
    state: {} as never,
  });
  qc.setQueryData(['warehouse', 'capital-allocation', 'report'], opts.report ?? capitalAllocationReport());
  return qc;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CompsView — Sale & Rent Comps section', () => {
  it('renders every stored CompSet with its source and sourcedAt date, grouped under the deal name via snapshot.deals lookup', () => {
    const deals = [makeDeal({ id: 'deal-1', name: 'Eastgate Trade Center', stage: 'Due Diligence' })];
    const dealComps: Record<string, CompSet> = {
      'deal-1': makeCompSet({
        sourcedAt: '2026-06-15T09:00:00.000Z',
        sources: ['https://loopnet.com/listing/1', 'CoStar market report'],
        saleComps: [
          { address: '100 Commerce Way', market: 'Eastgate', sf: 108_000, price: 12_400_000, pricePerSf: 115, capRate: 0.071, date: '2026-04-01', source: 'https://loopnet.com/listing/1' },
        ],
        rentComps: [
          { address: '200 Depot Rd', sf: 44_000, rentPerSf: 9.8, leaseType: 'NNN', date: '2026-05-01', source: 'CoStar market report' },
        ],
      }),
    };

    render(
      <QueryClientProvider client={seededClient({ deals, dealComps })}>
        <CompsView />
      </QueryClientProvider>,
    );

    // Grouped under the deal's resolved name (not the raw dealId).
    expect(screen.getByText('Eastgate Trade Center')).toBeTruthy();
    expect(screen.queryByText('deal-1')).toBeNull();

    // sourcedAt date is visible. Query the "Sourced ..." element itself (uniquely matched by
    // that prefix) rather than re-querying the whole document for the date — the page also
    // renders an unrelated "as of {date}" benchmarks-section timestamp (CompsView.tsx's
    // marketBenchmarks display) that can independently contain a colliding month/day fragment
    // (e.g. both being in the same month), which previously made the broad date regex match
    // two elements instead of one.
    const sourcedEl = screen.getByText(/Sourced/);
    expect(sourcedEl).toBeTruthy();
    expect(sourcedEl.textContent).toMatch(/2026-06-15|06\/15\/2026|Jun/i);

    // Sale + rent comp rows render, each with their own per-row source.
    expect(screen.getByText('100 Commerce Way')).toBeTruthy();
    expect(screen.getByText('200 Depot Rd')).toBeTruthy();
    expect(screen.getAllByText('https://loopnet.com/listing/1').length).toBeGreaterThan(0);
    expect(screen.getByText('CoStar market report')).toBeTruthy();
  });

  it('resolves multiple deals independently and does not cross-contaminate their comp tables', () => {
    const deals = [
      makeDeal({ id: 'deal-1', name: 'Eastgate Trade Center', stage: 'Due Diligence' }),
      makeDeal({ id: 'deal-2', name: 'Riverside Flex Portfolio', stage: 'LOI/PSA' }),
    ];
    const dealComps: Record<string, CompSet> = {
      'deal-1': makeCompSet({ saleComps: [{ address: 'Addr A', market: null, sf: null, price: null, pricePerSf: null, capRate: null, date: null, source: 'src-a' }] }),
      'deal-2': makeCompSet({ saleComps: [{ address: 'Addr B', market: null, sf: null, price: null, pricePerSf: null, capRate: null, date: null, source: 'src-b' }] }),
    };

    render(
      <QueryClientProvider client={seededClient({ deals, dealComps })}>
        <CompsView />
      </QueryClientProvider>,
    );

    expect(screen.getByText('Eastgate Trade Center')).toBeTruthy();
    expect(screen.getByText('Riverside Flex Portfolio')).toBeTruthy();
    expect(screen.getByText('Addr A')).toBeTruthy();
    expect(screen.getByText('Addr B')).toBeTruthy();
  });

  it('falls back to the raw dealId when the deal record is missing from snapshot.deals (stale overlay entry)', () => {
    const dealComps: Record<string, CompSet> = {
      'orphan-deal-9': makeCompSet({ saleComps: [{ address: 'Orphan Addr', market: null, sf: null, price: null, pricePerSf: null, capRate: null, date: null, source: 'src' }] }),
    };

    render(
      <QueryClientProvider client={seededClient({ deals: [], dealComps })}>
        <CompsView />
      </QueryClientProvider>,
    );

    expect(screen.getByText('orphan-deal-9')).toBeTruthy();
  });

  it('shows an honest empty state — not a blank screen — when dealComps is empty', () => {
    render(
      <QueryClientProvider client={seededClient({ deals: [], dealComps: {} })}>
        <CompsView />
      </QueryClientProvider>,
    );

    expect(screen.getByText('No comps captured yet — comps are recorded per-deal during due diligence.')).toBeTruthy();
  });
});

describe('CompsView — Submarket Cap Rate Benchmarks section', () => {
  it('renders the benchmark provenance badge + per-property positioning from the shared capital-allocation report', () => {
    const report = capitalAllocationReport({
      entries: [
        {
          propertyId: 'prop-1', propertyName: 'Prop One', market: 'Columbus, OH', sf: 42_000,
          capitalAction: 'invest', priorityScore: 61, healthScore: 78, attentionScore: 40,
          nearTermExpiryRent: 12_000, atRiskLikelihoodCount: 1, debtScore: 70, balloonMonths: null,
          dscr: 1.4, rationale: [], noi: 500_000, noiPerSf: 11.9, noiBasis: 'spine-a', leasingRisk: 20,
          impliedCapRate: 0.072, capRateGap: 0.008, capRatePercentile: 'top',
        },
        {
          propertyId: 'prop-2', propertyName: 'Prop Two', market: 'Indianapolis, IN', sf: 30_000,
          capitalAction: 'hold', priorityScore: 22, healthScore: 85, attentionScore: 15,
          nearTermExpiryRent: 0, atRiskLikelihoodCount: 0, debtScore: 88, balloonMonths: null,
          dscr: 1.9, rationale: [], noi: 300_000, noiPerSf: 10, noiBasis: 'spine-a', leasingRisk: 5,
          impliedCapRate: null, capRateGap: null, capRatePercentile: null,
        },
      ],
      marketBenchmarks: { available: true, source: 'fred', asOf: '2026-07-01' },
    });

    render(
      <QueryClientProvider client={seededClient({ report })}>
        <CompsView />
      </QueryClientProvider>,
    );

    expect(screen.getByText('Submarket Cap Rate Benchmarks')).toBeTruthy();
    expect(screen.getByText('Cap benchmarks: live')).toBeTruthy();
    expect(screen.getByText('Columbus, OH')).toBeTruthy();
    expect(screen.getByText('Indianapolis, IN')).toBeTruthy();
    expect(screen.getByText('Prop One')).toBeTruthy();
    // impliedCapRate 0.072 -> "7.2%" (same precision as CapitalModule's own fmtCapRate)
    expect(screen.getByText('7.2%')).toBeTruthy();
    // capRateGap 0.008 -> "+80 bps"
    expect(screen.getByText('+80 bps')).toBeTruthy();
    // capRatePercentile 'top' -> "Above mkt" badge
    expect(screen.getByText('Above mkt')).toBeTruthy();
    // Prop Two has all-null cap-rate fields -> fail-open em-dash, never a crash.
    const propTwoRow = screen.getByText('Prop Two').closest('tr')!;
    expect(propTwoRow.textContent).toContain('—');
  });

  it('shows a seeded-benchmark badge for source:"seed"', () => {
    render(
      <QueryClientProvider client={seededClient({ report: capitalAllocationReport({ marketBenchmarks: { available: true, source: 'seed', asOf: '2026-06-21' } }) })}>
        <CompsView />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Cap benchmarks: seeded')).toBeTruthy();
  });

  it('shows an offline badge for source:"unavailable" (fail-open, never a crash)', () => {
    render(
      <QueryClientProvider client={seededClient({ report: capitalAllocationReport({ marketBenchmarks: { available: false, source: 'unavailable', asOf: null } }) })}>
        <CompsView />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Cap benchmarks offline')).toBeTruthy();
  });

  it('renders an honest empty state when the report has zero entries', () => {
    render(
      <QueryClientProvider client={seededClient({ report: capitalAllocationReport({ entries: [] }) })}>
        <CompsView />
      </QueryClientProvider>,
    );
    expect(screen.getByText('No cap-rate benchmark data available.')).toBeTruthy();
  });
});

describe('MarketModule — Comps tab mounting', () => {
  // MacroView (the default tab) unconditionally calls useAnalytics() → buildAnalytics() on every
  // render, even before its own isLoading/!macro guard — this is pre-existing MarketModule
  // behavior, unchanged here. buildAnalytics needs a full PortfolioSnapshot (properties, leases,
  // loans, etc.) or it throws. This test only exercises tab-switching, so — mirroring
  // tests/unit/market-module-smoke.test.tsx — leave ['snapshot'] unseeded and stub a failing
  // fetch: useAnalytics's `q.data ? buildAnalytics(...) : null` guard then short-circuits to
  // null instead of crashing, and the Macro tab renders its ordinary loading skeleton.
  it('defaults to the Macro tab, and switching to Comps mounts CompsView without disrupting the tab shell', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
    });
    qc.setQueryData(['warehouse', 'capital-allocation', 'report'], capitalAllocationReport());

    render(
      <MemoryRouter>
        <QueryClientProvider client={qc}>
          <MarketModule />
        </QueryClientProvider>
      </MemoryRouter>,
    );

    // Default tab shows no Comps-only content yet.
    expect(screen.queryByText('Sale & Rent Comps')).toBeNull();

    fireEvent.click(screen.getByText('Comps'));

    expect(screen.getByText('Sale & Rent Comps')).toBeTruthy();
    expect(screen.getByText('Submarket Cap Rate Benchmarks')).toBeTruthy();
    // dealComps overlay hasn't resolved yet (fetch is stubbed/pending) — the loading skeleton
    // renders, not a crash. The honest empty-state copy itself is covered directly against
    // <CompsView> above, where the snapshot cache is pre-seeded and isLoading is already false.
  });
});
