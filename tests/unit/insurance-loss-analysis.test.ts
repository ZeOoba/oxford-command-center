// @vitest-environment node
//
// tests/unit/insurance-loss-analysis.test.ts
//
// Phase 4c — Insurance LOSS reasoning layer: buildInsuranceLossReport().
// PURE function — no DB, no I/O, no mocking. Plain fixture objects satisfying the
// resolver-output + PolicyEconomics types (Task 2 / insurance-analysis contract).
// Every expected number is hand-computed in the comment above its assertion.
import { describe, expect, it } from 'vitest';
import { buildInsuranceLossReport, MIN_LOSS_YEARS, type LossAnalysisInputs } from '../../server/warehouse/insurance-loss-analysis';
import { InsuranceLossReport } from '../../src/contracts/insurance-loss';
import type { PolicyEconomics } from '../../src/contracts/insurance-analysis';
import type { DataSource, DecPageEntry, DecPagesResolved, LossEventRow, LossEventsResolved } from '../../server/warehouse/placeholder-data';

// ── fixture builders ────────────────────────────────────────────────────────────────────────

function mkPolicy(over: Partial<PolicyEconomics> & { policyId: string }): PolicyEconomics {
  return {
    property: 'Prop',
    propertyId: null,
    carrier: null,
    policyType: 'Commercial Property',
    premium: 10000,
    tiv: 1_000_000,
    ratePer100Tiv: null,
    cohort: 'property-package',
    excessPremiumVsMedian: null,
    renewalBucket: 'later',
    daysToExpiry: null,
    ...over,
  };
}

function mkEvent(id: string, propertyId: string, lossDate: string, grossIncurred: number): LossEventRow {
  return { id, propertyId, policyRef: null, lossDate, cause: null, grossIncurred, paid: null, reserve: null, source: 'loss-runs.placeholder.json' };
}

function lossEvents(rows: LossEventRow[], source: DataSource = 'placeholder', droppedRows = 0): LossEventsResolved {
  return { rows, source, droppedRows };
}

function dec(source: DataSource): DecPageEntry {
  return source === 'absent'
    ? { deductible: null, coverageLimit: null, source }
    : { deductible: 25000, coverageLimit: 2_000_000, source };
}

function decPagesOf(entries: Record<string, DecPageEntry>): DecPagesResolved {
  return { byPolicyId: new Map(Object.entries(entries)), anyPlaceholder: Object.values(entries).some((e) => e.source === 'placeholder') };
}

function inputs(over: Partial<LossAnalysisInputs>): LossAnalysisInputs {
  return {
    asOf: '2026-07-09',
    policies: [],
    decPages: { byPolicyId: new Map(), anyPlaceholder: false },
    lossEvents: { rows: [], source: 'placeholder', droppedRows: 0 },
    ...over,
  };
}

