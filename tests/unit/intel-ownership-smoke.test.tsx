// tests/unit/intel-ownership-smoke.test.tsx
//
// Render-level SMOKE test for the Ownership Intelligence view (PFI Phase B.3). The heavy intel
// views are normally browser-verified (the pure logic carries the coverage), but the sandbox
// brain server 500s on every /api route, so a crash-smoke that actually mounts the view closes
// the integration gap: it proves the morning-briefing hero, heat-strip, and since-acquisition
// leaderboard render without throwing on real-shaped data (incl. the null-$/SF property).
//
// We seed a local TanStack QueryClient cache with the ANALYTICS_KEYS so the hooks resolve from
// cache with NO network and NO module mocking — `vitest.config.ts` sets `isolate: false`, under
// which `vi.mock` can bleed across the suite, so cache-seeding is the safe pattern. OwnershipView
// uses only jsdom-friendly primitives (no @visx charts), so it mounts cleanly.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OwnershipView } from '../../src/modules/intel/OwnershipView';
import {
  ANALYTICS_KEYS,
  type PropertyScore,
  type PeriodMetrics,
  type SinceAcquisition,
} from '../../src/modules/intel/analytics-hooks';

const score = (over: Partial<PropertyScore>): PropertyScore => ({
  propertyId: 'p',
  propertyName: 'P',
  period: '2025',
  health: 70,
  healthBand: 'good',
  attentionBand: 'green',
  capitalAction: 'hold',
  subScores: {},
  noiPerSfQuartile: 2,
  benchmarkCohortSize: 1,
  reasons: [],
  ...over,
});

const pm = (over: Partial<PeriodMetrics>): PeriodMetrics => ({
  propertyId: 'p',
  propertyName: 'P',
  period: '2025',
  grainHint: 'year',
  basis: 'cash',
  rentableSf: 10000,
  ownershipPct: 1,
  revenue: 100,
  opex: 40,
  noi: 60,
  noiMargin: 0.6,
  expenseRatio: 0.4,
  capex: 0,
  ti: 0,
  leasing: 0,
  categories: {},
  revenueCategories: {},
  revenuePerSf: 0.01,
  noiPerSf: 0.006,
  expensePerSf: 0.004,
  taxesPerSf: 0.001,
  insurancePerSf: 0.0005,
  repairsPerSf: 0.0008,
  oxfordNoi: 60,
  ...over,
});

const sa = (over: Partial<SinceAcquisition>): SinceAcquisition => ({
  propertyId: 'p',
  anchorPeriod: '2023',
  latestPeriod: '2025',
  comparable: true,
  revenueGrowth: null,
  noiGrowth: null,
  noiPerSfGrowth: null,
  taxesGrowth: null,
  insuranceGrowth: null,
  revenuePerSfGrowth: null,
  noiCagr: null,
  ...over,
});

function seededClient(): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  const scores: PropertyScore[] = [
    score({ propertyId: 'red-branch', propertyName: '9050 Red Branch', attentionBand: 'green', healthBand: 'good', capitalAction: 'hold', noiPerSfQuartile: 1 }),
    score({ propertyId: 'club-solar', propertyName: '1851 Solar', attentionBand: 'red', healthBand: 'concern', capitalAction: 'disposition-candidate', noiPerSfQuartile: 4, reasons: ['bottom-quartile NOI/SF'] }),
  ];
  const metrics: PeriodMetrics[] = [
    pm({ propertyId: 'red-branch', propertyName: '9050 Red Branch', noi: 1_100_224, oxfordNoi: 1_100_224, noiPerSf: 6.25 }),
    pm({ propertyId: 'club-solar', propertyName: '1851 Solar', noi: 507_472, oxfordNoi: 507_472, rentableSf: null, noiPerSf: null }), // null-$/SF property
  ];
  const sinceAcquisition: SinceAcquisition[] = [
    sa({ propertyId: 'red-branch', noiGrowth: 0.12, noiPerSfGrowth: 0.1, comparable: true }),
    sa({ propertyId: 'club-solar', comparable: false }), // excluded → "insufficient history" note
  ];
  qc.setQueryData(ANALYTICS_KEYS.scores, scores);
  qc.setQueryData(ANALYTICS_KEYS.metrics, metrics);
  qc.setQueryData(ANALYTICS_KEYS.growth, { growth: [], sinceAcquisition });
  qc.setQueryData(ANALYTICS_KEYS.anomalies, []);
  qc.setQueryData(ANALYTICS_KEYS.pm, []);
  return qc;
}

afterEach(() => cleanup());

describe('OwnershipView (render smoke)', () => {
  it('mounts the briefing hero, heat-strip and leaderboard on real-shaped data without crashing', () => {
    render(
      <QueryClientProvider client={seededClient()}>
        <OwnershipView onOpenProperty={() => {}} period={null} periodLabel={null} />
      </QueryClientProvider>,
    );
    // getByText throws if the node is absent, so each call is itself the presence assertion
    // (toBeTruthy avoids depending on jest-dom matcher types, which this repo doesn't wire into tsc).
    // Hero verdict sentence (portfolioVerdict) rendered.
    expect(screen.getByText(/portfolio NOI across 2 properties/i)).toBeTruthy();
    // "disposition candidate" appears in both the verdict and the capital labels — assert ≥1.
    expect(screen.getAllByText(/disposition candidate/i).length).toBeGreaterThan(0);
    // Section headers present (hero + below-the-fold leaderboard).
    expect(screen.getByText('Morning Briefing')).toBeTruthy();
    expect(screen.getByText('Compounding Since Acquisition')).toBeTruthy();
    // A property name renders (heat tile / matrix), and the null-$/SF property did not crash.
    expect(screen.getAllByText('1851 Solar').length).toBeGreaterThan(0);
    // The since-acq leaderboard excluded the incomparable property with a note.
    expect(screen.getByText(/excluded — insufficient history/i)).toBeTruthy();
  });
});
