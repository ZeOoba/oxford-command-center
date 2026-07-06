// tests/unit/taxes-module.test.tsx
//
// Phase 6 — Taxes module (UX Agent build). Covers:
//   1. Pure KPI/aggregation helpers in src/modules/taxes/hooks.ts — especially that
//      "Identified Opportunity" sums ONLY Oxford-share, ONLY determinate 'appeal' opportunities
//      (never savingsFullAsset, never 'assessment-watch', never a null-savings appeal).
//   2. StrategyBoard never renders a fabricated cost-seg/depreciation/entity-structuring tier —
//      exactly two TierBoard tiers, plus the honest deferred-scope Card.
//   3. Indeterminate opportunities render "—" for impact, never a computed-looking $0.
//   4. AssessmentsTable's File Appeal flow calls useFileAppeal's mutation with the correct
//      TaxAppealInput-shaped payload.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  sumIdentifiedOpportunityUsd,
  computePortfolioEffectiveRate,
  countAppealsInFlight,
  isAppealInFlight,
  appealStatusTone,
  opportunityByProperty,
  appealsByProperty,
  TAX_KEYS,
} from '../../src/modules/taxes/hooks';
import type {
  TaxOpportunity,
  TaxAssessment,
  TaxAppeal,
  TaxAppealStatus,
  TaxAnalysisReport,
} from '../../src/modules/taxes/hooks';
import { StrategyBoard } from '../../src/modules/taxes/StrategyBoard';
import { AssessmentsTable } from '../../src/modules/taxes/AssessmentsTable';
import { TaxesModule } from '../../src/modules/taxes/TaxesModule';

// ── Fixture builders ─────────────────────────────────────────────────────────────────────────

function makeOpportunity(
  partial: Partial<TaxOpportunity> & Pick<TaxOpportunity, 'propertyId' | 'kind'>,
): TaxOpportunity {
  return {
    propertyName: null,
    title: 'Tax opportunity',
    detail: 'detail',
    savingsFullAsset: null,
    savingsOxfordShare: null,
    basisNote: 'Full-asset assessment basis; Oxford share = full-asset savings × ownership %.',
    effectiveRate: null,
    cohortPercentile: null,
    indeterminate: false,
    prov: { source: 'test', confidence: 'derived' },
    advisoryOnly: true,
    ...partial,
  };
}

function makeAssessment(
  partial: Partial<TaxAssessment> & Pick<TaxAssessment, 'propertyId' | 'taxYear'>,
): TaxAssessment {
  return {
    jurisdiction: null,
    assessedValue: null,
    assessmentRatio: null,
    millageRate: null,
    annualTaxBilled: null,
    source: 'test',
    asOf: null,
    ...partial,
  };
}

function makeAppeal(
  partial: Partial<TaxAppeal> & Pick<TaxAppeal, 'id' | 'propertyId' | 'taxYear' | 'status'>,
): TaxAppeal {
  return {
    filedDate: null,
    estSavingsAnnual: null,
    realizedSavingsAnnual: null,
    notes: null,
    ...partial,
  };
}

function makeReport(partial: Partial<TaxAnalysisReport> = {}): TaxAnalysisReport {
  return {
    asOf: '2026-07-06',
    propertiesCovered: 0,
    propertiesIndeterminate: 0,
    ledgerTaxAnnualUsd: null,
    opportunities: [],
    assessments: [],
    appeals: [],
    advisoryOnly: true,
    ...partial,
  };
}

// ── 1. Pure helpers ──────────────────────────────────────────────────────────────────────────

