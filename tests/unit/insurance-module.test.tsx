import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { InsuranceAnalysisReport, PolicyEconomics } from '../../src/contracts/insurance-analysis';
import type { InsurancePolicy } from '../../src/contracts/insurance';
import { InsuranceModule } from '../../src/modules/insurance/InsuranceModule';
import { SavingsBoard } from '../../src/modules/insurance/SavingsBoard';
import {
  INSURANCE_ANALYSIS_KEY,
  buildSavingsTiers,
  computeInsuranceKpis,
  sumPremiumAboveMedian,
  countRenewalsWithin90,
  benchmarkSublabel,
  fmtRatePer100,
} from '../../src/modules/insurance/hooks';

afterEach(() => cleanup());

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

function seededClient(report: InsuranceAnalysisReport, policies: InsurancePolicy[] = []): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  qc.setQueryData(INSURANCE_ANALYSIS_KEY, report);
  qc.setQueryData(['snapshot'], { snapshot: { insurance: policies }, state: {} } as never);
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

describe('SavingsBoard tiers', () => {
  it('groups rebid candidates and renewal-watch policies into exactly two tiers, never fabricating a third', () => {
    render(
      <QueryClientProvider client={seededClient(sufficientReport())}>
        <SavingsBoard />
      </QueryClientProvider>,
    );
    const board = screen.getByRole('list', { name: 'Tier board' });
    expect(board.children).toHaveLength(2);
    expect(screen.getByText('Re-bid — above book median')).toBeTruthy();
    expect(screen.getByText('Renewal watch')).toBeTruthy();
    expect(screen.queryByText(/optimize coverage/i)).toBeNull();
    expect(screen.queryByText(/retain risk/i)).toBeNull();
    expect(screen.queryByText(/self-insur/i)).toBeNull();
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
