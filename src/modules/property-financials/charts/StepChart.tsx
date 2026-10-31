// src/modules/property-financials/charts/StepChart.tsx
//
// Property explorer adapter over the shared kit's StepChart (roadmap 2.6): lease rent steps in the
// module's palette slot 1 with its USD formats.
import { axisUsd, usd } from '@analytics/property-financials/format';
import { StepChart as KitStepChart } from '@/charts/kit/StepChart';
import type { LeaseStepRow } from '../explorer-model';

export function StepChart({ rows, today, ariaLabel }: { rows: readonly LeaseStepRow[]; today: string; ariaLabel: string }) {
  return (
    <KitStepChart rows={rows} today={today} ariaLabel={ariaLabel} color="var(--pf-c1)" formatAxis={axisUsd} formatCell={(v) => usd(v, 'f')} testId="pf-step-chart" />
  );
}