describe('sumIdentifiedOpportunityUsd', () => {
  it('sums ONLY savingsOxfordShare on determinate appeal-kind opportunities', () => {
    const opportunities: TaxOpportunity[] = [
      // Included: determinate appeal with an Oxford-share figure.
      makeOpportunity({ propertyId: 'p1', kind: 'appeal', indeterminate: false, savingsOxfordShare: 5_000, savingsFullAsset: 8_000 }),
      // Excluded: indeterminate appeal (missing valuation inputs) — must not contribute a guess.
      makeOpportunity({ propertyId: 'p2', kind: 'appeal', indeterminate: true, savingsOxfordShare: null, savingsFullAsset: null }),
      // Excluded: determinate appeal but Oxford ownership % itself unavailable → savingsOxfordShare null.
      makeOpportunity({ propertyId: 'p3', kind: 'appeal', indeterminate: false, savingsOxfordShare: null, savingsFullAsset: 12_000 }),
      // Excluded: assessment-watch kind, even though it carries a real savings figure.
      makeOpportunity({ propertyId: 'p4', kind: 'assessment-watch', indeterminate: false, savingsOxfordShare: 3_000, savingsFullAsset: 4_800 }),
      // Included: a second determinate appeal.
      makeOpportunity({ propertyId: 'p5', kind: 'appeal', indeterminate: false, savingsOxfordShare: 1_250 }),
    ];

    expect(sumIdentifiedOpportunityUsd(opportunities)).toBe(6_250);
  });

  it('returns 0 (not null) when there are no determinate appeal opportunities', () => {
    const opportunities: TaxOpportunity[] = [
      makeOpportunity({ propertyId: 'p1', kind: 'assessment-watch' }),
      makeOpportunity({ propertyId: 'p2', kind: 'appeal', indeterminate: true }),
    ];
    expect(sumIdentifiedOpportunityUsd(opportunities)).toBe(0);
  });

  it('never uses savingsFullAsset even when savingsOxfordShare is present and smaller', () => {
    const opportunities: TaxOpportunity[] = [
      makeOpportunity({ propertyId: 'p1', kind: 'appeal', indeterminate: false, savingsFullAsset: 100_000, savingsOxfordShare: 62_500 }),
    ];
    expect(sumIdentifiedOpportunityUsd(opportunities)).toBe(62_500);
  });
});

describe('computePortfolioEffectiveRate', () => {
  it('computes a weighted rate across assessments carrying both fields', () => {
    const assessments: TaxAssessment[] = [
      makeAssessment({ propertyId: 'p1', taxYear: 2026, annualTaxBilled: 10_000, assessedValue: 500_000 }),
      makeAssessment({ propertyId: 'p2', taxYear: 2026, annualTaxBilled: 20_000, assessedValue: 1_000_000 }),
      // Missing assessedValue — excluded from both sums, must not skew the weighted rate.
      makeAssessment({ propertyId: 'p3', taxYear: 2026, annualTaxBilled: 999_999, assessedValue: null }),
    ];
    expect(computePortfolioEffectiveRate(assessments)).toBeCloseTo(0.02, 6);
  });

  it('returns null when no assessment carries both fields', () => {
    const assessments: TaxAssessment[] = [
      makeAssessment({ propertyId: 'p1', taxYear: 2026, annualTaxBilled: null, assessedValue: 500_000 }),
      makeAssessment({ propertyId: 'p2', taxYear: 2026, annualTaxBilled: 10_000, assessedValue: null }),
    ];
    expect(computePortfolioEffectiveRate(assessments)).toBeNull();
  });

  it('returns null for an empty assessments list', () => {
    expect(computePortfolioEffectiveRate([])).toBeNull();
  });
});

describe('appeals-in-flight helpers', () => {
  it('isAppealInFlight is false only for won/lost/withdrawn', () => {
    const closed: TaxAppealStatus[] = ['won', 'lost', 'withdrawn'];
    const open: TaxAppealStatus[] = ['draft', 'filed', 'hearing'];
    for (const s of closed) expect(isAppealInFlight(s)).toBe(false);
    for (const s of open) expect(isAppealInFlight(s)).toBe(true);
  });

  it('countAppealsInFlight excludes won/lost/withdrawn', () => {
    const appeals: TaxAppeal[] = [
      makeAppeal({ id: 'a1', propertyId: 'p1', taxYear: 2026, status: 'draft' }),
      makeAppeal({ id: 'a2', propertyId: 'p1', taxYear: 2025, status: 'filed' }),
      makeAppeal({ id: 'a3', propertyId: 'p2', taxYear: 2026, status: 'won' }),
      makeAppeal({ id: 'a4', propertyId: 'p2', taxYear: 2025, status: 'lost' }),
      makeAppeal({ id: 'a5', propertyId: 'p3', taxYear: 2026, status: 'withdrawn' }),
      makeAppeal({ id: 'a6', propertyId: 'p3', taxYear: 2025, status: 'hearing' }),
    ];
    expect(countAppealsInFlight(appeals)).toBe(3); // draft, filed, hearing
  });
});

describe('appealStatusTone', () => {
  it('maps every status to the correct badge tone', () => {
    expect(appealStatusTone('draft')).toBe('neutral');
    expect(appealStatusTone('filed')).toBe('blue');
    expect(appealStatusTone('hearing')).toBe('blue');
    expect(appealStatusTone('won')).toBe('green');
    expect(appealStatusTone('lost')).toBe('red');
    expect(appealStatusTone('withdrawn')).toBe('red');
  });
});

