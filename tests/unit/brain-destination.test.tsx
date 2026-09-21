// tests/unit/brain-destination.test.tsx
//
// IA decongestion Phase 4e — the Brain destination: Digest · Insights · Track record · Feedback · Memory.
// CommandBrainModule owns the strip; Digest (PrincipalModule) and Insights (InsightsModule) are lazy panels
// (mocked here — each has its own suite). The three report-backed tabs share <ReportGate>.
//   R2     — the disclaimer + four KPI tiles moved INSIDE the report-backed panels: they render on Track
//            record / Feedback / Memory and NOT on Digest / Insights.
//   Rule G — the /brain/report offline gate is scoped to those three panels. Digest and Insights read the
//            snapshot and work on the static mirror, so they must render in full when the report 503s. The
//            failure path is REAL: the actual useBrainReport hook is driven to WarehouseUnavailableError
//            via a 503 fetch stub (no mocked hook).
//   Rule H — switching a destination tab clears `?view=` (owned by Memory's inner SegmentedControl).
//   Versions — the old Versions tab is a `?view=versions` SegmentedControl switch inside Memory (R5).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { CommandBrainModule } from '../../src/modules/command-brain/CommandBrainModule';
import { BRAIN_KEYS } from '../../src/modules/command-brain/hooks';
import type { BrainReport } from '../../src/contracts/brain-report';

vi.mock('../../src/modules/principal/PrincipalModule', () => ({ PrincipalModule: () => <div>digest-panel</div> }));
vi.mock('../../src/modules/insights/InsightsModule', () => ({ InsightsModule: () => <div>insights-panel</div> }));

const REPORT: BrainReport = {
  asOf: '2026-07-06T00:00:00.000Z',
  dataAsOf: '2026-07-05T18:00:00.000Z',
  overallHitRate: 0.72,
  overallCi: { lo: 0.55, hi: 0.85 },
  resolvedTotal: 18,
  watchedSignals: 42,
  recalibrations: 3,
  accuracySeries: [
    { month: '2026-01', resolvedN: 5, scoreableN: 5, hitRate: 0.6 },
    { month: '2026-02', resolvedN: 5, scoreableN: 5, hitRate: 0.8 },
  ],
  trackRecord: [
    {
      verdictId: 'v1', kind: 'capital-action', subject: '1100-rarig',
      predictedBand: 'disposition-candidate', realizedBand: 'noi-flat-or-declined',
      outcome: 'hit', resolvedAt: '2026-06-01', predictedValue: null, realizedValue: null,
    },
  ],
  confidenceByMarket: [
    { key: 'market:dc-metro', label: 'DC Metro', sampleN: 40, coverageConfidence: 0.85, basisNote: 'coverage-based, not predictive skill' },
  ],
  confidenceByManager: [],
  openQuestions: [
    { kind: 'data-quality', title: 'Thin AR-aging coverage for 1100-rarig', detail: 'Only 2 of the last 6 months have an AR-aging import.', wouldClose: 'Import the missing AR-aging files' },
    { kind: 'dormant-generator', title: 'No anomaly signals fired in 90 days', detail: 'The anomaly generator has not emitted since the last import batch.', wouldClose: 'Re-run the anomaly detector after the next import' },
  ],
  versionLog: [
    { at: '2026-06-01T00:00:00.000Z', kind: 'config-change', detail: 'INTEL_CONFIG weights ratified (Option B)' },
  ],
  advisoryOnly: true,
};

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.search}</div>;
}

function renderModule(entry = '/command-brain', { report = REPORT }: { report?: BrainReport | null } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  if (report) qc.setQueryData(BRAIN_KEYS.report, report);
  return {
    qc,
    ...render(
      <MemoryRouter initialEntries={[entry]}>
        <QueryClientProvider client={qc}>
          <CommandBrainModule />
          <LocationProbe />
        </QueryClientProvider>
      </MemoryRouter>,
    ),
  };
}

