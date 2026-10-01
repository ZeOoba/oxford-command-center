// tests/unit/deal-drawer.test.tsx
//
// Render smoke for the DealDrawer's Underwriting panel (IMPLEMENTATION_PLAN task 7.4).
// Network is stubbed via vi.stubGlobal('fetch', ...) for the GET /acq/intel call the panel's score
// lookup makes via useAcqIntel() (grader-hooks.ts) — the same pattern tests/unit/grader-view.test.tsx
// already uses for PipelineTierBoard, which consumes the exact same hook/endpoint.
//
// Covers:
//   1. no AcquisitionInput for the deal → light empty state, no fabricated score.
//   2. an AcquisitionInput + a matched, scored RankedCandidate → input summary renders the exact
//      values from the shared fixture, and the score panel (gauge/tier/reasons) renders the exact
//      figures from the SAME AcquisitionScore fixture object PipelineTierBoard/RankedCandidateList
//      would render for that candidate — proving no client-side recomputation.
//   3. an AcquisitionInput but no persisted score yet (latestScore: null, or no candidate synced at
//      all) → input summary renders, but no score/gauge is fabricated.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AcquisitionInput, type AcquisitionScore, type AcqIntelResponse, type AcqCandidateRow, type RankedCandidate } from '@contracts/acquisition';
import type { Deal, PortfolioSnapshot } from '@contracts/index';
import { DealDrawer } from '../../src/brain/DealDrawer';

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────

function makeScore(overrides: Partial<AcquisitionScore> = {}): AcquisitionScore {
  return {
    schemaVersion: '1.0.0',
    inputsVersion: 'abc1234567890def',
    rulesetVersion: '1.1.0',
    ratification: 'ratified',
    scoredAt: '2026-06-14T00:00:00Z',
    dealId: 'd-scored',
    isVacant: false,
    gates: [{ id: 'product', passed: true, detail: 'shallow-bay-multi OK' }],
    gatesPassed: true,
    floors: [{ id: 'basis', passed: true, actual: 0.56, required: 0.25, detail: '56.0% vs 25% required' }],
    floorsPassed: true,
    floorIndeterminate: false,
    ddCriticalUnresolved: [],
    subScores: [
      { id: 'basis', points: 20, maxPoints: 25, normalized: 80, confidence: 'confirmed' },
      { id: 'asset', points: 15, maxPoints: 20, normalized: 75, confidence: 'confirmed' },
      { id: 'market', points: 9, maxPoints: 12, normalized: 75, confidence: 'estimated' },
      { id: 'risk', points: 8, maxPoints: 17, normalized: 47, confidence: 'estimated' },
    ],
    composite: 88,
    tier: 'T1',
    verdict: 'PURSUE',
    cappedAtT2: false,
    incompleteRuleset: false,
    advisoryOnly: false,
    confidence: 'estimated',
    reasons: ['Composite 88 of 100 clears the T1 pursue band', 'No DD critical items unresolved'],
    dataQuality: [],
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<AcqCandidateRow> & Pick<AcqCandidateRow, 'id'>): AcqCandidateRow {
  return {
    source: 'manual',
    sourceBatchId: null,
    address: '100 Fixture Ave',
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

function makeIntelResponse(rankedCandidates: RankedCandidate[]): AcqIntelResponse {
  return {
    rankedCandidates,
    calibrationSummary: { totalVerdicts: 0, resolvedVerdicts: 0, overallHitRate: null, wilsonLow: null, wilsonHigh: null },
    advisoryOnly: false,
    rulesetVersion: '1.1.0',
    asOf: '2026-06-14T00:00:00Z',
  };
}

// Deliberately distinct from every FIXTURE_INPUT/FIXTURE_SCORE value below (SF, price, hold years,
// etc.) — the Deal Detail / Returns / Underwriting Assumptions / Financing cards already render
// several deal-native fields with the same formatters (fmtUsdCompact, fmtSf, "N yr"), so overlapping
// numbers here would make the Underwriting-panel assertions ambiguous (multiple DOM matches).
function makeDeal(overrides: Partial<Deal> & Pick<Deal, 'id'>): Deal {
  return {
    name: 'Fixture Deal',
    shortName: null,
    location: 'Columbus, OH',
    market: 'Columbus OH',
    sf: 95_000,
    buildings: 1,
    stage: 'Candidate',
    estPrice: 3_100_000,
    capRate: 0.065,
    irr: 0.12,
    equityMultiple: 1.6,
    holdYrs: 7,
    lender: null,
    status: 'Active',
    nextAction: null,
    owner: null,
    targetCloseDate: null,
    confidential: false,
    notionDealId: null,
    estimatedFields: [],
    ...overrides,
  };
}

function makeSnapshot(deals: Deal[], acquisitionInputs: Record<string, AcquisitionInput>): PortfolioSnapshot {
  return {
    deals,
    dealComps: {},
    acquisitionInputs,
  } as unknown as PortfolioSnapshot;
}

function stubFetchWithIntel(response: AcqIntelResponse) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/acq/intel')) {
      return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 500 });
  }));
}

