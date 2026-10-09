// src/modules/property-financials/charts/PeriodBars.tsx
//
// GroupedBars (revenue / operating expense / NOI by period) and StackedBars (operating expense by
// category per period) of the Property explorer (plan T7; the reference artifact's barChart in its
// 'group' and 'stack' modes). Hand-built SVG over ./geometry on ONE value axis with a hairline grid;
// partial periods are faded AND labelled (legend note + tooltip line); every bar has a tooltip
// (MarkFrame); colours only from the fixed palette slots the data assigns (--pf-c1..8).
import { useMemo } from 'react';
import { useMeasure } from '@/lib/useMeasure';
import { axisUsd, usd } from '@analytics/property-financials/format';
import { stackTotalsData, type BarsData } from '../explorer-model';
import { barAxis, barY, chartWidth, groupedBarsLayout, stackedBarsLayout, stackHeights, type PlotBox } from './geometry';
import { Legend, MarkFrame, type TipMark } from './MarkFrame';

const H = 270;
const M = { l: 52, r: 10, t: 14, b: 36 } as const;
const slotColor = (slot: number) => `var(--pf-c${slot})`;

function plotOf(W: number): PlotBox {
  return { left: M.l, top: M.t, width: W - M.l - M.r, height: H - M.t - M.b };
}