/** Report NOT seeded: the real useBrainReport hits fetch -> 503 -> WarehouseUnavailableError (the static mirror). */
const renderOffline = (entry = '/command-brain') => renderModule(entry, { report: null });

const clickTab = (name: string | RegExp) => fireEvent.click(screen.getByRole('tab', { name }));
const selected = (name: string | RegExp) => screen.getByRole('tab', { name }).getAttribute('aria-selected') === 'true';
const search = () => new URLSearchParams(screen.getByTestId('loc').textContent ?? '');
const DISCLAIMER = /nothing here is invented/;
// useBrainReport retries once (QUERY_OPTS) with react-query's 1s backoff before the query settles into its
// error state, so the offline assertions wait past that.
const SETTLE = { timeout: 4000 };
/** Resolves once the REAL report query has failed (WarehouseUnavailableError) - the state that used to blank the module. */
const reportFailed = (qc: QueryClient) =>
  waitFor(() => expect(qc.getQueryState(BRAIN_KEYS.report)?.status).toBe('error'), SETTLE);

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Brain destination - strip + default', () => {
  it('declares the five tabs in order and lands on Digest', async () => {
    renderModule();
    expect(screen.getAllByRole('tab').map((t) => t.textContent?.replace(/\s*\d+$/, ''))).toEqual([
      'Digest', 'Insights', 'Track record', 'Feedback', 'Memory',
    ]);
    expect(selected('Digest')).toBe(true);
    expect(await screen.findByText('digest-panel')).toBeTruthy();
  });

  it('deep-links a tab via ?tab=', async () => {
    renderModule('/command-brain?tab=insights');
    expect(selected('Insights')).toBe(true);
    expect(await screen.findByText('insights-panel')).toBeTruthy();
  });

  it('falls back to Digest for the retired ?tab=versions value (the alias table redirects it upstream)', () => {
    renderModule('/command-brain?tab=versions');
    expect(selected('Digest')).toBe(true);
  });
});

describe('Brain destination - R2: disclaimer + KPI tiles live inside the report-backed panels only', () => {
  it('Digest and Insights render neither the disclaimer nor the KPI tiles', async () => {
    renderModule();
    await screen.findByText('digest-panel');
    expect(screen.queryByText(DISCLAIMER)).toBeNull();
    expect(screen.queryByText('Flag Accuracy')).toBeNull();
    clickTab('Insights');
    await screen.findByText('insights-panel');
    expect(screen.queryByText(DISCLAIMER)).toBeNull();
    expect(screen.queryByText('Signals Watched')).toBeNull();
  });

  for (const [tab, marker] of [
    ['Track record', 'Flag Accuracy Over Time'],
    [/^Feedback/, 'Open Questions'],
    ['Memory', 'DC Metro — 85%'],
  ] as const) {
    it(`${String(tab)} shows the disclaimer + all four KPI tiles above its panel`, () => {
      renderModule();
      clickTab(tab);
      expect(screen.getByText(DISCLAIMER)).toBeTruthy();
      for (const label of ['Flag Accuracy', 'Signals Watched', 'Recalibrations', 'Resolved Outcomes']) {
        expect(screen.getByText(label)).toBeTruthy();
      }
      expect(screen.getByText('72%')).toBeTruthy();
      expect(screen.getByText(marker)).toBeTruthy();
    });
  }
});

