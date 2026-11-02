// src/charts/kit/DivergingBars.tsx
//
// Horizontal diverging bars around zero on ONE scale (the reference artifact's drawBars, corrected to
// a single scale — see geometry.divergingLayout). Each bar is a focusable mark with a hover / touch /
// keyboard tooltip; a two-entry legend names the two directions; a data-table fallback lists every
// value. Colour is never the only cue: each bar carries a signed value label.
import { useId, useState } from 'react';
import { useMeasure } from '@/lib/useMeasure';
import { divergingLayout } from './geometry';
import './kit.css';

export interface DivergingItem {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  /** Extra tooltip lines under the value. */
  readonly detail?: readonly string[];
}

export interface DivergingBarsProps {
  readonly items: readonly DivergingItem[];
  /** Signed, compact value text drawn at the bar end and in the tooltip. */
  readonly formatValue: (v: number) => string;
  readonly positive: { readonly label: string; readonly color: string };
  readonly negative: { readonly label: string; readonly color: string };
  readonly ariaLabel: string;
  readonly rowHeight?: number;
}

const BAR_H = 16;
const VALUE_GUTTER = 64;
const TIP_W = 190;

export function DivergingBars({ items, formatValue, positive, negative, ariaLabel, rowHeight = 30 }: DivergingBarsProps) {
  const [ref, measured] = useMeasure<HTMLDivElement>();
  const W = measured > 0 ? measured : 400;
  const labelW = Math.min(150, W * 0.4);
  const H = items.length * rowHeight + 22;
  const plot = { left: labelW + (items.some((i) => i.value < 0) ? 8 : 0), width: Math.max(10, W - labelW - VALUE_GUTTER - 8) };
  const layout = divergingLayout(items, plot);
  const [active, setActive] = useState<number | null>(null);
  const tableId = useId();

  const activeItem = active === null ? undefined : items[active];
  const activeBar = active === null ? undefined : layout.bars[active];
  const tipTop = active === null ? 0 : active * rowHeight + 6 + BAR_H + 4;
  const tipLeft = activeBar ? Math.max(0, Math.min(W - TIP_W, activeBar.x + activeBar.width / 2 - TIP_W / 2)) : 0;

  return (
    <div className="ck-chart" ref={ref} style={{ minHeight: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} aria-describedby={tableId} onPointerLeave={() => setActive(null)}>
        {items.map((it, i) => {
          const b = layout.bars[i]!;
          const y = i * rowHeight + 6;
          const up = it.value >= 0;
          const valueX = up ? b.x + b.width + 6 : layout.zero + 6;
          return (
            <g
              key={it.key}
              data-mark
              tabIndex={0}
              role="img"
              aria-label={`${it.label}: ${formatValue(it.value)}`}
              onPointerEnter={() => setActive(i)}
              onPointerDown={() => setActive(i)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
            >
              <rect x={0} y={y - 6} width={W} height={rowHeight} fill="transparent" />
              <text className="ck-bar-label" x={labelW - 8} y={y + 13} textAnchor="end">
                {it.label}
              </text>
              <rect x={b.x} y={y} width={Math.max(b.width, 1)} height={BAR_H} fill={up ? positive.color : negative.color} />
              <text className="ck-bar-value" x={valueX} y={y + 12} textAnchor="start">
                {formatValue(it.value)}
              </text>
            </g>
          );
        })}
        <line x1={layout.zero} x2={layout.zero} y1={0} y2={H - 16} stroke="var(--border-strong)" strokeWidth={1} />
        <text x={layout.zero} y={H - 3} textAnchor="middle">
          0
        </text>
      </svg>
      {activeItem && (
        <div className="ck-tip" role="status" style={{ left: tipLeft, top: tipTop, width: TIP_W }}>
          <b>{activeItem.label}</b>
          <div>{formatValue(activeItem.value)}</div>
          {activeItem.detail?.map((d) => (
            <div key={d} className="ck-mut">
              {d}
            </div>
          ))}
        </div>
      )}
      <div className="ck-legend">
        <span>
          <i style={{ background: positive.color }} aria-hidden />
          {positive.label}
        </span>
        <span>
          <i style={{ background: negative.color }} aria-hidden />
          {negative.label}
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
                <th scope="col">Category</th>
                <th scope="col">Change</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.key}>
                  <td>{it.label}</td>
                  <td>{formatValue(it.value)}</td>
                  <td style={{ textAlign: 'left', whiteSpace: 'normal' }}>{it.detail?.join('; ') ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
