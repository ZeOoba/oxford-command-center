// tests/unit/principal-module-render.test.tsx
//
// I-2(a) (2026-09-23 review): principal-module.test.tsx only covered the pure principalKpis()
// helper — there was no render test for PrincipalModule itself. This renders the real component
// (not mocked) against a seeded QueryClient cache, matching the house pattern in
// overview-banner.test.tsx / portfolio-module-other-holdings.test.tsx: only the data HOOKS are
// substituted (by seeding their query keys directly, and stubbing global fetch so any unseeded
// query degrades safely) — everything else (React Query, UiContext defaults, the real
// principalDigest/digestSummary/anomaliesToInsights pipeline) runs for real.
//
// Rather than hardcode expected counts, the test independently recomputes the SAME
// buildAnalytics → principalDigest → digestSummary pipeline PrincipalModule runs internally (the
// same "prove by construction" style as overview-banner.test.tsx's buildSummary() check) — so a
// future change to the digest logic can't silently desync the assertions from the real behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within, fireEvent, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PortfolioSnapshot, Property } from '../../src/contracts/index';
import type { AnomalyFlag } from '../../src/contracts/warehouse';
import type { InsightCandidate } from '../../src/contracts/insights';
import { buildAnalytics } from '../../src/analytics/engine';
import { SNAPSHOT_KEY } from '../../src/data/queries';
import { ANALYTICS_KEYS } from '../../src/modules/intel/analytics-hooks';
import { INSIGHTS_KEYS } from '../../src/modules/insights/hooks';
import { mergeInsightSources } from '../../src/modules/insights/insights.logic';
import { UiContext, type UiState } from '../../src/brain/ui-context';
import { principalDigest } from '../../src/brain/principal-digest';
import { anomaliesToInsights } from '../../src/brain/anomaly-insights';
import { digestSummary } from '../../src/modules/principal/digest-summary';
import { PrincipalModule } from '../../src/modules/principal/PrincipalModule';

const ASOF = '2026-09-23';

const investment: Property = {
  id: 'p1', index: 1, name: '29000 Information Lane, Easton MD', address: '29000 Information Lane', city: null, state: null, market: 'Mid-Atlantic', type: 'Flex',
  sf: 48000, tenantCount: 1, occPct: 1, acqDate: null, estValue100: 0, oxfordOwnPct: 1, oxfordValue: 7_310_000, grossIncome: 0, expenses: 0, noi: 511_000, noiScenarioAdj: 511_000,
  debtService: 0, netCashFlow: 0, capRate: 0.07, dscr: 2.45, lender: 'Symetra', loanBalance: 2_770_000, ltv: 0.38, valuePerSf: null, rentPerSf: null, equityInvested: 1_000_000,
  cashOnCash: null, holdYrs: null, encumbered: true, flags: [],
} as Property;
const residence: Property = {
  ...investment, id: 'res', index: 2, name: '9510 Persimmon Tree Rd, Potomac MD', type: 'Residence', sf: 6700, oxfordValue: 2_000_000, noi: 0, noiScenarioAdj: 0,
  capRate: null, dscr: null, lender: null, loanBalance: 0, ltv: null, equityInvested: 900_000, encumbered: false,
} as Property;

const closingDeal = {
  id: 'deal-1', name: 'Northgate Flex — Columbus OH', shortName: 'Northgate Flex', location: 'Columbus, OH', market: null,
  sf: 40_000, buildings: 1, stage: 'Closing', estPrice: 5_000_000, capRate: 0.075, irr: null, equityMultiple: null, holdYrs: null,
  lender: null, status: null, nextAction: 'Fund at closing', owner: 'Gabriel', targetCloseDate: null, notionDealId: null,
  confidential: false, estimatedFields: [],
};

const criticalAnomaly: AnomalyFlag = {
  propertyId: 'p1', period: '2026-08', kind: 'noi-decline', subkey: '', severity: 'critical',
  detail: 'NOI dropped 22% month-over-month', metricValue: -0.22,
};