describe('Brain destination - Rule G: the report offline gate is scoped to the three report tabs', () => {
  it('Digest renders fully when /brain/report 503s (no whole-module offline card)', async () => {
    const { qc } = renderOffline();
    expect(await screen.findByText('digest-panel')).toBeTruthy();
    await reportFailed(qc); // the failure has landed - it must not blank the destination
    expect(screen.getByText('digest-panel')).toBeTruthy();
    expect(screen.queryByText(/requires the live brain server/)).toBeNull();
    expect(screen.getAllByRole('tab')).toHaveLength(5);
  });

  it('Insights renders fully when /brain/report 503s', async () => {
    const { qc } = renderOffline('/command-brain?tab=insights');
    expect(await screen.findByText('insights-panel')).toBeTruthy();
    await reportFailed(qc);
    expect(screen.getByText('insights-panel')).toBeTruthy();
    expect(screen.queryByText(/requires the live brain server/)).toBeNull();
  });

  for (const [entry, tab] of [
    ['/command-brain?tab=track-record', 'Track record'],
    ['/command-brain?tab=feedback', 'Feedback'],
    ['/command-brain?tab=memory', 'Memory'],
  ] as const) {
    it(`${tab} shows the offline card while the strip stays`, async () => {
      renderOffline(entry);
      expect(await screen.findByText(/requires the live brain server/, undefined, SETTLE)).toBeTruthy();
      expect(screen.getByText('offline')).toBeTruthy();
      expect(screen.getAllByRole('tab')).toHaveLength(5);
      expect(selected(tab)).toBe(true);
      expect(screen.queryByText(DISCLAIMER)).toBeNull();
      // the strip is live: from the offline tab, Digest is one click away and renders
      clickTab('Digest');
      expect(await screen.findByText('digest-panel')).toBeTruthy();
    });
  }
});

describe('Brain destination - Feedback badge (R4)', () => {
  it('carries the open-question count, sourced from the shared report query', () => {
    renderModule();
    expect(screen.getByRole('tab', { name: 'Feedback 2' })).toBeTruthy();
  });

  it('no badge at 0 open questions, and none while the report is unavailable', async () => {
    renderModule('/command-brain', { report: { ...REPORT, openQuestions: [] } });
    expect(screen.getByRole('tab', { name: 'Feedback' })).toBeTruthy();
    cleanup();
    const { qc } = renderOffline();
    await screen.findByText('digest-panel');
    await reportFailed(qc);
    expect(screen.getByRole('tab', { name: 'Feedback' })).toBeTruthy();
  });
});

describe('Brain destination - Memory views (Versions became a view)', () => {
  it('Memory has a "Memory views" radiogroup: Memory · Versions, defaulting to the confidence board', () => {
    renderModule('/command-brain?tab=memory');
    expect(screen.getByRole('radiogroup', { name: 'Memory views' })).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect((screen.getByRole('radio', { name: 'Memory' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: 'Versions' }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText('DC Metro — 85%')).toBeTruthy();
    expect(screen.queryByText('Version Log')).toBeNull();
  });

  it('?view=versions renders the version log', () => {
    renderModule('/command-brain?tab=memory&view=versions');
    expect(screen.getByText('Version Log')).toBeTruthy();
    expect(screen.getByText('INTEL_CONFIG weights ratified (Option B)')).toBeTruthy();
    expect(screen.queryByText('DC Metro — 85%')).toBeNull();
  });

  it('switching the radio writes ?view=versions, and back to Memory removes it', () => {
    renderModule('/command-brain?tab=memory');
    fireEvent.click(screen.getByRole('radio', { name: 'Versions' }));
    expect(search().get('view')).toBe('versions');
    expect(screen.getByText('Version Log')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Memory' }));
    expect(search().has('view')).toBe(false);
    expect(screen.getByText('DC Metro — 85%')).toBeTruthy();
  });

  it('Rule H: a tab switch clears ?view= (and preserves other params)', () => {
    renderModule('/command-brain?tab=memory&view=versions&scenario=Upside');
    clickTab('Track record');
    expect(search().get('tab')).toBe('track-record');
    expect(search().has('view')).toBe(false);
    expect(search().get('scenario')).toBe('Upside');
    clickTab('Memory');
    expect(screen.getByText('DC Metro — 85%')).toBeTruthy(); // the leaked view did not follow us back
  });
});
