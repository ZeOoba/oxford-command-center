// tests/unit/overview-banner.test.tsx
//
// Render-level tests for the Overview module's Results banner + Priority Actions widgets
// (src/modules/overview/widgets.tsx, task 7.1). Both widgets reuse the P2 merged-insight feed
// (src/modules/insights/insights.logic.ts's mergeInsightSources/buildSummary/totalsBySpine) —
// they never recompute a $ total independently. This file proves that reuse holds by construction:
// each test independently calls the SAME insights.logic.ts functions on the SAME seeded input and
// asserts the rendered widget shows the identical (formatted) numbers, so a future edit that makes
// the widget "helpfully" recompute its own total would fail here immediately.
//
// Fixture style mirrors tests/unit/insights-module.test.tsx (schema-complete PortfolioSnapshot +
// InsightReport builders, QueryClient cache seeded directly — deterministic, no network).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import type { InsightReport, InsightCandidate } from '../../src/contracts/insights';
import { SNAPSHOT_KEY } from '../../src/data/queries';
import { INSIGHTS_KEYS } from '../../src/modules/insights/hooks';
import { mergeInsightSources, buildSummary, buildTiers } from '../../src/modules/insights/insights.logic';
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
    quickbooks: null,
    governors: null,
    marketRents: {},
    workbookTotals: { noi: null, value: null, rent: null },
    dataQuality: [],
  };
}

function candidate(over: Partial<InsightCandidate> & Pick<InsightCandidate, 'id' | 'family' | 'propertyId'>): InsightCandidate {
  return {
    generatorId: 'test-gen',
    spine: 'A',
    attribution: { inputs: {} },
    confidence: 0.7,
    goal: 1,
    materialityUsd: null,
    title: 'Candidate',
    discovery: 'Candidate discovery narrative.',
    prov: { source: 'test', confidence: 'derived', asOf: ASOF },
    advisoryOnly: true,
    ...over,
  };
}

