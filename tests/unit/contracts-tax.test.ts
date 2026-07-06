// tests/unit/contracts-tax.test.ts
//
// TDD boundary tests for src/contracts/tax.ts (Phase 6 — Taxes module).
import { describe, expect, it } from 'vitest';
import {
  TaxAssessment,
  TaxAppeal,
  TaxAppealInput,
  TaxOpportunity,
  TaxAnalysisReport,
} from '@contracts/tax';
import { CalibrationVerdictSchema } from '@contracts/warehouse';

// ── TaxAssessment ─────────────────────────────────────────────────────────────

describe('TaxAssessment', () => {
  const valid = {
    propertyId: 'prop-westbelt-a',
    taxYear: 2025,
    jurisdiction: 'Franklin County OH',
    assessedValue: 1_250_000,
    assessmentRatio: 0.35,
    millageRate: 62.5,
    annualTaxBilled: 27_343.75,
    source: 'Franklin County Auditor export 2026',
    asOf: '2026-01-15',
  };

  it('parses a valid assessment', () => {
    const result = TaxAssessment.parse(valid);
    expect(result.propertyId).toBe('prop-westbelt-a');
    expect(result.assessmentRatio).toBeCloseTo(0.35);
  });

  it('accepts null for every nullable field (workbook/assessor gaps are genuinely absent)', () => {
    const result = TaxAssessment.parse({
      ...valid,
      jurisdiction: null,
      assessedValue: null,
      assessmentRatio: null,
      millageRate: null,
      annualTaxBilled: null,
      asOf: null,
    });
    expect(result.assessedValue).toBeNull();
    expect(result.millageRate).toBeNull();
  });

  it('rejects an assessment ratio above 1', () => {
    expect(() => TaxAssessment.parse({ ...valid, assessmentRatio: 1.2 })).toThrow();
  });

  it('rejects a negative assessed value', () => {
    expect(() => TaxAssessment.parse({ ...valid, assessedValue: -100 })).toThrow();
  });

  it('rejects a negative millage rate', () => {
    expect(() => TaxAssessment.parse({ ...valid, millageRate: -1 })).toThrow();
  });

  it('rejects a non-integer tax year', () => {
    expect(() => TaxAssessment.parse({ ...valid, taxYear: 2025.5 })).toThrow();
  });
});

// ── TaxAppeal / TaxAppealInput ────────────────────────────────────────────────

describe('TaxAppeal', () => {
  const valid = {
    id: 'appeal-1',
    propertyId: 'prop-westbelt-a',
    taxYear: 2025,
    status: 'filed' as const,
    filedDate: '2026-02-01',
    estSavingsAnnual: 4200,
    realizedSavingsAnnual: null,
    notes: 'Filed with comparable sales evidence.',
  };

  it('parses a valid appeal', () => {
    expect(TaxAppeal.parse(valid).status).toBe('filed');
  });

  it('accepts null for nullable fields', () => {
    const result = TaxAppeal.parse({
      ...valid,
      filedDate: null,
      estSavingsAnnual: null,
      realizedSavingsAnnual: null,
      notes: null,
    });
    expect(result.filedDate).toBeNull();
  });

  it('rejects an invalid status', () => {
    expect(() => TaxAppeal.parse({ ...valid, status: 'appealed' })).toThrow();
  });

  for (const status of ['draft', 'filed', 'hearing', 'won', 'lost', 'withdrawn']) {
    it(`accepts status '${status}'`, () => {
      expect(TaxAppeal.parse({ ...valid, status }).status).toBe(status);
    });
  }
});

describe('TaxAppealInput', () => {
  it('parses a minimal create payload (no id, defaults applied)', () => {
    const result = TaxAppealInput.parse({ propertyId: 'prop-westbelt-a', taxYear: 2025 });
    expect(result.id).toBeUndefined();
    expect(result.status).toBe('draft');
    expect(result.filedDate).toBeNull();
    expect(result.estSavingsAnnual).toBeNull();
  });

  it('parses an update payload carrying an id', () => {
    const result = TaxAppealInput.parse({
      id: 'appeal-1',
      propertyId: 'prop-westbelt-a',
      taxYear: 2025,
      status: 'won',
      realizedSavingsAnnual: 3900,
    });
    expect(result.id).toBe('appeal-1');
    expect(result.status).toBe('won');
    expect(result.realizedSavingsAnnual).toBe(3900);
  });

  it('rejects an invalid status', () => {
    expect(() =>
      TaxAppealInput.parse({ propertyId: 'prop-westbelt-a', taxYear: 2025, status: 'pending' }),
    ).toThrow();
  });
});

