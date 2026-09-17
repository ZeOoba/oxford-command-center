// src/charts/RentCurve.tsx
//
// Asking rent (NNN-equivalent $/SF/yr) vs. available SF, log scale, with P25–P75 bands per size band.
// Solid = quoted NNN; hollow = converted / low confidence; highlighted = ORA space.
import { useMemo, useState } from 'react';
import { Group } from '@visx/group';
import { scaleLinear, scaleLog } from '@visx/scale';
import { AxisBottom, AxisLeft } from '@visx/axis';
import { useMeasure } from '@/lib/useMeasure';
import { AXIS_TICK, GRID_STROKE } from './theme';
import { curveDomains, curveTickValues, sizeBands, type CurveDatum } from './rent-curve-layout';

interface Props {
  points: CurveDatum[];
  height?: number;
  valueFormat?: (n: number) => string;
}

const defaultFormat = (n: number) => `$${n.toFixed(2)}`;
const sfFormat = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(Math.round(n)));

export function RentCurve({ points, height = 300, valueFormat = defaultFormat }: Props) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<{ point: CurveDatum; left: number; top: number } | null>(null);
  const domains = useMemo(() => curveDomains(points), [points]);
  const bands = useMemo(() => sizeBands(points), [points]);

  if (!domains) {
    return (
      <div ref={ref} className="py-6 text-center text-2xs" style={{ color: 'var(--text-tertiary)' }}>
        No quoted asking rents yet.
      </div>
    );
  }

  const margin = { top: 12, right: 16, bottom: 32, left: 52 };
  const iw = Math.max(0, width - margin.left - margin.right);
  const ih = Math.max(0, height - margin.top - margin.bottom);
  const x = scaleLog<number>({ domain: domains.x, range: [0, iw] });
  const y = scaleLinear<number>({ domain: domains.y, range: [ih, 0] });
  const clampX = (sf: number) => x(Math.min(domains.x[1], Math.max(domains.x[0], sf)));
  const tickValues = curveTickValues(domains.x);
  // Highlighted (ORA) points render last so their dots sit on top of the general cloud.
  const orderedPoints = [...points].sort((a, b) => Number(a.highlight) - Number(b.highlight));

  return (
    <div ref={ref} style={{ width: '100%', position: 'relative' }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`Asking rent by available square feet, ${points.length} listings`}>
          <Group left={margin.left} top={margin.top}>
            {y.ticks(5).map((t) => (
              <line key={`g${t}`} x1={0} x2={iw} y1={y(t)} y2={y(t)} stroke={GRID_STROKE} />
            ))}
            {bands.map((b) => {
              const x0 = clampX(b.minSf || domains.x[0]);
              const x1 = clampX(b.maxSf);
              return (
                <g key={`${b.minSf}-${b.maxSf}`}>
                  <rect x={x0} width={Math.max(1, x1 - x0)} y={y(b.p75)} height={Math.max(1, y(b.p25) - y(b.p75))} fill="var(--accent)" opacity={0.1} />
                  <line x1={x0} x2={x1} y1={y(b.median)} y2={y(b.median)} stroke="var(--accent)" strokeWidth={2} opacity={0.8} />
                </g>
              );
            })}
            {orderedPoints.map((p) => {
              const cx = clampX(p.sf);
              const cy = y(p.value);
              const color = p.highlight ? 'var(--color-warn)' : 'var(--color-info)';
              return (
                <circle
                  key={p.id}
                  cx={cx}
                  cy={cy}
                  r={p.highlight ? 5 : 3.5}
                  fill={p.solid ? color : 'transparent'}
                  stroke={color}
                  strokeWidth={1.5}
                  style={{ cursor: 'pointer' }}
                  onMouseMove={() => setHover({ point: p, left: margin.left + cx, top: margin.top + cy })}
                  onMouseLeave={() => setHover(null)}
                />
              );
            })}
            <AxisLeft scale={y} numTicks={5} hideAxisLine hideTicks tickFormat={(v) => valueFormat(Number(v))} tickLabelProps={() => ({ ...AXIS_TICK, textAnchor: 'end', dx: '-0.4em', dy: '0.3em' })} />
            <AxisBottom top={ih} scale={x} tickValues={tickValues} hideAxisLine hideTicks tickFormat={(v) => sfFormat(Number(v))} tickLabelProps={() => ({ ...AXIS_TICK, textAnchor: 'middle', dy: '0.5em' })} />
          </Group>
        </svg>
      )}
      {hover && (
        <div
          className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full rounded-[var(--radius-sm)] px-2 py-1 text-2xs"
          style={{ left: hover.left, top: hover.top - 10, background: 'var(--surface-overlay)', border: '1px solid var(--border-strong)', boxShadow: '0 10px 24px -12px rgba(0,0,0,0.7)', whiteSpace: 'nowrap' }}
        >
          <span style={{ color: 'var(--text-tertiary)' }}>{hover.point.label}</span>
          <span className="num ml-2 font-semibold" style={{ color: 'var(--text-primary)' }}>
            {Math.round(hover.point.sf).toLocaleString('en-US')} SF · {valueFormat(hover.point.value)}
            {hover.point.solid ? '' : ' (converted)'}
          </span>
        </div>
      )}
    </div>
  );
}
