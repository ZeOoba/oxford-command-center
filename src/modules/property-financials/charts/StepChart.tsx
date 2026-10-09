// src/modules/property-financials/charts/StepChart.tsx
//
// Lease rent schedule as a step line on a time axis (the reference artifact's stepChart): one axis,
// hairline grid, a 2px step line in palette slot 1, a dot per step with a tooltip (dates, monthly
// rent, change vs the prior step), a dashed "today" marker, and a data-table fallback.
import { useMeasure } from '@/lib/useMeasure';
import { axisUsd, usd } from '@analytics/property-financials/format';
import { stepChartLayout, tickValues } from './geometry';
import { MarkFrame, type TipMark } from './MarkFrame';
import type { LeaseStepRow } from '../explorer-model';

const H = 170;
const M = { l: 52, r: 14, t: 12, b: 26 } as const;

export function StepChart({ rows, today, ariaLabel }: { rows: readonly LeaseStepRow[]; today: string; ariaLabel: string }) {
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
      testId="pf-step-chart"
      table={
        <table>
          <caption className="pf-note" style={{ textAlign: 'left', captionSide: 'top' }}>
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
                <td>{usd(r.value, 'f')}</td>
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
              <line x1={M.l} x2={W - M.r} y1={L.y(v)} y2={L.y(v)} stroke="var(--pf-grid)" strokeWidth={1} />
              <text x={M.l - 6} y={L.y(v) + 3} textAnchor="end">
                {axisUsd(v)}
              </text>
            </g>
          ))}
          <path d={L.path} fill="none" stroke="var(--pf-c1)" strokeWidth={2} />
          {L.todayX !== null && (
            <g>
              <line x1={L.todayX} x2={L.todayX} y1={M.t} y2={H - M.b} stroke="var(--pf-gold)" strokeDasharray="3 3" />
              <text x={L.todayX} y={H - 8} textAnchor="middle" style={{ fill: 'var(--pf-gold-ink)' }}>
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
            <circle key={rows[i]!.from} {...bind(i)} cx={p.x} cy={p.y} r={active === i ? 6 : 5} fill="var(--pf-c1)" stroke="var(--pf-surface)" strokeWidth={2} />
          ))}
        </>
      )}
    </MarkFrame>
  );
}
