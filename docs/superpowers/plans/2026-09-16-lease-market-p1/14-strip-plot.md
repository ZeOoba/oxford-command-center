### Task 14: `StripPlot` chart (visx)

**Files:**
- Create: `src/charts/StripPlot.tsx`
- Test: `tests/unit/strip-plot.test.tsx`

**Interfaces:**
- Consumes: `useMeasure` from `@/lib/useMeasure`; `AXIS_TICK`, `GRID_STROKE` from `src/charts/theme.ts`; `@visx/group`, `@visx/scale`, `@visx/axis` (already dependencies). Follow `src/charts/BarChart.tsx` for structure, tooltip styling and tokens.
- Produces:
  - `interface StripPoint { id: string; value: number; solid: boolean; highlight: boolean; label: string }`
  - `interface StripGroup { key: string; label: string; points: StripPoint[]; p25: number | null; median: number | null; p75: number | null }`
  - `jitter(id: string): number` — deterministic, in [-0.5, 0.5)
  - `stripDomain(groups: readonly StripGroup[]): [number, number] | null` — shared x domain padded by max(5% of range, 0.25), floor 0; null when there are no points
  - `StripPlot(props: { groups: StripGroup[]; rowHeight?: number; valueFormat?: (n: number) => string }): JSX.Element`

Encoding: one row per group; each point a circle (solid fill = quoted NNN / benchmark-eligible, hollow = converted/low confidence); highlighted points (ORA) larger and in `var(--color-warn)`, others `var(--color-info)`; P25–P75 band as a translucent `var(--accent)` rect; median as a 2px `var(--accent)` tick. Empty state text: `No quoted asking rents yet.`

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/strip-plot.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { StripPlot, jitter, stripDomain, type StripGroup } from '../../src/charts/StripPlot';

afterEach(cleanup);

const group = (points: number[]): StripGroup => ({
  key: 'g', label: 'Whse 15-30K', p25: null, median: null, p75: null,
  points: points.map((v, i) => ({ id: `p${i}`, value: v, solid: true, highlight: false, label: `p${i}` })),
});

describe('StripPlot helpers', () => {
  it('jitter is deterministic and bounded', () => {
    expect(jitter('abc')).toBe(jitter('abc'));
    for (const id of ['a', 'b', 'listing-123', '']) {
      expect(jitter(id)).toBeGreaterThanOrEqual(-0.5);
      expect(jitter(id)).toBeLessThan(0.5);
    }
  });

  it('pads the shared domain and floors at zero', () => {
    expect(stripDomain([])).toBeNull();
    expect(stripDomain([group([])])).toBeNull();
    const [lo, hi] = stripDomain([group([8, 12]), group([10])])!;
    expect(lo).toBeCloseTo(7.75);
    expect(hi).toBeCloseTo(12.25);
    expect(stripDomain([group([0.1])])![0]).toBe(0);
  });
});

