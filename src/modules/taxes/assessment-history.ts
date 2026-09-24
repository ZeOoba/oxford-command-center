// src/modules/taxes/assessment-history.ts
//
// Task 26 — pure builders for the tax assessment history chart (AssessmentHistoryCard.tsx).
// Split into its own .ts file per repo convention (see leasing/rollover-chart-data.ts,
// insurance/PremiumHistoryCard.tsx's equivalent Task 25 precedent) — react-refresh/
// only-export-components forbids mixing non-component exports into a component .tsx file.
import type { TaxAssessment } from '@contracts/tax';

export interface TaxYearBar {
  label: string;
  value: number;
  /** Distinct properties contributing a billed-tax figure to this year (mirrors
   *  insurance-history.ts's byYear.lines — distinct contributors, not row count). */
  count: number;
}

/** Total annualTaxBilled per tax year (nulls skipped, ascending by year), plus the distinct
 *  count of properties contributing to that year — I-3: a year covering fewer properties than
 *  another reads identically to a full-portfolio year with no indication of the gap. */
export function taxByYear(a: TaxAssessment[]): TaxYearBar[] {
  const m = new Map<number, { value: number; properties: Set<string> }>();
  for (const r of a) {
    if (r.annualTaxBilled === null) continue;
    const cur = m.get(r.taxYear) ?? { value: 0, properties: new Set<string>() };
    cur.value += r.annualTaxBilled;
    cur.properties.add(r.propertyId);
    m.set(r.taxYear, cur);
  }
  return [...m.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([year, v]) => ({ label: String(year), value: v.value, count: v.properties.size }));
}

/**
 * Turns taxByYear rows into BarChart data, appending the property count to the label and
 * marking a year "(partial)" when it covers FEWER properties than the year with the most
 * (I-3) — e.g. this year's tax bill hasn't posted for every property yet.
 */
export function taxYearBars(rows: TaxYearBar[]): Array<{ label: string; value: number }> {
  const maxCount = rows.reduce((max, r) => Math.max(max, r.count), 0);
  return rows.map((r) => ({
    label: `${r.label}${r.count < maxCount ? ' (partial)' : ''} · ${r.count} prop${r.count === 1 ? '' : 's'}`,
    value: r.value,
  }));
}

/** Assessed-value series per property (ascending by year), only for properties with >=2 years of data. */
export function assessedSeries(a: TaxAssessment[]): Array<{ propertyId: string; values: number[] }> {
  const m = new Map<string, Array<[number, number]>>();
  for (const r of a) if (r.assessedValue !== null) m.set(r.propertyId, [...(m.get(r.propertyId) ?? []), [r.taxYear, r.assessedValue]]);
  return [...m.entries()]
    .filter(([, pts]) => pts.length >= 2)
    .map(([propertyId, pts]) => ({ propertyId, values: pts.sort((x, y) => x[0] - y[0]).map((p) => p[1]) }));
}
