// src/modules/taxes/AssessmentHistoryCard.tsx
//
// Task 26 — Taxes › Assessments & Appeals: a tax assessment history chart. Display-only — plots
// assessment values already present in TaxAssessment (src/contracts/tax.ts); computes no tax,
// appeal, or basis figure of its own. TaxAssessment is sourced from real assessor documents
// (import-assessments.ts) — it is NOT one of the P4c/C2 placeholder fixtures (docs/
// placeholder-data.md covers insurance loss-runs/dec-pages and tax cost-seg/filed-returns only),
// so no PlaceholderBanner applies here. Pure builders live in ./assessment-history.ts (non-
// component exports don't belong in a component .tsx — see that file's header).
import { BarChart } from '@/charts/BarChart';
import { Sparkline } from '@/charts/Sparkline';
import { Card, CardHeader } from '@/primitives/Card';
import { fmtUsdCompact } from '@/analytics/format';
import type { TaxAssessment } from '@contracts/tax';
import { assessedSeries, taxByYear, taxYearBars } from './assessment-history';

export function AssessmentHistoryCard({
  assessments,
  nameFor,
}: {
  assessments: TaxAssessment[];
  nameFor: (id: string) => string;
}) {
  const rows = taxByYear(assessments);
  const series = assessedSeries(assessments);
  // I-5: the convention is "no data at all -> render nothing" — NOT "no billed-tax bar ->
  // render nothing". A property with only assessed values (no billed tax yet) still has a
  // sparkline worth showing, and hiding the whole card silently dropped it.
  if (rows.length === 0 && series.length === 0) return null;
  const bars = taxYearBars(rows);
  return (
    <Card>
      <CardHeader title="Property Tax History" />
      {bars.length > 0 && (
        <div className="px-3 pb-2 pt-3">
          <BarChart data={bars} valueFormat={fmtUsdCompact} height={200} color="var(--color-warn)" ariaLabel="Property tax history by year" />
        </div>
      )}
      {series.length > 0 && (
        <ul className="grid grid-cols-1 gap-2 px-4 pb-4 md:grid-cols-2">
          {series.map((s) => (
            <li key={s.propertyId} className="flex items-center justify-between gap-3 text-2xs">
              <span style={{ color: 'var(--text-secondary)' }}>{nameFor(s.propertyId)} · assessed</span>
              <Sparkline data={s.values} width={72} height={20} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
