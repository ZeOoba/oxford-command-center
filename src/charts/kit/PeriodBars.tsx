// src/charts/kit/PeriodBars.tsx
//
// GroupedBars and StackedBars of the shared chart kit (built for the Property explorer, plan T7, as
// the reference artifact's barChart 'group' / 'stack' modes; promoted by roadmap 2.6). Hand-built SVG
// over ./geometry on ONE value axis with a hairline grid; partial periods are faded AND labelled
// (legend note + tooltip line); every bar has a tooltip (MarkFrame). Series colours, number formats
// and the stack totals come from the caller: the kit holds no palette and no currency rules.
import { useMemo } from 'react';
import { useMeasure } from '@/lib/useMeasure';
import { barAxis, barY, chartWidth, groupedBarsLayout, stackedBarsLayout, stackHeights, type PlotBox } from './geometry';
import { Legend, MarkFrame, type TipMark } from './MarkFrame';

export interface BarColumn {
  readonly key: string;
  readonly label: string;
  /** A partial period: drawn faded and named in the legend and the table. */
  readonly partial: boolean;
}

export interface BarSeries {
  readonly id: string;
  readonly label: string;
  /** CSS colour, e.g. `var(--color-info)`. */
  readonly color: string;
}

export interface BarsData {
  readonly columns: readonly BarColumn[];
  readonly series: readonly BarSeries[];
  /** [column][series] */
  readonly values: ReadonlyArray<readonly number[]>;
  /** [column][series] tooltip lines, title first. */
  readonly tips: ReadonlyArray<ReadonlyArray<readonly string[]>>;
}

/** Per-column SIGNED totals of a stack (drawn segments floor at zero; credits are named, not drawn). */
export interface StackTotals {
  readonly totals: readonly number[];
  readonly credits: readonly number[];
  /** Accessible / compact total text per column. */
  readonly text: readonly string[];
  /** The data-table Total cell per column. */
  readonly tableText: readonly string[];
  /** Short note under the total label, or null when the column has no credit. */
  readonly creditNote: ReadonlyArray<string | null>;
}

interface Format {
  readonly formatAxis: (v: number) => string;
  /** Data-table cell. */
  readonly formatCell: (v: number) => string;
}

const H = 270;
const M = { l: 52, r: 10, t: 14, b: 36 } as const;

function plotOf(W: number): PlotBox {
  return { left: M.l, top: M.t, width: W - M.l - M.r, height: H - M.t - M.b };
}

function DataTable({ data, caption, total, formatCell }: { data: BarsData; caption: string; total?: readonly string[]; formatCell: (v: number) => string }) {
  return (
    <table>
      <caption className="ck-note" style={{ textAlign: 'left', captionSide: 'top' }}>
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
              <td key={s.id}>{formatCell(data.values[ci]![si]!)}</td>
            ))}
            {total && <td>{total[ci]}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Grid({ W, ticks, y, formatAxis }: { W: number; ticks: readonly number[]; y: (v: number) => number; formatAxis: (v: number) => string }) {
  return (
    <>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} stroke="var(--border-subtle)" strokeWidth={1} />
          <text x={M.l - 6} y={y(v) + 3} textAnchor="end">
            {formatAxis(v)}
          </text>
        </g>
      ))}
    </>
  );
}

export function GroupedBars({ data, ariaLabel, formatAxis, formatCell, testId }: { data: BarsData; ariaLabel: string; testId?: string } & Format) {
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
      testId={testId}
      legend={
        <Legend
          items={data.series.map((s) => ({ label: s.label, color: s.color }))}
          extra={anyPartial ? <span className="ck-mut">Faded bars are partial periods (not comparable)</span> : undefined}
        />
      }
      table={<DataTable data={data} caption={ariaLabel} formatCell={formatCell} />}
    >
      {(bind, active) => (
        <>
          <Grid W={W} ticks={axis.ticks} y={y} formatAxis={formatAxis} />
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
                  fill={data.series[si]!.color}
                  fillOpacity={data.columns[gi]!.partial ? 0.45 : 1}
                  stroke={active === i ? 'var(--text-primary)' : 'none'}
                  strokeWidth={1}
                />
              );
            }),
          )}
          {data.columns.map((c, gi) => (
            <text key={c.key} x={L.centers[gi]} y={H - 14} textAnchor="middle" style={{ fill: 'var(--text-secondary)' }}>
              {c.label}
            </text>
          ))}
          <line x1={M.l} x2={W - M.r} y1={L.zeroY} y2={L.zeroY} stroke="var(--border-strong)" strokeWidth={1} />
        </>
      )}
    </MarkFrame>
  );
}

export function StackedBars({ data, stack: totals, ariaLabel, formatAxis, formatCell, testId }: { data: BarsData; stack: StackTotals; ariaLabel: string; testId?: string } & Format) {
  const [ref, measured] = useMeasure<HTMLDivElement>();
  const n = data.columns.length;
  const W = chartWidth(measured, n, 64, M.l + M.r);
  const plot = plotOf(W);
  // The axis and the drawn segments use the positive heights (a credit cannot be drawn on a stack
  // that floors at zero); every TOTAL shown (label, data table) is the signed one, credit named.
  const axis = useMemo(() => barAxis(stackHeights(data.values), { floorAtZero: true }), [data]);
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
      testId={testId}
      legend={
        <Legend
          items={present.map(({ s, drawn }) => ({ label: drawn ? s.label : `${s.label} (net credit, not drawn)`, color: s.color }))}
          extra={
            anyPartial || anyCredit ? (
              <span className="ck-mut">
                {[anyPartial ? 'Faded bars are partial periods (not comparable)' : '', anyCredit ? 'Net credits are not drawn; totals include them' : ''].filter(Boolean).join('. ')}
              </span>
            ) : undefined
          }
        />
      }
      table={<DataTable data={data} caption={ariaLabel} total={totals.tableText} formatCell={formatCell} />}
    >
      {(bind, active) => (
        <>
          <Grid W={W} ticks={axis.ticks} y={y} formatAxis={formatAxis} />
          {flat.map(({ gi, s }, i) => (
            <rect
              key={`${gi}-${s.index}`}
              {...bind(i)}
              x={s.x}
              y={s.y}
              width={s.width}
              height={s.height}
              fill={data.series[s.index]!.color}
              fillOpacity={data.columns[gi]!.partial ? 0.45 : 1}
              stroke={active === i ? 'var(--text-primary)' : 'none'}
              strokeWidth={1}
            />
          ))}
          {data.columns.map((c, gi) => (
            <g key={c.key}>
              <text
                x={L.centers[gi]}
                y={L.topY[gi]! - (totals.creditNote[gi] ? 17 : 5)}
                textAnchor="middle"
                style={{ fill: 'var(--text-secondary)' }}
                aria-label={totals.text[gi]}
              >
                {formatAxis(totals.totals[gi]!)}
              </text>
              {totals.creditNote[gi] && (
                <text x={L.centers[gi]} y={L.topY[gi]! - 5} textAnchor="middle" fontSize={9} style={{ fill: 'var(--text-secondary)' }}>
                  {totals.creditNote[gi]}
                </text>
              )}
              <text x={L.centers[gi]} y={H - 14} textAnchor="middle" style={{ fill: 'var(--text-secondary)' }}>
                {c.label}
              </text>
            </g>
          ))}
          <line x1={M.l} x2={W - M.r} y1={y(0)} y2={y(0)} stroke="var(--border-strong)" strokeWidth={1} />
        </>
      )}
    </MarkFrame>
  );
}
