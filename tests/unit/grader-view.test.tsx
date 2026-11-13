// tests/unit/grader-view.test.tsx
//
// Render smoke for the OM Grader (GraderView) and its pipeline board (PipelineTierBoard).
// Network is stubbed via vi.stubGlobal('fetch', ...) — the same pattern already used by
// tests/unit/acquisitions-module-live-pipeline.test.tsx — rather than vi.mock, since neither
// component accepts an injectable fetch/scorer prop.
//
// Covers:
//   1. manual-entry form → Grade → renders the returned score's gauge/tier/verdict.
//   2. gates/floors checklists render Pass/Fail/Indeterminate from mock score data.
//   3. NO letter grade (A-F) text anywhere in the rendered output.
//   4. the Buy Box panel renders the RATIFIED ruleset's real category names/points (imported
//      from the actual config JSON, not hardcoded copies in this test) and has no edit controls.
//   5. the pipeline board groups mock candidates into the correct 4 tiers by their persisted
//      `tier` field (never re-derived from composite).
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AcquisitionScore, AcqIntelResponse, AcqCandidateRow } from '@contracts/acquisition';
import ruleset from '../../config/acquisition-ruleset.v1.json';
import { GraderView } from '../../src/modules/acquisitions/GraderView';
import { PipelineTierBoard } from '../../src/modules/acquisitions/PipelineTierBoard';

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────

