// tests/unit/command-brain-module.test.tsx
//
// Render + pure-function coverage for the Command Brain module (Phase 5a.2 UI). Pins down the
// honesty-doctrine requirements from the brief:
//   - KPI values render exactly from the mocked report (no fabrication, no NaN).
//   - The accuracy sparkline shows a GAP for a null-hitRate month, never a coerced zero.
//   - Track Record shows only hit/miss/not-scoreable badges — no 4th 'partial' state, ever.
//   - MemoryBoard buckets confidence rows by the documented coverageConfidence thresholds and always
//     surfaces the row's basisNote caption.
//   - The fully-empty report (all arrays empty, resolvedTotal 0, overallHitRate null) renders an
//     honest empty state in every section, never a zero-that-looks-like-data.
//   - Feedback Accept/Dismiss calls the mutation with the right subjectKind/subjectId/decision.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CommandBrainModule } from '../../src/modules/command-brain/CommandBrainModule';
import { MemoryBoard } from '../../src/modules/command-brain/MemoryBoard';
import { TrackRecordList } from '../../src/modules/command-brain/TrackRecordList';
import {
  BRAIN_KEYS,
  accuracySegments,
  buildMemoryTiers,
  confidenceTier,
  openQuestionSubjectId,
  openQuestionSubjectKind,
} from '../../src/modules/command-brain/hooks';
import type { BrainReport } from '../../src/contracts/brain-report';

const EMPTY_REPORT: BrainReport = {
  asOf: '2026-07-06T00:00:00.000Z',
  dataAsOf: null,
  overallHitRate: null,
  overallCi: null,
  resolvedTotal: 0,
  watchedSignals: 0,
  recalibrations: 0,
  accuracySeries: [],
  trackRecord: [],
  confidenceByMarket: [],
  confidenceByManager: [],
  openQuestions: [],
  versionLog: [],
  advisoryOnly: true,
};

const POPULATED_REPORT: BrainReport = {
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
    { month: '2026-03', resolvedN: 2, scoreableN: 2, hitRate: null },
    { month: '2026-04', resolvedN: 6, scoreableN: 6, hitRate: 0.5 },
    { month: '2026-05', resolvedN: 6, scoreableN: 6, hitRate: 0.9 },
  ],
  trackRecord: [
    {
      verdictId: 'v1', kind: 'capital-action', subject: '1100-rarig',
      predictedBand: 'disposition-candidate', realizedBand: 'noi-flat-or-declined',
      outcome: 'hit', resolvedAt: '2026-06-01', predictedValue: null, realizedValue: null,
    },
    {
      verdictId: 'v2', kind: 'debt-signal', subject: '2200-westgate',
      predictedBand: '', realizedBand: null,
      outcome: 'miss', resolvedAt: '2026-05-15', predictedValue: 0.15, realizedValue: -0.02,
    },
    {
      verdictId: 'v3', kind: 'leasing-forecast', subject: '3300-harborview',
      predictedBand: 'hold', realizedBand: null,
      outcome: 'not-scoreable', resolvedAt: '2026-04-20', predictedValue: null, realizedValue: null,
    },
  ],
  confidenceByMarket: [
    { key: 'market:dc-metro', label: 'DC Metro', sampleN: 40, coverageConfidence: 0.85, basisNote: 'coverage-based, not predictive skill' },
    { key: 'market:baltimore', label: 'Baltimore', sampleN: 12, coverageConfidence: 0.5, basisNote: 'coverage-based, not predictive skill' },
  ],
  confidenceByManager: [
    { key: 'manager:pm-1', label: 'PM Alpha', sampleN: 3, coverageConfidence: 0.2, basisNote: 'coverage-based, not predictive skill' },
  ],
  openQuestions: [
    {
      kind: 'data-quality',
      title: 'Thin AR-aging coverage for 1100-rarig',
      detail: 'Only 2 of the last 6 months have an AR-aging import.',
      wouldClose: 'Import the missing AR-aging files',
    },
    {
      kind: 'dormant-generator',
      title: 'No anomaly signals fired in 90 days',
      detail: 'The anomaly generator has not emitted since the last import batch.',
      wouldClose: 'Re-run the anomaly detector after the next import',
    },
  ],
  versionLog: [
    { at: '2026-06-01T00:00:00.000Z', kind: 'config-change', detail: 'INTEL_CONFIG weights ratified (Option B)' },
    { at: '2026-05-01T00:00:00.000Z', kind: 'inputs-version', detail: 'New P&L import batch (32 files)' },
  ],
  advisoryOnly: true,
};

function seededClient(report: BrainReport): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(BRAIN_KEYS.report, report);
  return qc;
}

