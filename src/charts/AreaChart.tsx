import { useId, useState } from 'react';
import { motion } from 'framer-motion';
import { Group } from '@visx/group';
import { scaleLinear } from '@visx/scale';
import { AxisBottom } from '@visx/axis';
import { LinePath, AreaClosed, Area } from '@visx/shape';
import { LinearGradient } from '@visx/gradient';
import { curveMonotoneX } from '@visx/curve';
import { useMeasure } from '@/lib/useMeasure';
import { AXIS_TICK, GRID_STROKE } from './theme';
import { PROVENANCE_DASH, PROVENANCE_LABEL, provenanceRuns, type Provenance, type SpreadPoint } from './series-provenance';

export interface TimePoint {
  date: string;
  value: number;
}

interface Props {
  data: TimePoint[];
  height?: number;
  color?: string;
  valueFormat?: (n: number) => string;
  /** Accessible name for the chart's <svg role="img">. Required (roadmap 2.5): an unnamed chart is
   *  announced as a bare image. Say what the series is and its basis. */
  ariaLabel: string;
  /** Per-point provenance (same length as data). Draws recorded solid, reconstructed dotted and
   *  forecast dashed, and fills only under non-forecast points. Pair with <SeriesLegend>. */
  provenance?: readonly Provenance[];
  /** Per-point scenario spread (same length as data; null where none), shaded between lo and hi.
   *  A range between two named scenarios — never a confidence interval. */
  band?: readonly (SpreadPoint | null)[];
}

/** Time-series area chart with branded gradient, animated draw-in, and hover tooltip. */
export function AreaChart({ data, height = 230, color = 'var(--color-pos)', valueFormat, ariaLabel, provenance, band }: Props) {
}

/** Time-series area chart with branded gradient, animated draw-in, and hover tooltip. */
export function AreaChart({ data, height = 230, color = 'var(--color-pos)', valueFormat, ariaLabel }: Props) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const gid = useId().replace(/:/g, '');
  const margin = { top: 16, right: 14, bottom: 28, left: 52 };
  const iw = Math.max(0, width - margin.left - margin.right);
  const ih = height - margin.top - margin.bottom;

  const xs = data.map((_, i) => i);
  const ys = data.map((d) => d.value);
  const x = scaleLinear({ domain: [0, Math.max(1, data.length - 1)], range: [0, iw] });
  const bandPts = band ? data.map((_, i) => ({ i, b: band[i] ?? null })).filter((d): d is { i: number; b: SpreadPoint } => d.b !== null) : [];
  const min = Math.min(...ys, ...bandPts.map((d) => d.b.lo));
  const max = Math.max(...ys, ...bandPts.map((d) => d.b.hi));
  const runs = provenance && provenance.length === data.length ? provenanceRuns(provenance) : [{ kind: 'recorded' as Provenance, from: 0, to: data.length - 1 }];
  // The gradient fill sits under history only; a forecast is a line, not a filled actual.
  const fillTo = provenance && provenance.length === data.length ? provenance.reduce((last, k, i) => (k === 'forecast' ? last : i), -1) : data.length - 1;
  const fillXs = xs.slice(0, fillTo + 1);
  const pad = (max - min) * 0.12 || 1;
  const y = scaleLinear({ domain: [min - pad, max + pad], range: [ih, 0] });
  const ticks = y.ticks(4);

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const idx = Math.max(0, Math.min(data.length - 1, Math.round((mx / iw) * (data.length - 1))));
    setHover(idx);
  };

  return (
    <div ref={ref} style={{ width: '100%', position: 'relative' }}>
      {width > 0 && data.length > 1 && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel}>
          <LinearGradient id={`area-${gid}`} from={color} to={color} fromOpacity={0.28} toOpacity={0} />
          <Group left={margin.left} top={margin.top}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={0} x2={iw} y1={y(t)} y2={y(t)} stroke={GRID_STROKE} />
                <text x={-10} y={y(t)} dy="0.32em" textAnchor="end" style={AXIS_TICK}>
                  {valueFormat ? valueFormat(t) : t}
                </text>
              </g>
            ))}
            {bandPts.length > 1 && (
              <Area
                data={bandPts}
                x={(d) => x(d.i)}
                y0={(d) => y(d.b.lo)}
                y1={(d) => y(d.b.hi)}
                curve={curveMonotoneX}
                fill={color}
                fillOpacity={0.16}
                data-testid="area-band"
              />
            )}
            {fillXs.length > 1 && (
              <AreaClosed data={fillXs} x={(i) => x(i)} y={(i) => y(ys[i]!)} yScale={y} curve={curveMonotoneX} fill={`url(#area-${gid})`} />
            )}
            <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }}>
              {runs.map((r) => (
                <LinePath
                  key={`${r.kind}-${r.from}`}
                  data={xs.slice(r.from, r.to + 1)}
                  x={(i) => x(i)}
                  y={(i) => y(ys[i]!)}
                  stroke={color}
                  strokeWidth={2}
                  strokeDasharray={PROVENANCE_DASH[r.kind]}
                  strokeLinecap="round"
                  curve={curveMonotoneX}
                  data-provenance={r.kind}
                />
              ))}
            </motion.g>
            {hover !== null && (
              <g>
                <line x1={x(hover)} x2={x(hover)} y1={0} y2={ih} stroke="var(--border-strong)" strokeDasharray="3 3" />
                <circle cx={x(hover)} cy={y(ys[hover]!)} r={4} fill={color} stroke="var(--surface-raised)" strokeWidth={1.5} />
              </g>
            )}
            <circle cx={x(data.length - 1)} cy={y(ys[ys.length - 1]!)} r={3} fill={color} />
            <AxisBottom
              top={ih}
              scale={x}
              numTicks={Math.min(data.length, 7)}
              hideAxisLine
              hideTicks
              tickFormat={(v) => {
                const d = data[Number(v)]?.date;
                return d ? new Date(d).toLocaleDateString('en-US', { month: 'short' }) : '';
              }}
              tickLabelProps={() => ({ ...AXIS_TICK, textAnchor: 'middle', dy: '0.4em' })}
            />
            <rect width={iw} height={ih} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} style={{ cursor: 'crosshair' }} />
          </Group>
        </svg>
      )}
      {hover !== null && (
        <div
          className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full rounded-[var(--radius-sm)] px-2 py-1 text-2xs"
          style={{
            left: margin.left + x(hover),
            top: margin.top + y(ys[hover]!) - 10,
            background: 'var(--surface-overlay)',
            border: '1px solid var(--border-strong)',
            boxShadow: '0 10px 24px -12px rgba(0,0,0,0.7)',
            whiteSpace: 'nowrap',
          }}
        >
          <span style={{ color: 'var(--text-tertiary)' }}>
            {new Date(data[hover]!.date).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })}
          </span>
          <span className="num ml-2 font-semibold" style={{ color: 'var(--text-primary)' }}>
            {valueFormat ? valueFormat(ys[hover]!) : ys[hover]}
          </span>
          {provenance?.[hover] && <span className="ml-2" style={{ color: 'var(--text-tertiary)' }}>{PROVENANCE_LABEL[provenance[hover]!]}</span>}
          {band?.[hover] && (
            <span className="num ml-2" style={{ color: 'var(--text-tertiary)' }}>
              range {valueFormat ? valueFormat(band[hover]!.lo) : band[hover]!.lo}–{valueFormat ? valueFormat(band[hover]!.hi) : band[hover]!.hi}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
