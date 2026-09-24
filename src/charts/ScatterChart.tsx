/* eslint-disable react-refresh/only-export-components -- pure scatterDomain helper colocated with its chart (unit-tested) */
import { scaleLinear } from '@visx/scale';
import { AxisBottom, AxisLeft } from '@visx/axis';
import { Group } from '@visx/group';
import { AXIS_TICK } from './theme';

export interface ScatterPoint { id: string; x: number; y: number; label: string; tone?: 'pos' | 'neg' | 'neutral' }

export function scatterDomain(points: ScatterPoint[], pad = 0.1): { x: [number, number]; y: [number, number] } {
  const span = (vals: number[]): [number, number] => {
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const r = hi - lo || Math.abs(hi) || 1;
    return [lo - r * pad, hi + r * pad];
  };
  return { x: span(points.map((p) => p.x)), y: span(points.map((p) => p.y)) };
}

const TONE = { pos: 'var(--color-pos)', neg: 'var(--color-neg)', neutral: 'var(--accent)' } as const;
const W = 640;
const M = { top: 12, right: 16, bottom: 36, left: 56 };

export function ScatterChart({ points, xLabel, yLabel, xFormat, yFormat, height = 280, yRef }: {
  points: ScatterPoint[]; xLabel: string; yLabel: string;
  xFormat: (n: number) => string; yFormat: (n: number) => string; height?: number; yRef?: number;
}) {
  if (points.length === 0) return null;
  const d = scatterDomain(points);
  const x = scaleLinear({ domain: d.x, range: [M.left, W - M.right] });
  const y = scaleLinear({ domain: d.y, range: [height - M.bottom, M.top] });
  return (
    <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="img" aria-label={`${yLabel} vs ${xLabel}`}>
      <Group>
        {yRef !== undefined && (
          <line x1={M.left} x2={W - M.right} y1={y(yRef)} y2={y(yRef)} stroke="var(--text-tertiary)" strokeDasharray="4 4" />
        )}
        {points.map((p) => (
          <circle key={p.id} cx={x(p.x)} cy={y(p.y)} r={5} fill={TONE[p.tone ?? 'neutral']} fillOpacity={0.8}>
            <title>{`${p.label} — ${xLabel} ${xFormat(p.x)}, ${yLabel} ${yFormat(p.y)}`}</title>
          </circle>
        ))}
        <AxisBottom top={height - M.bottom} scale={x} tickFormat={(v) => xFormat(Number(v))} numTicks={5} label={xLabel}
          stroke="var(--border-subtle)" tickStroke="var(--border-subtle)" tickLabelProps={{ ...AXIS_TICK }} />
        <AxisLeft left={M.left} scale={y} tickFormat={(v) => yFormat(Number(v))} numTicks={5} label={yLabel}
          stroke="var(--border-subtle)" tickStroke="var(--border-subtle)" tickLabelProps={{ ...AXIS_TICK }} />
      </Group>
    </svg>
  );
}
