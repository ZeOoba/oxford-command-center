import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { InsuranceAnalysisReport, PolicyEconomics } from '../../src/contracts/insurance-analysis';
import type { InsurancePolicy } from '../../src/contracts/insurance';
import type { InsuranceLossReport, PropertyEal, DeductibleReview, RebidPipelineItem } from '../../src/contracts/insurance-loss';
import { InsuranceModule } from '../../src/modules/insurance/InsuranceModule';
import { SavingsBoard } from '../../src/modules/insurance/SavingsBoard';
import { SelfInsureView } from '../../src/modules/insurance/SelfInsureView';
import {
  INSURANCE_ANALYSIS_KEY,
  INSURANCE_LOSS_KEY,
  buildSavingsTiers,
  buildOptimizeTier,
  isAnyPlaceholder,
  placeholderDetailInsurance,
  computeInsuranceKpis,
  sumPremiumAboveMedian,
  countRenewalsWithin90,
  benchmarkSublabel,
  fmtRatePer100,
} from '../../src/modules/insurance/hooks';

// Every test in this file renders at least InsuranceModule or SavingsBoard, both of which now
// call useInsuranceLoss() (P4c). Stub fetch to a deterministic 503-equivalent (also fails the
// /warehouse.json mirror probe) so that hook resolves to WarehouseUnavailableError unless a test
// explicitly seeds INSURANCE_LOSS_KEY via qc.setQueryData (cache hit — the queryFn never runs).
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function policy(overrides: Partial<PolicyEconomics> = {}): PolicyEconomics {
  return {
    policyId: 'p1',
    property: 'Test Property',
    propertyId: 'prop-1',
    carrier: 'Acme Insurance',
    policyType: 'Property Package',
    premium: 50_000,
    tiv: 10_000_000,
    ratePer100Tiv: 0.5,
    cohort: 'property-package',
    excessPremiumVsMedian: 5_000,
    renewalBucket: 'later',
    daysToExpiry: 200,
    ...overrides,
  };
}

const rebidOne = policy({ policyId: 'r1', property: 'Rebid One', excessPremiumVsMedian: 12_000, renewalBucket: 'later', daysToExpiry: 200 });
const rebidTwo = policy({ policyId: 'r2', property: 'Rebid Two', excessPremiumVsMedian: 4_000, renewalBucket: 'now-45', daysToExpiry: 30 });
const watchOnly = policy({ policyId: 'w1', property: 'Watch Only', excessPremiumVsMedian: null, renewalBucket: 'soon-90', daysToExpiry: 60, cohort: 'other', ratePer100Tiv: null });
const laterPolicy = policy({ policyId: 'l1', property: 'Later Policy', excessPremiumVsMedian: null, renewalBucket: 'later', daysToExpiry: 300, cohort: 'other', ratePer100Tiv: null });

function sufficientReport(): InsuranceAnalysisReport {
  const all = [rebidOne, rebidTwo, watchOnly, laterPolicy];
  return {
    asOf: '2026-07-06',
    premiumAnnualTotal: all.reduce((s, p) => s + p.premium, 0),
    policiesN: all.length,
    tivKnownN: all.length,
    benchmark: {
      cohort: 'property-package',
      medianRatePer100Tiv: 0.45,
      cohortN: 12,
      sufficient: true,
      basisNote: 'own-book median — dispersion, not market rate',
    },
    rebidCandidates: [rebidOne, rebidTwo],
    renewalCalendar: [rebidTwo, watchOnly, rebidOne, laterPolicy],
    advisoryOnly: true,
  };
}

function insufficientReport(): InsuranceAnalysisReport {
  return {
    asOf: '2026-07-06',
    premiumAnnualTotal: 90_000,
    policiesN: 3,
    tivKnownN: 3,
    benchmark: {
      cohort: 'property-package',
      medianRatePer100Tiv: null,
      cohortN: 3,
      sufficient: false,
      basisNote: 'own-book median — dispersion, not market rate',
    },
    rebidCandidates: [],
    renewalCalendar: [policy({ policyId: 'x1', renewalBucket: 'now-45', daysToExpiry: 10, excessPremiumVsMedian: null, cohort: 'other', ratePer100Tiv: null })],
    advisoryOnly: true,
  };
}

