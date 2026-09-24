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
}

interface Props {
  data: BarDatum[];
  height?: number;
  color?: string;
  valueFormat?: (n: number) => string;
  /** Accessible name for the chart's <svg>. Optional — omitted callers get no aria-label
   *  (unchanged from before this prop existed), same opt-in pattern as Waterfall's ariaLabel. */
  ariaLabel?: string;
}

interface HoverState {
  index: number;
  left: number;
  top: number;
}

/** Vertical bar chart — branded gradient bars, animated draw-in, hover tooltip. */
export function BarChart({ data, height = 250, color = 'var(--accent)', valueFormat, ariaLabel }: Props) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<HoverState | null>(null);
  const gid = useId().replace(/:/g, '');
  const margin = { top: 22, right: 6, bottom: 36, left: 6 };
  const iw = Math.max(0, width - margin.left - margin.right);
  const ih = height - margin.top - margin.bottom;

  const x = scaleBand({ domain: data.map((d) => d.label), range: [0, iw], padding: 0.36 });
  const max = Math.max(...data.map((d) => d.value), 1);
  const y = scaleLinear({ domain: [0, max], range: [ih, 0] });

  return (
    <div ref={ref} style={{ width: '100%', position: 'relative' }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel}>
          <LinearGradient id={`bar-${gid}`} from={color} to={color} fromOpacity={0.95} toOpacity={0.32} vertical />
          <Group left={margin.left} top={margin.top}>
            {data.map((d, i) => {
              const bw = x.bandwidth();
              const bx = x(d.label) ?? 0;
              const bh = ih - y(d.value);
              const active = hover?.index === i;
              return (
                <g key={d.label}>
                  <motion.rect
                    x={bx}
                    width={bw}
                    rx={4}
                    fill={`url(#bar-${gid})`}
                    style={{ cursor: 'pointer', opacity: hover && !active ? 0.55 : 1, transition: 'opacity 120ms' }}
                    initial={{ height: 0, y: ih }}
                    animate={{ height: bh, y: y(d.value) }}
                    transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                    onMouseMove={() => setHover({ index: i, left: margin.left + bx + bw / 2, top: margin.top + y(d.value) })}
                    onMouseLeave={() => setHover(null)}
                  />
                  <text
                    x={bx + bw / 2}
                    y={y(d.value) - 7}
                    textAnchor="middle"
                    style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, fill: 'var(--text-secondary)', fontWeight: 600, pointerEvents: 'none' }}
                  >
                    {valueFormat ? valueFormat(d.value) : d.value}
                  </text>
                </g>
              );
            })}
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
