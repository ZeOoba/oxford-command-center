// src/charts/kit/StepChart.tsx
//
// A schedule as a step line on a time axis (the reference artifact's stepChart; built for lease rent
// steps, promoted by roadmap 2.6): one axis, hairline grid, a 2px step line, a dot per step with a
// tooltip, a dashed "today" marker, and a data-table fallback. Colour and formats come from the caller.
import { useMeasure } from '@/lib/useMeasure';
import { stepChartLayout, tickValues, type ScheduleStep } from './geometry';
import { MarkFrame, type TipMark } from './MarkFrame';

export interface StepRow extends ScheduleStep {
  /** Tooltip lines, title first. */
  readonly tip: readonly string[];
}

interface Props {
  readonly rows: readonly StepRow[];
  readonly today: string;
  readonly ariaLabel: string;
  /** CSS colour of the line and dots. */
  readonly color: string;
  readonly formatAxis: (v: number) => string;
  readonly formatCell: (v: number) => string;
  readonly testId?: string;
}

const H = 170;
const M = { l: 52, r: 14, t: 12, b: 26 } as const;

export function StepChart({ rows, today, ariaLabel, color, formatAxis, formatCell, testId }: Props) {
  const [ref, measured] = useMeasure<HTMLDivElement>();
  const W = Math.max(measured > 0 ? measured : 520, 420);
  const L = stepChartLayout(rows, { left: M.l, top: M.t, width: W - M.l - M.r, height: H - M.t - M.b }, today);
  const marks: TipMark[] = L.points.map((p, i) => ({ x: p.x, y: p.y, lines: rows[i]!.tip }));
  return (
    <MarkFrame
      measureRef={ref}
      width={W}
      height={H}
      ariaLabel={ariaLabel}
      marks={marks}
      testId={testId}
      table={
        <table>
          <caption className="ck-note" style={{ textAlign: 'left', captionSide: 'top' }}>
            {ariaLabel}
          </caption>
          <thead>
            <tr>
              <th scope="col">From</th>
              <th scope="col">To</th>
              <th scope="col">Monthly</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.from}>
                <td>{r.from}</td>
                <td>{r.to}</td>
                <td>{formatCell(r.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    >
      {(bind, active) => (
        <>
          {tickValues(0, L.top, 3).map((v) => (
            <g key={v}>
              <line x1={M.l} x2={W - M.r} y1={L.y(v)} y2={L.y(v)} stroke="var(--border-subtle)" strokeWidth={1} />
              <text x={M.l - 6} y={L.y(v) + 3} textAnchor="end">
                {formatAxis(v)}
              </text>
            </g>
          ))}
          <path d={L.path} fill="none" stroke={color} strokeWidth={2} />
          {L.todayX !== null && (
            <g>
              <line x1={L.todayX} x2={L.todayX} y1={M.t} y2={H - M.b} stroke="var(--accent)" strokeDasharray="3 3" />
              <text x={L.todayX} y={H - 8} textAnchor="middle" style={{ fill: 'var(--text-accent)' }}>
                today
              </text>
            </g>
          )}
          {L.yearLabels.map((t) => (
            <text key={t.anchor} x={t.x} y={H - 8} textAnchor={t.anchor}>
              {t.text}
            </text>
          ))}
          {L.points.map((p, i) => (
            <circle key={rows[i]!.from} {...bind(i)} cx={p.x} cy={p.y} r={active === i ? 6 : 5} fill={color} stroke="var(--surface-raised)" strokeWidth={2} />
          ))}
        </>
      )}
    </MarkFrame>
  );
}