function renderModule(report: BrainReport) {
  return render(
    <QueryClientProvider client={seededClient(report)}>
      <CommandBrainModule />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 500 })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CommandBrainModule — KPI row renders exactly from the mocked report', () => {
  it('shows overallHitRate, its CI, watchedSignals, recalibrations, and resolvedTotal verbatim', () => {
    renderModule(POPULATED_REPORT);
    expect(screen.getByText('72%')).toBeTruthy();
    expect(screen.getByText(/95% CI 55–85%/)).toBeTruthy();
    expect(screen.getByText('Signals Watched')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('Recalibrations')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText(/distinct scoring-config versions/)).toBeTruthy();
    expect(screen.getByText('Resolved Outcomes')).toBeTruthy();
    expect(screen.getByText('18')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/NaN/);
  });
});

describe('CommandBrainModule — accuracy sparkline gaps', () => {
  it('a null-hitRate month splits the series into 2 segments, excluding the null (never coerced to 0)', () => {
    const segments = accuracySegments(POPULATED_REPORT.accuracySeries);
    expect(segments).toEqual([[0.6, 0.8], [0.5, 0.9]]);
    expect(segments.flat()).not.toContain(0);
  });

  it('an all-null series yields zero segments (the honest "no scoreable months" case)', () => {
    const allNull = [
      { month: '2026-01', resolvedN: 1, scoreableN: 1, hitRate: null },
      { month: '2026-02', resolvedN: 2, scoreableN: 2, hitRate: null },
    ];
    expect(accuracySegments(allNull)).toEqual([]);
  });

  it('renders the "no scoreable months yet" copy when every month is a gap', () => {
    const report: BrainReport = {
      ...POPULATED_REPORT,
      accuracySeries: [
        { month: '2026-01', resolvedN: 1, scoreableN: 1, hitRate: null },
      ],
    };
    renderModule(report);
    expect(screen.getByText(/no scoreable months yet/i)).toBeTruthy();
  });
});

describe('TrackRecordList — outcome badges', () => {
  it('renders hit/miss/not-scoreable badges only — the word "partial" never appears', () => {
    render(<TrackRecordList entries={POPULATED_REPORT.trackRecord} />);
    expect(screen.getByText('Hit')).toBeTruthy();
    expect(screen.getByText('Miss')).toBeTruthy();
    expect(screen.getByText('Not scoreable')).toBeTruthy();
    expect(document.body.textContent?.toLowerCase()).not.toContain('partial');
  });

  it('formats a predicted/realized numeric value when no band is present, never a fabricated number', () => {
    render(<TrackRecordList entries={POPULATED_REPORT.trackRecord} />);
    expect(screen.getByText('0.15')).toBeTruthy();
    expect(screen.getByText('-0.02')).toBeTruthy();
  });

  it('shows the exact honest empty-state copy when there are no resolved verdicts', () => {
    render(<TrackRecordList entries={[]} />);
    expect(
      screen.getByText('No resolved verdicts yet — first outcomes accumulate as acquisitions/allocations/appeals resolve'),
    ).toBeTruthy();
    expect(document.body.textContent?.toLowerCase()).not.toContain('partial');
  });
});

describe('MemoryBoard — coverageConfidence bucketing', () => {
  it('buckets rows into well-covered (>=0.7) / building-coverage (0.4-0.7) / sparse (<0.4)', () => {
    expect(confidenceTier(0.85)).toBe('well-covered');
    expect(confidenceTier(0.7)).toBe('well-covered');
    expect(confidenceTier(0.5)).toBe('building-coverage');
    expect(confidenceTier(0.4)).toBe('building-coverage');
    expect(confidenceTier(0.39)).toBe('sparse');
    expect(confidenceTier(0.2)).toBe('sparse');
  });

  it('buildMemoryTiers places the fixture rows in the correct tiers with basisNote captions preserved', () => {
    const tiers = buildMemoryTiers(POPULATED_REPORT.confidenceByMarket, POPULATED_REPORT.confidenceByManager);
    const wellCovered = tiers.find((t) => t.key === 'well-covered')!;
    const building = tiers.find((t) => t.key === 'building-coverage')!;
    const sparse = tiers.find((t) => t.key === 'sparse')!;
    expect(wellCovered.items.map((i) => i.title)).toEqual(['DC Metro — 85%']);
    expect(building.items.map((i) => i.title)).toEqual(['Baltimore — 50%']);
    expect(sparse.items.map((i) => i.title)).toEqual(['PM Alpha — 20%']);
    for (const tier of tiers) {
      for (const item of tier.items) {
        expect(item.detail).toContain('coverage-based, not predictive skill');
      }
    }
  });

  it('renders the honesty caption and TierBoard cards for a populated confidence set', () => {
    render(
      <MemoryBoard confidenceByMarket={POPULATED_REPORT.confidenceByMarket} confidenceByManager={POPULATED_REPORT.confidenceByManager} />,
    );
    expect(screen.getByText(/not a measure of/i)).toBeTruthy();
    expect(screen.getByText('DC Metro — 85%')).toBeTruthy();
    expect(screen.getAllByText(/coverage-based, not predictive skill/).length).toBeGreaterThan(0);
  });

  it('renders TierBoard\'s own empty-tier state ("Clear") for all 3 tiers when both confidence arrays are empty', () => {
    render(<MemoryBoard confidenceByMarket={[]} confidenceByManager={[]} />);
    expect(screen.getAllByText('Clear')).toHaveLength(3);
  });
});

