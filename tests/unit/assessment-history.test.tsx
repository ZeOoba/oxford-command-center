// tests/unit/assessment-history.test.tsx
//
// Task 26 — tax assessment history chart (Taxes › Assessments & Appeals).
// Pure builder coverage: taxByYear sums annualTaxBilled per year (nulls skipped, ascending);
// assessedSeries builds a per-property assessed-value series, only where >=2 years exist.
//
// Builders live in ./assessment-history.ts, not AssessmentHistoryCard.tsx (brief's stated import
// path) — react-refresh/only-export-components (max-warnings 0) forbids non-component exports
// from a component .tsx file; the repo's own Task-25 precedent (insurance/PremiumHistoryCard.tsx
// + leasing/rollover-chart-data.ts) keeps chart-data builders in a sibling .ts file. See
// AssessmentHistoryCard.tsx's header.
import { describe, expect, it } from 'vitest';
import { assessedSeries, taxByYear } from '../../src/modules/taxes/assessment-history';
import type { TaxAssessment } from '../../src/contracts/tax';

const a = (propertyId: string, taxYear: number, assessedValue: number | null, annualTaxBilled: number | null): TaxAssessment =>
  ({ propertyId, taxYear, jurisdiction: null, assessedValue, assessmentRatio: null, millageRate: null, annualTaxBilled, source: 's', asOf: null });

describe('tax history builders', () => {
  it('sums billed tax by year, skipping nulls', () => {
    expect(taxByYear([a('p', 2025, 1, 100), a('q', 2025, 1, 50), a('p', 2026, 1, null), a('p', 2024, 1, 90)]))
      .toEqual([{ label: '2024', value: 90 }, { label: '2025', value: 150 }]);
  });
  it('assessed-value series per property, only where ≥2 years exist', () => {
    expect(assessedSeries([a('p', 2025, 200, null), a('p', 2024, 180, null), a('q', 2025, 5, null)]))
      .toEqual([{ propertyId: 'p', values: [180, 200] }]);
  });
});
