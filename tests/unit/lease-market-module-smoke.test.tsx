// tests/unit/lease-market-module-smoke.test.tsx
//
// Render-level smoke for LeaseMarketModule (Task 16, spec rev 3 §4): KPI row + Portfolio tab by
// default, tab switching, and explicit empty states. Seeds a QueryClient directly (no fetch mocks)
// following the market-module-smoke.test.tsx / rent-curve.test.tsx pattern.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LeaseMarketModule } from '../../src/modules/lease-market/LeaseMarketModule';
import { LEASE_MARKET_KEYS } from '../../src/modules/lease-market/hooks';
import type { ChangesResponse, LeaseMarketSummaryResponse, PositioningResponse, RadarResponse, SignalsResponse } from '../../src/contracts/lease-market';

// jsdom doesn't ship ResizeObserver; the Market Rents tab mounts RentCurve/BarChart, whose
// useMeasure hook requires it (same pattern as rent-curve.test.tsx / market-module-smoke.test.tsx).
// No-op stub — doesn't drive width, so it's only good enough for assertions that don't depend on
// the `width > 0` render branch (the empty-state text asserted here renders regardless of width).
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SUMMARY: LeaseMarketSummaryResponse = {
  asOf: '2026-03-01', rowLevel: true,
  kpis: { marketsFresh: 1, marketsEnabled: 1, activeSpaces: 13, newInLatest: 13, priceCutsInLatest: 2, stale: 3, radarCandidates: 1 },
  freshness: [{ marketId: 'columbus', label: 'Columbus', enabled: true, lastLandingDate: '2026-02-15', lastCompleteDate: '2026-02-15', lastCompleteness: 'complete', partialReason: null, stale: false }],
  dataQuality: [{ marketId: 'columbus', activeSpaces: 13, lastExportRows: 13, lastExportSkipped: 0, quotedShare: 0.8, coordsShare: 1, lowConfidenceShare: 0.1, rejectedRents: 0 }],
  benchmarks: [],
  curve: [6, 7, 8, 9, 10].map((v, i) => ({ listingId: i + 1, propertyId: i + 1, marketId: 'columbus', subtype: 'warehouse' as const, availableSf: 20000, askingNnnEq: v, solid: true, isOra: false, address: `${i} Main St` })),
  domByMarket: [{ marketId: 'columbus', bins: [{ label: '0-90d', count: 5 }, { label: '90-180d', count: 0 }, { label: '180-365d', count: 0 }, { label: '365d+', count: 0 }] }],
};
const POSITIONING: PositioningResponse = {
  asOf: '2026-03-01', unconfiguredPropertyKeys: ['Sepich'], listedButLeased: [],
  rows: [{
    propertyKey: '1100 Rarig', unit: 'B', sf: 8000, oraListingId: 13, oraAskingNnnEq: 12,
    stats: { basis: 'similarity', n: 12, low: 5.5, p25: 8.75, median: 9.3, p75: 10, high: 10.4, confidence: 'MEDIUM', cellKey: null },
    comps: [], percentile: 1, gapPct: 0.29, band: 'above', recommendation: 'Asking is 29% above the comparable median ($9.30); comparable range $8.75–$10.00.',
    flags: [], effectiveDom: 45, brokerName: null, listingUrl: null, dateListed: '2026-01-15',
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

function renderWith(summary = SUMMARY, positioning = POSITIONING, radar = RADAR, signals = SIGNALS, changes = CHANGES) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(LEASE_MARKET_KEYS.summary, summary);
  qc.setQueryData(LEASE_MARKET_KEYS.positioning, positioning);
  qc.setQueryData(LEASE_MARKET_KEYS.radar, radar);
  qc.setQueryData(LEASE_MARKET_KEYS.signals, signals);
  qc.setQueryData(LEASE_MARKET_KEYS.changes, changes);
  return render(<QueryClientProvider client={qc}><LeaseMarketModule /></QueryClientProvider>);
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
    expect(screen.getByText('No vacant ORA units mapped to a comparable set.')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Market Rents' }));
    expect(screen.getByText('No quoted asking rents yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Acquisition Radar' }));
    expect(screen.getByText('No radar candidates.')).toBeTruthy();
  });
});