describe('StripPlot', () => {
  it('renders the empty state without NaN', () => {
    render(<StripPlot groups={[group([])]} />);
    expect(screen.getByText('No quoted asking rents yet.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/NaN/);
  });
});
```

(jsdom reports width 0 from `useMeasure`, so the SVG branch does not render in unit tests; the helpers carry the logic and the module smoke test in Task 15 covers mounting.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/strip-plot.test.tsx`
Expected: FAIL — cannot resolve `StripPlot`.

- [ ] **Step 3: Write the component**

```tsx
// src/charts/StripPlot.tsx
//
// Horizontal strip plot: one row per group, one dot per listing, with the P25–P75 band and median.
// Solid dots = quoted NNN (benchmark-eligible); hollow = converted / low confidence; highlighted = ORA.
import { useMemo, useState } from 'react';
import { Group } from '@visx/group';
import { scaleLinear } from '@visx/scale';
import { AxisBottom } from '@visx/axis';
import { useMeasure } from '@/lib/useMeasure';
import { AXIS_TICK, GRID_STROKE } from './theme';

export interface StripPoint {
  id: string;
  value: number;
  solid: boolean;
  highlight: boolean;
  label: string;
}

export interface StripGroup {
  key: string;
  label: string;
  points: StripPoint[];
  p25: number | null;
  median: number | null;
  p75: number | null;
}

interface Props {
  groups: StripGroup[];
  rowHeight?: number;
  valueFormat?: (n: number) => string;
}

/** Deterministic vertical jitter in [-0.5, 0.5) so re-renders never reshuffle dots (FNV-1a hash of the id). */
export function jitter(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000 - 0.5;
}

/** Shared x-domain across all groups, padded; null when nothing is plottable. */
export function stripDomain(groups: readonly StripGroup[]): [number, number] | null {
  const values = groups.flatMap((g) => g.points.map((p) => p.value));
  if (values.length === 0) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max((max - min) * 0.05, 0.25);
  return [Math.max(0, min - pad), max + pad];
}

const defaultFormat = (n: number) => `$${n.toFixed(2)}`;

export function StripPlot({ groups, rowHeight = 44, valueFormat = defaultFormat }: Props) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<{ point: StripPoint; left: number; top: number } | null>(null);
  const domain = useMemo(() => stripDomain(groups), [groups]);

  if (!domain) {
    return (
      <div ref={ref} className="py-6 text-center text-2xs" style={{ color: 'var(--text-tertiary)' }}>
        No quoted asking rents yet.
      </div>
    );
  }

  const margin = { top: 8, right: 16, bottom: 28, left: 120 };
  const height = margin.top + margin.bottom + rowHeight * groups.length;
  const iw = Math.max(0, width - margin.left - margin.right);
  const x = scaleLinear<number>({ domain, range: [0, iw] });

  return (
    <div ref={ref} style={{ width: '100%', position: 'relative' }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Asking rent distribution">
          <Group left={margin.left} top={margin.top}>
            {groups.map((g, gi) => {
              const cy = gi * rowHeight + rowHeight / 2;
              return (
                <g key={g.key}>
                  <text x={-10} y={cy} textAnchor="end" dominantBaseline="middle" style={{ ...AXIS_TICK, fontSize: 11, fill: 'var(--text-secondary)' }}>
                    {g.label}
                  </text>
                  <line x1={0} x2={iw} y1={cy} y2={cy} stroke={GRID_STROKE} />
                  {g.p25 !== null && g.p75 !== null && (
                    <rect x={x(g.p25)} width={Math.max(1, x(g.p75) - x(g.p25))} y={cy - rowHeight * 0.3} height={rowHeight * 0.6} rx={3} fill="var(--accent)" opacity={0.12} />
                  )}
                  {g.median !== null && (
                    <line x1={x(g.median)} x2={x(g.median)} y1={cy - rowHeight * 0.34} y2={cy + rowHeight * 0.34} stroke="var(--accent)" strokeWidth={2} />
                  )}
                  {g.points.map((p) => {
                    const px = x(p.value);
                    const py = cy + jitter(p.id) * rowHeight * 0.5;
                    const color = p.highlight ? 'var(--color-warn)' : 'var(--color-info)';
                    return (
                      <circle
                        key={p.id}
                        cx={px}
                        cy={py}
                        r={p.highlight ? 5 : 3.5}
                        fill={p.solid ? color : 'transparent'}
                        stroke={color}
                        strokeWidth={1.5}
                        style={{ cursor: 'pointer' }}
                        onMouseMove={() => setHover({ point: p, left: margin.left + px, top: margin.top + py })}
                        onMouseLeave={() => setHover(null)}
                      />
                    );
                  })}
                </g>
              );
            })}
            <AxisBottom
              top={rowHeight * groups.length}
              scale={x}
              numTicks={6}
              hideAxisLine
              hideTicks
              tickFormat={(v) => valueFormat(Number(v))}
              tickLabelProps={() => ({ ...AXIS_TICK, textAnchor: 'middle', dy: '0.5em' })}
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
          <span style={{ color: 'var(--text-tertiary)' }}>{hover.point.label}</span>
          <span className="num ml-2 font-semibold" style={{ color: 'var(--text-primary)' }}>
            {valueFormat(hover.point.value)}
            {hover.point.solid ? '' : ' (converted)'}
          </span>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test, typecheck, lint**

Run: `npx vitest run tests/unit/strip-plot.test.tsx && npm run typecheck && npx eslint src/charts/StripPlot.tsx tests/unit/strip-plot.test.tsx --max-warnings 0`
Expected: PASS / clean. (`react-refresh/only-export-components` is a warning with `allowConstantExport`; exporting the two helper functions from a component file may trip it under `--max-warnings 0`. If so, move `jitter` and `stripDomain` to `src/charts/strip-plot-layout.ts`, import them in `StripPlot.tsx`, and point the test at the new file.)

- [ ] **Step 5: Commit**

```bash
git add src/charts/StripPlot.tsx tests/unit/strip-plot.test.tsx
git commit -F <message-file>   # "feat(charts): StripPlot for asking-rent distributions"
```
