// @vitest-environment node
//
// tests/unit/insurance-loss-analysis.test.ts
//
// Phase 4c — Insurance LOSS reasoning layer: buildInsuranceLossReport().
// PURE function — no DB, no I/O, no mocking. Plain fixture objects satisfying the
// resolver-output + PolicyEconomics types (Task 2 / insurance-analysis contract).
// Every expected number is hand-computed in the comment above its assertion.
import { describe, expect, it } from 'vitest';
import { buildInsuranceLossReport, MIN_LOSS_YEARS, type LossAnalysisInputs, type PolicyTerm } from '../../server/warehouse/insurance-loss-analysis';
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

function mkRefEvent(id: string, propertyId: string, lossDate: string, grossIncurred: number, policyRef: string, cause: string | null = null): LossEventRow {
  return { ...mkEvent(id, propertyId, lossDate, grossIncurred), policyRef, cause };
}

function termsOf(entries: Record<string, PolicyTerm>): ReadonlyMap<string, PolicyTerm> {
  return new Map(Object.entries(entries));
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
    policyTerms: new Map(),
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

  it('(c2) each loss event is attached to exactly ONE policy — a multi-policy property never double-counts', () => {
    // Property P1 carries TWO property-package policies with no term data on file (empty
    // policyTerms). The single event (gross 42,000) is attached to exactly one of them — with no
    // covering term the pick is most-recent effective date, then policyId ascending as the
    // total-order tiebreak → '1'.
    //   policy '1': d=25,000, L=2M → retained 25,000; transferred 17,000; eventsN 1
    //   policy '2': d=10,000, L=2M → no events attached → all zeros; eventsN 0
    // selfInsure = Σ over review rows (events are disjoint across rows) = 25,000 / 17,000 — never
    // the double-count 35,000 / 49,000 of reviewing the same event against both policies.
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
    expect(report.deductibleReviews).toHaveLength(2);
    expect(report.deductibleReviews[0]).toMatchObject({ policyId: '1', eventsN: 1, retainedUsd: 25000, transferredUsd: 17000 });
    expect(report.deductibleReviews[1]).toMatchObject({ policyId: '2', eventsN: 0, retainedUsd: 0, transferredUsd: 0, lossRatio: 0 });
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

// ── Term / policy_ref-aware loss attachment (2026-09-24, refute wf_b8d4eadd-e31) ──────────────
//
// Live shape at 9620 E State Route 350, Raytown: two property-package policies in force at once,
// both resolving to the same property_master id —
//   1734 Westchester  2025-10-18 → 2026-10-18   (policy_number MMF17962784-002)
//   1735 Hartford BOP 2026-05-28 → 2027-05-28   (policy_number 37 SBA CB6KKB)
// Matching events by propertyId alone and picking a "primary" policy by lexicographic policyId
// ('1734' < '1735') books a loss inside the Hartford term against the Westchester deductible.
// Each event now attaches to the one policy whose term covers it.
describe('buildInsuranceLossReport — term / policy_ref-aware loss attachment', () => {
  const RAYTOWN = '9620-e-state-route-350-raytown-mo';
  const WESTCHESTER = mkPolicy({ policyId: '1734', property: '9620 E State Route 350, Raytown MO', propertyId: RAYTOWN, premium: 6000 });
  const HARTFORD = mkPolicy({ policyId: '1735', property: '9620 E State Route 350, Raytown MO', propertyId: RAYTOWN, premium: 5000 });
  const TERMS = termsOf({
    '1734': { policyNumber: 'MMF17962784-002', lineNumbers: ['MMF17962784-002'], effectiveDate: '2025-10-18', expirationDate: '2026-10-18' },
    '1735': { policyNumber: '37SBACB6KKB', lineNumbers: ['37SBACB6KKB'], effectiveDate: '2026-05-28', expirationDate: '2027-05-28' },
  });
  // Distinct deductibles so a wrong attachment is visible in the split.
  const DECS = decPagesOf({
    '1734': { deductible: 10000, coverageLimit: 2_000_000, source: 'warehouse' },
    '1735': { deductible: 25000, coverageLimit: 2_000_000, source: 'warehouse' },
  });

  function run(policies: PolicyEconomics[], events: LossEventRow[]) {
    return buildInsuranceLossReport(inputs({ policies, decPages: DECS, policyTerms: TERMS, lossEvents: lossEvents(events) }));
  }
  function review(r: ReturnType<typeof run>, policyId: string) {
    const found = r.deductibleReviews.find((d) => d.policyId === policyId);
    if (!found) throw new Error(`no review row for policy ${policyId}`);
    return found;
  }

  it('overlapping terms: a 2026-07-04 loss (inside BOTH terms) uses the Hartford policy — the most recent effective date', () => {
    // Hartford: d=25,000, L=2M, gross 42,000 → retained 25,000 / transferred 17,000
    // lossRatio = 42,000 / 5,000 = 8.4 ; Westchester reviews nothing.
    const r = run([WESTCHESTER, HARTFORD], [mkEvent('e1', RAYTOWN, '2026-07-04', 42000)]);
    expect(review(r, '1735')).toMatchObject({ eventsN: 1, retainedUsd: 25000, transferredUsd: 17000, overLimitUsd: 0 });
    expect(review(r, '1735').lossRatio).toBeCloseTo(8.4, 10);
    expect(review(r, '1734')).toMatchObject({ eventsN: 0, retainedUsd: 0, transferredUsd: 0 });
    expect(r.selfInsure).toMatchObject({ retainedUsd: 25000, transferredUsd: 17000, overLimitUsd: 0 });
  });

  it('the result is order-independent — reversing the policy and event arrays changes nothing', () => {
    const events = [
      mkEvent('e1', RAYTOWN, '2026-07-04', 42000),
      mkEvent('e2', RAYTOWN, '2026-01-15', 8000),
    ];
    const a = run([WESTCHESTER, HARTFORD], events);
    const b = run([HARTFORD, WESTCHESTER], [...events].reverse());
    expect(b.deductibleReviews).toEqual(a.deductibleReviews);
    expect(b.selfInsure).toEqual(a.selfInsure);
  });

  it('a loss covered ONLY by the older term attaches to it (2026-01-15 → Westchester)', () => {
    // Westchester: d=10,000, gross 8,000 → retained 8,000 / transferred 0, below the deductible.
    const r = run([WESTCHESTER, HARTFORD], [mkEvent('e1', RAYTOWN, '2026-01-15', 8000)]);
    expect(review(r, '1734')).toMatchObject({ eventsN: 1, retainedUsd: 8000, transferredUsd: 0, lossesBelowDeductible: 1 });
    expect(review(r, '1735')).toMatchObject({ eventsN: 0 });
  });

  it('term boundaries are inclusive on both ends', () => {
    // 2027-05-28 = Hartford expiration (only Hartford covers); 2025-10-18 = Westchester effective
    // (only Westchester covers).
    const r = run([WESTCHESTER, HARTFORD], [
      mkEvent('e1', RAYTOWN, '2027-05-28', 30000),
      mkEvent('e2', RAYTOWN, '2025-10-18', 30000),
    ]);
    expect(review(r, '1735').eventsN).toBe(1);
    expect(review(r, '1734').eventsN).toBe(1);
  });

  it('a policy_ref matching a policy_number wins over term recency', () => {
    // 2026-07-04 is inside both terms (recency would pick Hartford) but the loss run names the
    // Westchester policy: d=10,000, gross 42,000 → retained 10,000 / transferred 32,000.
    const r = run([WESTCHESTER, HARTFORD], [mkRefEvent('e1', RAYTOWN, '2026-07-04', 42000, 'MMF17962784-002')]);
    expect(review(r, '1734')).toMatchObject({ eventsN: 1, retainedUsd: 10000, transferredUsd: 32000 });
    expect(review(r, '1735').eventsN).toBe(0);
  });

  it('an unmatched policy_ref (the placeholder fixture uses "PLACEHOLDER") falls through to term attachment', () => {
    const r = run([WESTCHESTER, HARTFORD], [mkRefEvent('e1', RAYTOWN, '2026-07-04', 42000, 'PLACEHOLDER')]);
    expect(review(r, '1735').eventsN).toBe(1);
    expect(review(r, '1734').eventsN).toBe(0);
  });

  it('a loss outside every current term falls back to the most recent effective date (Hartford)', () => {
    // 2023-04-01 predates both current terms (prior terms are collapsed away upstream).
    const r = run([WESTCHESTER, HARTFORD], [mkEvent('e1', RAYTOWN, '2023-04-01', 42000)]);
    expect(review(r, '1735').eventsN).toBe(1);
    expect(review(r, '1734').eventsN).toBe(0);
  });

  it('every event is booked exactly once: Σ review eventsN = attributable events, selfInsure = Σ review rows', () => {
    const events = [
      mkEvent('e1', RAYTOWN, '2026-07-04', 42000),
      mkEvent('e2', RAYTOWN, '2026-01-15', 8000),
      mkEvent('e3', RAYTOWN, '2023-04-01', 3000),
      mkEvent('e4', RAYTOWN, '2027-01-01', 60000),
    ];
    const r = run([WESTCHESTER, HARTFORD], events);
    expect(r.deductibleReviews.reduce((s, d) => s + d.eventsN, 0)).toBe(events.length);
    expect(r.selfInsure.retainedUsd).toBe(r.deductibleReviews.reduce((s, d) => s + d.retainedUsd, 0));
    expect(r.selfInsure.transferredUsd).toBe(r.deductibleReviews.reduce((s, d) => s + d.transferredUsd, 0));
    // Hand check: Hartford gets e1 (42k), e3 (fallback, 3k), e4 (60k); Westchester gets e2 (8k).
    //   Hartford d=25k:    retained 25k + 3k + 25k = 53k; transferred 17k + 0 + 35k = 52k
    //   Westchester d=10k: retained 8k;                   transferred 0
    expect(r.selfInsure.retainedUsd).toBe(61000);
    expect(r.selfInsure.transferredUsd).toBe(52000);
  });

  it('events at a property with no reviewable property line stay in EAL but reach no deductible review', () => {
    const gl = mkPolicy({ policyId: '1733', propertyId: RAYTOWN, cohort: 'other', policyType: 'General Liability (GL)' });
    const r = run([gl], [mkEvent('e1', RAYTOWN, '2026-07-04', 42000)]);
    expect(r.deductibleReviews).toHaveLength(0);
    expect(r.eal).toHaveLength(1);
    expect(r.selfInsure).toMatchObject({ retainedUsd: 0, transferredUsd: 0 });
  });

  // ── refute wf_f867be02-d49 regressions ──────────────────────────────────────────────────────

  it('review eligibility ignores TIV: live-shaped TIV-less policies (cohort excluded-null-tiv) still attach and are reviewed', () => {
    // All 30 live current terms carry null coverage_tiv → cohort 'excluded-null-tiv'. The review
    // never uses TIV, so both 9620 property lines are still reviewed; 2026-07-04 → Hartford.
    const w = { ...WESTCHESTER, cohort: 'excluded-null-tiv' as const, tiv: null };
    const h = { ...HARTFORD, cohort: 'excluded-null-tiv' as const, tiv: null, policyType: 'Property (Hartford Spectrum BOP)' };
    const r = run([w, h], [mkEvent('e1', RAYTOWN, '2026-07-04', 42000)]);
    expect(r.deductibleReviews).toHaveLength(2);
    expect(review(r, '1735')).toMatchObject({ eventsN: 1, retainedUsd: 25000, transferredUsd: 17000 });
    expect(r.selfInsure).toMatchObject({ retainedUsd: 25000, transferredUsd: 17000 });
  });

  it('a loss naming a TIV-less policy by policy_ref books against THAT policy, never its TIV-bearing sibling', () => {
    // Westchester has no TIV on its current capture; the loss run names it and the date sits only
    // in its term. d=10,000, gross 42,000 → retained 10,000 / transferred 32,000 on 1734 — not
    // 25,000 / 17,000 on Hartford.
    const w = { ...WESTCHESTER, cohort: 'excluded-null-tiv' as const, tiv: null };
    const r = run([w, HARTFORD], [mkRefEvent('e1', RAYTOWN, '2026-01-15', 42000, 'MMF17962784-002')]);
    expect(review(r, '1734')).toMatchObject({ eventsN: 1, retainedUsd: 10000, transferredUsd: 32000 });
    expect(review(r, '1735').eventsN).toBe(0);
    expect(r.selfInsure).toMatchObject({ retainedUsd: 10000, transferredUsd: 32000 });
  });

  it('a policy_ref naming a NON-property line at the property leaves the loss EAL-only (never moved onto a property deductible)', () => {
    const gl = mkPolicy({ policyId: '1733', propertyId: RAYTOWN, cohort: 'other', policyType: 'General Liability (GL)' });
    const terms = new Map<string, PolicyTerm>([...TERMS, ['1733', { policyNumber: 'GLWF18677015-001', lineNumbers: ['GLWF18677015-001'], effectiveDate: '2025-10-18', expirationDate: '2026-10-18' }]]);
    const r = buildInsuranceLossReport(inputs({
      policies: [gl, WESTCHESTER, HARTFORD],
      decPages: DECS,
      policyTerms: terms,
      lossEvents: lossEvents([mkRefEvent('e1', RAYTOWN, '2026-07-04', 42000, 'GLWF18677015-001')]),
    }));
    expect(r.deductibleReviews.map((d) => d.policyId).sort()).toEqual(['1734', '1735']); // GL gets no review row
    expect(r.deductibleReviews.every((d) => d.eventsN === 0)).toBe(true);
    expect(r.selfInsure).toMatchObject({ retainedUsd: 0, transferredUsd: 0 });
    expect(r.eal[0]).toMatchObject({ propertyId: RAYTOWN, eventsN: 1, grossIncurredTotal: 42000 });
  });

  it('a tenant evidence-of-insurance certificate takes no attachment or review — its deductible is not ORA retention', () => {
    const FISHEL = '7658-fishel-dr-n-dublin-oh';
    const cert = mkPolicy({ policyId: '1753', propertyId: FISHEL, cohort: 'excluded-null-tiv', tiv: null, policyType: 'Evidence of Property Insurance (ACORD 28)' });
    const r = buildInsuranceLossReport(inputs({
      policies: [cert],
      decPages: decPagesOf({ '1753': { deductible: 5000, coverageLimit: 2_000_000, source: 'warehouse' } }),
      lossEvents: lossEvents([mkEvent('e1', FISHEL, '2026-03-01', 42000)]),
    }));
    expect(r.deductibleReviews).toHaveLength(0);
    expect(r.selfInsure).toMatchObject({ retainedUsd: 0, transferredUsd: 0 });
    expect(r.eal[0]).toMatchObject({ propertyId: FISHEL, grossIncurredTotal: 42000 });
  });

  it('per-policy sums are a function of the event SET — fractional amounts give identical output in any row order', () => {
    // 0.1 + 0.2 + 0.3 = 0.6000000000000001 in row order but 0.6 reversed; accumulation is
    // (lossDate, id)-sorted so both orders produce the same bits.
    const events = [
      mkEvent('f1', RAYTOWN, '2026-06-01', 0.1),
      mkEvent('f2', RAYTOWN, '2026-06-02', 0.2),
      mkEvent('f3', RAYTOWN, '2026-06-03', 0.3),
    ];
    const a = run([WESTCHESTER, HARTFORD], events);
    const b = run([WESTCHESTER, HARTFORD], [...events].reverse());
    expect(b.deductibleReviews).toEqual(a.deductibleReviews);
    expect(b.selfInsure).toEqual(a.selfInsure);
  });

  // ── refute wf_9161a34b-7f0 regressions ──────────────────────────────────────────────────────

  // Live Hartford Spectrum BOP at 9620: ONE policy number spans the property, GL, umbrella and
  // EPLI lines.
  const BOP = '37 SBA CB6KKB';
  const BOP_GL = mkPolicy({ policyId: '1736', propertyId: RAYTOWN, cohort: 'excluded-null-tiv', tiv: null, policyType: 'Business Liability / GL (in BOP)' });
  const BOP_EPLI = mkPolicy({ policyId: '1738', propertyId: RAYTOWN, cohort: 'excluded-null-tiv', tiv: null, policyType: 'EPLI $25K (NEW — in bundled premium)' });
  const BOP_TERMS = new Map<string, PolicyTerm>([
    ...TERMS,
    ['1736', { policyNumber: '37SBACB6KKB', lineNumbers: ['37SBACB6KKB'], effectiveDate: '2026-05-28', expirationDate: '2027-05-28' }],
    ['1738', { policyNumber: '37SBACB6KKB', lineNumbers: ['37SBACB6KKB'], effectiveDate: '2026-05-28', expirationDate: '2027-05-28' }],
  ]);
  function runBop(events: LossEventRow[]) {
    return buildInsuranceLossReport(inputs({
      policies: [WESTCHESTER, HARTFORD, BOP_GL, BOP_EPLI], decPages: DECS, policyTerms: BOP_TERMS, lossEvents: lossEvents(events),
    }));
  }

  it('a liability claim citing a bundled BOP number is EAL-only — never retained under the property deductible', () => {
    const r = runBop([mkRefEvent('e1', RAYTOWN, '2026-07-04', 40000, BOP, 'liability - slip and fall')]);
    expect(r.deductibleReviews.every((d) => d.eventsN === 0)).toBe(true);
    expect(r.selfInsure).toMatchObject({ retainedUsd: 0, transferredUsd: 0 });
    expect(r.eal[0]).toMatchObject({ propertyId: RAYTOWN, eventsN: 1, grossIncurredTotal: 40000 });
  });

  it('a first-party claim citing the same bundled BOP number books to the BOP property line', () => {
    // Hartford d=25,000: gross 40,000 → retained 25,000 / transferred 15,000.
    const r = runBop([mkRefEvent('e1', RAYTOWN, '2026-07-04', 40000, BOP, 'wind')]);
    expect(review(r, '1735')).toMatchObject({ eventsN: 1, retainedUsd: 25000, transferredUsd: 15000 });
    expect(review(r, '1734').eventsN).toBe(0);
  });

  it('a ref-matched pool is narrowed to REVIEWABLE lines before the tiebreak — a lower-id GL sharing the number never wins', () => {
    // Mutation guard for attachEvent's `pool = byRef.filter(isReviewable)`: the runBop fixture
    // passes on `pool = byRef` by coincidence, because preferPolicy's policyId tiebreak
    // ('1735' < '1736' < '1738') happens to land on the property line. Here a GL line sharing
    // the same own number sorts BEFORE the property line ('1700' < '1735') on an identical
    // effective date, so an unfiltered pool would attach the wind loss to the GL row — which takes
    // no review — and the event would vanish from every deductible review and the self-insure
    // roll-up. Hartford d=25,000: gross 40,000 → retained 25,000 / transferred 15,000.
    const bopGlLowId = mkPolicy({ policyId: '1700', propertyId: RAYTOWN, cohort: 'other', policyType: 'Business Liability / GL (in BOP)' });
    const terms = new Map<string, PolicyTerm>([
      ...TERMS,
      ['1700', { policyNumber: '37SBACB6KKB', lineNumbers: ['37SBACB6KKB'], effectiveDate: '2026-05-28', expirationDate: '2027-05-28' }],
    ]);
    const r = buildInsuranceLossReport(inputs({
      policies: [bopGlLowId, WESTCHESTER, HARTFORD], decPages: DECS, policyTerms: terms,
      lossEvents: lossEvents([mkRefEvent('e1', RAYTOWN, '2026-07-04', 40000, BOP, 'wind')], 'warehouse'),
    }));
    expect(r.deductibleReviews.map((d) => d.policyId).sort()).toEqual(['1734', '1735']); // GL gets no review row
    expect(review(r, '1735')).toMatchObject({ eventsN: 1, retainedUsd: 25000, transferredUsd: 15000, overLimitUsd: 0 });
    expect(review(r, '1734').eventsN).toBe(0);
    expect(r.selfInsure).toMatchObject({ retainedUsd: 25000, transferredUsd: 15000, overLimitUsd: 0 });
    expect(r.unmatchedPolicyRefs).toEqual([]);
  });

  it('a third-party cause with NO policy_ref is EAL-only too (e.g. the placeholder fixture\'s liability event)', () => {
    const r = run([WESTCHESTER, HARTFORD], [{ ...mkEvent('e1', RAYTOWN, '2026-07-04', 30000), cause: 'liability' }]);
    expect(r.deductibleReviews.every((d) => d.eventsN === 0)).toBe(true);
    expect(r.selfInsure.retainedUsd).toBe(0);
  });

  it('policy_ref matches a superseded number on the same line and is normalized (case / whitespace)', () => {
    // Live: row 1310 'MMF17962784' was reissued as 1734 'MMF17962784-002' (same term); only 1734
    // survives the current-term collapse, so its line carries both numbers. 2026-07-04 is inside
    // both terms — recency alone would pick Hartford.
    const terms = new Map<string, PolicyTerm>([
      ...TERMS,
      ['1734', { policyNumber: 'MMF17962784-002', lineNumbers: ['MMF17962784', 'MMF17962784-002'], effectiveDate: '2025-10-18', expirationDate: '2026-10-18' }],
    ]);
    const r = buildInsuranceLossReport(inputs({
      policies: [WESTCHESTER, HARTFORD], decPages: DECS, policyTerms: terms,
      lossEvents: lossEvents([mkRefEvent('e1', RAYTOWN, '2026-07-04', 42000, '  mmf17962784 ')]),
    }));
    expect(review(r, '1734')).toMatchObject({ eventsN: 1, retainedUsd: 10000, transferredUsd: 32000 });
    expect(review(r, '1735').eventsN).toBe(0);
  });

  it('pre-term fallback is go-forward: a loss before every current term is reviewed under the newest policy\'s deductible', () => {
    // Distinct deductibles pin the choice: Hartford (eff 2026-05-28, d=25,000) not Westchester
    // (d=10,000). gross 42,000 → retained 25,000 / transferred 17,000.
    const r = run([WESTCHESTER, HARTFORD], [mkEvent('e1', RAYTOWN, '2024-03-01', 42000)]);
    expect(review(r, '1735')).toMatchObject({ eventsN: 1, retainedUsd: 25000, transferredUsd: 17000 });
  });

  it('EAL totals are a function of the event SET — fractional amounts give identical EAL in any row order', () => {
    const events = [
      mkEvent('f1', 'P-NOPOLICY', '2026-06-01', 0.1),
      mkEvent('f2', 'P-NOPOLICY', '2026-06-01', 0.2),
      mkEvent('f3', 'P-NOPOLICY', '2026-06-01', 0.3),
    ];
    const a = buildInsuranceLossReport(inputs({ lossEvents: lossEvents(events) }));
    const b = buildInsuranceLossReport(inputs({ lossEvents: lossEvents([...events].reverse()) }));
    expect(b.eal).toEqual(a.eal);
  });

  // ── refute wf_4af14459-c62 regressions ──────────────────────────────────────────────────────

  it('an exact own-number ref wins over line aliases when one line carries two surviving policies', () => {
    // Both policies sit on one raw line, so each carries the other's number as a line alias. The
    // ref names Westchester exactly; recency alone (2026-07-04 inside both terms) would pick
    // Hartford. d=10,000, gross 42,000 → retained 10,000 / transferred 32,000 on 1734.
    const both = ['37SBACB6KKB', 'MMF17962784-002'];
    const terms = new Map<string, PolicyTerm>([
      ['1734', { policyNumber: 'MMF17962784-002', lineNumbers: both, effectiveDate: '2025-10-18', expirationDate: '2026-10-18' }],
      ['1735', { policyNumber: '37SBACB6KKB', lineNumbers: both, effectiveDate: '2026-05-28', expirationDate: '2027-05-28' }],
    ]);
    const r = buildInsuranceLossReport(inputs({
      policies: [WESTCHESTER, HARTFORD], decPages: DECS, policyTerms: terms,
      lossEvents: lossEvents([mkRefEvent('e1', RAYTOWN, '2026-07-04', 42000, 'MMF17962784-002')]),
    }));
    expect(review(r, '1734')).toMatchObject({ eventsN: 1, retainedUsd: 10000, transferredUsd: 32000 });
    expect(review(r, '1735').eventsN).toBe(0);
  });

  it('policy_ref matching is whitespace-insensitive: "MMF 17962784-002" names Westchester', () => {
    const r = run([WESTCHESTER, HARTFORD], [mkRefEvent('e1', RAYTOWN, '2026-07-04', 42000, 'mmf 17962784 - 002')]);
    expect(review(r, '1734').eventsN).toBe(1);
    expect(review(r, '1735').eventsN).toBe(0);
  });

  it.each([
    ['Slip joint failure - water', false],
    ['roof slip / membrane', false],
    ['Property liability - water backup', false],
    ['Water damage from tenant liability dispute', false],
    ['wind', false],
    ['liability', true],
    ['liability - slip and fall', true],
    ['Trip and fall - premises', true],
    ['slip & fall in lobby', true],
    ['Bodily injury claim', true],
    ['EPLI - wrongful termination', true],
    // refute wf_a4ae3c23-a46: hyphenated spelling + strong markers beat a named peril
    ['slip-and-fall', true],
    ['Trip-and-fall in lot', true],
    ['Slip and fall on ice', true],
    ['Claimant fell on snow/ice - bodily injury', true],
    ['Bodily injury from roof collapse', true],
    ['Fire liability suit', true],
    ['Slip & fall - ice in lot - BI claim', true],
  ])('cause %j → third-party %s', (cause, thirdParty) => {
    const r = run([WESTCHESTER, HARTFORD], [{ ...mkEvent('e1', RAYTOWN, '2026-07-04', 42000), cause }]);
    expect(review(r, '1735').eventsN).toBe(thirdParty ? 0 : 1);
  });

  it('EAL rows take the resolved property display name from the policy register', () => {
    const r = run([WESTCHESTER, HARTFORD], [mkEvent('e1', RAYTOWN, '2026-07-04', 42000)]);
    expect(r.eal[0]).toMatchObject({ propertyId: RAYTOWN, property: '9620 E State Route 350, Raytown MO' });
  });
});

// ── Unmatched policy_ref visibility (2026-09-24) ─────────────────────────────────────────────
//
// A non-blank policy_ref that names NO policy at the event's property (own number or line alias,
// across every line — not only reviewable ones) is silently ignored by attachEvent. The report now
// lists those events in `unmatchedPolicyRefs` so a loss-run typo or a policy missing from
// property_insurance_policies is visible. Visibility ONLY: attachment, EAL, reviews and the
// self-insure roll-up are byte-for-byte what they were.
describe('buildInsuranceLossReport — unmatchedPolicyRefs', () => {
  const RAYTOWN = '9620-e-state-route-350-raytown-mo';
  const RAYTOWN_NAME = '9620 E State Route 350, Raytown MO';
  const FISHEL = '7658-fishel-dr-n-dublin-oh';
  const WESTCHESTER = mkPolicy({ policyId: '1734', property: RAYTOWN_NAME, propertyId: RAYTOWN, premium: 6000 });
  const HARTFORD = mkPolicy({ policyId: '1735', property: RAYTOWN_NAME, propertyId: RAYTOWN, premium: 5000 });
  const GL = mkPolicy({ policyId: '1733', property: RAYTOWN_NAME, propertyId: RAYTOWN, cohort: 'other', policyType: 'General Liability (GL)' });
  const FISHEL_POLICY = mkPolicy({ policyId: '1750', property: '7658 Fishel Dr N, Dublin OH', propertyId: FISHEL, premium: 4000 });
  const TERMS = termsOf({
    '1734': { policyNumber: 'MMF17962784-002', lineNumbers: ['MMF17962784', 'MMF17962784-002'], effectiveDate: '2025-10-18', expirationDate: '2026-10-18' },
    '1735': { policyNumber: '37SBACB6KKB', lineNumbers: ['37SBACB6KKB'], effectiveDate: '2026-05-28', expirationDate: '2027-05-28' },
    '1733': { policyNumber: 'GLWF18677015-001', lineNumbers: ['GLWF18677015-001'], effectiveDate: '2025-10-18', expirationDate: '2026-10-18' },
    '1750': { policyNumber: 'FISHEL-PROP-1', lineNumbers: ['FISHEL-PROP-1'], effectiveDate: '2026-01-01', expirationDate: '2027-01-01' },
  });
  const DECS = decPagesOf({
    '1734': { deductible: 10000, coverageLimit: 2_000_000, source: 'warehouse' },
    '1735': { deductible: 25000, coverageLimit: 2_000_000, source: 'warehouse' },
    '1750': { deductible: 5000, coverageLimit: 2_000_000, source: 'warehouse' },
  });
  const ALL = [GL, WESTCHESTER, HARTFORD, FISHEL_POLICY];

  function run(events: LossEventRow[], policies: PolicyEconomics[] = ALL) {
    return buildInsuranceLossReport(inputs({ policies, decPages: DECS, policyTerms: TERMS, lossEvents: lossEvents(events, 'warehouse') }));
  }
  function review(r: ReturnType<typeof run>, policyId: string) {
    const found = r.deductibleReviews.find((d) => d.policyId === policyId);
    if (!found) throw new Error(`no review row for policy ${policyId}`);
    return found;
  }

  it('a ref matching nothing at the property is listed with the RAW ref, and the event still attaches by covering term', () => {
    // 2026-07-04 sits inside both Raytown terms → recency picks Hartford, exactly as with no ref.
    const raw = ' mmf-TYPO 17962784 ';
    const r = run([mkRefEvent('e1', RAYTOWN, '2026-07-04', 42000, raw, 'wind')]);
    expect(r.unmatchedPolicyRefs).toEqual([{
      eventId: 'e1',
      propertyId: RAYTOWN,
      property: RAYTOWN_NAME,
      policyRef: raw,
      lossDate: '2026-07-04',
      cause: 'wind',
      grossIncurred: 42000,
    }]);
    expect(review(r, '1735')).toMatchObject({ eventsN: 1, retainedUsd: 25000, transferredUsd: 17000 });
    expect(review(r, '1734').eventsN).toBe(0);
  });

  it('detection never changes attachment, EAL, reviews or the self-insure split (unmatched ref ≡ no ref)', () => {
    const withRef = run([
      mkRefEvent('e1', RAYTOWN, '2026-07-04', 42000, 'NOT-ON-FILE'),
      mkRefEvent('e2', RAYTOWN, '2026-01-15', 8000, 'ALSO-NOT-ON-FILE'),
      mkRefEvent('e3', RAYTOWN, '2023-04-01', 3000, 'NOPE'),
    ]);
    const without = run([
      mkEvent('e1', RAYTOWN, '2026-07-04', 42000),
      mkEvent('e2', RAYTOWN, '2026-01-15', 8000),
      mkEvent('e3', RAYTOWN, '2023-04-01', 3000),
    ]);
    expect(withRef.unmatchedPolicyRefs).toHaveLength(3);
    expect(without.unmatchedPolicyRefs).toEqual([]);
    expect(withRef.deductibleReviews).toEqual(without.deductibleReviews);
    expect(withRef.eal).toEqual(without.eal);
    expect(withRef.selfInsure).toEqual(without.selfInsure);
  });

  it("a ref matching a policy's OWN number is not listed", () => {
    const r = run([mkRefEvent('e1', RAYTOWN, '2026-07-04', 42000, 'MMF17962784-002')]);
    expect(r.unmatchedPolicyRefs).toEqual([]);
    expect(review(r, '1734').eventsN).toBe(1);
  });

  it('a ref matching only a lineNumbers alias (superseded number on the same line) is not listed', () => {
    const r = run([mkRefEvent('e1', RAYTOWN, '2026-07-04', 42000, 'MMF17962784')]);
    expect(r.unmatchedPolicyRefs).toEqual([]);
    expect(review(r, '1734').eventsN).toBe(1);
  });

  it('a ref naming a NON-reviewable line at the property (GL) is not listed — it matched something', () => {
    const r = run([mkRefEvent('e1', RAYTOWN, '2026-07-04', 42000, 'GLWF18677015-001')]);
    expect(r.unmatchedPolicyRefs).toEqual([]);
    expect(r.deductibleReviews.every((d) => d.eventsN === 0)).toBe(true); // EAL-only, unchanged
  });

  it('a third-party cause with an unmatched ref is still listed (attachEvent returns early; detection is separate)', () => {
    const r = run([mkRefEvent('e1', RAYTOWN, '2026-07-04', 40000, 'BOGUS-GL-NUMBER', 'liability - slip and fall')]);
    expect(r.unmatchedPolicyRefs).toEqual([expect.objectContaining({ eventId: 'e1', policyRef: 'BOGUS-GL-NUMBER', cause: 'liability - slip and fall' })]);
    expect(r.deductibleReviews.every((d) => d.eventsN === 0)).toBe(true);
    expect(r.selfInsure).toMatchObject({ retainedUsd: 0, transferredUsd: 0 });
  });

  it('a null ref and a whitespace-only ref are not listed (they normalize to null)', () => {
    const r = run([
      mkEvent('e1', RAYTOWN, '2026-07-04', 42000),
      mkRefEvent('e2', RAYTOWN, '2026-07-05', 1000, '   '),
      mkRefEvent('e3', RAYTOWN, '2026-07-06', 1000, ''),
    ]);
    expect(r.unmatchedPolicyRefs).toEqual([]);
  });

  it('a ref that matches a policy at a DIFFERENT property only is listed', () => {
    // FISHEL-PROP-1 is on file — but at Fishel, not Raytown.
    const r = run([mkRefEvent('e1', RAYTOWN, '2026-07-04', 42000, 'FISHEL-PROP-1')]);
    expect(r.unmatchedPolicyRefs.map((u) => [u.eventId, u.propertyId])).toEqual([['e1', RAYTOWN]]);
    expect(review(r, '1735').eventsN).toBe(1); // still attached by covering term at Raytown
  });

  it('a property with zero policies plus a non-null ref is listed, with the id as display-name fallback', () => {
    const r = run([mkRefEvent('e1', 'P-NOPOLICY', '2026-07-04', 500, 'ANY-REF')]);
    expect(r.unmatchedPolicyRefs).toEqual([expect.objectContaining({ eventId: 'e1', propertyId: 'P-NOPOLICY', property: 'P-NOPOLICY', policyRef: 'ANY-REF' })]);
    expect(r.deductibleReviews.every((d) => d.eventsN === 0)).toBe(true);
  });

  it('a blank-propertyId event is never listed (unattributable; already dropped from per-property grouping)', () => {
    const r = run([mkRefEvent('e1', '', '2026-07-04', 42000, 'NOT-ON-FILE')]);
    expect(r.unmatchedPolicyRefs).toEqual([]);
    expect(r.eal).toEqual([]);
  });

  it('a case / whitespace variant of an existing number is not listed', () => {
    const r = run([
      mkRefEvent('e1', RAYTOWN, '2026-07-04', 42000, 'mmf 17962784 - 002'),
      mkRefEvent('e2', RAYTOWN, '2026-07-05', 1000, '37 sba cb6kkb'),
    ]);
    expect(r.unmatchedPolicyRefs).toEqual([]);
  });

  it('ordering is over content — (propertyId, lossDate, eventId, cause, grossIncurred, policyRef) — independent of input row order', () => {
    const events = [
      mkRefEvent('z9', RAYTOWN, '2026-07-04', 100, 'X1'),
      mkRefEvent('a1', RAYTOWN, '2026-07-04', 100, 'X2'),
      mkRefEvent('m5', RAYTOWN, '2026-01-01', 100, 'X3'),
      mkRefEvent('b2', FISHEL, '2026-12-31', 100, 'X4'),
      mkRefEvent('c3', 'P-NOPOLICY', '2024-01-01', 100, 'X5'),
    ];
    const expected = [
      [FISHEL, '2026-12-31', 'b2'],
      [RAYTOWN, '2026-01-01', 'm5'],
      [RAYTOWN, '2026-07-04', 'a1'],
      [RAYTOWN, '2026-07-04', 'z9'],
      ['P-NOPOLICY', '2024-01-01', 'c3'],
    ];
    const key = (r: ReturnType<typeof run>) => r.unmatchedPolicyRefs.map((u) => [u.propertyId, u.lossDate, u.eventId]);
    expect(key(run(events))).toEqual(expected);
    expect(key(run([...events].reverse()))).toEqual(expected);
    expect(key(run([events[3]!, events[0]!, events[4]!, events[2]!, events[1]!]))).toEqual(expected);
  });

  it('the report with unmatched refs still Zod-parses', () => {
    const r = run([mkRefEvent('e1', RAYTOWN, '2026-07-04', 42000, 'NOT-ON-FILE')]);
    expect(() => InsuranceLossReport.parse(r)).not.toThrow();
  });

  // ── refute wf_dd1d6f45-da0 regressions ──────────────────────────────────────────────────────

  it('fails closed: a blank event id (admitted by both loaders) with an unmatched ref is listed and the report still builds', () => {
    const r = run([mkRefEvent('', RAYTOWN, '2026-07-04', 42000, 'NOT-ON-FILE')]);
    expect(r.unmatchedPolicyRefs).toEqual([expect.objectContaining({ eventId: '', policyRef: 'NOT-ON-FILE' })]);
    expect(review(r, '1735').eventsN).toBe(1);
  });

  it("repeated '' ids (NULL ids coerced by resolveLossEvents) at one property and date are ALL listed, and attachment / EAL are unaffected", () => {
    // The engine trusts `id: string` — NULL → '' coercion lives in resolveLossEvents (the warehouse
    // mapper; the fixture parser drops non-string ids), so the honest engine-level input is what the
    // resolver emits: several '' ids. Covers the per-property (lossDate, id) sort AND the
    // unmatchedPolicyRefs sort, where eventId is a repeatable tiebreak, not a key.
    const r = run([
      mkRefEvent('', RAYTOWN, '2026-07-04', 42000, 'NOT-ON-FILE'),
      mkRefEvent('', RAYTOWN, '2026-07-04', 8000, 'ALSO-NOT-ON-FILE', 'hail'),
    ]);
    expect(r.unmatchedPolicyRefs.map((u) => [u.eventId, u.policyRef])).toEqual([['', 'NOT-ON-FILE'], ['', 'ALSO-NOT-ON-FILE']]);
    // Both attach by covering term → Hartford (d=25k): 25k + 8k retained, 17k + 0 transferred.
    expect(review(r, '1735')).toMatchObject({ eventsN: 2, retainedUsd: 33000, transferredUsd: 17000 });
    expect(review(r, '1734').eventsN).toBe(0);
    const named = run([
      mkRefEvent('e1', RAYTOWN, '2026-07-04', 42000, 'NOT-ON-FILE'),
      mkRefEvent('e2', RAYTOWN, '2026-07-04', 8000, 'ALSO-NOT-ON-FILE', 'hail'),
    ]);
    expect(r.eal).toEqual(named.eal);
    expect(r.deductibleReviews).toEqual(named.deductibleReviews);
  });

  it("three '' ids at one property/date with non-dyadic amounts (0.1/0.2/0.3): eal, reviews and unmatchedPolicyRefs are identical forward and reversed (refute wf_45165937-d0b)", () => {
    // (lossDate, id) alone ties on repeated '' ids and falls back to the unspecified SQLite
    // ORDER BY loss_date order; 0.1+0.2+0.3 ≠ 0.3+0.2+0.1 in IEEE-754, so the float sums and the
    // unmatched list would both depend on row order. Migration 022's UNIQUE(property_id,
    // loss_date, cause, gross_incurred) makes (cause, grossIncurred) a key for the tiebreak.
    const events = [
      mkRefEvent('', RAYTOWN, '2026-07-04', 0.1, 'REF-A', 'wind'),
      mkRefEvent('', RAYTOWN, '2026-07-04', 0.2, 'REF-B', 'hail'),
      mkRefEvent('', RAYTOWN, '2026-07-04', 0.3, 'REF-C', 'fire'),
    ];
    const fwd = run(events);
    const rev = run([...events].reverse());
    expect(rev.eal).toEqual(fwd.eal);
    expect(rev.deductibleReviews).toEqual(fwd.deductibleReviews);
    expect(rev.unmatchedPolicyRefs).toEqual(fwd.unmatchedPolicyRefs);
    expect(fwd.unmatchedPolicyRefs.map((u) => u.policyRef)).toEqual(['REF-C', 'REF-B', 'REF-A']); // cause order: fire < hail < wind
    expect(review(fwd, '1735').eventsN).toBe(3);
  });

  it("G1: three '' ids, SAME cause, null ref, 0.1/0.2/0.3 — only the grossIncurred key separates them; eal and reviews equal forward vs reversed", () => {
    // Every earlier key (lossDate, id, cause) ties and policyRef is null, so the per-property sort's
    // grossIncurred comparator is the sole thing keeping 0.1+0.2+0.3 order-independent.
    const events = [0.1, 0.2, 0.3].map((amt) => ({ ...mkEvent('', RAYTOWN, '2026-07-04', amt), cause: 'wind' }));
    const fwd = run(events);
    const rev = run([...events].reverse());
    expect(rev.eal).toEqual(fwd.eal);
    expect(rev.deductibleReviews).toEqual(fwd.deductibleReviews);
    expect(review(fwd, '1735').eventsN).toBe(3);
  });

  it('G2: unmatched rows tying on every key before gross list gross ASCENDING, even when ref order disagrees', () => {
    const events = [
      mkRefEvent('', RAYTOWN, '2026-07-04', 300, 'AAA', 'wind'),
      mkRefEvent('', RAYTOWN, '2026-07-04', 100, 'ZZZ', 'wind'),
      mkRefEvent('', RAYTOWN, '2026-07-04', 200, 'MMM', 'wind'),
    ];
    const key = (r: ReturnType<typeof run>) => r.unmatchedPolicyRefs.map((u) => [u.grossIncurred, u.policyRef]);
    expect(key(run(events))).toEqual([[100, 'ZZZ'], [200, 'MMM'], [300, 'AAA']]);
    expect(key(run([...events].reverse()))).toEqual([[100, 'ZZZ'], [200, 'MMM'], [300, 'AAA']]);
  });

  it('is computed ONLY on warehouse loss runs — the same unmatched ref gives [] on placeholder / absent sources', () => {
    const events = [mkRefEvent('e1', RAYTOWN, '2026-07-04', 42000, 'PLACEHOLDER')];
    const build = (source: DataSource) =>
      buildInsuranceLossReport(inputs({ policies: ALL, decPages: DECS, policyTerms: TERMS, lossEvents: lossEvents(events, source) }));
    expect(build('warehouse').unmatchedPolicyRefs.map((u) => u.eventId)).toEqual(['e1']);
    expect(build('placeholder').unmatchedPolicyRefs).toEqual([]);
    expect(build('absent').unmatchedPolicyRefs).toEqual([]);
    // attachment is identical across sources — the gate changes visibility only
    expect(build('placeholder').deductibleReviews.map((d) => [d.policyId, d.eventsN]))
      .toEqual(build('warehouse').deductibleReviews.map((d) => [d.policyId, d.eventsN]));
  });
});
