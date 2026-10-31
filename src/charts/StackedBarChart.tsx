// Colour: segment fill is `colorAt(index of key in keys)` from theme.ts, which WRAPS after 6 keys.
// Callers should cap at 5 categories plus an 'Other' bucket (index 5 is the grey text-tertiary
// token, which suits 'Other'). The chart draws no legend; callers supply one.
// Labels: `data` labels must be unique (duplicates share a React key and collapse into one band).
// Frame: rendered inside the shared kit's MarkFrame (roadmap 2.6) — one tab stop whose arrow keys
// walk the bars, a tooltip per bar on hover / touch / keyboard, and a <details> data-table fallback.
import { scaleBand, scaleLinear } from '@visx/scale';
import { useMeasure } from '@/lib/useMeasure';
import { AXIS_TICK, colorAt } from './theme';
import { MarkFrame, type TipMark } from './kit/MarkFrame';

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
  /** Names the overlay in the tooltip and the data table. */
  overlayLabel?: string;
}

interface Seg {
  key: string;
  value: number;
  top: number;
  height: number;
}

const fin = (n: number) => (Number.isFinite(n) ? n : 0);

/** Stacked vertical bars over a zero baseline. Positive segments stack upward, negative segments
 *  (credits) stack downward; rect heights are always >= 0. Segments stack in `keys` order. */
export function StackedBarChart({ data, keys, height = 250, valueFormat, ariaLabel = 'Stacked bar chart', overlay, overlayLabel = 'Overlay' }: Props) {
  const [ref, measured] = useMeasure<HTMLDivElement>();
  const width = measured > 0 ? measured : 400;
  const margin = { top: 22, right: 6, bottom: 36, left: 6 };
  const iw = Math.max(0, width - margin.left - margin.right);
  const ih = Math.max(0, height - margin.top - margin.bottom);
  const fmt = (n: number) => (valueFormat ? valueFormat(n) : String(n));
  const signed = (n: number) => (n < 0 ? `-${fmt(-n)}` : fmt(n));

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
  const overlayBy = new Map(overlayPts.map((o) => [o.label, o.value]));

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
  const geo = bars.map((b) => {
    const segs = segGeometry(b);
    return { segs, stackTop: segs.length ? Math.min(...segs.map((s) => s.top)) : y0 };
  });

  // One mark per bar: header, each segment signed (a credit reads -$10), the net total, the overlay.
  const marks: TipMark[] = bars.map((b, i) => {
    const ov = overlayBy.get(b.label);
    return {
      x: margin.left + (x(b.label) ?? 0) + bw / 2,
      y: margin.top + geo[i]!.stackTop,
      lines: [b.label, ...b.parts.map((p) => `${p.key}: ${signed(p.value)}`), `Total: ${signed(b.total)}`, ...(ov === undefined ? [] : [`${overlayLabel}: ${signed(ov)}`])],
    };
  });

  const table = (
    <table>
      <caption className="ck-note" style={{ textAlign: 'left', captionSide: 'top' }}>
        {ariaLabel}
      </caption>
      <thead>
        <tr>
          <th scope="col">Period</th>
          {keys.map((k) => (
            <th scope="col" key={k}>
              {k}
            </th>
          ))}
          <th scope="col">Total</th>
          {overlayPts.length > 0 && <th scope="col">{overlayLabel}</th>}
        </tr>
      </thead>
      <tbody>
        {bars.map((b) => (
          <tr key={b.label}>
            <th scope="row">{b.label}</th>
            {keys.map((k) => {
              const v = b.parts.find((p) => p.key === k)?.value;
              return <td key={k}>{v === undefined ? '—' : signed(v)}</td>;
            })}
            <td>{signed(b.total)}</td>
            {overlayPts.length > 0 && <td>{overlayBy.has(b.label) ? signed(overlayBy.get(b.label)!) : '—'}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <MarkFrame measureRef={ref} width={width} height={height} ariaLabel={ariaLabel} marks={marks} table={table}>
      {(bind, active) => (
        <g transform={`translate(${margin.left},${margin.top})`}>
          {bars.map((b, i) => {
            const bx = x(b.label) ?? 0;
            const { segs } = geo[i]!;
            return (
              <g key={b.label}>
                {segs.map((s) => (
                  <rect
                    key={s.key}
                    {...bind(i)}
                    data-key={s.key}
                    x={bx}
                    y={s.top}
                    width={bw}
                    height={s.height}
                    fill={colorAt(keys.indexOf(s.key))}
                    stroke={active === i ? 'var(--text-primary)' : 'var(--surface-base, transparent)'}
                    strokeWidth={active === i ? 1 : 0.5}
                    style={{ cursor: 'pointer', opacity: active !== null && active !== i ? 0.55 : 1, transition: 'opacity 120ms' }}
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
                {i % tickEvery === 0 && (
                  <text x={bx + bw / 2} y={ih + 14} textAnchor="middle" style={{ ...AXIS_TICK, pointerEvents: 'none' }}>
                    {b.label.length > 14 ? `${b.label.slice(0, 13)}…` : b.label}
                  </text>
                )}
              </g>
            );
          })}
          {hasNeg && (
            <line className="zero-baseline" x1={0} x2={iw} y1={y0} y2={y0} stroke="var(--border-strong)" strokeWidth={1} pointerEvents="none" />
          )}
          {overlayPts.length > 0 && (
            <path className="overlay-line" d={linePath} fill="none" stroke="var(--text-primary)" strokeWidth={1.5} strokeDasharray="4 3" pointerEvents="none" />
          )}
        </g>
      )}
    </MarkFrame>
  );
}