// ── TaxOpportunity ─────────────────────────────────────────────────────────────

describe('TaxOpportunity', () => {
  const valid = {
    propertyId: 'prop-westbelt-a',
    propertyName: 'Westbelt A',
    kind: 'appeal' as const,
    title: 'Assessment exceeds indicated value',
    detail: 'Assessed value sits 18% above the income-indicated value at current millage.',
    savingsFullAsset: 6720,
    savingsOxfordShare: 4200,
    basisNote: 'full-asset assessment × Oxford 62.5% share',
    effectiveRate: 0.0219,
    cohortPercentile: 82,
    indeterminate: false,
    prov: { source: 'property_tax_assessments 2025', confidence: 'derived' as const },
    advisoryOnly: true as const,
  };

  it('parses a minimal valid opportunity', () => {
    const result = TaxOpportunity.parse(valid);
    expect(result.kind).toBe('appeal');
    expect(result.advisoryOnly).toBe(true);
  });

  it('parses an indeterminate opportunity (missing millage → null savings, not $0)', () => {
    const result = TaxOpportunity.parse({
      ...valid,
      kind: 'assessment-watch',
      savingsFullAsset: null,
      savingsOxfordShare: null,
      effectiveRate: null,
      cohortPercentile: null,
      indeterminate: true,
    });
    expect(result.indeterminate).toBe(true);
    expect(result.savingsFullAsset).toBeNull();
  });

  it('rejects a bad kind', () => {
    expect(() => TaxOpportunity.parse({ ...valid, kind: 'reassessment' })).toThrow();
  });

  it('rejects a missing advisoryOnly flag', () => {
    const { advisoryOnly: _omit, ...noFlag } = valid as Record<string, unknown>;
    expect(() => TaxOpportunity.parse(noFlag)).toThrow();
  });

  it('rejects advisoryOnly: false (must be the literal true)', () => {
    expect(() => TaxOpportunity.parse({ ...valid, advisoryOnly: false })).toThrow();
  });
});

// ── TaxAnalysisReport envelope ─────────────────────────────────────────────────

describe('TaxAnalysisReport', () => {
  it('round-trips a full report', () => {
    const report = TaxAnalysisReport.parse({
      asOf: '2026-07-06',
      propertiesCovered: 27,
      propertiesIndeterminate: 3,
      ledgerTaxAnnualUsd: 412_000,
      opportunities: [],
      assessments: [],
      appeals: [],
      advisoryOnly: true,
    });
    expect(report.propertiesCovered).toBe(27);
    expect(report.advisoryOnly).toBe(true);
  });

  it('accepts a null ledger total (no Taxes-classified rows for the period)', () => {
    const report = TaxAnalysisReport.parse({
      asOf: '2026-07-06',
      propertiesCovered: 0,
      propertiesIndeterminate: 0,
      ledgerTaxAnnualUsd: null,
      opportunities: [],
      assessments: [],
      appeals: [],
      advisoryOnly: true,
    });
    expect(report.ledgerTaxAnnualUsd).toBeNull();
  });

  it('rejects a negative propertiesCovered count', () => {
    expect(() =>
      TaxAnalysisReport.parse({
        asOf: '2026-07-06',
        propertiesCovered: -1,
        propertiesIndeterminate: 0,
        ledgerTaxAnnualUsd: null,
        opportunities: [],
        assessments: [],
        appeals: [],
        advisoryOnly: true,
      }),
    ).toThrow();
  });
});

// ── VerdictKind/VerdictEngine widening (4a.4/6a.4 prerequisite) ───────────────

describe('CalibrationVerdictSchema — tax-appeal verdict kind (6a.4)', () => {
  it("parses a verdict with verdictKind 'tax-appeal' and verdictEngine 'tax-analysis'", () => {
    const verdict = CalibrationVerdictSchema.parse({
      subjectKind: 'property',
      subjectId: 'prop-westbelt-a',
      verdictKind: 'tax-appeal',
      verdictEngine: 'tax-analysis',
      predictedBand: 'appeal-recommended',
      predictedValue: 4200,
      predictedUnit: 'usd',
      confidence: 0.7,
      direction: 'down',
      reasons: ['assessed value exceeds indicated value by 18%'],
      asOfPeriod: '2025',
      horizonPeriods: 1,
      inputsVersion: '0123456789abcdef',
      emittedBy: 'tax-analysis-engine',
    });
    expect(verdict.verdictKind).toBe('tax-appeal');
    expect(verdict.verdictEngine).toBe('tax-analysis');
  });
});
