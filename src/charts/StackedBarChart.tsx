// Colour: segment fill is `colorAt(index of key in keys)` from theme.ts, which WRAPS after 6 keys.
// Callers should cap at 5 categories plus an 'Other' bucket (index 5 is the grey text-tertiary
// token, which suits 'Other'). The chart draws no legend; callers supply one.
// Labels: `data` labels must be unique (duplicates share a React key and collapse into one band).
import { useState } from 'react';
import { motion } from 'framer-motion';
import { Group } from '@visx/group';
import { scaleBand, scaleLinear } from '@visx/scale';
import { AxisBottom } from '@visx/axis';
import { useMeasure } from '@/lib/useMeasure';
import { AXIS_TICK, colorAt } from './theme';

export interface StackedBarDatum {
  label: string;
  segments: Array<{ key: string; value: number }>;
}

interface Props {
  data: StackedBarDatum[];
  /** Ordered category keys. Colour is `colorAt(index)` from the shared SERIES palette, so a
   *  category keeps its colour across charts that pass the same `keys`. It WRAPS after 6 keys:
   *  cap at 5 + an 'Other' bucket (index 5 = grey text-tertiary). No legend is drawn. Segments whose
   *  key is NOT listed here are ignored (not drawn, not counted in totals or the y domain). */
  keys: string[];
  height?: number;
  valueFormat?: (n: number) => string;
  ariaLabel?: string;
  /** Optional line drawn over the bars (e.g. same month last year). Points are matched to bars by
   *  `label`; entries with no matching bar label are dropped. */
  overlay?: Array<{ label: string; value: number }>;
}

interface Seg {
  key: string;
  value: number;
  top: number;
  height: number;
}
interface HoverState {
  index: number;
  left: number;
  top: number;
}

const fin = (n: number) => (Number.isFinite(n) ? n : 0);

/** Stacked vertical bars over a zero baseline. Positive segments stack upward, negative segments
 *  (credits) stack downward; rect heights are always >= 0. Segments stack in `keys` order. */
