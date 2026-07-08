// tests/unit/insights-module.test.tsx
//
// Render-level test for src/modules/insights/InsightsModule.tsx.
//
// Seeds the QueryClient cache directly (mirrors tests/unit/market-module-smoke.test.tsx and
// tests/unit/intel-ownership-smoke.test.tsx) so the render is deterministic and network-free:
//   - SNAPSHOT_KEY (['snapshot']) with an empty-array snapshot — Spine-A's evaluateConditions
//     fires zero insights against it, so the merged board is driven entirely by the seeded
//     warehouse candidates below (deterministic, no Spine-A fixture engineering needed).
//   - INSIGHTS_KEYS.report (['warehouse','insights']) with a hand-built InsightReport spanning
//     Critical/Priority/Monitor severities and two families (CF, TE, DR) so the category pills
//     and tier board both have real content to assert against.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import type { InsightReport } from '../../src/contracts/insights';
import { SNAPSHOT_KEY } from '../../src/data/queries';
import { INSIGHTS_KEYS } from '../../src/modules/insights/hooks';
import { InsightsModule } from '../../src/modules/insights/InsightsModule';

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
    quickbooks: null,
    marketRents: {},
    dataQuality: [],
  };
}

function report(): InsightReport {
  return {
    candidates: [
      {
        id: 'c-critical-1',
        family: 'CF',
        generatorId: 'cf-hurdle-drag',
        propertyId: 'prop-1',
        spine: 'A',
        attribution: { inputs: {} },
        confidence: 0.9,
        goal: 1,
        materialityUsd: 50_000,
        title: 'Premium valuation opportunity',
        discovery: 'Prop One yields well below the market median cap rate.',
        prov: { source: 'capital-allocation-report', confidence: 'derived', asOf: ASOF },
        advisoryOnly: true,
      },
      {
        id: 'c-warning-1',
        family: 'TE',
        generatorId: 'te-test-gen',
        propertyId: 'prop-2',
        spine: 'B',
        attribution: { inputs: {} },
        confidence: 0.6,
        goal: 2,
        materialityUsd: 20_000,
        title: 'Tenant renewal risk',
        discovery: 'A large tenant lease expires within 6 months with no renewal signed.',
        prov: { source: 'lease-run', confidence: 'derived', asOf: ASOF },
        advisoryOnly: true,
      },
      {
        id: 'c-warning-2',
        family: 'CF',
        generatorId: 'cf-hurdle-drag',
        propertyId: 'prop-3',
        spine: 'A',
        attribution: { inputs: {} },
        confidence: 0.55,
        goal: 1,
        materialityUsd: 5_000,
        title: 'Secondary premium valuation',
        discovery: 'Prop Three is modestly below the market median cap rate.',
        prov: { source: 'capital-allocation-report', confidence: 'derived', asOf: ASOF },
        advisoryOnly: true,
      },
      {
        id: 'c-info-1',
        family: 'DR',
        generatorId: 'dr-test-gen',
        propertyId: null,
        spine: 'B',
        attribution: { inputs: {} },
        confidence: 0.3,
        goal: 3,
        materialityUsd: null,
        title: 'Portfolio-wide data quality note',
        discovery: 'A handful of imports carry low-confidence account mappings.',
        prov: { source: 'warehouse', confidence: 'estimated', asOf: ASOF },
        advisoryOnly: true,
      },
    ],
    dataReadiness: [
      { generatorId: 'cf-hurdle-drag', status: 'live', sampleN: 2 },
      { generatorId: 'dr-none', status: 'dormant-no-outcomes', sampleN: null },
      { generatorId: 'te-none', status: 'dormant-no-outcomes', sampleN: null },
      { generatorId: 'tr-none', status: 'dormant-no-outcomes', sampleN: null },
      { generatorId: 'cr-none', status: 'dormant-no-outcomes', sampleN: null },
    ],
    generatedAt: '2026-07-06T12:00:00.000Z',
    advisoryOnly: true,
  };
}

function seededClient(): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  qc.setQueryData(SNAPSHOT_KEY, { snapshot: emptySnapshot(), state: { status: 'fresh', source: 'workbook', lastUpdated: ASOF, lastError: null, workbookPath: 'test.xlsx', flagCount: 0 } });
  qc.setQueryData(INSIGHTS_KEYS.report, report());
  return qc;
}

beforeEach(() => {
  // Defensive stub matching the house pattern (market-module-smoke.test.tsx) — absorbs any
  // background refetch attempt so an unexpected network call can't destabilize the test.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
  // Pin wall-clock "now" a few hours after the fixture's generatedAt so evaluateConditions'
  // workbook-stale check (ALERT_THRESHOLDS.workbookStaleHours = 48h, src/analytics/conditions.ts)
  // never fires here as real time drifts past this fixture's fixed date — this test asserts an
  // exact Open Actions count and must not depend on how long ago the fixture was written.
  vi.spyOn(Date, 'now').mockReturnValue(new Date(`${ASOF}T06:00:00.000Z`).getTime());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderModule() {
  return render(
    <QueryClientProvider client={seededClient()}>
      <InsightsModule />
    </QueryClientProvider>,
  );
}

describe('InsightsModule', () => {
  it('renders the results banner, 3 tier columns, and category pills', () => {
    renderModule();

    // Banner cells.
    expect(screen.getByText('Risk Impact')).toBeTruthy();
    expect(screen.getByText('Monitor Impact')).toBeTruthy();
    expect(screen.getByText('Open Insights')).toBeTruthy();

    // 3 tier columns (TierBoard renders one listitem per tier).
    expect(screen.getByText('Critical')).toBeTruthy();
    expect(screen.getByText('Priority')).toBeTruthy();
    expect(screen.getByText('Monitor')).toBeTruthy();
    // TierBoard's outer role="list" has exactly 3 direct role="listitem" children (one per
    // tier); each tier's own <ul>/<li> item list also carries an implicit listitem role, so we
    // scope to the board's direct children rather than counting every listitem in the tree.
    const board = screen.getByRole('list', { name: 'Tier board' });
    expect(board.children).toHaveLength(3);

    // Category pills: All + one per family present in the seeded candidates (CF, DR, TE).
    expect(screen.getByText(/All ·/)).toBeTruthy();
    expect(screen.getByText(/CF ·/)).toBeTruthy();
    expect(screen.getByText(/DR ·/)).toBeTruthy();
    expect(screen.getByText(/TE ·/)).toBeTruthy();
  });

  it('the unratified ranking-weights badge is present', () => {
    renderModule();
    expect(screen.getByText(/Ranking weights: proposed, pending ratification/i)).toBeTruthy();
  });

  it('clicking a category pill filters the board (item count changes)', () => {
    renderModule();

    // All 4 candidates visible initially (2 CF + 1 TE + 1 DR = 4 listed items across tiers).
    const allPill = screen.getByText(/All ·/);
    expect(allPill.textContent).toContain('4');

    const cfPill = screen.getByText(/CF ·/);
    expect(cfPill.textContent).toContain('2'); // c-critical-1 + c-warning-2

    fireEvent.click(cfPill);

    // After filtering to CF, only the 2 CF candidates should render as tier cards.
    expect(screen.getByText('Premium valuation opportunity')).toBeTruthy();
    expect(screen.getByText('Secondary premium valuation')).toBeTruthy();
    expect(screen.queryByText('Tenant renewal risk')).toBeNull();
    expect(screen.queryByText('Portfolio-wide data quality note')).toBeNull();
  });
});