function makeScore(overrides: Partial<AcquisitionScore> = {}): AcquisitionScore {
  return {
    schemaVersion: '1.0.0',
    inputsVersion: 'abc1234567890def',
    rulesetVersion: '2.0.0',
    ratification: 'ratified',
    scoredAt: '2026-06-14T00:00:00Z',
    dealId: 'om-grader',
    isVacant: false,
    gates: [
      { id: 'product', passed: true, detail: 'shallow-bay-multi OK' },
      { id: 'flood', passed: false, detail: 'SFHA on pad' },
    ],
    gatesPassed: false,
    floors: [
      { id: 'basis', passed: true, actual: 0.56, required: 0.25, detail: '56.0% vs 25% required' },
      { id: 'irr', passed: false, actual: null, required: 0.15, detail: 'leveredIrr not provided' },
    ],
    floorsPassed: false,
    floorIndeterminate: true,
    ddCriticalUnresolved: ['roof'],
    subScores: [
      { id: 'basis', points: 20, maxPoints: 25, normalized: 80, confidence: 'confirmed' },
      { id: 'asset', points: 15, maxPoints: 20, normalized: 75, confidence: 'confirmed' },
      { id: 'market', points: 9, maxPoints: 12, normalized: 75, confidence: 'estimated' },
      { id: 'risk', points: 8, maxPoints: 17, normalized: 47, confidence: 'estimated' },
    ],
    composite: 82,
    tier: 'T1',
    verdict: 'PURSUE',
    cappedAtT2: false,
    incompleteRuleset: false,
    advisoryOnly: false,
    confidence: 'estimated',
    reasons: ['Composite 82/100 → T1.'],
    dataQuality: [],
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<AcqCandidateRow> & Pick<AcqCandidateRow, 'id' | 'address'>): AcqCandidateRow {
  return {
    source: 'manual',
    sourceBatchId: null,
    county: null,
    state: null,
    market: null,
    rentableSf: null,
    yearBuilt: null,
    ownerName: null,
    parcelScreenScore: null,
    status: 'active',
    notionDealId: null,
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function makeIntelResponse(): AcqIntelResponse {
  return {
    rankedCandidates: [
      {
        candidate: makeCandidate({ id: 'c-t1', address: '100 T1 Ave', market: 'established', notionDealId: 'deal-1' }),
        latestScore: makeScore({ tier: 'T1', verdict: 'PURSUE', composite: 88 }),
        governorDscrCleared: true,
        governorLtvCleared: null,
        calibrationHitRate: null,
        scoredAt: '2026-06-14T00:00:00Z',
      },
      {
        candidate: makeCandidate({ id: 'c-t2', address: '200 T2 Blvd', market: 'entry' }),
        latestScore: makeScore({ tier: 'T2', verdict: 'WATCH', composite: 70, cappedAtT2: true }),
        governorDscrCleared: true,
        governorLtvCleared: null,
        calibrationHitRate: null,
        scoredAt: '2026-06-14T00:00:00Z',
      },
      {
        candidate: makeCandidate({ id: 'c-pass', address: '300 Pass St', market: 'satellite' }),
        latestScore: makeScore({ tier: 'PASS', verdict: 'PASS', composite: 40 }),
        governorDscrCleared: false,
        governorLtvCleared: null,
        calibrationHitRate: null,
        scoredAt: '2026-06-14T00:00:00Z',
      },
      {
        candidate: makeCandidate({ id: 'c-killed', address: '400 Killed Rd', market: 'none' }),
        latestScore: makeScore({ tier: 'KILLED', verdict: 'KILLED', composite: 5 }),
        governorDscrCleared: false,
        governorLtvCleared: null,
        calibrationHitRate: null,
        scoredAt: '2026-06-14T00:00:00Z',
      },
      {
        // Not yet scored — must be omitted from all 4 tier columns.
        candidate: makeCandidate({ id: 'c-unscored', address: '500 Unscored Way' }),
        latestScore: null,
        governorDscrCleared: null,
        governorLtvCleared: null,
        calibrationHitRate: null,
        scoredAt: null,
      },
    ],
    calibrationSummary: { totalVerdicts: 4, resolvedVerdicts: 0, overallHitRate: null, wilsonLow: null, wilsonHigh: null },
    advisoryOnly: false,
    rulesetVersion: '2.0.0',
    asOf: '2026-06-14T00:00:00Z',
  };
}

function renderWithClient(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// ── GraderView ───────────────────────────────────────────────────────────────────────────

describe('GraderView', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/acquisition/score') && init?.method === 'POST') {
        return new Response(JSON.stringify({ score: makeScore() }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 500 });
    }));
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  });

  it('grades a manually-entered input and renders the returned gauge/tier/verdict', async () => {
    renderWithClient(<GraderView />);

    // Manual entry: type a price into the form (proves the controlled form → buildInput → POST path).
    const priceInput = screen.getByLabelText(/^Price$/i) as HTMLInputElement;
    fireEvent.change(priceInput, { target: { value: '2500000' } });

    fireEvent.click(screen.getByRole('button', { name: /^grade$/i }));

    await waitFor(() => expect(screen.getAllByText('PURSUE').length).toBeGreaterThan(0));
    expect(screen.getAllByText('T1').length).toBeGreaterThan(0);
    // Gauge center renders the rounded composite.
    expect(screen.getByText('82')).toBeTruthy();

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const call = (fetchMock.mock.calls as Array<[string, RequestInit]>).find(([u]) => u.includes('/acquisition/score'));
    const body = JSON.parse(call![1].body as string) as Record<string, unknown>;
    expect(body.price).toBe(2500000);
  });

  it('shows the engine PROXY / DENOMINATOR-SENSITIVE note beside the graded verdict', async () => {
    const proxyNote = "RCT row for 'Madison WI' is a [PROXY] from a neighbouring metro - DENOMINATOR-SENSITIVE: a local insurance comp or GC quote is required pre-LOI.";
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      score: makeScore({ dataQuality: [{ entity: 'x', field: 'replacementCost', issue: proxyNote, severity: 'warn' }] }),
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    renderWithClient(<GraderView />);
    fireEvent.click(screen.getByRole('button', { name: /^grade$/i }));
    await waitFor(() => expect(screen.getByText(new RegExp('DENOMINATOR-SENSITIVE'))).toBeTruthy());
  });

  it('renders gates and floors checklists as Pass/Fail/Indeterminate from the score', async () => {
    renderWithClient(<GraderView />);
    fireEvent.click(screen.getByRole('button', { name: /^grade$/i }));
    await waitFor(() => expect(screen.getAllByText('PURSUE').length).toBeGreaterThan(0));

    // Gates: product passed, flood failed.
    expect(screen.getByText('product')).toBeTruthy();
    expect(screen.getByText('flood')).toBeTruthy();
    // Floors: basis passed, irr indeterminate (actual === null). ('basis' also labels a sub-score bar.)
    expect(screen.getAllByText('basis').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('irr')).toBeTruthy();
    expect(screen.getAllByText('Pass').length).toBeGreaterThanOrEqual(2); // product gate + basis floor
    expect(screen.getAllByText('Fail').length).toBeGreaterThanOrEqual(1); // flood gate
    expect(screen.getAllByText('Indeterminate').length).toBeGreaterThanOrEqual(1); // irr floor
  });

  it('never renders a letter grade (A-F) anywhere in the output', async () => {
    const { container } = renderWithClient(<GraderView />);
    fireEvent.click(screen.getByRole('button', { name: /^grade$/i }));
    await waitFor(() => expect(screen.getAllByText('PURSUE').length).toBeGreaterThan(0));

    // No standalone letter-grade token (this repo's ratified scorecard has no A-F mapping —
    // the design-handoff Grader.html prototype's simulated letter grades are NOT ported here).
    const letterGradeNodes = Array.from(container.querySelectorAll('*')).filter(
      (el) => el.children.length === 0 && /^[ABCDF][+-]?$/.test(el.textContent?.trim() ?? ''),
    );
    expect(letterGradeNodes).toHaveLength(0);
    expect(container.textContent).not.toMatch(/grade[:\s]+[ABCDF][+-]?\b/i);
  });

  it('renders the ratified Buy Box read-only, sourced from the real config JSON, with no edit controls', () => {
    renderWithClient(<GraderView />);

    const buyBox = screen.getByTestId('buy-box-panel');
    const firstCategory = ruleset.scorecard[0]!;

    // Real values from config/acquisition-ruleset.v1.json — not hardcoded expectations.
    expect(within(buyBox).getByText(firstCategory.label)).toBeTruthy();
    expect(within(buyBox).getByText(new RegExp(`${firstCategory.points}\\s*pts`))).toBeTruthy();
    expect(within(buyBox).getByText(new RegExp(`ratified\\s+${ruleset.ratifiedDate}`))).toBeTruthy();

    // No edit surface — this is a read-only reference panel.
    expect(within(buyBox).queryAllByRole('textbox')).toHaveLength(0);
    expect(within(buyBox).queryAllByRole('combobox')).toHaveLength(0);
    expect(within(buyBox).queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(buyBox).queryAllByRole('button')).toHaveLength(0);
  });
});

