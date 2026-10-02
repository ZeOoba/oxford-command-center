import { useId, useState } from 'react';
import { useMeasure } from '@/lib/useMeasure';

export interface HeatCell {
  row: string;
  col: string;
  /** null = no data: drawn with a hatched "no data" look, never as zero. */
  value: number | null;
}

interface Props {
  cells: HeatCell[];
  rows: string[];
  cols: string[];
  height?: number;
  valueFormat?: (n: number) => string;
  /** Colour-scale clamp [min, max]. Default: symmetric about zero, +/- max(|min|, |max|) of the data.
   *  Values beyond the domain clamp to the edge intensity. */
  domain?: [number, number];
  ariaLabel?: string;
}

interface HoverState {
  row: string;
  col: string;
  left: number;
  top: number;
}

const MARGIN = { top: 22, right: 4, bottom: 4, left: 92 };
const GAP = 2;
const MAX_ROW_H = 30;
const MIN_LABEL_W = 44;
const MIN_LABEL_H = 15;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s);

/** Diverging variance heatmap. Values above 0 shade toward the negative/alert token (expense
 *  overrun), values below 0 toward the positive token, 0 is neutral. null / missing cells render a
 *  hatched dashed "no data" cell and are never coloured as zero. Duplicate (row, col) cells: last wins. */
export function Heatmap({ cells, rows, cols, height = 260, valueFormat, domain, ariaLabel }: Props) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<HoverState | null>(null);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const patternId = `hm-nodata-${uid}`;
  const fmt = (n: number) => (valueFormat ? valueFormat(n) : String(n));

  // Last duplicate wins; non-finite values are treated as no data.
  const byKey = new Map<string, number | null>();
  for (const c of cells) byKey.set(`${c.row}\u0000${c.col}`, c.value !== null && Number.isFinite(c.value) ? c.value : null);

  const vals = [...byKey.values()].filter((v): v is number => v !== null);
  const absMax = vals.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const posScale = domain ? Math.max(0, domain[1]) : absMax;
  const negScale = domain ? Math.max(0, -domain[0]) : absMax;
  const intensity = (v: number): number => {
    if (v === 0) return 0;
    const scale = v > 0 ? posScale : negScale;
    return scale > 0 ? Math.min(1, Math.abs(v) / scale) : 1;
  };

  const iw = Math.max(0, width - MARGIN.left - MARGIN.right);
  const ih = Math.max(0, height - MARGIN.top - MARGIN.bottom);
  const cw = cols.length ? iw / cols.length : 0;
  const ch = rows.length ? Math.min(MAX_ROW_H, ih / rows.length) : 0;
  const rw = Math.max(0, cw - GAP);
  const rh = Math.max(0, ch - GAP);
  const showLabels = rw >= MIN_LABEL_W && rh >= MIN_LABEL_H;
  const colChars = Math.max(2, Math.floor(cw / 6.5));
  const svgHeight = Math.min(height, MARGIN.top + ch * rows.length + MARGIN.bottom);

  const hoverVal = hover ? (byKey.get(`${hover.row}\u0000${hover.col}`) ?? null) : null;

  return (
    <div ref={ref} style={{ width: '100%', position: 'relative' }}>
      {width > 0 && (
        <svg width={width} height={svgHeight} role="img" aria-label={ariaLabel}>
          <defs>
            <pattern id={patternId} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width={6} height={6} fill="var(--surface-raised)" />
              <line x1={0} y1={0} x2={0} y2={6} stroke="var(--border-strong)" strokeWidth={1.5} />
            </pattern>
          </defs>
          {cols.map((col, ci) => (
            <text
              key={`c-${col}`}
              x={MARGIN.left + ci * cw + cw / 2}
              y={MARGIN.top - 8}
              textAnchor="middle"
              style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fill: 'var(--text-tertiary)' }}
            >
              {clip(col, colChars)}
            </text>
          ))}
          {rows.map((row, ri) => (
            <g key={`r-${row}`}>
              <text
                x={MARGIN.left - 8}
                y={MARGIN.top + ri * ch + ch / 2}
                textAnchor="end"
                dominantBaseline="central"
                style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fill: 'var(--text-secondary)' }}
              >
                <title>{row}</title>
                {clip(row, 14)}
              </text>
              {cols.map((col, ci) => {
                const v = byKey.get(`${row}\u0000${col}`) ?? null;
                const x = MARGIN.left + ci * cw + GAP / 2;
                const y = MARGIN.top + ri * ch + GAP / 2;
                const active = hover?.row === row && hover?.col === col;
                const common = {
                  'data-row': row,
                  'data-col': col,
                  x,
                  y,
                  width: rw,
                  height: rh,
                  rx: 2,
                  style: { cursor: 'pointer', opacity: hover && !active ? 0.7 : 1, transition: 'opacity 120ms' },
                  onMouseMove: () => setHover({ row, col, left: x + rw / 2, top: y }),
                  onMouseLeave: () => setHover(null),
                };
                if (v === null) {
                  return (
                    <rect
                      key={`${row}-${col}`}
                      {...common}
                      data-no-data="true"
                      fill={`url(#${patternId})`}
                      stroke="var(--border-strong)"
                      strokeWidth={1}
                      strokeDasharray="3 2"
                    />
                  );
                }
                const t = intensity(v);
                return (
                  <g key={`${row}-${col}`}>
                    <rect
                      {...common}
                      data-value={v}
                      data-intensity={Math.round(t * 1000) / 1000}
                      fill={v === 0 ? 'var(--border-subtle)' : v > 0 ? 'var(--color-neg)' : 'var(--color-pos)'}
                      fillOpacity={v === 0 ? 0.5 : 0.15 + 0.75 * t}
                    />
                    {showLabels && (
                      <text
                        x={x + rw / 2}
                        y={y + rh / 2}
                        textAnchor="middle"
                        dominantBaseline="central"
                        style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fill: 'var(--text-primary)', pointerEvents: 'none' }}
                      >
                        {fmt(v)}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          ))}
        </svg>
      )}
      {hover && (
        <div
          data-testid="heatmap-tooltip"
          className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full rounded-[var(--radius-sm)] px-2 py-1 text-2xs"
          style={{
            left: hover.left,
            top: hover.top - 6,
            background: 'var(--surface-overlay)',
            border: '1px solid var(--border-strong)',
            boxShadow: '0 10px 24px -12px rgba(0,0,0,0.7)',
            whiteSpace: 'nowrap',
          }}
        >
          <div style={{ color: 'var(--text-tertiary)' }}>
            {hover.row} · {hover.col}
          </div>
          <div className="num" style={{ color: 'var(--text-primary)' }}>
            {hoverVal === null ? 'no data' : fmt(hoverVal)}
          </div>
        </div>
      )}
    </div>
  );
}