export function StackedBarChart({ data, keys, height = 250, valueFormat, ariaLabel, overlay }: Props) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<HoverState | null>(null);
  const margin = { top: 22, right: 6, bottom: 36, left: 6 };
  const iw = Math.max(0, width - margin.left - margin.right);
  const ih = Math.max(0, height - margin.top - margin.bottom);
  const fmt = (n: number) => (valueFormat ? valueFormat(n) : String(n));

  // Per bar: sum values by listed key (unlisted keys dropped), non-finite treated as 0.
  const bars = data.map((d) => {
    const byKey = new Map<string, number>();
    for (const s of d.segments) {
      if (keys.includes(s.key)) byKey.set(s.key, (byKey.get(s.key) ?? 0) + fin(s.value));
    }
    const parts = keys.map((k) => ({ key: k, value: byKey.get(k) ?? 0 })).filter((p) => p.value !== 0);
    const pos = parts.filter((p) => p.value > 0).reduce((a, p) => a + p.value, 0);
    const neg = parts.filter((p) => p.value < 0).reduce((a, p) => a + p.value, 0);
    return { label: d.label, parts, pos, neg, total: pos + neg };
  });

  const overlayPts = (overlay ?? []).filter((o) => data.some((d) => d.label === o.label) && Number.isFinite(o.value));

  const hasNeg = bars.some((b) => b.neg < 0) || overlayPts.some((o) => o.value < 0);
  let max = Math.max(0, ...bars.map((b) => b.pos), ...overlayPts.map((o) => o.value));
  const min = Math.min(0, ...bars.map((b) => b.neg), ...overlayPts.map((o) => o.value));
  if (max === 0 && min === 0) max = 1; // all-zero data: avoid a degenerate domain
  const x = scaleBand({ domain: data.map((d) => d.label), range: [0, iw], padding: 0.36 });
  // As in BarChart: with negatives the range stops short of the axis labels.
  const y = scaleLinear({ domain: [min, max], range: [hasNeg ? Math.max(0, ih - 18) : ih, 0] });
  const y0 = y(0);
  const bw = x.bandwidth();
  // Narrow charts (12 bars at 375px): thin the tick labels and drop the per-bar totals (the tooltip keeps
  // them) instead of letting neighbouring labels overprint each other.
  const step = data.length > 0 ? iw / data.length : 0;
  const tickEvery = step > 0 ? Math.max(1, Math.ceil(46 / step)) : 1;
  const tickLabels = data.map((d) => d.label).filter((_, i) => i % tickEvery === 0);
  const showTotals = step === 0 || step >= 40;

  const linePath = overlayPts
    .map((o, i) => `${i === 0 ? 'M' : 'L'}${(x(o.label) ?? 0) + bw / 2},${y(o.value)}`)
    .join(' ');

  const segGeometry = (b: (typeof bars)[number]): Seg[] => {
    let posCum = 0;
    let negCum = 0;
    return b.parts.map((p) => {
      if (p.value > 0) {
        const top = y(posCum + p.value);
        const h = y(posCum) - top;
        posCum += p.value;
        return { key: p.key, value: p.value, top, height: Math.max(0, h) };
      }
      const top = y(negCum);
      const h = y(negCum + p.value) - top;
      negCum += p.value;
      return { key: p.key, value: p.value, top, height: Math.max(0, h) };
    });
  };

  const hovered = hover ? bars[hover.index] : undefined;

  return (
    <div ref={ref} style={{ width: '100%', position: 'relative' }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel}>
          <Group left={margin.left} top={margin.top}>
            {bars.map((b, i) => {
              const bx = x(b.label) ?? 0;
              const active = hover?.index === i;
              const segs = segGeometry(b);
              const stackTop = segs.length ? Math.min(...segs.map((s) => s.top)) : y0;
              return (
                <g key={b.label}>
                  {segs.map((s) => (
                    <motion.rect
                      key={s.key}
                      data-key={s.key}
                      x={bx}
                      width={bw}
                      fill={colorAt(keys.indexOf(s.key))}
                      stroke="var(--surface-base, transparent)"
                      strokeWidth={0.5}
                      style={{ cursor: 'pointer', opacity: hover && !active ? 0.55 : 1, transition: 'opacity 120ms' }}
                      initial={{ height: 0, y: y0 }}
                      animate={{ height: s.height, y: s.top }}
                      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                      onMouseMove={() => setHover({ index: i, left: margin.left + bx + bw / 2, top: margin.top + stackTop })}
                      onMouseLeave={() => setHover(null)}
                    />
                  ))}
                  {segs.length > 0 && showTotals && (
                    <text
                      x={bx + bw / 2}
                      y={b.pos > 0 ? y(b.pos) - 7 : y(b.neg) + 15}
                      textAnchor="middle"
                      style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, fill: 'var(--text-secondary)', fontWeight: 600, pointerEvents: 'none' }}
                    >
                      {fmt(b.total)}
                    </text>
                  )}
                </g>
              );
            })}
            {hasNeg && (
              <line className="zero-baseline" x1={0} x2={iw} y1={y0} y2={y0} stroke="var(--border-strong)" strokeWidth={1} pointerEvents="none" />
            )}
            {overlayPts.length > 0 && (
              <path
                className="overlay-line"
                d={linePath}
                fill="none"
                stroke="var(--text-primary)"
                strokeWidth={1.5}
                strokeDasharray="4 3"
                pointerEvents="none"
              />
            )}
            <AxisBottom
              top={ih}
              scale={x}
              tickValues={tickLabels}
              hideAxisLine
              hideTicks
              tickLabelProps={() => ({ ...AXIS_TICK, textAnchor: 'middle', dy: '0.5em' })}
              tickFormat={(v) => (String(v).length > 14 ? `${String(v).slice(0, 13)}…` : String(v))}
            />
          </Group>
        </svg>
      )}
      {hover && hovered && (
        <div
          data-testid="stacked-tooltip"
          className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full rounded-[var(--radius-sm)] px-2 py-1 text-2xs"
          style={{
            left: hover.left,
            top: hover.top - 10,
            background: 'var(--surface-overlay)',
            border: '1px solid var(--border-strong)',
            boxShadow: '0 10px 24px -12px rgba(0,0,0,0.7)',
            whiteSpace: 'nowrap',
          }}
        >
          <div style={{ color: 'var(--text-tertiary)' }}>{hovered.label}</div>
          {hovered.parts.map((p) => (
            <div key={p.key} className="flex items-center justify-between gap-3">
              <span style={{ color: 'var(--text-secondary)' }}>
                <span
                  aria-hidden
                  style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, marginRight: 6, background: colorAt(keys.indexOf(p.key)) }}
                />
                {p.key}
              </span>
              <span className="num" style={{ color: 'var(--text-primary)' }}>
                {p.value < 0 ? `-${fmt(-p.value)}` : fmt(p.value)}
              </span>
            </div>
          ))}
          <div className="flex items-center justify-between gap-3 font-semibold" style={{ borderTop: '1px solid var(--border-strong)', marginTop: 2, paddingTop: 2 }}>
            <span style={{ color: 'var(--text-tertiary)' }}>Total</span>
            <span className="num" style={{ color: 'var(--text-primary)' }}>
              {hovered.total < 0 ? `-${fmt(-hovered.total)}` : fmt(hovered.total)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
