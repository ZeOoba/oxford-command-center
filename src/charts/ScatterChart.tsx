/* eslint-disable react-refresh/only-export-components -- pure scatterDomain helper colocated with its chart (unit-tested) */
// Frame: the shared kit's MarkFrame (roadmap 2.6) — one tab stop whose arrow keys walk the points,
// a tooltip per point on hover / touch / keyboard, and a <details> data-table fallback. The plot keeps
// its 640px drawing space at its true size, so on a narrow card it scrolls inside the frame instead of
// shrinking its text.
import { scaleLinear } from '@visx/scale';
import { AxisBottom, AxisLeft } from '@visx/axis';
import { AXIS_TICK, AXIS_LABEL } from './theme';
import { MarkFrame, type TipMark } from './kit/MarkFrame';

export interface ScatterPoint { id: string; x: number; y: number; label: string; tone?: 'pos' | 'neg' | 'neutral' }

export function scatterDomain(points: ScatterPoint[], pad = 0.1): { x: [number, number]; y: [number, number] } {
  const span = (vals: number[]): [number, number] => {
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const r = hi - lo || Math.abs(hi) || 1;
    return [lo - r * pad, hi + r * pad];
  };
  return { x: span(points.map((p) => p.x)), y: span(points.map((p) => p.y)) };
}

const TONE = { pos: 'var(--color-pos)', neg: 'var(--color-neg)', neutral: 'var(--accent)' } as const;
const W = 640;
// left widened 56 -> 68 (I-1): the y-axis label needs to clear its own tick labels (e.g.
// "-275 bps") before it starts, and 56px wasn't enough room for both.
const M = { top: 12, right: 16, bottom: 40, left: 68 };

export function ScatterChart({ points, xLabel, yLabel, xFormat, yFormat, height = 280, yRef }: {
  points: ScatterPoint[]; xLabel: string; yLabel: string;
  xFormat: (n: number) => string; yFormat: (n: number) => string; height?: number; yRef?: number;
}) {
  if (points.length === 0) return null;
  const d = scatterDomain(points);
  const x = scaleLinear({ domain: d.x, range: [M.left, W - M.right] });
  const y = scaleLinear({ domain: d.y, range: [height - M.bottom, M.top] });
  const ariaLabel = `${yLabel} vs ${xLabel}`;
  const marks: TipMark[] = points.map((p) => ({ x: x(p.x), y: y(p.y), lines: [p.label, `${xLabel}: ${xFormat(p.x)}`, `${yLabel}: ${yFormat(p.y)}`] }));
  const table = (
    <table>
      <caption className="ck-note" style={{ textAlign: 'left', captionSide: 'top' }}>
        {ariaLabel}
      </caption>
      <thead>
        <tr>
          <th scope="col">Point</th>
          <th scope="col">{xLabel}</th>
          <th scope="col">{yLabel}</th>
        </tr>
      </thead>
      <tbody>
        {points.map((p) => (
          <tr key={p.id}>
            <th scope="row">{p.label}</th>
            <td>{xFormat(p.x)}</td>
            <td>{yFormat(p.y)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <MarkFrame measureRef={null} width={W} height={height} ariaLabel={ariaLabel} marks={marks} table={table}>
      {(bind, active) => (
        <>
          {yRef !== undefined && (
            <line x1={M.left} x2={W - M.right} y1={y(yRef)} y2={y(yRef)} stroke="var(--text-tertiary)" strokeDasharray="4 4" />
          )}
          {points.map((p, i) => (
            <circle
              key={p.id}
              {...bind(i)}
              cx={x(p.x)}
              cy={y(p.y)}
              r={active === i ? 7 : 5}
              fill={TONE[p.tone ?? 'neutral']}
              fillOpacity={0.8}
              stroke={active === i ? 'var(--text-primary)' : 'none'}
              strokeWidth={1.5}
            >
              <title>{`${p.label} — ${xLabel} ${xFormat(p.x)}, ${yLabel} ${yFormat(p.y)}`}</title>
            </circle>
          ))}
          <AxisBottom top={height - M.bottom} scale={x} tickFormat={(v) => xFormat(Number(v))} numTicks={5} label={xLabel}
            stroke="var(--border-subtle)" tickStroke="var(--border-subtle)" tickLabelProps={{ ...AXIS_TICK }}
            labelProps={{ ...AXIS_LABEL, style: { fill: AXIS_LABEL.fill } }} labelOffset={12} />
          <AxisLeft left={M.left} scale={y} tickFormat={(v) => yFormat(Number(v))} numTicks={5} label={yLabel}
            stroke="var(--border-subtle)" tickStroke="var(--border-subtle)" tickLabelProps={{ ...AXIS_TICK }}
            labelProps={{ ...AXIS_LABEL, style: { fill: AXIS_LABEL.fill } }} labelOffset={44} />
        </>
      )}
    </MarkFrame>
  );
}
