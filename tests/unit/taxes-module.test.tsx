// tests/unit/taxes-module.test.tsx
//
// Phase 6 — Taxes module (UX Agent build). Covers:
//   1. Pure KPI/aggregation helpers in src/modules/taxes/hooks.ts — especially that
//      "Identified Opportunity" sums ONLY Oxford-share, ONLY determinate 'appeal' opportunities
//      (never savingsFullAsset, never 'assessment-watch', never a null-savings appeal).
//   2. StrategyBoard renders exactly two TierBoard tiers (Appeals + Assessment Watch) plus the
//      honest deferred-scope Card WHEN no strategy report (or an 'absent'-sourced one) is passed
//      — it never fabricates a cost-seg/depreciation/entity-structuring tier out of thin air.
//      When a present (placeholder- or warehouse-sourced) strategyReport prop IS passed (P4c /
//      C2, Task 10), a third "Depreciation & Cost-Seg" tier + a qualitative entity-strategies
//      Card render INSTEAD of the deferred card — see the "cost-seg tier" describe block below.
//   3. Indeterminate opportunities render "—" for impact, never a computed-looking $0.
//   4. AssessmentsTable's File Appeal flow calls useFileAppeal's mutation with the correct
//      TaxAppealInput-shaped payload.
//   5. FiledReturnsTable (P4c / C2, Task 10) — metadata-only filed-return catalog. Shows a
//      role=status PLACEHOLDER METADATA banner and repeats the C2 confidentiality-boundary
//      sentence below the table; never a column for return contents (the contract has none).
//   6. TaxesModule now threads a SECOND hook — useTaxStrategy() — down as props (RESOLVED
//      data-flow: TaxesModule owns both queries, StrategyBoard/FiledReturnsTable stay prop-only,
//      matching the existing useTaxAnalysis()-at-the-module-level pattern exactly). Renders
//      THREE tab pills now, including "Filed Returns".
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
  buildCostSegTier,
  placeholderDetailTax,
  TAX_KEYS,
  TAX_STRATEGY_KEY,
} from '../../src/modules/taxes/hooks';
import type {
  TaxOpportunity,
  TaxAssessment,
  TaxAppeal,
  TaxAppealStatus,
  TaxAnalysisReport,
  TaxStrategyReport,
  CostSegOpportunity,
  EntityStrategyItem,
  FiledReturnMeta,
} from '../../src/modules/taxes/hooks';
import { StrategyBoard } from '../../src/modules/taxes/StrategyBoard';
import { AssessmentsTable } from '../../src/modules/taxes/AssessmentsTable';
import { FiledReturnsTable } from '../../src/modules/taxes/FiledReturnsTable';
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

// ── Tax STRATEGY fixture builders (P4c / C2 — Task 10) ──────────────────────────────────────

function makeCostSegOpportunity(
  partial: Partial<CostSegOpportunity> & Pick<CostSegOpportunity, 'propertyId'>,
): CostSegOpportunity {
  return {
    propertyName: null,
    depreciableBasis: 1_000_000,
    landAllocationPct: 0.2,
    reclassifiablePct: 0.3,
    reclassifiableBasis: 240_000,
    bonusYearPct: 0.6,
    firstYearAccelerationUsd: 144_000,
    firstYearAccelerationOxfordShare: 72_000,
    savingsFullAsset: null,
    savingsOxfordShare: null,
    indeterminate: false,
    basisNote: 'Deduction-timing basis note.',
    prov: { source: 'test', confidence: 'estimated' },
    ...partial,
  };
}

function makeEntityStrategyItem(
  partial: Partial<EntityStrategyItem> & Pick<EntityStrategyItem, 'id' | 'kind'>,
): EntityStrategyItem {
  return {
    title: 'Strategy title',
    detail: 'Strategy detail.',
    applicabilityNote:
      'Qualitative placeholder — review with accountant; no dollar impact is computed by design.',
    ...partial,
  };
}