// ── PipelineTierBoard ────────────────────────────────────────────────────────────────────

describe('PipelineTierBoard', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('/acq/intel')) {
        return new Response(JSON.stringify(makeIntelResponse()), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 500 });
    }));
  });

  it('groups candidates into the correct 4 tiers by their persisted tier field', async () => {
    renderWithClient(<PipelineTierBoard />);

    await waitFor(() => expect(screen.getByText('100 T1 Ave')).toBeTruthy());

    // Query direct children of the board (each a tier column) rather than getAllByRole('listitem'),
    // which would also match the nested <li> item cards inside each column's <ul>.
    const board = screen.getByRole('list', { name: /tier board/i });
    const columns = Array.from(board.children) as HTMLElement[];
    expect(columns).toHaveLength(4); // T1, T2, Pass, Killed — exactly 4 tiers

    const [t1, t2, pass, killed] = columns as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];

    expect(within(t1).getByText('100 T1 Ave')).toBeTruthy();
    expect(within(t1).queryByText('200 T2 Blvd')).toBeNull();

    expect(within(t2).getByText('200 T2 Blvd')).toBeTruthy();
    expect(within(t2).queryByText('100 T1 Ave')).toBeNull();

    expect(within(pass).getByText('300 Pass St')).toBeTruthy();
    expect(within(killed).getByText('400 Killed Rd')).toBeTruthy();

    // Unscored candidate (latestScore: null) has no tier to bucket into — omitted entirely.
    expect(screen.queryByText('500 Unscored Way')).toBeNull();
  });
});
