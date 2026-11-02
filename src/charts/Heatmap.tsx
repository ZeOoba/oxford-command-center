// Frame: the shared kit's MarkFrame (roadmap 2.6) — one tab stop whose arrow keys walk the cells in
// row-major order, a tooltip per cell (row · column, then the value or "no data") on hover / touch /
// keyboard, and a <details> data-table fallback with the full grid.
import { useId } from 'react';
import { useMeasure } from '@/lib/useMeasure';
import { MarkFrame, type TipMark } from './kit/MarkFrame';

export interface HeatCell {
  row: string;
  col: string;
  /** null = no data: drawn with a hatched "no data" look, never as zero. */
  value: number | null;
}

interface Props {
  cells: HeatCell[];
  /** Row ids (cells reference these). Must be unique. */
  rows: string[];
  /** Optional display labels by row id; default is the id. Labels may repeat across rows. */
  rowLabels?: Record<string, string>;
  cols: string[];
  height?: number;
  valueFormat?: (n: number) => string;
  /** Colour-scale clamp [min, max]. Default: symmetric about zero, +/- max(|min|, |max|) of the data.
   *  Values beyond the domain clamp to the edge intensity. */
  domain?: [number, number];
  ariaLabel?: string;
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
export function Heatmap({ cells, rows, rowLabels, cols, height = 260, valueFormat, domain, ariaLabel = 'Heatmap' }: Props) {
  const [ref, measured] = useMeasure<HTMLDivElement>();
  const width = measured > 0 ? measured : 400;
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const patternId = `hm-nodata-${uid}`;
  const labelOf = (id: string) => rowLabels?.[id] ?? id;
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

  const valueAt = (row: string, col: string): number | null => byKey.get(`${row}\u0000${col}`) ?? null;
  // One mark per cell, row-major, so the keyboard walk reads the grid row by row.
  const marks: TipMark[] = rows.flatMap((row, ri) =>
    cols.map((col, ci) => {
      const v = valueAt(row, col);
      return {
        x: MARGIN.left + ci * cw + cw / 2,
        y: MARGIN.top + ri * ch + GAP / 2,
        lines: [`${labelOf(row)} · ${col}`, v === null ? 'no data' : fmt(v)],
      };
    }),
  );

  const table = (
    <table>
      <caption className="ck-note" style={{ textAlign: 'left', captionSide: 'top' }}>
        {ariaLabel}
      </caption>
      <thead>
        <tr>
          <th scope="col">Row</th>
          {cols.map((col) => (
            <th scope="col" key={col}>
              {col}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row}>
            <th scope="row">{labelOf(row)}</th>
            {cols.map((col) => {
              const v = valueAt(row, col);
              return <td key={col}>{v === null ? 'no data' : fmt(v)}</td>;
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <MarkFrame measureRef={ref} width={width} height={svgHeight} ariaLabel={ariaLabel} marks={marks} table={table}>
      {(bind, active) => (
        <>
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
                <title>{labelOf(row)}</title>
                {clip(labelOf(row), 14)}
              </text>
              {cols.map((col, ci) => {
                const v = valueAt(row, col);
                const i = ri * cols.length + ci;
                const x = MARGIN.left + ci * cw + GAP / 2;
                const y = MARGIN.top + ri * ch + GAP / 2;
                const common = {
                  ...bind(i),
                  'data-row': row,
                  'data-col': col,
                  x,
                  y,
                  width: rw,
                  height: rh,
                  rx: 2,
                  style: { cursor: 'pointer', opacity: active !== null && active !== i ? 0.7 : 1, transition: 'opacity 120ms' },
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
                      stroke={active === i ? 'var(--text-primary)' : 'none'}
                      strokeWidth={1}
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
        </>
      )}
    </MarkFrame>
  );
}