function renderDrawer(dealId: string, snapshot: PortfolioSnapshot) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DealDrawer
        dealId={dealId}
        snapshot={snapshot}
        canWrite={true}
        onClose={() => {}}
        onDraft={() => {}}
        onAdvanceStage={() => {}}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// ── Tests ────────────────────────────────────────────────────────────────────────────────

describe('DealDrawer — Underwriting panel', () => {
  beforeEach(() => {
    stubFetchWithIntel(makeIntelResponse([]));
  });

  it('renders the empty state when no AcquisitionInput exists for the deal', async () => {
    const deal = makeDeal({ id: 'd-none' });
    const snapshot = makeSnapshot([deal], {});

    renderDrawer('d-none', snapshot);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.getByText(/no underwriting input captured yet/i)).toBeTruthy();
    expect(screen.getByText(/grader tab/i)).toBeTruthy();

    // No fabricated score/gauge for an unscored, un-underwritten deal.
    expect(screen.queryAllByRole('img')).toHaveLength(0);
    expect(screen.queryByText('T1')).toBeNull();
    expect(screen.queryByText('PURSUE')).toBeNull();
  });
});

describe('DealDrawer — Underwriting panel with an input and a persisted score (parity fixture)', () => {
  // ONE shared fixture object, reused directly in both the render wiring and the assertions below —
  // this is what proves the rendered figures are not re-derived: the test never recomputes a score,
  // it only checks that the exact fields of FIXTURE_SCORE reached the screen unchanged.
  const FIXTURE_INPUT = AcquisitionInput.parse({
    dealId: 'd-scored',
    price: 2_500_000,
    totalSf: 120_000,
    clearHeightFt: 24,
    productType: 'shallow-bay-multi',
    allInBasis: 9_500_000,
    stabilizedYoc: 0.072,
    leveredIrr: 0.155,
    underwriteHorizonYrs: 5,
  });
  const FIXTURE_SCORE = makeScore();
  const FIXTURE_CANDIDATE: RankedCandidate = {
    candidate: makeCandidate({ id: 'c-scored', notionDealId: 'd-scored' }),
    latestScore: FIXTURE_SCORE,
    governorDscrCleared: true,
    governorLtvCleared: null,
    calibrationHitRate: null,
    scoredAt: '2026-06-14T00:00:00Z',
  };

  beforeEach(() => {
    stubFetchWithIntel(makeIntelResponse([FIXTURE_CANDIDATE]));
  });

  it('renders the input summary + the persisted score with figures identical to the fixture', async () => {
    const deal = makeDeal({ id: 'd-scored' });
    const snapshot = makeSnapshot([deal], { 'd-scored': FIXTURE_INPUT });

    renderDrawer('d-scored', snapshot);

    // Input summary — exact formatted values for the shared FIXTURE_INPUT.
    expect(await screen.findByText('$2.50M')).toBeTruthy(); // price
    expect(screen.getByText('120,000 SF')).toBeTruthy(); // totalSf
    expect(screen.getByText('24 ft')).toBeTruthy(); // clearHeightFt
    expect(screen.getByText('shallow-bay-multi')).toBeTruthy(); // productType
    expect(screen.getByText('$9.50M')).toBeTruthy(); // allInBasis
    expect(screen.getByText('7.2%')).toBeTruthy(); // stabilizedYoc
    expect(screen.getByText('15.5%')).toBeTruthy(); // leveredIrr
    expect(screen.getByText('5 yr')).toBeTruthy(); // underwriteHorizonYrs

    // Score — same numeric fields as FIXTURE_SCORE, not recomputed.
    await waitFor(() => expect(screen.getByText(String(Math.round(FIXTURE_SCORE.composite)))).toBeTruthy());
    expect(screen.getAllByText(FIXTURE_SCORE.tier).length).toBeGreaterThan(0);
    expect(screen.getByText(new RegExp(`${FIXTURE_SCORE.tier}.*${FIXTURE_SCORE.verdict}`))).toBeTruthy();
    for (const reason of FIXTURE_SCORE.reasons) {
      expect(screen.getByText(new RegExp(reason))).toBeTruthy();
    }
  });
});

