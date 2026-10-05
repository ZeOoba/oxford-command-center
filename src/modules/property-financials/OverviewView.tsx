// src/modules/property-financials/OverviewView.tsx
//
// Overview tab (reference artifact "OVERVIEW"): computed lede, four KPI tiles, the same-store rent vs
// operating-cost chart, the what-moved diverging bars, and "Where the money is" with workflow
// controls. Every figure comes from model.ts / the calc lib; nothing here is hardcoded firm data.
import { useMemo, type ReactNode } from 'react';
import type { PfDataset, PfEntityId } from '@contracts/property-financials';
import { sameStoreSeries } from '@analytics/property-financials/metrics';
import { pct, usd } from '@analytics/property-financials/format';
import { LineChartCrosshair } from './charts/LineChartCrosshair';
import { DivergingBars } from './charts/DivergingBars';
import { MetricCell } from './components';
import { InsightRow } from './InsightWorkflow';
import { usePfInsightStatuses } from './hooks';
import { cubeMonths, fmtMonth, monthRangeLabel, opexDeltaItems, overviewKpis, overviewLede, toneClass, whereTheMoneyIs } from './model';

const kUsd = (v: number) => usd(v, 'k').replace('.0K', 'K');
const signedK = (v: number) => `${v >= 0 ? '+' : '-'}${kUsd(Math.abs(v))}`;

function Kpi({ label, value, children }: { label: string; value: string; children: ReactNode }) {
  return (
    <div className="pf-kpi">
      <div className="pf-kpi-l">{label}</div>
      <div className="pf-kpi-v">{value}</div>
      <div className="pf-kpi-d">{children}</div>
    </div>
  );
}

export function OverviewView({ dataset: d, onOpenProperty }: { dataset: PfDataset; onOpenProperty: (entity: PfEntityId) => void }) {
  const k = useMemo(() => overviewKpis(d), [d]);
  const lede = useMemo(() => overviewLede(d), [d]);
  const ytd = d.portfolio.same_store_YTD26_vs_YTD25;
  const priorLabel = monthRangeLabel(d.meta.periods.YTD25.months);
  const series = useMemo(() => {
    const months = cubeMonths(d, ytd.members);
    return sameStoreSeries(d.monthly, ytd.members, months);
  }, [d, ytd.members]);
  const deltas = useMemo(() => opexDeltaItems(ytd.view), [ytd.view]);
  const money = useMemo(() => whereTheMoneyIs(d.insights), [d.insights]);
  const statuses = usePfInsightStatuses();
  const byId = useMemo(() => new Map((statuses.data?.records ?? []).map((r) => [r.insightId, r])), [statuses.data]);
  const highTypes = [...new Set(d.insights.filter((i) => i.severity === 'High').map((i) => i.type.toLowerCase()))];

  const tax = deltas.find((x) => x.category === 'Real estate & property tax');
  const topUps = deltas.filter((x) => x.category !== 'Real estate & property tax' && x.value > 0).slice(0, 2);

  return (
    <div>
      <p className="pf-lede" data-testid="pf-lede">
        {lede}
      </p>
      <div className="pf-kpis" data-testid="pf-kpis">
        <Kpi label={`Base rent, ${k.periodLabel}`} value={usd(k.baseRent.current)}>
          <MetricCell result={k.baseRent.change} format={pct} className={(v) => toneClass(v)} /> vs {priorLabel}, {k.baseRent.members} same-store assets
        </Kpi>
        <Kpi label={`Opex excl. RE tax, ${k.periodLabel.split(' ')[0]}`} value={usd(k.opexExTax.current)}>
          <MetricCell result={k.opexExTax.change} format={pct} className={(v) => toneClass(v, true)} /> vs {priorLabel.split(' ').pop()} (tax is cash-timing)
        </Kpi>
        <Kpi label="NOI FY2025" value={usd(k.noiFy.current)}>
          <MetricCell result={k.noiFy.change} format={pct} className={(v) => toneClass(v)} /> vs FY2024, {k.noiFy.members} PM-reported assets with full-year history
        </Kpi>
        <Kpi label="High-severity items" value={String(k.high.count)}>
          across {highTypes.join(', ')}; {usd(k.high.grossSwing, 'k')} gross annual swing
        </Kpi>
      </div>

      <div className="pf-grid2">
        <div className="pf-panel">
          <h3>Same-store base rent vs operating cost</h3>
          <div className="pf-sub">
            Monthly, 3-month trailing average. {ytd.members.length} assets with full history. Operating cost excludes real estate tax, which is paid in lumps.
          </div>
          <LineChartCrosshair
            x={series.months}
            series={[
              { id: 'rent', label: 'Base rent', color: 'var(--pf-s1)', values: series.baseRent },
              { id: 'opex', label: 'Opex excl. real estate tax', color: 'var(--pf-s2)', values: series.opexExTax },
            ]}
            xTick={(m) => (m.endsWith('-01') ? m.slice(0, 4) : m.endsWith('-07') ? 'Jul' : null)}
            xTitle={(m) => fmtMonth(m)}
            formatAxis={kUsd}
            formatValue={(v) => `${usd(v, 'f')}/mo`}
            tooltipNote="3-month trailing average"
            ariaLabel="Monthly same-store base rent and operating cost excluding real estate tax, 3-month trailing average"
          />
        </div>
        <div className="pf-panel">
          <h3>
            What moved, {k.periodLabel} vs {priorLabel.split(' ').pop()}
          </h3>
          <div className="pf-sub">Change in dollars by cost category, same-store.</div>
          <DivergingBars
            items={deltas.map((x) => ({
              key: x.category,
              label: x.label,
              value: x.value,
              detail: [`${usd(x.prior, 'f')} → ${usd(x.current, 'f')}`, x.change.value === null ? `n/m: ${x.change.reason}` : `${pct(x.change.value)} change`],
            }))}
            formatValue={signedK}
            positive={{ label: 'Cost up', color: 'var(--pf-s2)' }}
            negative={{ label: 'Cost down', color: 'var(--pf-s1)' }}
            ariaLabel={`Change in operating cost by category, ${k.periodLabel} versus ${priorLabel}`}
          />
          <p className="pf-note" style={{ marginTop: 6 }} data-testid="pf-tax-note">
            {tax && tax.value < 0
              ? `Real estate tax reads ${signedK(tax.value)}: this is cash basis, so installments not yet paid are missing from the current period; compare tax on full years. `
              : ''}
            {topUps.length > 0 ? `The largest increases are ${topUps.map((x) => `${x.label.toLowerCase()} (${signedK(x.value)})`).join(' and ')}.` : 'No category rose.'}
          </p>
        </div>
      </div>

      <section className="pf-sec" aria-labelledby="pf-money">
        <h2 id="pf-money">Where the money is</h2>
        <div className="pf-note" style={{ marginBottom: 6 }}>
          High-severity items ranked by estimated annual swing. Sizes are estimates or sensitivities; the basis is stated on each item in the Expense watchlist and Rent &amp; NOI levers tabs.
          {statuses.isError && ' Owner, due date and status are unavailable right now (status store unreachable).'}
        </div>
        {money.map((i) => (
          <InsightRow key={i.id} insight={i} record={byId.get(i.id)} workflowAvailable={!statuses.isError} onOpenProperty={onOpenProperty} />
        ))}
      </section>
    </div>
  );
}