function propertyEal(overrides: Partial<PropertyEal> = {}): PropertyEal {
  return {
    propertyId: 'prop-1',
    property: 'Test Property',
    eventsN: 4,
    grossIncurredTotal: 120_000,
    observationYears: 5,
    ealAnnual: 24_000,
    indeterminate: false,
    prov: { source: 'placeholder fixture', confidence: 'estimated' },
    ...overrides,
  };
}

function deductibleReview(overrides: Partial<DeductibleReview> = {}): DeductibleReview {
  return {
    policyId: 'pol-1',
    property: 'Test Property',
    propertyId: 'prop-1',
    deductible: 25_000,
    coverageLimit: 5_000_000,
    decSource: 'warehouse',
    eventsN: 4,
    lossesBelowDeductible: 3,
    lossesAboveDeductible: 1,
    retainedUsd: 75_000,
    transferredUsd: 45_000,
    overLimitUsd: 0,
    lossRatio: 1.5,
    prov: { source: 'placeholder fixture', confidence: 'estimated' },
    ...overrides,
  };
}

function rebidPipelineItem(overrides: Partial<RebidPipelineItem> = {}): RebidPipelineItem {
  return {
    policyId: 'pol-1',
    property: 'Test Property',
    stage: 'watch',
    excessPremiumVsMedian: 4_000,
    renewalBucket: 'later',
    reason: 'Above book median',
    ...overrides,
  };
}

function lossReport(overrides: Partial<InsuranceLossReport> = {}): InsuranceLossReport {
  return {
    asOf: '2026-07-06',
    lossDataSource: 'warehouse',
    decPageDataSource: 'warehouse',
    droppedFixtureRows: 0,
    eal: [propertyEal()],
    deductibleReviews: [deductibleReview()],
    selfInsure: {
      retainedUsd: 75_000,
      transferredUsd: 45_000,
      overLimitUsd: 0,
      premiumAnnualTotal: 50_000,
      portfolioEalAnnual: 24_000,
      observationYears: 5,
    },
    rebidPipeline: [rebidPipelineItem()],
    basisNote: 'Arithmetic roll-up of observed loss runs vs stated deductible/limit.',
    advisoryOnly: true,
    ...overrides,
  };
}

function insurancePolicy(overrides: Partial<InsurancePolicy> = {}): InsurancePolicy {
  return {
    id: 'ins-1',
    property: 'Registry Property LLC',
    entity: null,
    coverage: 'All Risk',
    effective: '2026-01-01',
    expires: '2026-12-31',
    policyNo: 'POL-100',
    carrier: 'Acme Insurance',
    premium: 42_000,
    daysToExpiry: 178,
    status: 'Current',
    notes: null,
    flags: [],
    tiv: 8_000_000,
    deductible: 25_000,
    coverageLimit: 8_000_000,
    ...overrides,
  };
}

function seededClient(
  report: InsuranceAnalysisReport,
  policies: InsurancePolicy[] = [],
  loss?: InsuranceLossReport,
): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  qc.setQueryData(INSURANCE_ANALYSIS_KEY, report);
  qc.setQueryData(['snapshot'], { snapshot: { insurance: policies }, state: {} } as never);
  if (loss) qc.setQueryData(INSURANCE_LOSS_KEY, loss);
  return qc;
}

/** KpiStat renders label then value as adjacent sibling divs — scope value assertions to the
 *  specific KPI card instead of a bare getByText that could collide with a tier-count pill
 *  elsewhere on the page. */
function kpiValueFor(label: string): string {
  const labelEl = screen.getByText(label);
  return labelEl.nextElementSibling?.textContent ?? '';
}

function kpiSublabelFor(label: string): string {
  const labelEl = screen.getByText(label);
  return labelEl.nextElementSibling?.nextElementSibling?.textContent ?? '';
}

describe('InsuranceModule KPIs', () => {
  it('renders real numbers computed from the mocked analysis report', () => {
    render(
      <QueryClientProvider client={seededClient(sufficientReport())}>
        <InsuranceModule />
      </QueryClientProvider>,
    );
    expect(kpiValueFor('Annual Premium')).toBe('$200K');
    expect(kpiValueFor('Rate vs Benchmark')).toBe('$0.45');
    expect(kpiValueFor('Premium Above Median')).toBe('$16K');
    expect(kpiValueFor('Renewals ≤90d')).toBe('2');
  });

  it('shows an insufficient-cohort state instead of a numeric benchmark when benchmark.sufficient is false', () => {
    render(
      <QueryClientProvider client={seededClient(insufficientReport())}>
        <InsuranceModule />
      </QueryClientProvider>,
    );
    expect(kpiValueFor('Rate vs Benchmark')).toBe('—');
    expect(kpiSublabelFor('Rate vs Benchmark')).toMatch(/insufficient cohort — n=3/);
  });
});

