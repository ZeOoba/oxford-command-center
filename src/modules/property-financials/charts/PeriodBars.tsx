// src/modules/property-financials/charts/PeriodBars.tsx
//
// Property explorer adapters over the shared kit's GroupedBars / StackedBars (roadmap 2.6): map the
// data's fixed palette slots onto the module's --pf-c1..8 colours and apply the module's USD formats.
import { axisUsd, usd } from '@analytics/property-financials/format';
import { GroupedBars as KitGroupedBars, StackedBars as KitStackedBars, type BarsData as KitBars } from '@/charts/kit/PeriodBars';
import { stackTotalsData, type BarsData } from '../explorer-model';

const slotColor = (slot: number) => `var(--pf-c${slot})`;
const cell = (v: number) => usd(v, 'f');

function toKit(data: BarsData): KitBars {
  return { columns: data.columns, series: data.series.map((s) => ({ id: s.id, label: s.label, color: slotColor(s.slot) })), values: data.values, tips: data.tips };
}

export function GroupedBars({ data, ariaLabel }: { data: BarsData; ariaLabel: string }) {
  return <KitGroupedBars data={toKit(data)} ariaLabel={ariaLabel} formatAxis={axisUsd} formatCell={cell} testId="pf-grouped-bars" />;
}

export function StackedBars({ data, ariaLabel }: { data: BarsData; ariaLabel: string }) {
  return (
    <KitStackedBars
      data={toKit(data)}
      stack={data.stack ?? stackTotalsData(data.values)}
      ariaLabel={ariaLabel}
      formatAxis={axisUsd}
      formatCell={cell}
      testId="pf-stacked-bars"
    />
  );
}