function makeFiledReturnMeta(
  partial: Partial<FiledReturnMeta> & Pick<FiledReturnMeta, 'id'>,
): FiledReturnMeta {
  return {
    taxYear: 2025,
    entity: 'PLACEHOLDER — Entity A LLC',
    preparer: 'PLACEHOLDER CPA',
    status: 'filed',
    storageNote: 'Contents in SharePoint — metadata only by design',
    ...partial,
  };
}

function makeStrategyReport(partial: Partial<TaxStrategyReport> = {}): TaxStrategyReport {
  return {
    asOf: '2026-07-06',
    basisDataSource: 'placeholder',
    filedReturnsDataSource: 'placeholder',
    droppedFixtureRows: 0,
    scheduleNote: 'Placeholder bonus-depreciation schedule.',
    costSeg: [makeCostSegOpportunity({ propertyId: 'p1', propertyName: 'Prop One' })],
    entityStrategies: [
      makeEntityStrategyItem({ id: 'es-entity-review', kind: 'entity-structure', title: 'Holding-entity structure review' }),
      makeEntityStrategyItem({ id: 'es-sec469-grouping', kind: 'sec469', title: 'Section 469 passive-activity grouping election' }),
      makeEntityStrategyItem({ id: 'es-pipeline-1031', kind: 'pipeline', title: 'Acquisition-pipeline 1031 planning' }),
    ],
    filedReturns: [makeFiledReturnMeta({ id: 'PLR-2024-A' })],
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

// ── StrategyBoard — third "Depreciation & Cost-Seg" tier (P4c / C2, Task 10) ────────────────
//
// Driven by an OPTIONAL strategyReport prop (RESOLVED data-flow: TaxesModule calls both
// useTaxAnalysis() and useTaxStrategy() and threads both reports down as props — StrategyBoard
// itself calls no hook). Absent/undefined or an 'absent'-sourced report falls back to exactly the
// pre-existing two-tier + deferred-card behavior proven above; a placeholder- or
// warehouse-sourced report renders a third tier + a qualitative entity-strategies Card instead.

describe('StrategyBoard — cost-seg tier (P4c / C2)', () => {
  const opportunities: TaxOpportunity[] = [
    makeOpportunity({ propertyId: 'appeal-det', kind: 'appeal', propertyName: 'Appeal Co', savingsOxfordShare: 5_000 }),
  ];

  it('renders the "Depreciation & Cost-Seg" third tier and NOT the deferred card when a placeholder-sourced strategy report is passed', () => {
    render(<StrategyBoard opportunities={opportunities} strategyReport={makeStrategyReport()} />);
    const board = screen.getByRole('list', { name: /tier board/i });
    const tierColumns = board.querySelectorAll(':scope > [role="listitem"]');
    expect(tierColumns).toHaveLength(3);
    expect(board.className).toContain('grid-cols-3');
    expect(screen.getByText('Depreciation & Cost-Seg')).toBeTruthy();
    expect(screen.queryByText(/deferred pending that data source/i)).toBeNull();
  });

  it('renders the entity-strategies "Structure & Pipeline — qualitative" Card listing all three items alongside the third tier', () => {
    render(<StrategyBoard opportunities={opportunities} strategyReport={makeStrategyReport()} />);
    expect(screen.getByText('Structure & Pipeline — qualitative')).toBeTruthy();
    expect(screen.getByText('Holding-entity structure review')).toBeTruthy();
    expect(screen.getByText('Section 469 passive-activity grouping election')).toBeTruthy();
    expect(screen.getByText('Acquisition-pipeline 1031 planning')).toBeTruthy();
  });

  it('renders the deferred card and no third tier when strategyReport is undefined (pre-existing behavior)', () => {
    render(<StrategyBoard opportunities={opportunities} />);
    const board = screen.getByRole('list', { name: /tier board/i });
    const tierColumns = board.querySelectorAll(':scope > [role="listitem"]');
    expect(tierColumns).toHaveLength(2);
    expect(screen.queryByText('Depreciation & Cost-Seg')).toBeNull();
    expect(screen.getByText(/deferred pending that data source/i)).toBeTruthy();
  });

  it('renders the deferred card and no third tier when strategyReport.basisDataSource is "absent"', () => {
    render(
      <StrategyBoard
        opportunities={opportunities}
        strategyReport={makeStrategyReport({ basisDataSource: 'absent', costSeg: [] })}
      />,
    );
    const board = screen.getByRole('list', { name: /tier board/i });
    const tierColumns = board.querySelectorAll(':scope > [role="listitem"]');
    expect(tierColumns).toHaveLength(2);
    expect(screen.queryByText('Depreciation & Cost-Seg')).toBeNull();
    expect(screen.getByText(/deferred pending that data source/i)).toBeTruthy();
  });

  it('cost-seg tier item detail language is deduction-acceleration / not-tax-savings, never a bare dollar-savings claim', () => {
    render(<StrategyBoard opportunities={opportunities} strategyReport={makeStrategyReport()} />);
    const card = screen.getByText('Prop One').closest('li')!;
    expect(card.textContent).toMatch(/not tax savings|deduction acceleration/i);
    expect(card.textContent).not.toMatch(/\$[\d,.]+[KMB]?\s*(in\s+)?savings/i);
  });
});

describe('tax strategy hooks — pure helpers (P4c / C2, Task 10)', () => {
  it('buildCostSegTier returns key "costseg", title "Depreciation & Cost-Seg", tone "accent"', () => {
    const tier = buildCostSegTier(makeStrategyReport());
    expect(tier.key).toBe('costseg');
    expect(tier.title).toBe('Depreciation & Cost-Seg');
    expect(tier.tone).toBe('accent');
  });

  it('maps impactUsd to firstYearAccelerationOxfordShare, null-safe', () => {
    const tier = buildCostSegTier(
      makeStrategyReport({
        costSeg: [
          makeCostSegOpportunity({ propertyId: 'p1', firstYearAccelerationOxfordShare: 50_000 }),
          makeCostSegOpportunity({
            propertyId: 'p2',
            firstYearAccelerationOxfordShare: null,
            firstYearAccelerationUsd: null,
            bonusYearPct: null,
            indeterminate: true,
          }),
        ],
      }),
    );
    expect(tier.items.find((i) => i.id === 'p1')?.impactUsd).toBe(50_000);
    expect(tier.items.find((i) => i.id === 'p2')?.impactUsd).toBeNull();
    expect(tier.items.every((i) => i.impactKind === 'info')).toBe(true);
  });

  it('chips include PLACEHOLDER only when basisDataSource is "placeholder"', () => {
    const placeholderTier = buildCostSegTier(makeStrategyReport({ basisDataSource: 'placeholder' }));
    expect(placeholderTier.items[0]?.chips).toContain('PLACEHOLDER');

    const warehouseTier = buildCostSegTier(makeStrategyReport({ basisDataSource: 'warehouse' }));
    expect(warehouseTier.items[0]?.chips).toBeUndefined();
  });

  it('every cost-seg tier item detail says "not tax savings" / "deduction acceleration"', () => {
    const tier = buildCostSegTier(
      makeStrategyReport({
        costSeg: [
          makeCostSegOpportunity({ propertyId: 'p1' }),
          makeCostSegOpportunity({ propertyId: 'p2', propertyName: 'Prop Two' }),
        ],
      }),
    );
    for (const item of tier.items) {
      expect(item.detail).toMatch(/not tax savings|deduction acceleration/i);
    }
  });

  it('placeholderDetailTax always includes the fixed confidentiality-boundary sentence', () => {
    expect(placeholderDetailTax(makeStrategyReport())).toContain(
      'Return contents never enter this system',
    );
  });

  it('placeholderDetailTax notes dropped fixture rows when present', () => {
    const detail = placeholderDetailTax(makeStrategyReport({ droppedFixtureRows: 3 }));
    expect(detail).toContain('3 fixture rows dropped');
  });
});

// ── FiledReturnsTable (P4c / C2, Task 10) — metadata-only filed-return catalog ──────────────

describe('FiledReturnsTable (P4c / C2)', () => {
  it('shows a role=status PLACEHOLDER METADATA banner and a PLACEHOLDER entity row', () => {
    render(<FiledReturnsTable report={makeStrategyReport()} />);
    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('PLACEHOLDER METADATA');
    expect(screen.getByText('PLACEHOLDER — Entity A LLC')).toBeTruthy();
  });

  it('renders Tax Year / Entity / Preparer / Status / Storage columns with a status badge per lifecycle', () => {
    render(
      <FiledReturnsTable
        report={makeStrategyReport({
          filedReturns: [
            makeFiledReturnMeta({ id: 'r1', taxYear: 2024, status: 'filed' }),
            makeFiledReturnMeta({ id: 'r2', taxYear: 2025, status: 'extended' }),
            makeFiledReturnMeta({ id: 'r3', taxYear: 2026, status: 'amended' }),
          ],
        })}
      />,
    );
    expect(screen.getByText('filed')).toBeTruthy();
    expect(screen.getByText('extended')).toBeTruthy();
    expect(screen.getByText('amended')).toBeTruthy();
    expect(screen.getAllByText('Contents in SharePoint — metadata only by design').length).toBe(3);
  });

  it('repeats the C2 confidentiality boundary sentence below the table', () => {
    render(<FiledReturnsTable report={makeStrategyReport()} />);
    expect(
      screen.getAllByText(/metadata and SharePoint link-out only, by confidentiality design/i).length,
    ).toBeGreaterThan(0);
  });

  it('never renders a column for return contents (metadata-only, by contract)', () => {
    const { container } = render(<FiledReturnsTable report={makeStrategyReport()} />);
    expect((container.textContent ?? '').toLowerCase()).not.toContain('return contents:');
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

// ── TaxesModule tabs (P4c / C2, Task 10) — three pills, Filed Returns wired to useTaxStrategy ──

describe('TaxesModule tabs (P4c / C2)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders three tab pills including "Filed Returns"', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));

    const qc = seededClient();
    qc.setQueryData(TAX_KEYS.analysis, makeReport());

    render(
      <QueryClientProvider client={qc}>
        <TaxesModule />
      </QueryClientProvider>,
    );

    expect(screen.getByText('Strategy Board')).toBeTruthy();
    expect(screen.getByText('Assessments & Appeals')).toBeTruthy();
    expect(screen.getByText('Filed Returns')).toBeTruthy();
  });

  it('renders FiledReturnsTable content when the Filed Returns tab is selected and useTaxStrategy resolves', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));

    const qc = seededClient();
    qc.setQueryData(TAX_KEYS.analysis, makeReport());
    qc.setQueryData(TAX_STRATEGY_KEY, makeStrategyReport());

    render(
      <QueryClientProvider client={qc}>
        <TaxesModule />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByText('Filed Returns'));
    expect(screen.getByText('PLACEHOLDER — Entity A LLC')).toBeTruthy();
  });

  it('renders the Depreciation & Cost-Seg tier on the Strategy Board tab once useTaxStrategy resolves', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));

    const qc = seededClient();
    qc.setQueryData(TAX_KEYS.analysis, makeReport());
    qc.setQueryData(TAX_STRATEGY_KEY, makeStrategyReport());

    render(
      <QueryClientProvider client={qc}>
        <TaxesModule />
      </QueryClientProvider>,
    );

    expect(screen.getByText('Depreciation & Cost-Seg')).toBeTruthy();
  });
});
