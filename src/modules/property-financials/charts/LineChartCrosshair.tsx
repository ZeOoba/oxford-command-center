// src/modules/property-financials/charts/LineChartCrosshair.tsx
//
// Multi-series line chart with a hover/touch/keyboard crosshair (the reference artifact's drawLine).
// Hand-built SVG over ./geometry: 2px lines, hairline grid, ONE y axis, last-point dots, a legend for
// two or more series, a tooltip at every x position, and a data-table fallback. Missing values are
// gaps, never zeros. Width tracks the container; the viewBox equals the measured width so text stays
// at its CSS size.
import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useMeasure } from '@/lib/useMeasure';
import { linePath, linearScale, nearestIndex, niceTop, tickValues } from './geometry';

export interface LineSeries {
  readonly id: string;
  readonly label: string;
  /** CSS colour, e.g. `var(--pf-s1)`. */
  readonly color: string;
  readonly values: ReadonlyArray<number | null>;
}

export interface LineChartCrosshairProps {
  readonly series: readonly LineSeries[];
  /** One category key per x position (e.g. `YYYY-MM`). */
  readonly x: readonly string[];
  /** Axis label for x position i, or null for no tick. */
  readonly xTick: (key: string, i: number) => string | null;
  /** Tooltip / table heading for x position i. */
  readonly xTitle: (key: string, i: number) => string;
  readonly formatAxis: (v: number) => string;
  readonly formatValue: (v: number) => string;
  readonly ariaLabel: string;
  /** Optional note under the tooltip values (e.g. "3-month average"). */
  readonly tooltipNote?: string;
  readonly height?: number;
}

const M = { l: 48, r: 12, t: 10, b: 26 } as const;
const TIP_W = 172;

export function LineChartCrosshair({ series, x, xTick, xTitle, formatAxis, formatValue, ariaLabel, tooltipNote, height = 280 }: LineChartCrosshairProps) {
  const [ref, measured] = useMeasure<HTMLDivElement>();
  const W = measured > 0 ? measured : 600;
  const H = height;
  const n = x.length;
  const [active, setActive] = useState<number | null>(null);
  const tableId = useId();

  const geo = useMemo(() => {
    const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null && Number.isFinite(v)));
    const { top } = niceTop(Math.max(0, ...all), 4);
    const xs = linearScale([0, Math.max(1, n - 1)], [M.l, W - M.r]);
    const ys = linearScale([0, top], [H - M.b, M.t]);
    // The first index with any value: trailing windows start late, so the crosshair starts there.
    const first = Math.max(0, x.findIndex((_, i) => series.some((s) => s.values[i] !== null && s.values[i] !== undefined)));
    return { top, xs, ys, first };
  }, [series, x, n, W, H]);

  const plotW = W - M.l - M.r;
  const move = (clientX: number, el: Element) => {
    const r = el.getBoundingClientRect();
    const scale = r.width > 0 ? W / r.width : 1;
    setActive(nearestIndex((clientX - r.left) * scale, M.l, plotW, n, { min: geo.first }));
  };
  const onPointer = (e: PointerEvent<SVGSVGElement>) => move(e.clientX, e.currentTarget);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = active ?? n - 1;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = cur - 1;
    else if (e.key === 'ArrowRight') next = cur + 1;
    else if (e.key === 'Home') next = geo.first;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Escape') {
      setActive(null);
      return;
    }
    if (next === null) return;
    e.preventDefault();
    setActive(Math.max(geo.first, Math.min(n - 1, next)));
  };

  const last = n - 1;
  const tipLeft = active === null ? 0 : geo.xs(active) + 12 + TIP_W > W ? geo.xs(active) - TIP_W : geo.xs(active) + 12;

  return (
    <div className="pf-chart" ref={ref}>
      <div
        className="pf-chart-focus"
        tabIndex={0}
        role="group"
        aria-label={`${ariaLabel}. Use the left and right arrow keys to read values; the data table below lists every point.`}
        aria-describedby={tableId}
        onKeyDown={onKey}
        onFocus={() => setActive((a) => a ?? last)}
        onBlur={() => setActive(null)}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={ariaLabel}
          onPointerMove={onPointer}
          onPointerDown={onPointer}
          onPointerLeave={() => setActive(null)}
          style={{ touchAction: 'pan-y' }}
        >
          {tickValues(0, geo.top, 4).map((v) => (
            <g key={v}>
              <line x1={M.l} x2={W - M.r} y1={geo.ys(v)} y2={geo.ys(v)} stroke="var(--pf-grid)" strokeWidth={1} />
              <text x={M.l - 6} y={geo.ys(v) + 3} textAnchor="end">
                {formatAxis(v)}
              </text>
            </g>
          ))}
          {x.map((k, i) => {
            const t = xTick(k, i);
            return t === null ? null : (
              <text key={k} x={geo.xs(i)} y={H - 8} textAnchor="middle">
                {t}
              </text>
            );
          })}
          {series.map((s) => (
            <path key={s.id} d={linePath(s.values, geo.xs, geo.ys)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {series.map((s) => {
            const v = s.values[last];
            return v === null || v === undefined ? null : (
              <circle key={`${s.id}-end`} cx={geo.xs(last)} cy={geo.ys(v)} r={4} fill={s.color} stroke="var(--pf-surface)" strokeWidth={2} />
            );
          })}
          {active !== null && (
            <line data-testid="pf-crosshair" x1={geo.xs(active)} x2={geo.xs(active)} y1={M.t} y2={H - M.b} stroke="var(--pf-axis)" strokeWidth={1} />
          )}
          <rect x={M.l} y={M.t} width={Math.max(0, plotW)} height={H - M.t - M.b} fill="transparent" />
        </svg>
        {active !== null && x[active] !== undefined && (
          <div className="pf-tip" role="status" style={{ left: tipLeft, top: 8 }}>
            <b>{xTitle(x[active]!, active)}</b>
            {series.map((s) => {
              const v = s.values[active];
              return (
                <div key={s.id}>
                  {s.label} {v === null || v === undefined ? '–' : formatValue(v)}
                </div>
              );
            })}
            {tooltipNote && <div className="pf-mut">{tooltipNote}</div>}
          </div>
        )}
      </div>
      {series.length >= 2 && (
        <div className="pf-legend">
          {series.map((s) => (
            <span key={s.id}>
              <i style={{ background: s.color }} aria-hidden />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <details className="pf-tablefb" id={tableId}>
        <summary>Data table</summary>
        <div className="pf-tbl">
          <table>
            <caption className="pf-note" style={{ textAlign: 'left', captionSide: 'top' }}>
              {ariaLabel}
            </caption>
            <thead>
              <tr>
                <th scope="col">Period</th>
                {series.map((s) => (
                  <th scope="col" key={s.id}>
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {x.map((k, i) =>
                series.every((s) => s.values[i] === null || s.values[i] === undefined) ? null : (
                  <tr key={k}>
                    <th scope="row" style={{ textAlign: 'left', borderBottom: '1px solid var(--pf-rule)' }}>
                      {xTitle(k, i)}
                    </th>
                    {series.map((s) => {
                      const v = s.values[i];
                      return <td key={s.id}>{v === null || v === undefined ? '–' : formatValue(v)}</td>;
                    })}
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