describe('DealDrawer — Underwriting panel with an input but no persisted score yet', () => {
  it('does not fabricate a score when only an input exists (candidate unscored)', async () => {
    const input = AcquisitionInput.parse({ dealId: 'd-input-only', price: 1_000_000 });
    const unscoredCandidate: RankedCandidate = {
      candidate: makeCandidate({ id: 'c-unscored', notionDealId: 'd-input-only' }),
      latestScore: null,
      governorDscrCleared: null,
      governorLtvCleared: null,
      calibrationHitRate: null,
      scoredAt: null,
    };
    stubFetchWithIntel(makeIntelResponse([unscoredCandidate]));

    const deal = makeDeal({ id: 'd-input-only' });
    const snapshot = makeSnapshot([deal], { 'd-input-only': input });

    renderDrawer('d-input-only', snapshot);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(await screen.findByText(/not yet scored/i)).toBeTruthy();
    expect(screen.getByText('$1.00M')).toBeTruthy(); // input summary still renders

    // No gauge/tier/verdict — a score must never be fabricated from an input alone.
    expect(screen.queryAllByRole('img')).toHaveLength(0);
    expect(screen.queryByText('T1')).toBeNull();
    expect(screen.queryByText('T2')).toBeNull();
    expect(screen.queryByText('PASS')).toBeNull();
    expect(screen.queryByText('KILLED')).toBeNull();
  });

  it('does not fabricate a score when no candidate is synced to the deal at all', async () => {
    stubFetchWithIntel(makeIntelResponse([])); // no candidates synced to this deal

    const input = AcquisitionInput.parse({ dealId: 'd-no-candidate', price: 750_000 });
    const deal = makeDeal({ id: 'd-no-candidate' });
    const snapshot = makeSnapshot([deal], { 'd-no-candidate': input });

    renderDrawer('d-no-candidate', snapshot);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(await screen.findByText(/not yet scored/i)).toBeTruthy();
    expect(screen.queryAllByRole('img')).toHaveLength(0);
  });
});

// OI-354/356: the client drawer now prices every RCT market (was 4 of 10), and a PROXY market must carry the
// skill's DENOMINATOR-SENSITIVE / local-quote-pre-LOI warning instead of a bare green/red verdict.
describe('DealDrawer — Replacement Cost card (all RCT markets, proxy warning)', () => {
  beforeEach(() => {
    stubFetchWithIntel(makeIntelResponse([]));
  });

  it('prices a market the old 4-market client table could not (Cincinnati) and shows a verdict', async () => {
    const deal = makeDeal({ id: 'd-cin', market: 'Cincinnati OH', sf: 40_000, estPrice: 3_000_000 });
    renderDrawer('d-cin', makeSnapshot([deal], {}));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByText(/no RCT v03 row for this market/i)).toBeNull();
    expect(screen.getByText(/Clears basis floor|Fails basis floor/)).toBeTruthy();
    expect(screen.queryByText(/DENOMINATOR-SENSITIVE/)).toBeNull(); // Cincinnati is sourced, not a proxy
  });

  it('shows the DENOMINATOR-SENSITIVE / local-quote warning for a PROXY market (Madison)', async () => {
    const deal = makeDeal({ id: 'd-mad', market: 'Madison WI', sf: 40_000, estPrice: 3_000_000 });
    renderDrawer('d-mad', makeSnapshot([deal], {}));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.getByText(/DENOMINATOR-SENSITIVE/)).toBeTruthy();
    expect(screen.getByText(/insurance comp or GC quote is required before an LOI/i)).toBeTruthy();
  });

  it('still refuses to score an uncovered market (Toledo) rather than inventing a denominator', async () => {
    const deal = makeDeal({ id: 'd-tol', market: 'Toledo OH', sf: 40_000, estPrice: 3_000_000 });
    renderDrawer('d-tol', makeSnapshot([deal], {}));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.getByText(/no RCT v03 row for this market/i)).toBeTruthy();
  });
});