// A warehouse-only critical candidate — no Spine-A insight exists for it in this fixture (no
// loans/leases/insurance rows), so it exercises the "board shows a candidate the Digest must ALSO
// show" half of gap #1, distinct from the dedup/superseded half covered in principal-digest.test.ts.
const criticalCandidate: InsightCandidate = {
  id: 'cf-hurdle-drag::p1',
  family: 'CF',
  generatorId: 'cf-hurdle-drag',
  propertyId: 'p1',
  spine: 'B',
  attribution: { inputs: {} },
  confidence: 0.9,
  goal: 2,
  materialityUsd: 42_000,
  title: 'Hurdle rate drag — 29000 Information Lane',
  discovery: 'Projected unlevered IRR trails the 8% hurdle.',
  prov: { source: 'test', confidence: 'derived' },
  advisoryOnly: true,
};

function snapshot(): PortfolioSnapshot {
  return {
    meta: { schemaVersion: '1.0.0', asOf: ASOF, generatedAt: `${ASOF}T00:00:00.000Z`, source: 'test', scenario: 'Base' },
    assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: ASOF },
    properties: [investment, residence],
    leases: [],
    loans: [],
    cash: { asOf: ASOF, totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
    insurance: [], deals: [closingDeal], tasks: [], counterparties: [],
    renewalStages: {}, tenantNotes: {}, dealComps: {}, acquisitionInputs: {}, noiBudgets: {}, tenantArrears: {}, arBalances: [],
    quickbooks: null, governors: null, marketRents: {}, workbookTotals: { noi: null, value: null, rent: null }, dataQuality: [],
  } as unknown as PortfolioSnapshot;
}

function seededClient(s: PortfolioSnapshot): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  qc.setQueryData(SNAPSHOT_KEY, { snapshot: s, state: { status: 'fresh', source: 'workbook', lastUpdated: ASOF, lastError: null, workbookPath: 'test.xlsx', flagCount: 0 } });
  // useAnomalies' queryFn resolves to AnomalyFlag[] (r.anomalies unwrapped) — seed that shape directly.
  qc.setQueryData(ANALYTICS_KEYS.anomalies, [criticalAnomaly]);
  // useWarehouseInsights' queryFn resolves to the parsed InsightReport envelope.
  qc.setQueryData(INSIGHTS_KEYS.report, {
    candidates: [criticalCandidate],
    dataReadiness: [],
    generatedAt: `${ASOF}T00:00:00.000Z`,
    advisoryOnly: true,
  });
  return qc;
}

