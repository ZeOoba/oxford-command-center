// src/modules/property-financials/charts/TimelineChart.tsx
//
// Monthly base rent vs operating expense excl. RE tax (3-month trailing) with net rent-step markers
// (the reference artifact's lineChart). Hand-built SVG over ./geometry: one axis, hairline grid, 2px
// lines (slot 1 = rent, slot 2 = opex), up / down TRIANGLE markers (shape + colour, never colour
// alone), a crosshair tooltip at every month on hover / touch / keyboard that includes the step
// detail when a marker sits on that month, a legend, and a data-table fallback. Wide histories
// scroll inside the chart container.
import { useId, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useMeasure } from '@/lib/useMeasure';
import '@/charts/kit/kit.css';
import { axisUsd, usd } from '@analytics/property-financials/format';
import { fmtMonth } from '../model';
import type { TimelineSeries } from '../explorer-model';
import { linePath, linearScale, markerPath, nearestIndex, niceTop, tickValues } from '@/charts/kit/geometry';

const H = 270;
const M = { l: 52, r: 12, t: 12, b: 28 } as const;
const TIP_W = 210;

export function TimelineChart({ series, ariaLabel }: { series: TimelineSeries; ariaLabel: string }) {
  const [ref, measured] = useMeasure<HTMLDivElement>();
  const n = series.months.length;
  const W = Math.max(measured > 0 ? measured : 600, Math.min(1400, n * 8) + M.l + M.r);
  const [active, setActive] = useState<number | null>(null);
  const tableId = useId();
  const all = [...series.baseRent, ...series.opexExTax].filter((v): v is number => v !== null && Number.isFinite(v));
  const { top } = niceTop(Math.max(0, ...all), 4);
  const X = linearScale([0, Math.max(1, n - 1)], [M.l, W - M.r]);
  const Y = linearScale([0, top], [H - M.b, M.t]);
  const plotW = W - M.l - M.r;
  const first = Math.max(0, series.baseRent.findIndex((v, i) => v !== null || series.opexExTax[i] !== null));
  const markerAt = new Map(series.markers.map((m) => [m.index, m]));

  const move = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const scale = r.width > 0 ? W / r.width : 1;
    setActive(nearestIndex((e.clientX - r.left) * scale, M.l, plotW, n, { min: first }));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = active ?? n - 1;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = cur - 1;
    else if (e.key === 'ArrowRight') next = cur + 1;
    else if (e.key === 'Home') next = first;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Escape') {
      setActive(null);
      return;
    }
    if (next === null) return;
    e.preventDefault();
    setActive(Math.max(first, Math.min(n - 1, next)));
  };

  const am = active === null ? undefined : series.months[active];
  const tipLeft = active === null ? 0 : X(active) + 14 + TIP_W > W ? X(active) - TIP_W - 14 : X(active) + 14;
  const v = (x: number | null | undefined) => (x === null || x === undefined ? '–' : usd(x, 'f'));
  const tri = (dir: 'up' | 'down', color: string) => (
    <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden style={{ marginRight: 6, verticalAlign: 'middle' }}>
      <path d={markerPath(6, 6, dir, 5)} fill={color} />
    </svg>
  );

  return (
    <div className="ck-xchart" data-testid="pf-timeline">
      <div className="ck-chart ck-chart-sx" ref={ref}>
        <div
          className="ck-cin ck-chart-focus"
          style={{ width: W }}
          tabIndex={0}
          role="group"
          aria-label={`${ariaLabel}. Use the left and right arrow keys to read each month; the data table below lists every point.`}
          aria-describedby={tableId}
          onKeyDown={onKey}
          onFocus={() => setActive((a) => a ?? n - 1)}
          onBlur={() => setActive(null)}
        >
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} onPointerMove={move} onPointerDown={move} onPointerLeave={() => setActive(null)} style={{ width: W, height: H, maxWidth: 'none', touchAction: 'pan-x pan-y' }}>
            {tickValues(0, top, 4).map((t) => (
              <g key={t}>
                <line x1={M.l} x2={W - M.r} y1={Y(t)} y2={Y(t)} stroke="var(--border-subtle)" strokeWidth={1} />
                <text x={M.l - 6} y={Y(t) + 3} textAnchor="end">
                  {axisUsd(t)}
                </text>
              </g>
            ))}
            {series.months.map((m, i) =>
              m.endsWith('-01') ? (
                <text key={m} x={X(i)} y={H - 8} textAnchor="middle">
                  {m.slice(0, 4)}
                </text>
              ) : null,
            )}
            <path d={linePath(series.opexExTax, X, Y)} fill="none" stroke="var(--pf-c2)" strokeWidth={2} strokeLinejoin="round" />
            <path d={linePath(series.baseRent, X, Y)} fill="none" stroke="var(--pf-c1)" strokeWidth={2} strokeLinejoin="round" />
            {series.markers.map((mk) => {
              const y = series.baseRent[mk.index];
              if (y === null || y === undefined) return null;
              return (
                <path
                  key={mk.event.m}
                  data-marker={mk.row.dir}
                  d={markerPath(X(mk.index), Y(y), mk.row.dir, 7)}
                  fill={mk.row.dir === 'up' ? 'var(--pf-good)' : 'var(--pf-crit)'}
                  stroke="var(--surface-raised)"
                  strokeWidth={1.5}
                />
              );
            })}
            {active !== null && <line x1={X(active)} x2={X(active)} y1={M.t} y2={H - M.b} stroke="var(--border-strong)" strokeWidth={1} />}
            <rect x={M.l} y={M.t} width={Math.max(0, plotW)} height={H - M.t - M.b} fill="transparent" />
          </svg>
          {active !== null && am && (
            <div className="ck-tip" role="status" style={{ left: Math.max(0, tipLeft), top: 6, width: TIP_W }}>
              <b>{fmtMonth(am)}</b>
              <div>Base rent {v(series.baseRent[active])}</div>
              <div>Opex excl. tax {v(series.opexExTax[active])}</div>
              <div className="ck-mut">3-month average</div>
              {markerAt.get(active)?.row.tip.map((l, i) => (
                <div key={i} className={i === 0 ? 'ck-tip-sep' : undefined}>
                  {l}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="ck-legend">
        <span>
          <i style={{ background: 'var(--pf-c1)' }} aria-hidden />
          Base rent per month
        </span>
        <span>
          <i style={{ background: 'var(--pf-c2)' }} aria-hidden />
          Operating expense excl. RE tax
        </span>
        <span>
          {tri('up', 'var(--pf-good)')}
          Net rent step up
        </span>
        <span>
          {tri('down', 'var(--pf-crit)')}
          Step down
        </span>
      </div>
      <details className="ck-tablefb" id={tableId}>
        <summary>Data table</summary>
        <div className="ck-tbl">
          <table>
            <caption className="ck-note" style={{ textAlign: 'left', captionSide: 'top' }}>
              {ariaLabel}
            </caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">Base rent (3-mo avg)</th>
                <th scope="col">Opex excl. tax (3-mo avg)</th>
                <th scope="col">Rent step</th>
              </tr>
            </thead>
            <tbody>
              {series.months.map((m, i) =>
                series.baseRent[i] === null && series.opexExTax[i] === null ? null : (
                  <tr key={m}>
                    <th scope="row" style={{ textAlign: 'left' }}>
                      {fmtMonth(m)}
                    </th>
                    <td>{v(series.baseRent[i])}</td>
                    <td>{v(series.opexExTax[i])}</td>
                    <td>{markerAt.get(i) ? markerAt.get(i)!.row.tip.slice(1).join('; ') : ''}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