function DataTable({ data, caption, total }: { data: BarsData; caption: string; total?: readonly string[] }) {
  return (
    <table>
      <caption className="pf-note" style={{ textAlign: 'left', captionSide: 'top' }}>
        {caption}
      </caption>
      <thead>
        <tr>
          <th scope="col">Period</th>
          {data.series.map((s) => (
            <th scope="col" key={s.id}>
              {s.label}
            </th>
          ))}
          {total && <th scope="col">Total</th>}
        </tr>
      </thead>
      <tbody>
        {data.columns.map((c, ci) => (
          <tr key={c.key}>
            <th scope="row" style={{ textAlign: 'left' }}>
              {c.label}
              {c.partial ? ' (partial)' : ''}
            </th>
            {data.series.map((s, si) => (
              <td key={s.id}>{usd(data.values[ci]![si]!, 'f')}</td>
            ))}
            {total && <td>{total[ci]}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Grid({ W, ticks, y }: { W: number; ticks: readonly number[]; y: (v: number) => number }) {
  return (
    <>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} stroke="var(--pf-grid)" strokeWidth={1} />
          <text x={M.l - 6} y={y(v) + 3} textAnchor="end">
            {axisUsd(v)}
          </text>
        </g>
      ))}
    </>
  );
}

export function GroupedBars({ data, ariaLabel }: { data: BarsData; ariaLabel: string }) {
  const [ref, measured] = useMeasure<HTMLDivElement>();
  const n = data.columns.length;
  const W = chartWidth(measured, n, 84, M.l + M.r);
  const plot = plotOf(W);
  const axis = useMemo(() => barAxis(data.values.flat()), [data]);
  const L = groupedBarsLayout(data.values, plot, axis);
  const y = barY(axis, plot);
  const marks: TipMark[] = L.bars.flatMap((g, gi) => g.map((b, si) => ({ x: b.x + b.width / 2, y: b.y, lines: data.tips[gi]![si]! })));
  const k = data.series.length;
  const anyPartial = data.columns.some((c) => c.partial);
  return (
    <MarkFrame
      measureRef={ref}
      width={W}
      height={H}
      ariaLabel={ariaLabel}
      marks={marks}
      testId="pf-grouped-bars"
      legend={
        <Legend
          items={data.series.map((s) => ({ label: s.label, color: slotColor(s.slot) }))}
          extra={anyPartial ? <span className="pf-mut">Faded bars are partial periods (not comparable)</span> : undefined}
        />
      }
      table={<DataTable data={data} caption={ariaLabel} />}
    >
      {(bind, active) => (
        <>
          <Grid W={W} ticks={axis.ticks} y={y} />
          {L.bars.map((g, gi) =>
            g.map((b, si) => {
              const i = gi * k + si;
              return (
                <rect
                  key={`${gi}-${si}`}
                  {...bind(i)}
                  x={b.x}
                  y={b.y}
                  width={b.width}
                  height={b.height}
                  fill={slotColor(data.series[si]!.slot)}
                  fillOpacity={data.columns[gi]!.partial ? 0.45 : 1}
                  stroke={active === i ? 'var(--pf-ink)' : 'none'}
                  strokeWidth={1}
                />
              );
            }),
          )}
          {data.columns.map((c, gi) => (
            <text key={c.key} x={L.centers[gi]} y={H - 14} textAnchor="middle" style={{ fill: 'var(--pf-ink2)' }}>
              {c.label}
            </text>
          ))}
          <line x1={M.l} x2={W - M.r} y1={L.zeroY} y2={L.zeroY} stroke="var(--pf-axis)" strokeWidth={1} />
        </>
      )}
    </MarkFrame>
  );
}

export function StackedBars({ data, ariaLabel }: { data: BarsData; ariaLabel: string }) {
  const [ref, measured] = useMeasure<HTMLDivElement>();
  const n = data.columns.length;
  const W = chartWidth(measured, n, 64, M.l + M.r);
  const plot = plotOf(W);
  // The axis and the drawn segments use the positive heights (a credit cannot be drawn on a stack
  // that floors at zero); every TOTAL shown (label, data table) is the signed one, credit named.
  const axis = useMemo(() => barAxis(stackHeights(data.values), { floorAtZero: true }), [data]);
  const totals = useMemo(() => data.stack ?? stackTotalsData(data.values), [data]);
  const L = stackedBarsLayout(data.values, plot, axis);
  const y = barY(axis, plot);
  const flat = L.segments.flatMap((g, gi) => g.map((s) => ({ gi, s })));
  const marks: TipMark[] = flat.map(({ gi, s }) => ({ x: s.x + s.width / 2, y: s.y, lines: data.tips[gi]![s.index]! }));
  // A category present only as a net credit keeps its legend entry, marked (it has no drawn segment).
  const present = data.series
    .map((s, si) => ({ s, drawn: data.values.some((g) => (g[si] ?? 0) > 0), any: data.values.some((g) => (g[si] ?? 0) !== 0) }))
    .filter((x) => x.any);
  const anyPartial = data.columns.some((c) => c.partial);
  const anyCredit = totals.credits.some((c) => c < 0);
  return (
    <MarkFrame
      measureRef={ref}
      width={W}
      height={H}
      ariaLabel={ariaLabel}
      marks={marks}
      testId="pf-stacked-bars"
      legend={
        <Legend
          items={present.map(({ s, drawn }) => ({ label: drawn ? s.label : `${s.label} (net credit, not drawn)`, color: slotColor(s.slot) }))}
          extra={
            anyPartial || anyCredit ? (
              <span className="pf-mut">
                {[anyPartial ? 'Faded bars are partial periods (not comparable)' : '', anyCredit ? 'Net credits are not drawn; totals include them' : ''].filter(Boolean).join('. ')}
              </span>
            ) : undefined
          }
        />
      }
      table={<DataTable data={data} caption={ariaLabel} total={totals.tableText} />}
    >
      {(bind, active) => (
        <>
          <Grid W={W} ticks={axis.ticks} y={y} />
          {flat.map(({ gi, s }, i) => (
            <rect
              key={`${gi}-${s.index}`}
              {...bind(i)}
              x={s.x}
              y={s.y}
              width={s.width}
              height={s.height}
              fill={slotColor(data.series[s.index]!.slot)}
              fillOpacity={data.columns[gi]!.partial ? 0.45 : 1}
              stroke={active === i ? 'var(--pf-ink)' : 'none'}
              strokeWidth={1}
            />
          ))}
          {data.columns.map((c, gi) => (
            <g key={c.key}>
              <text
                x={L.centers[gi]}
                y={L.topY[gi]! - (totals.creditNote[gi] ? 17 : 5)}
                textAnchor="middle"
                style={{ fill: 'var(--pf-ink2)' }}
                aria-label={totals.text[gi]}
              >
                {axisUsd(totals.totals[gi]!)}
              </text>
              {totals.creditNote[gi] && (
                <text x={L.centers[gi]} y={L.topY[gi]! - 5} textAnchor="middle" fontSize={9} style={{ fill: 'var(--pf-ink2)' }}>
                  {totals.creditNote[gi]}
                </text>
              )}
              <text x={L.centers[gi]} y={H - 14} textAnchor="middle" style={{ fill: 'var(--pf-ink2)' }}>
                {c.label}
              </text>
            </g>
          ))}
          <line x1={M.l} x2={W - M.r} y1={y(0)} y2={y(0)} stroke="var(--pf-axis)" strokeWidth={1} />
        </>
      )}
    </MarkFrame>
  );
}
