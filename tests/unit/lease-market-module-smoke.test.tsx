// tests/unit/lease-market-module-smoke.test.tsx
//
// Render-level smoke for LeaseMarketModule (Task 16, spec rev 3 §4): KPI row + Portfolio tab by
// default, tab switching, and explicit empty states. Seeds a QueryClient directly (no fetch mocks)
// following the market-module-smoke.test.tsx / rent-curve.test.tsx pattern.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { LeaseMarketModule } from '../../src/modules/lease-market/LeaseMarketModule';
import { LEASE_MARKET_KEYS } from '../../src/modules/lease-market/hooks';
import { ORA_JSON_MUTATION_HEADERS } from '../../src/contracts/client-header';
import { __resetWarehouseMirrorCache } from '../../src/lib/warehouse-mirror';
import type { ChangesResponse, HistoryResponse, LeaseMarketSummaryResponse, PositioningResponse, RadarResponse, SignalsResponse } from '../../src/contracts/lease-market';

// jsdom doesn't ship ResizeObserver; the Market Rents tab mounts RentCurve/BarChart, whose
// useMeasure hook requires it (same pattern as rent-curve.test.tsx / market-module-smoke.test.tsx).
// No-op stub — doesn't drive width, so it's only good enough for assertions that don't depend on
// the `width > 0` render branch (the empty-state text asserted here renders regardless of width).
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  // loadWarehouseMirror() memoizes its result at module scope; reset it per test so a mock `fetch`
  // stubbed by an earlier test in this file can never leak its resolved mirror envelope forward.
  __resetWarehouseMirrorCache();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const LIVE_PROBE_KEY = ['warehouse', 'live-probe'];

const SUMMARY: LeaseMarketSummaryResponse = {
  asOf: '2026-03-01', rowLevel: true, lastComputedAt: '2026-03-01',
  kpis: { marketsFresh: 1, marketsEnabled: 1, activeSpaces: 13, newInLatest: 13, priceCutsInLatest: 2, stale: 3, radarCandidates: 1 },
  freshness: [{ marketId: 'columbus', label: 'Columbus', enabled: true, lastLandingDate: '2026-02-15', lastCompleteDate: '2026-02-15', lastCompleteness: 'complete', partialReason: null, stale: false }],
  dataQuality: [{ marketId: 'columbus', activeSpaces: 13, lastExportRows: 13, lastExportSkipped: 0, quotedShare: 0.8, coordsShare: 1, lowConfidenceShare: 0.1, rejectedRents: 0 }],
  benchmarks: [],
  curve: [6, 7, 8, 9, 10].map((v, i) => ({ listingId: i + 1, propertyId: i + 1, marketId: 'columbus', subtype: 'warehouse' as const, availableSf: 20000, askingNnnEq: v, solid: true, isOra: false, address: `${i} Main St` })),
  domByMarket: [{ marketId: 'columbus', bins: [{ label: '0-90d', count: 5 }, { label: '90-180d', count: 0 }, { label: '180-365d', count: 0 }, { label: '365d+', count: 0 }] }],
};
const POSITIONING: PositioningResponse = {
  asOf: '2026-03-01', unconfiguredPropertyKeys: ['Sepich'], listedButLeased: [], hygieneFlags: [],
  rows: [{
    propertyKey: '1100 Rarig', unit: 'B', sf: 8000, oraAskingNnnEq: 12,
    stats: { basis: 'similarity', n: 12, low: 5.5, p25: 8.75, median: 9.3, p75: 10, high: 10.4, confidence: 'MEDIUM', cellKey: null, unknown: [] },
    comps: [], percentile: 1, gapPct: 0.29, band: 'above', recommendation: 'Asking is 29% above the comparable median ($9.30); comparable range $8.75–$10.00.',
    flags: [], effectiveDom: 45, source: 'rent-roll',
  }],
};
const RADAR: RadarResponse = {
  asOf: '2026-03-01', candidatesWithheld: [], monitor: [],
  candidates: [{
    propertyId: 2, marketId: 'columbus', address: '101 Industrial Pkwy', subtype: 'warehouse', buildingSf: 40000, score: 55,
    parts: { dom: 0, reductions: 0, belowMarket: 25, vacancy: 15, buyBoxFit: 10, owner: 5 }, confidence: 'MEDIUM', vacancyShare: 0.5,
    maxEffectiveDom: 45, reductionCount: 0, cumulativeReductionPct: 0, bestGapPct: -0.36, comparableMedian: 9.4, indicativeRentGapUsd: 68000,
    ownerName: 'SMITH FAMILY LLC', ownerType: 'private', ownerListingCount: 11, brokerName: 'Pat Broker', latestDecision: null,
  }],
};
const SIGNALS: SignalsResponse = { asOf: '2026-03-01', candidatesWithheld: [], signals: [] };
const CHANGES: ChangesResponse = { asOf: '2026-03-01', events: [{ id: 1, listingId: 2, propertyId: 2, marketId: 'columbus', address: '101 Industrial Pkwy', kind: 'price_cut', eventDate: '2026-02-15', prevValue: 6.5, newValue: 6 }] };