function report(): InsightReport {
  return {
    candidates: [
      // critical: high confidence + quantified -> severity 'critical' (spine A)
      candidate({
        id: 'c-critical-1',
        family: 'CF',
        generatorId: 'cf-hurdle-drag',
        propertyId: 'prop-1',
        spine: 'A',
        confidence: 0.9,
        materialityUsd: 80_000,
        title: 'Below-market cap rate — Prop One',
        discovery: 'Prop One yields well below the market median cap rate.',
      }),
      // warning: moderate confidence (spine B)
      candidate({
        id: 'c-warning-1',
        family: 'TE',
        generatorId: 'te-test-gen',
        propertyId: 'prop-2',
        spine: 'B',
        confidence: 0.6,
        materialityUsd: 20_000,
        title: 'Tenant renewal risk — Prop Two',
        discovery: 'A large tenant lease expires within 6 months with no renewal signed.',
      }),
      // warning: moderate confidence (spine A) — smaller $ than the two above, ranks lower
      candidate({
        id: 'c-warning-2',
        family: 'CF',
        generatorId: 'cf-hurdle-drag',
        propertyId: 'prop-3',
        spine: 'A',
        confidence: 0.55,
        materialityUsd: 5_000,
        title: 'Secondary premium valuation — Prop Three',
        discovery: 'Prop Three is modestly below the market median cap rate.',
      }),
      // info: low confidence, unquantified, portfolio-wide (spine B) — excluded from risk $, counted in monitor
      candidate({
        id: 'c-info-1',
        family: 'DR',
        generatorId: 'dr-test-gen',
        propertyId: null,
        spine: 'B',
        confidence: 0.3,
        materialityUsd: null,
        title: 'Portfolio-wide data quality note',
        discovery: 'A handful of imports carry low-confidence account mappings.',
      }),
    ],
    dataReadiness: [{ generatorId: 'cf-hurdle-drag', status: 'live', sampleN: 2 }],
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

function widget(id: string) {
  const def = OVERVIEW_WIDGETS.find((w) => w.id === id);
  if (!def) throw new Error(`widget not registered: ${id}`);
  return def.Component;
}

beforeEach(() => {
  // Defensive stub matching the house pattern (insights-module.test.tsx) — absorbs any
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

function renderWidget(id: string) {
  const Component = widget(id);
  return render(
    <QueryClientProvider client={seededClient()}>
      <Component />
    </QueryClientProvider>,
  );
}

describe('Overview widget registry', () => {
  it('registers results-banner, priority-actions and insights widgets', () => {
    expect(OVERVIEW_WIDGETS.map((w) => w.id)).toContain('results-banner');
    expect(OVERVIEW_WIDGETS.map((w) => w.id)).toContain('priority-actions');
    expect(OVERVIEW_WIDGETS.map((w) => w.id)).toContain('insights');
  });
});

describe('ResultsBannerWidget', () => {
  it('banner sums exactly match buildSummary() computed independently for the same input', () => {
    // Independently reproduce what the widget itself computes internally: same snapshot, same
    // Spine-A insights (none — empty snapshot yields zero Spine-A conditions), same candidates.
    const snapshot = emptySnapshot();
    const { merged } = mergeInsightSources([], report().candidates, snapshot);
    const expected = buildSummary(merged);

    renderWidget('results-banner');

    // Per-spine labels present (never a single blended figure).
    expect(screen.getAllByText('Spine A').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Spine B/cross').length).toBeGreaterThan(0);

    // Risk Impact (critical+warning): expected Spine A = 80,000 + 5,000 = 85,000; Spine B/cross = 20,000.
    expect(expected.riskImpactBySpine).toEqual([
      { label: 'Spine A', totalUsd: 85_000 },
      { label: 'Spine B/cross', totalUsd: 20_000 },
    ]);
    // Monitor Impact (info-only): only c-info-1, materialityUsd null -> 0 on both spines.
    expect(expected.monitorImpactBySpine).toEqual([
      { label: 'Spine A', totalUsd: 0 },
      { label: 'Spine B/cross', totalUsd: 0 },
    ]);
    expect(expected.count).toBe(4);

    // The rendered banner must show exactly these independently-computed numbers (formatted the
    // same way the widget formats them, fmtUsdCompact) — proving no independent recomputation.
    expect(screen.getByText('$85K')).toBeTruthy(); // Risk Impact · Spine A
    expect(screen.getByText('$20K')).toBeTruthy(); // Risk Impact · Spine B/cross
    expect(screen.getAllByText('$0').length).toBeGreaterThanOrEqual(2); // Monitor Impact · both spines

    // Plain count, never combined into the spine totals.
    expect(screen.getByText('Open Actions')).toBeTruthy();
    expect(screen.getByText(String(expected.count))).toBeTruthy();
  });

  it('renders Risk Impact and Monitor Impact as distinct, never-combined labels', () => {
    renderWidget('results-banner');
    expect(screen.getByText('Risk Impact')).toBeTruthy();
    expect(screen.getByText('Monitor Impact')).toBeTruthy();
  });
});

describe('PriorityActionsWidget', () => {
  it('shows the top items ranked by $ impact across all severities (not grouped by severity)', () => {
    renderWidget('priority-actions');

    expect(screen.getByText('Priority Actions')).toBeTruthy();

    // Ranked purely by $ impact regardless of severity: 80k (critical) > 20k (warning) > 5k
    // (warning) > null (info, sorts last). Assert DOM order via compareDocumentPosition.
    const first = screen.getByText('Below-market cap rate — Prop One');
    const second = screen.getByText('Tenant renewal risk — Prop Two');
    const third = screen.getByText('Secondary premium valuation — Prop Three');
    const fourth = screen.getByText('Portfolio-wide data quality note');

    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(second.compareDocumentPosition(third) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(third.compareDocumentPosition(fourth) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Rank badges present.
    expect(screen.getByText('#1')).toBeTruthy();
    expect(screen.getByText('#4')).toBeTruthy();

    // Per-spine chip present per item (never a combined-spine chip).
    expect(screen.getAllByText('Spine A').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Spine B').length).toBeGreaterThan(0);
  });

  it('caps at the configured top-N limit (4 candidates seeded, all within the 6-item cap, all render)', () => {
    renderWidget('priority-actions');
    // All 4 seeded candidates fit within PRIORITY_ACTIONS_LIMIT (6) — confirm none are dropped.
    expect(screen.getByText('Below-market cap rate — Prop One')).toBeTruthy();
    expect(screen.getByText('Tenant renewal risk — Prop Two')).toBeTruthy();
    expect(screen.getByText('Secondary premium valuation — Prop Three')).toBeTruthy();
    expect(screen.getByText('Portfolio-wide data quality note')).toBeTruthy();
  });

  it('renders as a single tier (one card, no dead half-column) — design-parity finding #3', () => {
    const { container } = renderWidget('priority-actions');
    // TierBoard is given exactly one tier — assert the board's grid class is the exact
    // grid-cols-1 token (not merely "not grid-cols-2", which would also pass for an accidental
    // future columns={3}/{4} regression) and that exactly one tier column renders.
    const board = screen.getByRole('list', { name: 'Tier board' });
    expect(board.className.split(' ')).toContain('grid-cols-1');
    expect(container.querySelectorAll('[role="listitem"]').length).toBe(1);
  });
});

// ── InsightsWidget — design-parity finding #2 ────────────────────────────────────────────────
//
// The Overview "Insights & Alerts" widget must reuse mergeInsightSources()/buildTiers() (the
// exact same functions InsightsModule.tsx uses) and render a TierBoard — never a flat,
// independently-paginated <ul>. This proves the reuse by construction, the same way the
// ResultsBannerWidget test above does for buildSummary().
describe('InsightsWidget', () => {
  it('renders the same tiers buildTiers() computes independently for the same input — no flat list', () => {
    const snapshot = emptySnapshot();
    const { merged } = mergeInsightSources([], report().candidates, snapshot);
    const expectedTiers = buildTiers(merged);

    renderWidget('insights');

    // Tier board titles present (Critical / Priority / Monitor), proving buildTiers() ran.
    for (const tier of expectedTiers) {
      if (tier.items.length > 0) {
        expect(screen.getAllByText(tier.title).length).toBeGreaterThan(0);
      }
    }

    // The old flat-list pagination affordance must be gone entirely.
    expect(screen.queryByText(/Show \d+ more/)).toBeNull();

    // Tier board renders as a role="list" (TierBoard's own semantics) rather than a bare <ul>
    // of insight rows — the structural signature of the binding-rule violation fix.
    expect(screen.getByRole('list', { name: 'Tier board' })).toBeTruthy();
  });

  it('shows an active-count badge reflecting the merged (not raw analytics-only) insight count', () => {
    renderWidget('insights');
    expect(screen.getByText('Insights & Alerts')).toBeTruthy();
    const snapshot = emptySnapshot();
    const { merged } = mergeInsightSources([], report().candidates, snapshot);
    expect(screen.getByText(`${merged.length} active`)).toBeTruthy();
  });
});