describe('CommandBrainModule — fully empty report renders honest empty states, not zeros-that-look-like-data', () => {
  it('shows dash/explanatory KPI, and an explicit empty message in every section', () => {
    renderModule(EMPTY_REPORT);

    // Flag Accuracy: dash + explanatory caption (never "0%").
    const dashNodes = screen.getAllByText('—');
    expect(dashNodes.length).toBeGreaterThan(0);
    expect(screen.getByText(/too few to compute a rate/i)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/0\.00\s*%/);
    expect(document.body.textContent).not.toMatch(/NaN/);

    // Every section's honest empty state.
    expect(screen.getByText(/no scoreable months yet/i)).toBeTruthy();
    expect(
      screen.getByText('No resolved verdicts yet — first outcomes accumulate as acquisitions/allocations/appeals resolve'),
    ).toBeTruthy();
    expect(screen.getByText('No open questions to act on right now.')).toBeTruthy();
    expect(screen.getByText('No open questions right now.')).toBeTruthy();
    expect(screen.getByText('No scoring-config changes recorded yet.')).toBeTruthy();
    expect(screen.getAllByText('Clear')).toHaveLength(3);

    // The real zero counts (watchedSignals/recalibrations/resolvedTotal) are honest literal data,
    // not fabricated — but no 'partial' vocabulary should ever leak in, empty or not.
    expect(document.body.textContent?.toLowerCase()).not.toContain('partial');
  });
});

describe('CommandBrainModule — Feedback Accept/Dismiss', () => {
  it('Accept calls the mutation with the derived subjectKind/subjectId and decision="accept"', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (typeof url === 'string' && url.includes('/api/warehouse/brain/feedback')) {
          calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
          return new Response(
            JSON.stringify({ id: 'fb-1', subjectKind: 'insight', subjectId: 'oq-1', decision: 'accept', decidedAt: '2026-07-06T00:00:00.000Z', note: null }),
            { status: 200 },
          );
        }
        return new Response('{}', { status: 500 });
      }),
    );

    renderModule(POPULATED_REPORT);
    const dataQualityQuestion = POPULATED_REPORT.openQuestions[0]!;
    const expectedSubjectId = openQuestionSubjectId(dataQualityQuestion);
    const expectedSubjectKind = openQuestionSubjectKind(dataQualityQuestion.kind);
    expect(expectedSubjectKind).toBe('insight');

    const acceptButtons = screen.getAllByRole('button', { name: 'Accept' });
    fireEvent.click(acceptButtons[0]!);

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.body).toEqual({ subjectKind: expectedSubjectKind, subjectId: expectedSubjectId, decision: 'accept' });
  });

  it('Dismiss calls the mutation with decision="dismiss" for the second (dormant-generator) question', async () => {
    const calls: Array<{ body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (typeof url === 'string' && url.includes('/api/warehouse/brain/feedback')) {
          calls.push({ body: init?.body ? JSON.parse(String(init.body)) : null });
          return new Response(
            JSON.stringify({ id: 'fb-2', subjectKind: 'alert', subjectId: 'oq-2', decision: 'dismiss', decidedAt: '2026-07-06T00:00:00.000Z', note: null }),
            { status: 200 },
          );
        }
        return new Response('{}', { status: 500 });
      }),
    );

    renderModule(POPULATED_REPORT);
    const dormantQuestion = POPULATED_REPORT.openQuestions[1]!;
    const expectedSubjectId = openQuestionSubjectId(dormantQuestion);
    const expectedSubjectKind = openQuestionSubjectKind(dormantQuestion.kind);
    expect(expectedSubjectKind).toBe('alert');

    const dismissButtons = screen.getAllByRole('button', { name: 'Dismiss' });
    fireEvent.click(dismissButtons[1]!);

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.body).toEqual({ subjectKind: expectedSubjectKind, subjectId: expectedSubjectId, decision: 'dismiss' });
  });
});

describe('openQuestionSubjectId — stability', () => {
  it('is stable for the same (kind,title,detail) and distinct across different questions', () => {
    const a = openQuestionSubjectId(POPULATED_REPORT.openQuestions[0]!);
    const b = openQuestionSubjectId({ ...POPULATED_REPORT.openQuestions[0]! });
    const c = openQuestionSubjectId(POPULATED_REPORT.openQuestions[1]!);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