describe('InsuranceModule tabs', () => {
  it('renders three tab pills including Self-Insure & Bids', () => {
    render(
      <QueryClientProvider client={seededClient(sufficientReport())}>
        <InsuranceModule />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Savings Board')).toBeTruthy();
    expect(screen.getByText('Policy Register')).toBeTruthy();
    expect(screen.getByText('Self-Insure & Bids')).toBeTruthy();
  });

  it('renders SelfInsureView content when the Self-Insure & Bids tab is selected', () => {
    render(
      <QueryClientProvider client={seededClient(sufficientReport(), [], lossReport())}>
        <InsuranceModule />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText('Self-Insure & Bids'));
    expect(screen.getByText('Expected Annual Loss by Property')).toBeTruthy();
  });
});

describe('SavingsBoard tiers', () => {
  it('groups rebid candidates and renewal-watch policies into exactly two tiers when the loss report is unavailable, never fabricating a third', () => {
    render(
      <QueryClientProvider client={seededClient(sufficientReport())}>
        <SavingsBoard />
      </QueryClientProvider>,
    );
    const board = screen.getByRole('list', { name: 'Tier board' });
    expect(board.children).toHaveLength(2);
    expect(board.className).toContain('grid-cols-2');
    expect(screen.getByText('Re-bid — above book median')).toBeTruthy();
    expect(screen.getByText('Renewal watch')).toBeTruthy();
    expect(screen.queryByText(/optimize coverage/i)).toBeNull();
    expect(screen.queryByText(/retain risk/i)).toBeNull();
    expect(screen.queryByText(/self-insur/i)).toBeNull();
  });

  it('renders the Optimize Coverage tier as a third column when the loss report resolves', () => {
    render(
      <QueryClientProvider client={seededClient(sufficientReport(), [], lossReport())}>
        <SavingsBoard />
      </QueryClientProvider>,
    );
    const board = screen.getByRole('list', { name: 'Tier board' });
    expect(board.children).toHaveLength(3);
    expect(board.className).toContain('grid-cols-3');
    expect(screen.getByText('Optimize Coverage')).toBeTruthy();
  });

  it('never fabricates the Optimize Coverage tier when the loss hook errors with WarehouseUnavailableError', async () => {
    render(
      <QueryClientProvider client={seededClient(sufficientReport())}>
        <SavingsBoard />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      const board = screen.getByRole('list', { name: 'Tier board' });
      expect(board.children).toHaveLength(2);
    });
    expect(screen.queryByText('Optimize Coverage')).toBeNull();
  });

  it('dedupes a rebid candidate out of renewal watch even when it falls within the 90-day window', () => {
    render(
      <QueryClientProvider client={seededClient(sufficientReport())}>
        <SavingsBoard />
      </QueryClientProvider>,
    );
    expect(screen.getAllByText('Rebid Two')).toHaveLength(1);
    expect(screen.getByText('Watch Only')).toBeTruthy();
  });

  it('shows the insufficient-cohort badge and an empty rebid tier when the cohort is too small', () => {
    render(
      <QueryClientProvider client={seededClient(insufficientReport())}>
        <SavingsBoard />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/insufficient cohort — n=3/)).toBeTruthy();
    expect(screen.getByText('own-book median — dispersion, not market rate')).toBeTruthy();
  });
});

