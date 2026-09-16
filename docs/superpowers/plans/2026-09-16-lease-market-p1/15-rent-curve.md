### Task 15: `RentCurve` chart — asking rent vs. available SF (visx scatter)

> **Plan rev 2:** replaces the rev 1 `StripPlot` (cross-exam A11). Do not create `StripPlot.tsx`.

**Files:**
- Create: `src/charts/rent-curve-layout.ts` (pure helpers)
- Create: `src/charts/RentCurve.tsx`
- Test: `tests/unit/rent-curve.test.tsx`

**Interfaces:**
- Consumes: `useMeasure` (`@/lib/useMeasure`); `AXIS_TICK`, `GRID_STROKE` (`src/charts/theme.ts`); `@visx/group`, `@visx/scale`, `@visx/axis`; `quantileSorted` (`@analytics/lease-market/benchmarks`); follow `src/charts/BarChart.tsx` for tooltip styling and tokens.
- Produces (layout): `interface CurveDatum { id: string; sf: number; value: number; solid: boolean; highlight: boolean; label: string }` · `interface CurveBand { minSf: number; maxSf: number; p25: number; median: number; p75: number; n: number }` · `curveDomains(points): { x: [number, number]; y: [number, number] } | null` · `sizeBands(points, minN = 5): CurveBand[]`
- Produces (component): `RentCurve(props: { points: CurveDatum[]; height?: number; valueFormat?: (n: number) => string }): JSX.Element`

Rules: x = available SF on a **log** scale, domain [min × 0.9, max × 1.1] (floor 500); y = asking NNN-eq, domain [max(0, min − pad), max + pad] where pad = max(5% of range, 0.25). Band edges 0 · 5,000 · 15,000 · 30,000 · 50,000 · 80,000; a band renders only with ≥ `minN` **solid** points; `minSf`/`maxSf` are the raw edge values (the component clamps them to the x-domain when drawing). Dots: solid fill = quoted NNN, hollow = converted; highlighted (ORA) r=5 `var(--color-warn)`, others r=3.5 `var(--color-info)`. Band: translucent `var(--accent)` rect P25–P75 plus a 2px median line. Empty state text `No quoted asking rents yet.`

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/rent-curve.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { RentCurve } from '../../src/charts/RentCurve';
import { curveDomains, sizeBands, type CurveDatum } from '../../src/charts/rent-curve-layout';

afterEach(cleanup);
const pt = (id: number, sf: number, value: number, solid = true): CurveDatum => ({ id: String(id), sf, value, solid, highlight: false, label: `p${id}` });

describe('rent curve layout', () => {
  it('pads domains and floors them', () => {
    expect(curveDomains([])).toBeNull();
    const d = curveDomains([pt(1, 10000, 8), pt(2, 20000, 12)])!;
    expect(d.x[0]).toBeCloseTo(9000);
    expect(d.x[1]).toBeCloseTo(22000);
    expect(d.y[0]).toBeCloseTo(7.75);
    expect(d.y[1]).toBeCloseTo(12.25);
    expect(curveDomains([pt(1, 400, 0.1)])!.x[0]).toBe(500);
    expect(curveDomains([pt(1, 400, 0.1)])!.y[0]).toBe(0);
  });

  it('builds bands only from solid points with n >= minN', () => {
    const pts = [
      ...[8, 9, 10, 11, 12].map((v, i) => pt(i, 20000, v)),
      pt(10, 20000, 3, false),
      ...[7, 8, 9, 10].map((v, i) => pt(20 + i, 8000, v)),
    ];
    const bands = sizeBands(pts);
    expect(bands).toEqual([{ minSf: 15000, maxSf: 30000, p25: 9, median: 10, p75: 11, n: 5 }]);
  });
});

describe('RentCurve', () => {
  it('renders the empty state without NaN', () => {
    render(<RentCurve points={[]} />);
    expect(screen.getByText('No quoted asking rents yet.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/NaN/);
  });
});
```

- [ ] **Step 2:** `npx vitest run tests/unit/rent-curve.test.tsx` — Expected: FAIL.

- [ ] **Step 3: Write the layout helpers**

```ts
// src/charts/rent-curve-layout.ts
//
// Pure layout helpers for RentCurve (kept out of the component file so react-refresh lint stays clean).
import { quantileSorted } from '@analytics/lease-market/benchmarks';

export interface CurveDatum {
  id: string;
  sf: number;
  value: number;
  solid: boolean;
  highlight: boolean;
  label: string;
}

export interface CurveBand {
  minSf: number;
  maxSf: number;
  p25: number;
  median: number;
  p75: number;
  n: number;
}

const BAND_EDGES = [0, 5000, 15000, 30000, 50000, 80000] as const;

export function curveDomains(points: readonly CurveDatum[]): { x: [number, number]; y: [number, number] } | null {
  if (points.length === 0) return null;
  const sfs = points.map((p) => p.sf);
  const values = points.map((p) => p.value);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const pad = Math.max((maxV - minV) * 0.05, 0.25);
  return {
    x: [Math.max(500, Math.min(...sfs) * 0.9), Math.max(...sfs) * 1.1],
    y: [Math.max(0, minV - pad), maxV + pad],
  };
}

export function sizeBands(points: readonly CurveDatum[], minN = 5): CurveBand[] {
  const out: CurveBand[] = [];
  for (let i = 0; i < BAND_EDGES.length - 1; i++) {
    const lo = BAND_EDGES[i]!;
    const hi = BAND_EDGES[i + 1]!;
    const values = points.filter((p) => p.solid && p.sf >= lo && (i === BAND_EDGES.length - 2 ? p.sf <= hi : p.sf < hi)).map((p) => p.value).sort((a, b) => a - b);
    if (values.length < minN) continue;
    out.push({ minSf: lo, maxSf: hi, p25: quantileSorted(values, 0.25)!, median: quantileSorted(values, 0.5)!, p75: quantileSorted(values, 0.75)!, n: values.length });
  }
  return out;
}
```

- [ ] **Step 4: Write the component**

```tsx
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
import { curveDomains, sizeBands, type CurveDatum } from './rent-curve-layout';

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
  const ih = height - margin.top - margin.bottom;
  const x = scaleLog<number>({ domain: domains.x, range: [0, iw] });
  const y = scaleLinear<number>({ domain: domains.y, range: [ih, 0] });
  const clampX = (sf: number) => x(Math.min(domains.x[1], Math.max(domains.x[0], sf)));

  return (
    <div ref={ref} style={{ width: '100%', position: 'relative' }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Asking rent by available square feet">
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
            {points.map((p) => {
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
            <AxisBottom top={ih} scale={x} numTicks={6} hideAxisLine hideTicks tickFormat={(v) => sfFormat(Number(v))} tickLabelProps={() => ({ ...AXIS_TICK, textAnchor: 'middle', dy: '0.5em' })} />
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
```

- [ ] **Step 5:** `npx vitest run tests/unit/rent-curve.test.tsx && npm run typecheck && npx eslint src/charts/RentCurve.tsx src/charts/rent-curve-layout.ts tests/unit/rent-curve.test.tsx --max-warnings 0` — Expected: PASS / clean. (If `@analytics` does not resolve under the web tsconfig, import `quantileSorted` by relative path `../analytics/lease-market/benchmarks`.)

- [ ] **Step 6: Commit** — `git add src/charts/RentCurve.tsx src/charts/rent-curve-layout.ts tests/unit/rent-curve.test.tsx` ("feat(charts): RentCurve asking-rent vs SF scatter with size-band quartiles").
