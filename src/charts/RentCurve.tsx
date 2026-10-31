// src/charts/RentCurve.tsx
//
// Asking rent (NNN-equivalent $/SF/yr) vs. available SF, log scale, with P25–P75 bands per size band.
// Solid = quoted NNN; hollow = converted / low confidence; highlighted = ORA space.
// Frame: the shared kit's MarkFrame (roadmap 2.6) — one tab stop whose arrow keys walk the listings
// left to right by SF, a tooltip per listing on hover / touch / keyboard, and a <details> data-table
// fallback listing every point and every size band.
import { useMemo } from 'react';
import { scaleLinear, scaleLog } from '@visx/scale';
import { AxisBottom, AxisLeft } from '@visx/axis';
import { useMeasure } from '@/lib/useMeasure';
import { AXIS_TICK, GRID_STROKE } from './theme';
import { curveDomains, curveTickValues, sfFormat, sizeBands, validCurvePoints, type CurveDatum } from './rent-curve-layout';
import { MarkFrame, type TipMark } from './kit/MarkFrame';

interface Props {
  points: CurveDatum[];
  height?: number;
  valueFormat?: (n: number) => string;
}

const defaultFormat = (n: number) => `$${n.toFixed(2)}`;
const sfText = (sf: number) => `${Math.round(sf).toLocaleString('en-US')} SF`;
const basisText = (p: CurveDatum) => (p.solid ? 'Quoted NNN' : 'Converted / low confidence');

export function RentCurve({ points, height = 300, valueFormat = defaultFormat }: Props) {
  const [ref, measured] = useMeasure<HTMLDivElement>();
  // Filtered once here — feeds the circles, the aria-label count, and (redundantly-but-harmlessly,
  // since curveDomains/sizeBands filter internally too) the domains and bands below.
  const validPoints = useMemo(() => validCurvePoints(points), [points]);
  const domains = useMemo(() => curveDomains(validPoints), [validPoints]);
  const bands = useMemo(() => sizeBands(validPoints), [validPoints]);
  // The keyboard walk reads the listings left to right; the draw order (below) is separate.
  const walk = useMemo(() => [...validPoints].sort((a, b) => a.sf - b.sf || a.value - b.value), [validPoints]);

  if (!domains) {
    return (
      <div ref={ref} className="py-6 text-center text-2xs" style={{ color: 'var(--text-tertiary)' }}>
        No quoted asking rents yet.
      </div>
    );
  }

  const width = measured > 0 ? measured : 600;
  const margin = { top: 12, right: 16, bottom: 32, left: 52 };
  const iw = Math.max(0, width - margin.left - margin.right);
  const ih = Math.max(0, height - margin.top - margin.bottom);
  const x = scaleLog<number>({ domain: domains.x, range: [0, iw] });
  const y = scaleLinear<number>({ domain: domains.y, range: [ih, 0] });
  const clampX = (sf: number) => x(Math.min(domains.x[1], Math.max(domains.x[0], sf)));
  const tickValues = curveTickValues(domains.x);
  // Highlighted (ORA) points render last so their dots sit on top of the general cloud.
  const orderedPoints = [...validPoints].sort((a, b) => Number(a.highlight) - Number(b.highlight));
  const walkIndex = new Map(walk.map((p, i) => [p.id, i]));
  const ariaLabel = `Asking rent by available square feet, ${validPoints.length} listings`;

  const marks: TipMark[] = walk.map((p) => ({
    x: margin.left + clampX(p.sf),
    y: margin.top + y(p.value),
    lines: [p.label, `${sfText(p.sf)} · ${valueFormat(p.value)}`, basisText(p), ...(p.highlight ? ['ORA space'] : [])],
  }));

  const table = (
    <>
      <table>
        <caption className="ck-note" style={{ textAlign: 'left', captionSide: 'top' }}>
          {ariaLabel}
        </caption>
        <thead>
          <tr>
            <th scope="col">Listing</th>
            <th scope="col">Available SF</th>
            <th scope="col">Asking</th>
            <th scope="col">Basis</th>
          </tr>
        </thead>
        <tbody>
          {walk.map((p) => (
            <tr key={p.id}>
              <th scope="row">
                {p.label}
                {p.highlight ? ' (ORA)' : ''}
              </th>
              <td>{Math.round(p.sf).toLocaleString('en-US')}</td>
              <td>{valueFormat(p.value)}</td>
              <td>{basisText(p)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {bands.length > 0 && (
        <table>
          <caption className="ck-note" style={{ textAlign: 'left', captionSide: 'top' }}>
            Quoted-NNN size bands (P25 to P75 shaded, median line)
          </caption>
          <thead>
            <tr>
              <th scope="col">Size band</th>
              <th scope="col">Listings</th>
              <th scope="col">P25</th>
              <th scope="col">Median</th>
              <th scope="col">P75</th>
            </tr>
          </thead>
          <tbody>
            {bands.map((b) => (
              <tr key={`${b.minSf}-${b.maxSf}`}>
                <th scope="row">
                  {sfFormat(b.minSf)}–{sfFormat(b.maxSf)}
                </th>
                <td>{b.n}</td>
                <td>{valueFormat(b.p25)}</td>
                <td>{valueFormat(b.median)}</td>
                <td>{valueFormat(b.p75)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );

  return (
    <MarkFrame measureRef={ref} width={width} height={height} ariaLabel={ariaLabel} marks={marks} table={table}>
      {(bind, active) => (
        <g transform={`translate(${margin.left},${margin.top})`}>
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
            const i = walkIndex.get(p.id)!;
            const color = p.highlight ? 'var(--color-warn)' : 'var(--color-info)';
            const base = p.highlight ? 5 : 3.5;
            return (
              <circle
                key={p.id}
                {...bind(i)}
                cx={clampX(p.sf)}
                cy={y(p.value)}
                r={active === i ? base + 2 : base}
                fill={p.solid ? color : 'transparent'}
                stroke={active === i ? 'var(--text-primary)' : color}
                strokeWidth={1.5}
                style={{ cursor: 'pointer' }}
              />
            );
          })}
          <AxisLeft scale={y} numTicks={5} hideAxisLine hideTicks tickFormat={(v) => valueFormat(Number(v))} tickLabelProps={() => ({ ...AXIS_TICK, textAnchor: 'end', dx: '-0.4em', dy: '0.3em' })} />
          <AxisBottom top={ih} scale={x} tickValues={tickValues} hideAxisLine hideTicks tickFormat={(v) => sfFormat(Number(v))} tickLabelProps={() => ({ ...AXIS_TICK, textAnchor: 'middle', dy: '0.5em' })} />
        </g>
      )}
    </MarkFrame>
  );
}