function renderWith(summary = SUMMARY, positioning = POSITIONING, radar = RADAR, signals = SIGNALS, changes = CHANGES, live = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(LEASE_MARKET_KEYS.summary, summary);
  qc.setQueryData(LEASE_MARKET_KEYS.positioning, positioning);
  qc.setQueryData(LEASE_MARKET_KEYS.radar, radar);
  qc.setQueryData(LEASE_MARKET_KEYS.signals, signals);
  qc.setQueryData(LEASE_MARKET_KEYS.changes, changes);
  // useWarehouseLive() reads this key; seeding it avoids an unmocked, uncontrolled live-probe
  // fetch firing on every render (the mirror-write-gating tests below seed it explicitly).
  qc.setQueryData(LIVE_PROBE_KEY, live);
  return render(<MemoryRouter><QueryClientProvider client={qc}><LeaseMarketModule /></QueryClientProvider></MemoryRouter>);
}

describe('LeaseMarketModule', () => {
  it('renders KPIs and the Portfolio tab by default', () => {
    renderWith();
    expect(screen.getByText('Radar candidates')).toBeTruthy();
    expect(screen.getByText('1100 Rarig')).toBeTruthy();
    expect(screen.getByText('Above market')).toBeTruthy();
    expect(screen.getByText(/29% above the comparable median/)).toBeTruthy();
    expect(screen.getByText(/Not yet mapped to a comparable set: Sepich/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/NaN/);
  });

  it('shows the last-computed timestamp when compute has run, and a plain notice naming the command when it has not', () => {
    renderWith();
    expect(screen.getByText(/last computed 2026-03-01/)).toBeTruthy();
    expect(screen.queryByText(/lease-market:compute/)).toBeNull();

    renderWith({ ...SUMMARY, lastComputedAt: null });
    expect(screen.getByText(/compute has not been run/i)).toBeTruthy();
    expect(screen.getByText(/npm run lease-market:compute/)).toBeTruthy();
  });

  it('shows a plain notice that row-level identifiers are hidden when rowLevel is false', () => {
    renderWith();
    expect(screen.queryByText(/hidden on this mirror/)).toBeNull();

    renderWith({ ...SUMMARY, rowLevel: false });
    expect(screen.getByText(/hidden on this mirror/)).toBeTruthy();
    expect(screen.getByText(/Property 123/)).toBeTruthy();
  });

  it('surfaces the ComparableStats.unknown components and full low-high range on a Portfolio row', () => {
    renderWith({
      ...SUMMARY,
    }, {
      ...POSITIONING,
      rows: [{ ...POSITIONING.rows[0]!, stats: { ...POSITIONING.rows[0]!.stats!, unknown: ['location', 'clearHeight'] } }],
    });
    expect(screen.getByText('$5.50–$10.40')).toBeTruthy(); // full low-high range
    expect(screen.getByText(/unknown: location, clear height/)).toBeTruthy();
  });

  it('renders ORA-self-owned-but-unmapped listing hygiene flags in the Portfolio tab', () => {
    renderWith(SUMMARY, {
      ...POSITIONING,
      hygieneFlags: [{ listingId: 99, marketId: 'columbus', address: '500 Unmapped Ave', reason: 'CoStar shows an ORA-owned listing at an address that is not mapped — add it to oraProperties' }],
    });
    expect(screen.getByText('500 Unmapped Ave')).toBeTruthy();
    expect(screen.getByText(/not mapped — add it to oraProperties/)).toBeTruthy();
  });

  it('shows the export freshness lastLandingDate/lastCompleteness and the benchmark quotedShare', () => {
    renderWith({
      ...SUMMARY,
      freshness: [{ marketId: 'columbus', label: 'Columbus', enabled: true, lastLandingDate: '2026-02-20', lastCompleteDate: '2026-02-15', lastCompleteness: 'partial', partialReason: 'export row count below floor', stale: false }],
      benchmarks: [{ cellKey: 'columbus|warehouse|5-15K|all', marketId: 'columbus', submarket: null, subtype: 'warehouse', sizeBand: '5-15K', officeStratum: 'all', rolledUp: 'none', n: 8, totalN: 10, quotedShare: 0.8, p25: 8, median: 9, p75: 10, lowCoverage: false }],
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Data Quality' }));
    expect(screen.getByText('2026-02-20')).toBeTruthy();
    expect(screen.getByText('partial')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Market Rents' }));
    expect(screen.getByText('80%')).toBeTruthy();
  });

  it('shows the candidatesWithheld banner on the Changes tab signals table', () => {
    renderWith(SUMMARY, POSITIONING, RADAR, { ...SIGNALS, candidatesWithheld: [{ marketId: 'madison', reason: 'owner screen unavailable on the latest complete export; acquisition candidates withheld' }] });
    fireEvent.click(screen.getByRole('tab', { name: 'Changes' }));
    expect(screen.getByText(/madison/)).toBeTruthy();
    expect(screen.getByText(/owner screen unavailable/)).toBeTruthy();
  });

  it('re-clicking the selected Portfolio row toggles the comparables panel closed', () => {
    renderWith();
    expect(screen.queryByText(/Comparables — 1100 Rarig/)).toBeNull();
    fireEvent.click(screen.getByText('1100 Rarig'));
    expect(screen.getByText(/Comparables — 1100 Rarig/)).toBeTruthy();
    fireEvent.click(screen.getByText('1100 Rarig'));
    expect(screen.queryByText(/Comparables — 1100 Rarig/)).toBeNull();
  });

  it('filters the Market Rents benchmark table to the selected market, showing the empty state when only OTHER markets have benchmark cells', () => {
    const summaryWithOtherMarketBenchmarks: LeaseMarketSummaryResponse = {
      ...SUMMARY,
      benchmarks: [{
        cellKey: 'madison|warehouse|5-15K|all', marketId: 'madison', submarket: null, subtype: 'warehouse', sizeBand: '5-15K',
        officeStratum: 'all', rolledUp: 'none', n: 6, totalN: 6, quotedShare: 1, p25: 8, median: 9, p75: 10, lowCoverage: false,
      }],
    };
    renderWith(summaryWithOtherMarketBenchmarks);
    fireEvent.click(screen.getByRole('tab', { name: 'Market Rents' }));
    // data.benchmarks is non-empty overall (one Madison cell), but the selected market is Columbus --
    // the per-market filter must still show the empty state, not an empty table.
    expect(screen.getByText('No benchmark cells yet.')).toBeTruthy();
    expect(screen.queryByText('madison|warehouse|5-15K|all')).toBeNull();
  });

  it('switches to the radar, changes and data-quality tabs', () => {
    renderWith();
    fireEvent.click(screen.getByRole('tab', { name: 'Acquisition Radar' }));
    expect(screen.getByText('101 Industrial Pkwy')).toBeTruthy();
    expect(screen.getByText('$68,000')).toBeTruthy();
    expect(screen.getByText(/not NOI/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Investigate' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Changes' }));
    expect(screen.getByText('$6.50 → $6.00')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Data Quality' }));
    expect(screen.getAllByText(/Columbus|columbus/).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/NaN/);
  });

  it('renders explicit empty states', () => {
    renderWith(
      { ...SUMMARY, curve: [], domByMarket: [] },
      { ...POSITIONING, rows: [], unconfiguredPropertyKeys: [] },
      { ...RADAR, candidates: [] },
      SIGNALS,
      { ...CHANGES, events: [] },
    );
    expect(screen.getByText('No ORA space currently listed in CoStar or vacant in the rent roll.')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Market Rents' }));
    expect(screen.getByText('No quoted asking rents yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Acquisition Radar' }));
    expect(screen.getByText('No radar candidates.')).toBeTruthy();
  });

  it('hides the radar decision buttons when the live warehouse probe is false, shows them when true', () => {
    const notLive = renderWith(SUMMARY, POSITIONING, RADAR, SIGNALS, CHANGES, false);
    fireEvent.click(screen.getByRole('tab', { name: 'Acquisition Radar' }));
    expect(screen.getByText('101 Industrial Pkwy')).toBeTruthy(); // the table itself still renders
    expect(screen.queryByRole('button', { name: 'Investigate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Monitor' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pass' })).toBeNull();
    notLive.unmount();

    renderWith(SUMMARY, POSITIONING, RADAR, SIGNALS, CHANGES, true);
    fireEvent.click(screen.getByRole('tab', { name: 'Acquisition Radar' }));
    expect(screen.getByRole('button', { name: 'Investigate' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Monitor' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pass' })).toBeTruthy();
  });

  it('renders the top-level "Loading…" state before the summary query resolves', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(LIVE_PROBE_KEY, false);
    // Never-resolving fetch keeps the summary query in its initial "pending" (isLoading) state for
    // the lifetime of this synchronous assertion — no data or live-probe seeded for `summary`.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(<MemoryRouter><QueryClientProvider client={qc}><LeaseMarketModule /></QueryClientProvider></MemoryRouter>);
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('renders "Not available on this mirror." when the summary read is warehouse-unavailable', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(LIVE_PROBE_KEY, false);
    // A rejected fetch (offline / mirror absent) is exactly what fetchJson wraps into
    // WarehouseUnavailableError; loadWarehouseMirror's own fetch('/warehouse.json') hits the same
    // stub and fails closed to null, so fetchParsedOrMirror re-throws the unavailable error.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    render(<MemoryRouter><QueryClientProvider client={qc}><LeaseMarketModule /></QueryClientProvider></MemoryRouter>);
    // The lease-market hooks spread the shared QUERY_OPTS (retry: 1), so this query retries once
    // with a backoff delay before settling into its error state — give it more than the default
    // findByText timeout to clear that retry.
    expect(await screen.findByText('Not available on this mirror.', {}, { timeout: 5000 })).toBeTruthy();
  });

  it('clicking a Changes-tab event row opens the history drawer, which closes again on tab switch', async () => {
    const history: HistoryResponse = {
      listingId: 2,
      address: '101 Industrial Pkwy',
      observations: [{ observedAt: '2026-02-15', availableSf: 20000, askingNnnEq: 6, rentBasis: 'NNN', confidence: 'high', costarDom: 31 }],
      events: [{ id: 1, listingId: 2, propertyId: 2, marketId: 'columbus', address: '101 Industrial Pkwy', kind: 'new', eventDate: '2026-02-15', prevValue: null, newValue: null }],
    };
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/lease-market/history/2')) {
        return new Response(JSON.stringify(history), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected fetch in this test: ${url}`);
    }));
    renderWith();
    fireEvent.click(screen.getByRole('tab', { name: 'Changes' }));
    fireEvent.click(screen.getByText('$6.50 → $6.00')); // the event row (onRowClick bubbles from the cell)
    expect(await screen.findByText(/Space history — 101 Industrial Pkwy/)).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Portfolio' }));
    expect(screen.queryByText(/Space history/)).toBeNull();
  });

  it('POSTs the right body with ORA_JSON_MUTATION_HEADERS, disables the buttons while pending, and shows the error on failure', async () => {
    let resolveFetch!: (r: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    // The mock body only returns the pending promise -- it makes no assertions itself. A `throw`/
    // `expect` failure raised INSIDE a mock implementation surfaces as a rejected fetch() call in the
    // component under test (swallowed by whatever catches the mutation's promise) rather than as a
    // normal test failure, which makes the real cause hard to find. Capture the call args instead and
    // assert on them below, in the test body proper.
    const fetchMock = vi.fn((_input: string | URL, _init?: RequestInit) => pending);
    vi.stubGlobal('fetch', fetchMock);
    renderWith(SUMMARY, POSITIONING, RADAR, SIGNALS, CHANGES, true);
    fireEvent.click(screen.getByRole('tab', { name: 'Acquisition Radar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Investigate' }));

    // Still in flight: the decision buttons are disabled (not merely hidden). isPending flips a
    // tick after mutate() (TanStack Query's internal dispatch), so poll rather than assert bare.
    // (No jest-dom matchers in this codebase — check the DOM `disabled` property directly.)
    await waitFor(() => expect((screen.getByRole('button', { name: 'Investigate' }) as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByRole('button', { name: 'Monitor' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Pass' }) as HTMLButtonElement).disabled).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toBe('/api/warehouse/lease-market/radar/decision');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject(ORA_JSON_MUTATION_HEADERS);
    expect(JSON.parse(init!.body as string)).toEqual({ propertyId: 2, decision: 'investigate', note: null });

    resolveFetch(new Response(JSON.stringify({ error: 'call the broker first' }), { status: 400, headers: { 'content-type': 'application/json' } }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/call the broker first/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Go-live change (2026-09-17): Rent Position rows now carry a `source` telling Gabriel whether the
  // row came from an ORA-owned CoStar listing or a matched rent-roll vacancy.
  it('shows the Source column for both a listing-sourced and a rent-roll-sourced Rent Position row', () => {
    renderWith(SUMMARY, {
      ...POSITIONING,
      rows: [
        POSITIONING.rows[0]!, // source: 'rent-roll'
        {
          propertyKey: 'Banwick', unit: '2802', sf: 1500, oraAskingNnnEq: 13.2,
          stats: { basis: 'similarity', n: 8, low: 10, p25: 11, median: 12, p75: 13, high: 14, confidence: 'MEDIUM', cellKey: null, unknown: [] },
          comps: [], percentile: 0.9, gapPct: 0.1, band: 'in_band', recommendation: 'Within the comparable range ($11.00–$13.00).',
          flags: [], effectiveDom: 30, source: 'listing',
        },
      ],
    });
    expect(screen.getAllByText('Rent-roll vacancy')).toHaveLength(1);
    expect(screen.getAllByText('CoStar listing')).toHaveLength(1);
    expect(screen.getByText('Banwick')).toBeTruthy();
  });

  it('reworded the listed-but-not-vacant caption to describe a data inconsistency, not the routine case', () => {
    renderWith(SUMMARY, {
      ...POSITIONING,
      listedButLeased: [{ propertyKey: '1100 Rarig', listingId: 501, suite: 'Z', askingNnnEq: 9.5, effectiveDom: 60, address: '1100 Rarig Ave' }],
    });
    expect(screen.getByText('Listed in CoStar with no Rent Position row (data inconsistency)')).toBeTruthy();
    expect(screen.queryByText('Listed in CoStar but not vacant in the rent roll')).toBeNull();
  });
});