describe('opportunityByProperty / appealsByProperty', () => {
  it('opportunityByProperty keys by propertyId', () => {
    const map = opportunityByProperty([
      makeOpportunity({ propertyId: 'p1', kind: 'appeal', propertyName: 'One' }),
      makeOpportunity({ propertyId: 'p2', kind: 'assessment-watch', propertyName: 'Two' }),
    ]);
    expect(map.get('p1')?.propertyName).toBe('One');
    expect(map.get('p2')?.propertyName).toBe('Two');
    expect(map.get('p3')).toBeUndefined();
  });

  it('appealsByProperty groups multiple appeals under one property', () => {
    const map = appealsByProperty([
      makeAppeal({ id: 'a1', propertyId: 'p1', taxYear: 2025, status: 'lost' }),
      makeAppeal({ id: 'a2', propertyId: 'p1', taxYear: 2026, status: 'draft' }),
      makeAppeal({ id: 'a3', propertyId: 'p2', taxYear: 2026, status: 'filed' }),
    ]);
    expect(map.get('p1')).toHaveLength(2);
    expect(map.get('p2')).toHaveLength(1);
    expect(map.get('p3')).toBeUndefined();
  });
});

// ── 2 + 3. StrategyBoard ─────────────────────────────────────────────────────────────────────

afterEach(() => cleanup());

describe('StrategyBoard', () => {
  const opportunities: TaxOpportunity[] = [
    makeOpportunity({
      propertyId: 'appeal-det', kind: 'appeal', propertyName: 'Determinate Appeal Co',
      indeterminate: false, savingsOxfordShare: 5_000, savingsFullAsset: 8_000,
      effectiveRate: 0.021, cohortPercentile: 0.82,
    }),
    makeOpportunity({
      propertyId: 'watch-indet', kind: 'assessment-watch', propertyName: 'Indeterminate Watch Co',
      indeterminate: true, savingsOxfordShare: null, savingsFullAsset: null,
    }),
    makeOpportunity({
      propertyId: 'watch-det', kind: 'assessment-watch', propertyName: 'Determinate Watch Co',
      indeterminate: false, savingsOxfordShare: 1_200,
    }),
  ];

  it('renders exactly two TierBoard tiers (Appeals + Assessment Watch) — no fabricated third tier', () => {
    render(<StrategyBoard opportunities={opportunities} />);
    // TierBoard's own <li> items (one per opportunity card) also carry role="listitem", so scope
    // to DIRECT children of the "Tier board" list — those are exactly the tier columns themselves.
    const board = screen.getByRole('list', { name: /tier board/i });
    const tierColumns = board.querySelectorAll(':scope > [role="listitem"]');
    expect(tierColumns).toHaveLength(2);
  });

  it('renders the honest deferred-scope card instead of fake cost-seg/depreciation strategy cards', () => {
    render(<StrategyBoard opportunities={opportunities} />);
    expect(screen.getByText(/deferred pending that data source/i)).toBeTruthy();
    expect(screen.getByText(/depreciable-basis and/i)).toBeTruthy();
  });

  it('shows the determinate appeal Oxford-share figure, never the full-asset one', () => {
    render(<StrategyBoard opportunities={opportunities} />);
    const card = screen.getByText('Determinate Appeal Co').closest('li')!;
    expect(card.textContent).toMatch(/\$5(\.0)?K/); // savingsOxfordShare (5,000) compact-formatted
    expect(card.textContent).not.toMatch(/\$8K/); // never savingsFullAsset (8,000)
  });

  it('renders "—" for an indeterminate watch item, never a computed-looking $0', () => {
    render(<StrategyBoard opportunities={opportunities} />);
    const card = screen.getByText('Indeterminate Watch Co').closest('li')!;
    expect(card.textContent).toContain('—');
    expect(card.textContent).not.toMatch(/\$0(\.00)?(?!\d)/);
  });
});

// ── 4. AssessmentsTable — File Appeal flow ──────────────────────────────────────────────────

function seededClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
}

