// tests/unit/contracts-insurance-analysis.test.ts
//
// TDD boundary tests for src/contracts/insurance-analysis.ts (Phase 4 — Insurance reasoning
// layer) and the insurance.ts TIV/deductible/coverageLimit framework additions (4a.1).
import { describe, expect, it } from 'vitest';
import { PolicyEconomics, BookBenchmark, InsuranceAnalysisReport } from '@contracts/insurance-analysis';
import { InsurancePolicy } from '@contracts/insurance';
import { CalibrationVerdictSchema } from '@contracts/warehouse';

// ── InsurancePolicy — TIV/deductible/coverageLimit framework (4a.1) ───────────

describe('InsurancePolicy — TIV framework fields', () => {
  const base = {
    id: 'pol-1',
    property: '1100 Rarig Ave',
    entity: null,
    coverage: 'Property Package',
    effective: '2025-01-01',
    expires: '2026-01-01',
    policyNo: 'PKG-001',
    carrier: 'Cincinnati Insurance',
    premium: 8400,
    daysToExpiry: 120,
    status: 'Current' as const,
    notes: null,
    flags: [],
  };

  it('parses a policy with tiv/deductible/coverageLimit populated', () => {
    const result = InsurancePolicy.parse({ ...base, tiv: 1_200_000, deductible: 25_000, coverageLimit: 1_200_000 });
    expect(result.tiv).toBe(1_200_000);
    expect(result.deductible).toBe(25_000);
    expect(result.coverageLimit).toBe(1_200_000);
  });

  it('parses a policy with tiv/deductible/coverageLimit null (workbook column absent)', () => {
    const result = InsurancePolicy.parse({ ...base, tiv: null, deductible: null, coverageLimit: null });
    expect(result.tiv).toBeNull();
    expect(result.deductible).toBeNull();
    expect(result.coverageLimit).toBeNull();
  });

  it('rejects a negative tiv', () => {
    expect(() => InsurancePolicy.parse({ ...base, tiv: -1, deductible: null, coverageLimit: null })).toThrow();
  });

  it('rejects a negative deductible', () => {
    expect(() => InsurancePolicy.parse({ ...base, tiv: null, deductible: -1, coverageLimit: null })).toThrow();
  });

  it('rejects a negative coverageLimit', () => {
    expect(() => InsurancePolicy.parse({ ...base, tiv: null, deductible: null, coverageLimit: -1 })).toThrow();
  });
});

// ── PolicyEconomics ────────────────────────────────────────────────────────────

describe('PolicyEconomics', () => {
  const valid = {
    policyId: 'pol-1',
    property: '1100 Rarig Ave',
    propertyId: 'prop-1100-rarig',
    carrier: 'Cincinnati Insurance',
    policyType: 'property-package',
    premium: 8400,
    tiv: 1_200_000,
    ratePer100Tiv: 0.7,
    cohort: 'property-package' as const,
    excessPremiumVsMedian: 420,
    renewalBucket: 'soon-90' as const,
    daysToExpiry: 75,
  };

  it('parses a minimal valid policy economics row', () => {
    const result = PolicyEconomics.parse(valid);
    expect(result.cohort).toBe('property-package');
    expect(result.renewalBucket).toBe('soon-90');
  });

  it('accepts null for null-tolerant fields (excluded-null-tiv cohort)', () => {
    const result = PolicyEconomics.parse({
      ...valid,
      propertyId: null,
      carrier: null,
      policyType: null,
      tiv: null,
      ratePer100Tiv: null,
      cohort: 'excluded-null-tiv' as const,
      excessPremiumVsMedian: null,
      daysToExpiry: null,
    });
    expect(result.tiv).toBeNull();
    expect(result.cohort).toBe('excluded-null-tiv');
  });

  it('allows a negative excessPremiumVsMedian (below the book median)', () => {
    const result = PolicyEconomics.parse({ ...valid, excessPremiumVsMedian: -150 });
    expect(result.excessPremiumVsMedian).toBe(-150);
  });

  it('allows a negative daysToExpiry (already expired)', () => {
    const result = PolicyEconomics.parse({ ...valid, renewalBucket: 'expired' as const, daysToExpiry: -10 });
    expect(result.daysToExpiry).toBe(-10);
  });

  it('rejects a negative premium', () => {
    expect(() => PolicyEconomics.parse({ ...valid, premium: -100 })).toThrow();
  });

  it('rejects a negative tiv', () => {
    expect(() => PolicyEconomics.parse({ ...valid, tiv: -100 })).toThrow();
  });

  it('rejects an invalid cohort', () => {
    expect(() => PolicyEconomics.parse({ ...valid, cohort: 'commercial-auto' })).toThrow();
  });

  it('rejects an invalid renewalBucket', () => {
    expect(() => PolicyEconomics.parse({ ...valid, renewalBucket: 'due-30' })).toThrow();
  });
});