describe('UI copy doctrine — never "savings" for excessPremiumVsMedian', () => {
  it('SavingsBoard never uses the word "savings" anywhere in its own copy', () => {
    const { container } = render(
      <QueryClientProvider client={seededClient(sufficientReport())}>
        <SavingsBoard />
      </QueryClientProvider>,
    );
    expect((container.textContent ?? '').toLowerCase()).not.toContain('saving');
  });

  it('labels the KPI "Premium Above Median" — not "Savings" or "Identified Savings"', () => {
    render(
      <QueryClientProvider client={seededClient(sufficientReport())}>
        <InsuranceModule />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Premium Above Median')).toBeTruthy();
    expect(screen.queryByText(/identified savings/i)).toBeNull();
  });

  it('rebid tier cards read "premium above book median", never "savings"', () => {
    render(
      <QueryClientProvider client={seededClient(sufficientReport())}>
        <SavingsBoard />
      </QueryClientProvider>,
    );
    expect(screen.getAllByText('premium above book median').length).toBeGreaterThan(0);
  });
});

describe('Policy Register tab', () => {
  it('still renders the pre-existing policy table content after switching tabs', () => {
    render(
      <QueryClientProvider
        client={seededClient(sufficientReport(), [
          insurancePolicy(),
          insurancePolicy({ id: 'ins-2', property: 'Second Property LLC', premium: 15_000, status: 'Renew Now', daysToExpiry: 20 }),
        ])}
      >
        <InsuranceModule />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByText('Policy Register'));

    expect(screen.getByText('Policy Tracker')).toBeTruthy();
    expect(screen.getByText('2 policies')).toBeTruthy();
    expect(screen.getByText('Registry Property LLC')).toBeTruthy();
    expect(screen.getByText('Second Property LLC')).toBeTruthy();
    expect(screen.getByText('Current')).toBeTruthy();
    expect(screen.getByText('Renew Now')).toBeTruthy();
  });

  it('defaults to the Savings Board tab on first render', () => {
    render(
      <QueryClientProvider client={seededClient(sufficientReport(), [insurancePolicy()])}>
        <InsuranceModule />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Re-bid — above book median')).toBeTruthy();
    expect(screen.queryByText('Policy Tracker')).toBeNull();
  });
});

describe('SelfInsureView', () => {
  it('shows a role=status PlaceholderBanner and the EAL table when the report is placeholder-sourced', () => {
    render(
      <QueryClientProvider
        client={seededClient(sufficientReport(), [], lossReport({ lossDataSource: 'placeholder' }))}
      >
        <SelfInsureView />
      </QueryClientProvider>,
    );
    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('PLACEHOLDER DATA');
    expect(screen.getByText('Expected Annual Loss by Property')).toBeTruthy();
  });

  it('shows no PlaceholderBanner when both loss and dec-page data are warehouse-sourced', () => {
    render(
      <QueryClientProvider
        client={seededClient(
          sufficientReport(),
          [],
          lossReport({ lossDataSource: 'warehouse', decPageDataSource: 'warehouse' }),
        )}
      >
        <SelfInsureView />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText('Expected Annual Loss by Property')).toBeTruthy();
  });

  it('renders the deductible review table and the re-bid pipeline tiers', () => {
    render(
      <QueryClientProvider client={seededClient(sufficientReport(), [], lossReport())}>
        <SelfInsureView />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Deductible Review')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Tier board' }).children).toHaveLength(3);
  });

  it('renders the offline card when the loss report is unavailable (WarehouseUnavailableError), never crashing', async () => {
    // useInsuranceLoss hard-codes retry:1 via QUERY_OPTS (a per-query option, which always wins
    // over the QueryClient's own defaultOptions) — the default 1s retry backoff means the error
    // state can take a little over 1s to settle, hence the extended waitFor timeout below.
    const qc = new QueryClient({ defaultOptions: { queries: {} } });
    render(
      <QueryClientProvider client={qc}>
        <SelfInsureView />
      </QueryClientProvider>,
    );
    await waitFor(
      () => {
        expect(screen.getByText('offline')).toBeTruthy();
      },
      { timeout: 3000 },
    );
    expect(screen.getByText(/Loss reasoning requires the live brain server/)).toBeTruthy();
  });
});

