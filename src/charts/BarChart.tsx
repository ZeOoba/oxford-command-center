import { useId, useState } from 'react';
import { motion } from 'framer-motion';
import { Group } from '@visx/group';
import { scaleBand, scaleLinear } from '@visx/scale';
import { AxisBottom } from '@visx/axis';
import { LinearGradient } from '@visx/gradient';
import { useMeasure } from '@/lib/useMeasure';
import { AXIS_TICK } from './theme';

export interface BarDatum {
  label: string;
  value: number;
  /** Optional provenance styling (roadmap 3.3): reconstructed bars render faint, forecast bars as a
   *  dashed outline. Omitted = recorded/solid. Pair with <SeriesLegend>. */
  provenance?: 'recorded' | 'reconstructed' | 'forecast';
}

interface Props {
  data: BarDatum[];
  height?: number;
  color?: string;
  /** Fill for bars with a negative value. Defaults to the semantic loss token. */
  negativeColor?: string;
  valueFormat?: (n: number) => string;
  /** Accessible name for the chart's <svg role="img">. Required (roadmap 2.5): an unnamed chart is
   *  announced as a bare image. Say what the series is and its basis. */
  ariaLabel: string;
}

interface HoverState {
  index: number;
  left: number;
  top: number;
}

/** Vertical bar chart — branded gradient bars, animated draw-in, hover tooltip. Negative values
 *  render as diverging bars hanging below a zero baseline. */
export function BarChart({ data, height = 250, color = 'var(--accent)', negativeColor = 'var(--color-neg)', valueFormat, ariaLabel }: Props) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<HoverState | null>(null);
  const gid = useId().replace(/:/g, '');
  const margin = { top: 22, right: 6, bottom: 36, left: 6 };
  const iw = Math.max(0, width - margin.left - margin.right);
  const ih = height - margin.top - margin.bottom;

  const x = scaleBand({ domain: data.map((d) => d.label), range: [0, iw], padding: 0.36 });
  const hasNeg = data.some((d) => d.value < 0);
  // Positive-only data keeps the original [0, max(…,1)] domain and full-height range (unchanged).
  // With negatives the domain spans zero, and the range stops short of the axis labels so the
  // below-bar value label of the lowest bar does not collide with the x tick labels.
  const max = hasNeg ? Math.max(...data.map((d) => d.value), 0) : Math.max(...data.map((d) => d.value), 1);
  const min = Math.min(...data.map((d) => d.value), 0);
  const y = scaleLinear({ domain: [min, max], range: [hasNeg ? Math.max(0, ih - 18) : ih, 0] });
  const y0 = y(0); // zero baseline (== ih for positive-only data)

  return (
    <div ref={ref} style={{ width: '100%', position: 'relative' }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel}>
          <LinearGradient id={`bar-${gid}`} from={color} to={color} fromOpacity={0.95} toOpacity={0.32} vertical />
          <LinearGradient id={`barneg-${gid}`} from={negativeColor} to={negativeColor} fromOpacity={0.32} toOpacity={0.95} vertical />
          <Group left={margin.left} top={margin.top}>
            {data.map((d, i) => {
              const bw = x.bandwidth();
              const bx = x(d.label) ?? 0;
              const neg = d.value < 0;
              const bTop = Math.min(y(d.value), y0);
              const bh = Math.abs(y(d.value) - y0);
              const active = hover?.index === i;
              return (
                <g key={d.label}>
                  <motion.rect
                    x={bx}
                    width={bw}
                    rx={4}
                    fill={d.provenance === 'forecast' ? 'transparent' : `url(#${neg ? 'barneg' : 'bar'}-${gid})`}
                    stroke={d.provenance === 'forecast' ? (neg ? negativeColor : color) : undefined}
                    strokeDasharray={d.provenance === 'forecast' ? '4 3' : undefined}
                    data-provenance={d.provenance}
                    style={{
                      cursor: 'pointer',
                      opacity: (hover && !active ? 0.55 : 1) * (d.provenance === 'reconstructed' ? 0.45 : 1),
                      transition: 'opacity 120ms',
                    }}
                    initial={{ height: 0, y: y0 }}
                    animate={{ height: bh, y: bTop }}
                    transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                    onMouseMove={() => setHover({ index: i, left: margin.left + bx + bw / 2, top: margin.top + bTop })}
                    onMouseLeave={() => setHover(null)}
                  />
                  <text
                    x={bx + bw / 2}
                    y={neg ? y(d.value) + 15 : y(d.value) - 7}
                    textAnchor="middle"
                    style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, fill: 'var(--text-secondary)', fontWeight: 600, pointerEvents: 'none' }}
                  >
                    {valueFormat ? valueFormat(d.value) : d.value}
                  </text>
                </g>
              );
            })}
            {hasNeg && (
              <line className="zero-baseline" x1={0} x2={iw} y1={y0} y2={y0} stroke="var(--border-strong)" strokeWidth={1} pointerEvents="none" />
            )}
            <AxisBottom
              top={ih}
              scale={x}
              hideAxisLine
              hideTicks
              tickLabelProps={() => ({ ...AXIS_TICK, textAnchor: 'middle', dy: '0.5em' })}
              tickFormat={(v) => (String(v).length > 14 ? `${String(v).slice(0, 13)}…` : String(v))}
            />
          </Group>
        </svg>
      )}
      {hover && (
        <div
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
          <span style={{ color: 'var(--text-tertiary)' }}>{data[hover.index]!.label}</span>
          <span className="num ml-2 font-semibold" style={{ color: 'var(--text-primary)' }}>
            {valueFormat ? valueFormat(data[hover.index]!.value) : data[hover.index]!.value}
          </span>
        </div>
      )}
    </div>
  );
}