// ── BookBenchmark ───────────────────────────────────────────────────────────

describe('BookBenchmark', () => {
  it('parses a sufficient benchmark', () => {
    const result = BookBenchmark.parse({
      cohort: 'property-package',
      medianRatePer100Tiv: 0.65,
      cohortN: 12,
      sufficient: true,
      basisNote: 'own-book median — dispersion, not market rate',
    });
    expect(result.sufficient).toBe(true);
  });

  it('parses an insufficient-cohort benchmark (n<5) with a null median', () => {
    const result = BookBenchmark.parse({
      cohort: 'property-package',
      medianRatePer100Tiv: null,
      cohortN: 2,
      sufficient: false,
      basisNote: 'own-book median — dispersion, not market rate',
    });
    expect(result.sufficient).toBe(false);
    expect(result.medianRatePer100Tiv).toBeNull();
  });

  it('rejects a cohort other than property-package', () => {
    expect(() =>
      BookBenchmark.parse({
        cohort: 'other',
        medianRatePer100Tiv: null,
        cohortN: 0,
        sufficient: false,
        basisNote: 'n/a',
      }),
    ).toThrow();
  });
});

// ── InsuranceAnalysisReport envelope ──────────────────────────────────────────

describe('InsuranceAnalysisReport', () => {
  const benchmark = {
    cohort: 'property-package' as const,
    medianRatePer100Tiv: 0.65,
    cohortN: 12,
    sufficient: true,
    basisNote: 'own-book median — dispersion, not market rate',
  };

  it('round-trips a full report', () => {
    const report = InsuranceAnalysisReport.parse({
      asOf: '2026-07-06',
      premiumAnnualTotal: 166_000,
      policiesN: 24,
      tivKnownN: 20,
      benchmark,
      rebidCandidates: [],
      renewalCalendar: [],
      advisoryOnly: true,
    });
    expect(report.policiesN).toBe(24);
    expect(report.advisoryOnly).toBe(true);
  });

  it('rejects a missing advisoryOnly flag', () => {
    const payload = {
      asOf: '2026-07-06',
      premiumAnnualTotal: 166_000,
      policiesN: 24,
      tivKnownN: 20,
      benchmark,
      rebidCandidates: [],
      renewalCalendar: [],
    };
    expect(() => InsuranceAnalysisReport.parse(payload)).toThrow();
  });

  it('rejects a negative premiumAnnualTotal', () => {
    expect(() =>
      InsuranceAnalysisReport.parse({
        asOf: '2026-07-06',
        premiumAnnualTotal: -1,
        policiesN: 24,
        tivKnownN: 20,
        benchmark,
        rebidCandidates: [],
        renewalCalendar: [],
        advisoryOnly: true,
      }),
    ).toThrow();
  });
});

// ── VerdictKind/VerdictEngine widening (4a.4 prerequisite) ────────────────────

describe('CalibrationVerdictSchema — insurance-rebid verdict kind (4a.4)', () => {
  it("parses a verdict with verdictKind 'insurance-rebid' and verdictEngine 'insurance-analysis'", () => {
    const verdict = CalibrationVerdictSchema.parse({
      subjectKind: 'property',
      subjectId: 'prop-1100-rarig',
      verdictKind: 'insurance-rebid',
      verdictEngine: 'insurance-analysis',
      predictedBand: 'rebid-recommended',
      predictedValue: 420,
      predictedUnit: 'usd',
      confidence: 0.6,
      direction: 'down',
      reasons: ['premium sits above own-book median rate for the property-package cohort'],
      asOfPeriod: '2025',
      horizonPeriods: 1,
      inputsVersion: '0123456789abcdef',
      emittedBy: 'insurance-analysis-engine',
    });
    expect(verdict.verdictKind).toBe('insurance-rebid');
    expect(verdict.verdictEngine).toBe('insurance-analysis');
  });
});