describe('buildInsuranceLossReport', () => {
  it('(a) EAL = ΣgrossIncurred ÷ distinct years when observationYears ≥ MIN_LOSS_YEARS', () => {
    // events: P1 2023-03 $18,000 + P1 2024-06 $42,000 (Σ = 60,000); P2 2025-09 $6,000
    // distinct calendar years = {2023, 2024, 2025} → observationYears = 3 (= MIN_LOSS_YEARS)
    // P1 EAL = 60,000 / 3 = 20,000 ; P2 EAL = 6,000 / 3 = 2,000
    // portfolioEalAnnual = 20,000 + 2,000 = 22,000
    const report = buildInsuranceLossReport(inputs({
      lossEvents: lossEvents([
        mkEvent('e1', 'P1', '2023-03-01', 18000),
        mkEvent('e2', 'P1', '2024-06-01', 42000),
        mkEvent('e3', 'P2', '2025-09-01', 6000),
      ]),
    }));
    expect(report.selfInsure.observationYears).toBe(3);
    // eal is sorted by grossIncurredTotal DESC → P1 (60,000) then P2 (6,000)
    expect(report.eal[0]).toMatchObject({ propertyId: 'P1', eventsN: 2, grossIncurredTotal: 60000, observationYears: 3, ealAnnual: 20000, indeterminate: false });
    expect(report.eal[1]).toMatchObject({ propertyId: 'P2', eventsN: 1, grossIncurredTotal: 6000, ealAnnual: 2000, indeterminate: false });
    expect(report.eal[0]!.prov.formula).toBe('Σ gross_incurred ÷ observed years');
    expect(report.eal[0]!.prov.confidence).toBe('estimated');
    expect(report.selfInsure.portfolioEalAnnual).toBe(22000);
  });

  it('(b) indeterminate when < MIN_LOSS_YEARS distinct years', () => {
    // events only span {2023, 2024} → observationYears = 2 < 3 → ealAnnual null, indeterminate true
    // grossIncurredTotal still totals (18,000 + 42,000 = 60,000); portfolioEalAnnual is null
    const report = buildInsuranceLossReport(inputs({
      lossEvents: lossEvents([
        mkEvent('e1', 'P1', '2023-03-01', 18000),
        mkEvent('e2', 'P1', '2024-06-01', 42000),
      ]),
    }));
    expect(report.selfInsure.observationYears).toBe(2);
    expect(report.eal[0]).toMatchObject({ propertyId: 'P1', grossIncurredTotal: 60000, observationYears: 2, ealAnnual: null, indeterminate: true });
    expect(report.selfInsure.portfolioEalAnnual).toBeNull();
  });

  it('(c) retained/transferred split: d=25k, L=2M, gross=42k → retained 25k, transferred 17k, overLimit 0', () => {
    // retained    = min(42,000, 25,000)                    = 25,000
    // transferred = max(0, min(42,000, 2,000,000) − 25,000) = 42,000 − 25,000 = 17,000
    // overLimit   = max(0, 42,000 − 2,000,000)             = 0
    // lossRatio   = 42,000 / 10,000 (premium)              = 4.2
    const report = buildInsuranceLossReport(inputs({
      policies: [mkPolicy({ policyId: '1', propertyId: 'P1', cohort: 'property-package', premium: 10000 })],
      decPages: decPagesOf({ '1': { deductible: 25000, coverageLimit: 2_000_000, source: 'warehouse' } }),
      lossEvents: lossEvents([mkEvent('e1', 'P1', '2024-01-01', 42000)]),
    }));
    const r = report.deductibleReviews[0]!;
    expect(r.retainedUsd).toBe(25000);
    expect(r.transferredUsd).toBe(17000);
    expect(r.overLimitUsd).toBe(0);
    expect(r.eventsN).toBe(1);
    expect(r.lossesBelowDeductible).toBe(0); // 42,000 > 25,000 → pierces the deductible
    expect(r.lossesAboveDeductible).toBe(1);
    expect(r.lossRatio).toBeCloseTo(4.2, 10);
    // selfInsure rolls up the single review
    expect(report.selfInsure.retainedUsd).toBe(25000);
    expect(report.selfInsure.transferredUsd).toBe(17000);
    expect(report.selfInsure.overLimitUsd).toBe(0);
  });

  it('(c2) selfInsure counts a multi-policy property ONCE via its primary policy — no double-count', () => {
    // Property P1 carries TWO property-package policies; the single event (gross 42,000) matches
    // both review rows (per-policy reviews legitimately overlap):
    //   policy '1': d=25,000, L=2M → retained min(42,000,25,000)=25,000; transferred 42,000−25,000=17,000
    //   policy '2': d=10,000, L=2M → retained min(42,000,10,000)=10,000; transferred 42,000−10,000=32,000
    // Primary = first by policyId ascending localeCompare → '1'.
    // selfInsure must equal the PRIMARY's single-count split: retained 25,000 / transferred 17,000
    // — NOT the Σ-over-reviews double-count (35,000 / 49,000).
    // premiumAnnualTotal = 10,000 + 8,000 = 18,000 (still Σ over ALL policies).
    const report = buildInsuranceLossReport(inputs({
      policies: [
        mkPolicy({ policyId: '1', propertyId: 'P1', cohort: 'property-package', premium: 10000 }),
        mkPolicy({ policyId: '2', propertyId: 'P1', cohort: 'property-package', premium: 8000 }),
      ],
      decPages: decPagesOf({
        '1': { deductible: 25000, coverageLimit: 2_000_000, source: 'warehouse' },
        '2': { deductible: 10000, coverageLimit: 2_000_000, source: 'warehouse' },
      }),
      lossEvents: lossEvents([mkEvent('e1', 'P1', '2024-01-01', 42000)]),
    }));
    // per-policy review rows are unchanged: both exist, each with its own split
    expect(report.deductibleReviews).toHaveLength(2);
    // sorted by retainedUsd desc → '1' (25,000) then '2' (10,000)
    expect(report.deductibleReviews[0]).toMatchObject({ policyId: '1', retainedUsd: 25000, transferredUsd: 17000 });
    expect(report.deductibleReviews[1]).toMatchObject({ policyId: '2', retainedUsd: 10000, transferredUsd: 32000 });
    // portfolio sums are single-count via the primary policy
    expect(report.selfInsure.retainedUsd).toBe(25000);
    expect(report.selfInsure.transferredUsd).toBe(17000);
    expect(report.selfInsure.overLimitUsd).toBe(0);
    expect(report.selfInsure.premiumAnnualTotal).toBe(18000);
  });

  it('(d) over-limit disclosure when gross > limit', () => {
    // d=25k, L=2M, gross=2.5M
    // retained    = min(2,500,000, 25,000)                       = 25,000
    // transferred = max(0, min(2,500,000, 2,000,000) − 25,000)   = 2,000,000 − 25,000 = 1,975,000
    // overLimit   = max(0, 2,500,000 − 2,000,000)               = 500,000
    // the three buckets partition gross: 25,000 + 1,975,000 + 500,000 = 2,500,000
    const report = buildInsuranceLossReport(inputs({
      policies: [mkPolicy({ policyId: '1', propertyId: 'P1', cohort: 'property-package' })],
      decPages: decPagesOf({ '1': { deductible: 25000, coverageLimit: 2_000_000, source: 'warehouse' } }),
      lossEvents: lossEvents([mkEvent('e1', 'P1', '2024-01-01', 2_500_000)]),
    }));
    const r = report.deductibleReviews[0]!;
    expect(r.retainedUsd).toBe(25000);
    expect(r.transferredUsd).toBe(1_975_000);
    expect(r.overLimitUsd).toBe(500000);
    expect(r.retainedUsd + r.transferredUsd + r.overLimitUsd).toBe(2_500_000);
  });

  it('(e) lossRatio null when premium is 0', () => {
    // premium 0 → lossRatio is null (never a divide-by-zero Infinity)
    const report = buildInsuranceLossReport(inputs({
      policies: [mkPolicy({ policyId: '1', propertyId: 'P1', cohort: 'property-package', premium: 0 })],
      decPages: decPagesOf({ '1': { deductible: 25000, coverageLimit: 2_000_000, source: 'warehouse' } }),
      lossEvents: lossEvents([mkEvent('e1', 'P1', '2024-01-01', 42000)]),
    }));
    expect(report.deductibleReviews[0]!.lossRatio).toBeNull();
  });

  it('(f) rebid pipeline stage mapping for all three buckets; excludes excess ≤ 0 / null', () => {
    // stage: now-45 → rebid, soon-90 → quote, else → watch. Only excess > 0 enters.
    // A(5000/now-45)→rebid, B(3000/soon-90)→quote, C(1000/later)→watch
    // D(excess 0), E(excess null), F(excess −50) are all excluded
    // sorted by excess DESC → [A, B, C]
    const report = buildInsuranceLossReport(inputs({
      policies: [
        mkPolicy({ policyId: 'A', propertyId: 'P1', excessPremiumVsMedian: 5000, renewalBucket: 'now-45' }),
        mkPolicy({ policyId: 'B', propertyId: 'P2', excessPremiumVsMedian: 3000, renewalBucket: 'soon-90' }),
        mkPolicy({ policyId: 'C', propertyId: 'P3', excessPremiumVsMedian: 1000, renewalBucket: 'later' }),
        mkPolicy({ policyId: 'D', propertyId: 'P4', excessPremiumVsMedian: 0, renewalBucket: 'now-45' }),
        mkPolicy({ policyId: 'E', propertyId: 'P5', excessPremiumVsMedian: null, renewalBucket: 'now-45' }),
        mkPolicy({ policyId: 'F', propertyId: 'P6', excessPremiumVsMedian: -50, renewalBucket: 'expired' }),
      ],
    }));
    expect(report.rebidPipeline.map((p) => p.policyId)).toEqual(['A', 'B', 'C']);
    expect(Object.fromEntries(report.rebidPipeline.map((p) => [p.policyId, p.stage]))).toEqual({ A: 'rebid', B: 'quote', C: 'watch' });
    // reason names the excess $ and the bucket
    expect(report.rebidPipeline[0]!.reason).toContain('$5,000');
    expect(report.rebidPipeline[0]!.reason).toContain('now-45');
  });

  it('(g) decPageDataSource mixing rules', () => {
    const base = (decs: Record<string, DecPageEntry>) => buildInsuranceLossReport(inputs({
      policies: [
        mkPolicy({ policyId: '1', propertyId: 'P1', cohort: 'property-package' }),
        mkPolicy({ policyId: '2', propertyId: 'P2', cohort: 'property-package' }),
      ],
      decPages: decPagesOf(decs),
      lossEvents: lossEvents([]),
    }));
    // EVERY reviewed policy warehouse → 'warehouse'
    expect(base({ '1': dec('warehouse'), '2': dec('warehouse') }).decPageDataSource).toBe('warehouse');
    // ANY placeholder → 'placeholder'
    expect(base({ '1': dec('warehouse'), '2': dec('placeholder') }).decPageDataSource).toBe('placeholder');
    // all absent → 'absent'
    expect(base({ '1': dec('absent'), '2': dec('absent') }).decPageDataSource).toBe('absent');
    // mixed warehouse + absent (no placeholder) → not unambiguously warehouse → 'absent'
    expect(base({ '1': dec('warehouse'), '2': dec('absent') }).decPageDataSource).toBe('absent');
    // no reviewed policies at all → 'absent'
    expect(buildInsuranceLossReport(inputs({})).decPageDataSource).toBe('absent');
  });

  it('(h) output Zod-parses and advisoryOnly is literal true; placeholder prov path', () => {
    const report = buildInsuranceLossReport(inputs({
      policies: [mkPolicy({ policyId: '1', propertyId: 'P1', cohort: 'property-package', premium: 12000 })],
      decPages: decPagesOf({ '1': { deductible: 25000, coverageLimit: 2_000_000, source: 'placeholder' } }),
      lossEvents: lossEvents([
        mkEvent('e1', 'P1', '2023-01-01', 10000),
        mkEvent('e2', 'P1', '2024-01-01', 20000),
        mkEvent('e3', 'P1', '2025-01-01', 30000),
      ], 'placeholder', 2),
    }));
    // engine parses internally; a re-parse of the returned value must also succeed
    expect(() => InsuranceLossReport.parse(report)).not.toThrow();
    expect(report.advisoryOnly).toBe(true);
    expect(report.lossDataSource).toBe('placeholder');
    expect(report.droppedFixtureRows).toBe(2);
    // prov.source uses the placeholder path when lossDataSource !== 'warehouse'
    expect(report.eal[0]!.prov.source).toBe('loss-runs.placeholder.json');
    expect(report.deductibleReviews[0]!.prov.source).toBe('loss-runs.placeholder.json');
    expect(report.basisNote.length).toBeGreaterThan(0);
    // MINOR-1 disclosure: absent dec terms (d=0, L=∞) book the full gross as transferred
    expect(report.basisNote).toContain('fully transferred');
  });

  it('exports MIN_LOSS_YEARS = 3 and maps the warehouse prov source', () => {
    expect(MIN_LOSS_YEARS).toBe(3);
    const report = buildInsuranceLossReport(inputs({
      lossEvents: lossEvents([
        mkEvent('e1', 'P1', '2023-01-01', 10000),
        mkEvent('e2', 'P1', '2024-01-01', 20000),
        mkEvent('e3', 'P1', '2025-01-01', 30000),
      ], 'warehouse'),
    }));
    expect(report.eal[0]!.prov.source).toBe('insurance_loss_events');
    expect(report.lossDataSource).toBe('warehouse');
  });
});