describe('AssessmentsTable — File Appeal flow', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string, _opts?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/api/warehouse/tax/appeals')) {
        return new Response(
          JSON.stringify({
            id: 'new-appeal-id',
            propertyId: 'prop-a',
            taxYear: 2026,
            status: 'draft',
            filedDate: null,
            estSavingsAnnual: 4000,
            realizedSavingsAnnual: null,
            notes: null,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function report(): TaxAnalysisReport {
    return makeReport({
      opportunities: [
        makeOpportunity({
          propertyId: 'prop-a', kind: 'appeal', propertyName: 'Prop A Building',
          indeterminate: false, savingsOxfordShare: 4_000, savingsFullAsset: 6_400,
        }),
      ],
      assessments: [
        makeAssessment({
          propertyId: 'prop-a', taxYear: 2026, jurisdiction: 'Franklin County',
          assessedValue: 500_000, assessmentRatio: 0.35, millageRate: 32.5, annualTaxBilled: 10_000,
        }),
      ],
      appeals: [],
    });
  }

  it('opens the inline form pre-filled with the row tax year and status draft', () => {
    render(
      <QueryClientProvider client={seededClient()}>
        <AssessmentsTable report={report()} />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /file appeal for prop a building/i }));

    expect(screen.getByText(/file appeal — prop a building/i)).toBeTruthy();
    expect((screen.getByLabelText(/tax year/i) as HTMLInputElement).value).toBe('2026');
    expect((screen.getByLabelText(/appeal status/i) as HTMLSelectElement).value).toBe('draft');
  });

  it('calls the mutation with the correct TaxAppealInput-shaped payload on submit', async () => {
    render(
      <QueryClientProvider client={seededClient()}>
        <AssessmentsTable report={report()} />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /file appeal for prop a building/i }));
    fireEvent.click(screen.getByRole('button', { name: /submit appeal/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/warehouse/tax/appeals'));
    expect(call).toBeDefined();
    const [url, opts] = call!;
    expect(url).toBe('/api/warehouse/tax/appeals');
    expect(opts!.method).toBe('POST');
    const body = JSON.parse(opts!.body as string);
    expect(body).toEqual({
      propertyId: 'prop-a',
      taxYear: 2026,
      status: 'draft',
      filedDate: null,
      estSavingsAnnual: 4000, // pre-filled from the opportunity's savingsOxfordShare (rounded)
      realizedSavingsAnnual: null,
      notes: null,
    });
  });

  it('closes the form after a successful submit', async () => {
    render(
      <QueryClientProvider client={seededClient()}>
        <AssessmentsTable report={report()} />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /file appeal for prop a building/i }));
    fireEvent.click(screen.getByRole('button', { name: /submit appeal/i }));

    await waitFor(() => {
      expect(screen.queryByText(/file appeal — prop a building/i)).toBeNull();
    });
  });
});

// ── TaxesModule — KPI rendering from a seeded report ────────────────────────────────────────

describe('TaxesModule KPIs', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the Identified Opportunity KPI as the Oxford-share sum of determinate appeals only', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));

    const qc = seededClient();
    qc.setQueryData(TAX_KEYS.analysis, makeReport({
      ledgerTaxAnnualUsd: 250_000,
      opportunities: [
        makeOpportunity({ propertyId: 'p1', kind: 'appeal', indeterminate: false, savingsOxfordShare: 5_000, savingsFullAsset: 8_000 }),
        makeOpportunity({ propertyId: 'p2', kind: 'appeal', indeterminate: true, savingsOxfordShare: null }),
        makeOpportunity({ propertyId: 'p3', kind: 'assessment-watch', savingsOxfordShare: 9_000 }),
      ],
      assessments: [],
      appeals: [
        makeAppeal({ id: 'a1', propertyId: 'p1', taxYear: 2026, status: 'draft' }),
        makeAppeal({ id: 'a2', propertyId: 'p1', taxYear: 2025, status: 'won' }),
      ],
    }));

    render(
      <QueryClientProvider client={qc}>
        <TaxesModule />
      </QueryClientProvider>,
    );

    expect(screen.getByText('Identified Opportunity')).toBeTruthy();
    const kpiCard = screen.getByText('Identified Opportunity').closest('div')!.parentElement!;
    expect(kpiCard.textContent).toMatch(/\$5(\.0)?K/);
    expect(kpiCard.textContent).not.toMatch(/\$8K/); // never the full-asset figure
    expect(kpiCard.textContent).not.toMatch(/\$9K/); // never the watch-kind figure

    // Appeals in Flight: only the 'draft' appeal is in flight (the 'won' one is closed).
    expect(screen.getByText('Appeals in Flight')).toBeTruthy();
  });

  it('shows "varies by property" for the Effective Rate KPI when no assessment has both fields', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));

    const qc = seededClient();
    qc.setQueryData(TAX_KEYS.analysis, makeReport({
      assessments: [
        makeAssessment({ propertyId: 'p1', taxYear: 2026, annualTaxBilled: null, assessedValue: 500_000 }),
      ],
    }));

    render(
      <QueryClientProvider client={qc}>
        <TaxesModule />
      </QueryClientProvider>,
    );

    expect(screen.getByText(/varies by property/i)).toBeTruthy();
  });
});