describe('insurance hooks — pure helpers', () => {
  it('computeInsuranceKpis returns an all-null shape while the report is unavailable', () => {
    const k = computeInsuranceKpis(undefined);
    expect(k.premiumAnnualTotal).toBeNull();
    expect(k.medianRatePer100Tiv).toBeNull();
    expect(k.premiumAboveMedian).toBeNull();
    expect(k.renewalsWithin90).toBeNull();
  });

  it('computeInsuranceKpis derives every KPI from a loaded report', () => {
    const k = computeInsuranceKpis(sufficientReport());
    expect(k.premiumAnnualTotal).toBe(200_000);
    expect(k.medianRatePer100Tiv).toBe(0.45);
    expect(k.premiumAboveMedian).toBe(16_000);
    expect(k.renewalsWithin90).toBe(2);
  });

  it('sumPremiumAboveMedian sums only positive excess, guarding against a negative/null value', () => {
    expect(sumPremiumAboveMedian([rebidOne, rebidTwo])).toBe(16_000);
    expect(sumPremiumAboveMedian([policy({ excessPremiumVsMedian: null })])).toBe(0);
    expect(sumPremiumAboveMedian([])).toBe(0);
  });

  it('countRenewalsWithin90 counts only now-45 and soon-90 buckets', () => {
    expect(countRenewalsWithin90([rebidOne, rebidTwo, watchOnly, laterPolicy])).toBe(2);
    expect(countRenewalsWithin90([])).toBe(0);
  });

  it('benchmarkSublabel reports the cohort size in both the sufficient and insufficient cases', () => {
    expect(benchmarkSublabel({ cohort: 'property-package', medianRatePer100Tiv: 0.5, cohortN: 8, sufficient: true, basisNote: 'x' })).toBe('n=8 policies');
    expect(benchmarkSublabel({ cohort: 'property-package', medianRatePer100Tiv: null, cohortN: 2, sufficient: false, basisNote: 'x' })).toBe('insufficient cohort — n=2');
  });

  it('fmtRatePer100 formats a rate as a small dollar figure and dashes on null', () => {
    expect(fmtRatePer100(0.45)).toBe('$0.45');
    expect(fmtRatePer100(null)).toBe('—');
  });

  it('buildSavingsTiers never returns more than two tiers', () => {
    const tiers = buildSavingsTiers(sufficientReport());
    expect(tiers).toHaveLength(2);
    expect(tiers.map((t) => t.key)).toEqual(['rebid', 'renewal-watch']);
    expect(tiers[0]?.items.map((i) => i.id)).toEqual(['r1', 'r2']);
    expect(tiers[1]?.items.map((i) => i.id)).toEqual(['w1']);
  });
});

describe('insurance loss hooks — pure helpers (P4c)', () => {
  it('isAnyPlaceholder is true when either lossDataSource or decPageDataSource is placeholder', () => {
    expect(isAnyPlaceholder(lossReport({ lossDataSource: 'placeholder' }))).toBe(true);
    expect(isAnyPlaceholder(lossReport({ decPageDataSource: 'placeholder' }))).toBe(true);
    expect(
      isAnyPlaceholder(lossReport({ lossDataSource: 'warehouse', decPageDataSource: 'warehouse' })),
    ).toBe(false);
  });

  it('placeholderDetailInsurance always includes the fixed advisory sentence', () => {
    expect(placeholderDetailInsurance(lossReport())).toContain(
      'No figure on this tab is decision-grade.',
    );
  });

  it('placeholderDetailInsurance notes dropped fixture rows when present', () => {
    const detail = placeholderDetailInsurance(lossReport({ droppedFixtureRows: 2 }));
    expect(detail).toContain('2 fixture rows dropped');
  });

  it('buildOptimizeTier builds a Tier keyed "optimize" titled "Optimize Coverage" toned "accent", ranked by retainedUsd desc', () => {
    const report = lossReport({
      deductibleReviews: [
        deductibleReview({ policyId: 'a', property: 'A', retainedUsd: 10_000 }),
        deductibleReview({ policyId: 'b', property: 'B', retainedUsd: 50_000 }),
      ],
    });
    const tier = buildOptimizeTier(report);
    expect(tier.key).toBe('optimize');
    expect(tier.title).toBe('Optimize Coverage');
    expect(tier.tone).toBe('accent');
    expect(tier.items.map((i) => i.id)).toEqual(['b', 'a']);
    expect(tier.items.every((i) => i.impactUsd === null)).toBe(true);
  });

  it('buildOptimizeTier chips include PLACEHOLDER when the report is placeholder-sourced, absent otherwise', () => {
    const placeholderTier = buildOptimizeTier(lossReport({ lossDataSource: 'placeholder' }));
    expect(placeholderTier.items[0]?.chips).toContain('PLACEHOLDER');

    const warehouseTier = buildOptimizeTier(
      lossReport({ lossDataSource: 'warehouse', decPageDataSource: 'warehouse' }),
    );
    expect(warehouseTier.items[0]?.chips).toBeUndefined();
  });
});