const openTab = vi.fn();
const ui: UiState = {
  activeModuleId: 'command-brain', setActiveModule: () => {}, openTab,
  paletteOpen: false, openPalette: () => {}, closePalette: () => {}, togglePalette: () => {},
  selected: null, openEntity: () => {}, closeEntity: () => {},
  intelPropertyId: null, openIntelProperty: () => {},
  aiOpen: false, openAi: () => {}, closeAi: () => {}, toggleAi: () => {},
  scenario: 'Base', setScenario: () => {},
  draft: null, openDraft: () => {}, closeDraft: () => {},
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
  // Pin "now" to the fixture's asOf so the run-date-basis analytics build (useAnalytics uses
  // `new Date().toISOString()`, not the frozen workbook date) matches what this test independently
  // recomputes below with the same fixed date.
  vi.spyOn(Date, 'now').mockReturnValue(new Date(`${ASOF}T12:00:00.000Z`).getTime());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderModule() {
  const s = snapshot();
  return render(
    <QueryClientProvider client={seededClient(s)}>
      <UiContext.Provider value={ui}>
        <PrincipalModule />
      </UiContext.Provider>
    </QueryClientProvider>,
  );
}

// Independently reproduces PrincipalModule's internal pipeline for the SAME fixture: same
// snapshot, same scenario/run-date basis, same mergeInsightSources() call the Insights board
// itself makes — so the expected counts/top items can never be a hand-guessed number that
// silently drifts from the real digest logic. The bridged anomaly is DELIBERATELY excluded from
// this pipeline (2026-09-23 review, gap #1) — see expectedAnomalyCount() below for its own line.
function expectedSummary() {
  const s = snapshot();
  const analytics = buildAnalytics(s, 'Base', ASOF);
  const { merged } = mergeInsightSources(analytics.insights, [criticalCandidate], s);
  const digest = principalDigest(s, merged);
  return digestSummary(digest);
}

// The warehouse anomaly's own count — bridged separately, never folded into expectedSummary().
function expectedAnomalyCount() {
  const s = snapshot();
  const nameById = new Map(s.properties.map((p) => [p.id, p.name]));
  const anomalyInsights = anomaliesToInsights([criticalAnomaly], nameById);
  return anomalyInsights.filter((i) => i.severity === 'critical' || i.severity === 'warning').length;
}

describe('PrincipalModule render', () => {
  it('renders the three count tiles matching the real digest pipeline (Critical/Review/Deals)', () => {
    renderModule();
    const summary = expectedSummary();

    expect(screen.getByText('Critical')).toBeTruthy();
    expect(screen.getByText('Review')).toBeTruthy();
    expect(screen.getByText('Deals')).toBeTruthy();
    // Exactly one warehouse-only critical candidate and one Closing-stage deal in this fixture —
    // the bridged critical ANOMALY is NOT in this count (gap #1: it isn't on the board either).
    expect(summary.critical).toBe(1);
    expect(summary.deals).toBe(1);

    const critTile = screen.getByText('Critical').closest('div')!.parentElement!;
    expect(within(critTile).getByText(String(summary.critical))).toBeTruthy();
    const dealsTile = screen.getByText('Deals').closest('div')!.parentElement!;
    expect(within(dealsTile).getByText(String(summary.deals))).toBeTruthy();
  });

  it('lists the top critical item(s) matching digestSummary().top', () => {
    renderModule();
    const summary = expectedSummary();
    expect(summary.top.length).toBeGreaterThan(0);
    for (const item of summary.top) {
      expect(screen.getByText(item.title)).toBeTruthy();
    }
  });

  it('an anomaly-only critical does not change the Digest critical count vs the board (gap #1)', () => {
    renderModule();
    const summary = expectedSummary();
    const anomalyCount = expectedAnomalyCount();
    expect(anomalyCount).toBe(1); // the fixture's bridged anomaly IS critical
    // The rendered Critical tile equals the board's merged-set count, NOT board-count + anomalies.
    const critTile = screen.getByText('Critical').closest('div')!.parentElement!;
    expect(within(critTile).getByText(String(summary.critical))).toBeTruthy();
    expect(within(critTile).queryByText(String(summary.critical + anomalyCount))).toBeNull();
  });

  it('surfaces the bridged anomaly on its own labelled line, not folded into the count tiles, linking to Worklist › Alerts', () => {
    renderModule();
    const anomalyCount = expectedAnomalyCount();
    expect(screen.getByText(`${anomalyCount} ledger anomaly flagged (tracked in Worklist › Alerts)`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Worklist › Alerts/ }));
    expect(openTab).toHaveBeenCalledWith('worklist', 'alerts');
  });

  it('"Open Insights" calls openTab(\'command-brain\', \'insights\')', () => {
    renderModule();
    fireEvent.click(screen.getByRole('button', { name: /open insights/i }));
    expect(openTab).toHaveBeenCalledWith('command-brain', 'insights');
  });

  it("the Principal Value tile's sublabel includes the other-holdings clause (residence row present)", () => {
    renderModule();
    // Principal's Value tile has never shown a property count (unlike Overview/Portfolio) — just
    // the shared $ clause, present because this fixture's residence row makes otherHoldingsCount > 0.
    expect(screen.getByText('+$2.00M other holdings')).toBeTruthy();
  });
});
