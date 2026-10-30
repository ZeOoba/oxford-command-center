// tests/unit/bar-chart.test.tsx
//
// Minors (2026-09-23 review): BarChart's <svg role="img"> had no aria-label, unlike
// ScatterChart/Waterfall. Roadmap 2.5 (2026-10-30) made `ariaLabel` required.
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { BarChart } from '../../src/charts/BarChart';

// useMeasure's width starts at 0 and BarChart renders no <svg> until a ResizeObserver callback
// reports a nonzero width — the no-op stub used elsewhere in this suite never does. Invoke the
// callback immediately with a fixed width (same pattern as tests/unit/rent-curve.test.tsx).
class ImmediateResizeObserver {
  #cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.#cb = cb;
  }
  observe() {
    this.#cb([{ contentRect: { width: 400 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ImmediateResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('BarChart', () => {
  it('passes an optional ariaLabel through to the svg role="img"', () => {
    const { container } = render(<BarChart data={[{ label: 'A', value: 1 }]} ariaLabel="Test chart" />);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe('Test chart');
  });

});

// ---------------------------------------------------------------------------------------------
// Negative-value (diverging) bars. framer-motion animates height/y from 0 and jsdom never runs the
// animation, so mock motion.rect to render the TARGET (animate) geometry as plain attributes.
// ---------------------------------------------------------------------------------------------
vi.mock('framer-motion', () => ({
  motion: {
    rect: ({ animate, initial: _i, transition: _t, ...rest }: Record<string, unknown> & { animate: { height: number; y: number } }) => (
      <rect {...(rest as object)} height={animate.height} y={animate.y} />
    ),
  },
}));

interface Geo { x: number; y: number; w: number; h: number; fill: string | null }
function bars(container: HTMLElement): Geo[] {
  return [...container.querySelectorAll('svg rect')].map((r) => ({
    x: Number(r.getAttribute('x')),
    y: Number(r.getAttribute('y')),
    w: Number(r.getAttribute('width')),
    h: Number(r.getAttribute('height')),
    fill: r.getAttribute('fill'),
  }));
}
const PLOT_BOTTOM = 250 - 22 - 36; // height - margin.top - margin.bottom (defaults)

describe('BarChart negative values', () => {
  it('mixed data: one rect per bar, every height > 0, negatives hang below the zero baseline', () => {
    const data = [
      { label: 'A', value: 100 },
      { label: 'B', value: -50 },
      { label: 'C', value: 40 },
      { label: 'D', value: -100 },
    ];
    const { container } = render(<BarChart ariaLabel="T" data={data} />);
    const g = bars(container);
    expect(g).toHaveLength(4);
    for (const b of g) {
      expect(Number.isFinite(b.y) && Number.isFinite(b.h)).toBe(true);
      expect(b.h).toBeGreaterThan(0);
    }
    const baseline = g[0]!.y + g[0]!.h; // positive bar ends at the zero baseline
    expect(g[2]!.y + g[2]!.h).toBeCloseTo(baseline, 5);
    expect(g[1]!.y).toBeCloseTo(baseline, 5);
    expect(g[3]!.y).toBeCloseTo(baseline, 5);
    expect(g[3]!.h).toBeCloseTo(g[0]!.h, 5); // |-100| == |100|
    expect(g[1]!.h).toBeCloseTo(g[0]!.h / 2, 5);
    expect(g[3]!.y + g[3]!.h).toBeLessThanOrEqual(PLOT_BOTTOM);
    expect(g[1]!.fill).not.toBe(g[0]!.fill); // negative bars use a distinct color
  });

  it('all-positive data keeps the original geometry (bottom edge on plot bottom, height proportional)', () => {
    const { container } = render(
      <BarChart
        ariaLabel="T"
        data={[
          { label: 'A', value: 10 },
          { label: 'B', value: 20 },
          { label: 'C', value: 40 },
        ]}
      />,
    );
    const g = bars(container);
    for (const b of g) expect(b.y + b.h).toBeCloseTo(PLOT_BOTTOM, 5);
    expect(g[2]!.h).toBeCloseTo(PLOT_BOTTOM, 5); // max bar fills the plot
    expect(g[0]!.h).toBeCloseTo(PLOT_BOTTOM / 4, 5);
    expect(g[1]!.h).toBeCloseTo(PLOT_BOTTOM / 2, 5);
    expect(container.querySelectorAll('line.zero-baseline')).toHaveLength(0);
  });

  it('all-negative data renders visible bars hanging from the zero line', () => {
    const { container } = render(
      <BarChart ariaLabel="T" data={[{ label: 'A', value: -10 }, { label: 'B', value: -30 }]} />,
    );
    const g = bars(container);
    expect(g).toHaveLength(2);
    for (const b of g) expect(b.h).toBeGreaterThan(0);
    expect(g[0]!.y).toBeCloseTo(g[1]!.y, 5); // shared baseline at the top
    expect(g[1]!.h).toBeCloseTo(g[0]!.h * 3, 5);
  });

  it('zero value renders without negative or NaN attributes', () => {
    const { container } = render(
      <BarChart ariaLabel="T" data={[{ label: 'A', value: 0 }, { label: 'B', value: -5 }, { label: 'C', value: 5 }]} />,
    );
    for (const b of bars(container)) {
      expect(Number.isNaN(b.y) || Number.isNaN(b.h)).toBe(false);
      expect(b.h).toBeGreaterThanOrEqual(0);
    }
  });

  it('empty and single-bar data do not throw', () => {
    expect(() => render(<BarChart ariaLabel="T" data={[]} />)).not.toThrow();
    cleanup();
    const { container } = render(<BarChart ariaLabel="T" data={[{ label: 'A', value: -3 }]} />);
    expect(bars(container)[0]!.h).toBeGreaterThan(0);
  });
});
