// src/modules/taxes/assessment-history.ts
//
// Task 26 — pure builders for the tax assessment history chart (AssessmentHistoryCard.tsx).
// Split into its own .ts file per repo convention (see leasing/rollover-chart-data.ts,
// insurance/PremiumHistoryCard.tsx's equivalent Task 25 precedent) — react-refresh/
// only-export-components forbids mixing non-component exports into a component .tsx file.
import type { TaxAssessment } from '@contracts/tax';

/** Total annualTaxBilled per tax year, nulls skipped, ascending by year. */
export function taxByYear(a: TaxAssessment[]): Array<{ label: string; value: number }> {
  const m = new Map<number, number>();
  for (const r of a) if (r.annualTaxBilled !== null) m.set(r.taxYear, (m.get(r.taxYear) ?? 0) + r.annualTaxBilled);
  return [...m.entries()].sort((x, y) => x[0] - y[0]).map(([y, v]) => ({ label: String(y), value: v }));
}

/** Assessed-value series per property (ascending by year), only for properties with >=2 years of data. */
export function assessedSeries(a: TaxAssessment[]): Array<{ propertyId: string; values: number[] }> {
  const m = new Map<string, Array<[number, number]>>();
  for (const r of a) if (r.assessedValue !== null) m.set(r.propertyId, [...(m.get(r.propertyId) ?? []), [r.taxYear, r.assessedValue]]);
  return [...m.entries()]
    .filter(([, pts]) => pts.length >= 2)
    .map(([propertyId, pts]) => ({ propertyId, values: pts.sort((x, y) => x[0] - y[0]).map((p) => p[1]) }));
}
