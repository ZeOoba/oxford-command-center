// tests/unit/stacked-bar-chart.test.tsx
// StackedBarChart primitive (Portfolio Trends Wave 3B). Pins stacking geometry, credit (negative)
// segments, overlay alignment, degenerate inputs and hover content.
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { StackedBarChart } from '../../src/charts/StackedBarChart';
import { SERIES } from '../../src/charts/theme';

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

// jsdom never runs framer-motion's animation: render the TARGET (animate) geometry as attributes.
vi.mock('framer-motion', () => ({
  motion: {
    rect: ({ animate, initial: _i, transition: _t, ...rest }: Record<string, unknown> & { animate: { height: number; y: number } }) => (
      <rect {...(rest as object)} height={animate.height} y={animate.y} />
    ),
  },
}));

interface Geo { el: Element; key: string | null; x: number; y: number; h: number; fill: string | null }
function rects(container: HTMLElement): Geo[] {
  return [...container.querySelectorAll('svg rect')].map((r) => ({
    el: r,
    key: r.getAttribute('data-key'),
    x: Number(r.getAttribute('x')),
    y: Number(r.getAttribute('y')),
    h: Number(r.getAttribute('height')),
    fill: r.getAttribute('fill'),
  }));
}
const KEYS = ['a', 'b', 'c'];

describe('StackedBarChart', () => {
  it('draws one rect per non-zero segment and skips zero segments', () => {
    const { container } = render(
      <StackedBarChart
        keys={KEYS}
        data={[
          { label: 'Jan', segments: [{ key: 'a', value: 10 }, { key: 'b', value: 0 }, { key: 'c', value: 5 }] },
          { label: 'Feb', segments: [{ key: 'a', value: 20 }] },
        ]}
      />,
    );
    expect(rects(container)).toHaveLength(3);
  });

  it('stacks positives contiguously upward; total height equals the sum scaled by one y scale', () => {
    const { container } = render(
      <StackedBarChart
        keys={KEYS}
        data={[
          { label: 'Jan', segments: [{ key: 'a', value: 10 }, { key: 'b', value: 20 }, { key: 'c', value: 10 }] },
          { label: 'Feb', segments: [{ key: 'a', value: 10 }] },
        ]}
      />,
    );
    const g = rects(container);
    const jan = g.filter((r) => r.x === g[0]!.x);
    expect(jan).toHaveLength(3);
    const feb = g.filter((r) => r.x !== g[0]!.x);
    const perUnit = feb[0]!.h / 10;
    // Contiguous: each next segment's bottom edge is the previous one's top edge.
    expect(jan[1]!.y + jan[1]!.h).toBeCloseTo(jan[0]!.y, 5);
    expect(jan[2]!.y + jan[2]!.h).toBeCloseTo(jan[1]!.y, 5);
    expect(jan[0]!.h).toBeCloseTo(10 * perUnit, 5);
    expect(jan[1]!.h).toBeCloseTo(20 * perUnit, 5);
    expect(jan[0]!.h + jan[1]!.h + jan[2]!.h).toBeCloseTo(40 * perUnit, 5);
    // Both stacks share the zero baseline.
    expect(jan[0]!.y + jan[0]!.h).toBeCloseTo(feb[0]!.y + feb[0]!.h, 5);
  });

  it('negative (credit) segments stack downward below the baseline; no rect has a negative height', () => {
    const { container } = render(
      <StackedBarChart
        keys={KEYS}
        data={[
          { label: 'Jan', segments: [{ key: 'a', value: 30 }, { key: 'b', value: -10 }, { key: 'c', value: -20 }] },
          { label: 'Feb', segments: [{ key: 'a', value: 30 }] },
        ]}
      />,
    );
    const g = rects(container);
    for (const r of g) {
      expect(Number.isFinite(r.y) && Number.isFinite(r.h)).toBe(true);
      expect(r.h).toBeGreaterThanOrEqual(0);
      expect(r.el.getAttribute('height')!.startsWith('-')).toBe(false);
    }
    const jan = g.filter((r) => r.x === g[0]!.x);
    const baseline = jan[0]!.y + jan[0]!.h; // positive segment ends on the baseline
    const perUnit = jan[0]!.h / 30;
    expect(jan[1]!.y).toBeCloseTo(baseline, 5); // -10 starts at baseline, hangs down
    expect(jan[1]!.h).toBeCloseTo(10 * perUnit, 5);
    expect(jan[2]!.y).toBeCloseTo(jan[1]!.y + jan[1]!.h, 5); // -20 contiguous below it
    expect(jan[2]!.h).toBeCloseTo(20 * perUnit, 5);
  });

  it('ignores a segment whose key is not in `keys`; a key with no data draws nothing', () => {
    const { container } = render(
      <StackedBarChart
        keys={['a', 'unused']}
        data={[{ label: 'Jan', segments: [{ key: 'a', value: 10 }, { key: 'zzz', value: 99 }] }]}
      />,
    );
    const g = rects(container);
    expect(g).toHaveLength(1);
    expect(g[0]!.key).toBe('a');
    // The ignored segment must not inflate the y domain: the lone stack fills the plot.
    expect(g[0]!.h).toBeCloseTo(250 - 22 - 36, 5);
  });

  it('assigns colours from the shared SERIES palette by keys order', () => {
    const { container } = render(
      <StackedBarChart keys={KEYS} data={[{ label: 'Jan', segments: [{ key: 'c', value: 1 }, { key: 'a', value: 1 }] }]} />,
    );
    const byKey = Object.fromEntries(rects(container).map((r) => [r.key, r.fill]));
    expect(byKey.a).toBe(SERIES[0]);
    expect(byKey.c).toBe(SERIES[2]);
  });

  it('overlay draws exactly one path with one point per matching label; unmatched labels are dropped', () => {
    const data = [
      { label: 'Jan', segments: [{ key: 'a', value: 10 }] },
      { label: 'Feb', segments: [{ key: 'a', value: 20 }] },
      { label: 'Mar', segments: [{ key: 'a', value: 15 }] },
    ];
    const { container } = render(
      <StackedBarChart
        keys={KEYS}
        data={data}
        overlay={[{ label: 'Jan', value: 12 }, { label: 'Feb', value: 18 }, { label: 'Mar', value: 16 }]}
      />,
    );
    const paths = container.querySelectorAll('svg path.overlay-line');
    expect(paths).toHaveLength(1);
    const d = paths[0]!.getAttribute('d')!;
    expect(d).not.toMatch(/NaN/);
    expect(d.match(/[ML]/g)).toHaveLength(3);
    // Aligned to bar centres: first point x equals Jan rect centre.
    const g = rects(container);
    const rw = Number(container.querySelector('svg rect')!.getAttribute('width'));
    const firstX = Number(d.match(/M\s*([\d.-]+)/)![1]);
    expect(firstX).toBeCloseTo(g[0]!.x + rw / 2, 3);

    cleanup();
    const { container: c2 } = render(
      <StackedBarChart keys={KEYS} data={data} overlay={[{ label: 'Jan', value: 12 }, { label: 'Nope', value: 5 }, { label: 'Mar', value: 16 }]} />,
    );
    expect(c2.querySelector('svg path.overlay-line')!.getAttribute('d')!.match(/[ML]/g)).toHaveLength(2);
  });

  it('empty data, a single bar and all-zero data do not throw and emit no NaN attributes', () => {
    expect(() => render(<StackedBarChart keys={KEYS} data={[]} />)).not.toThrow();
    cleanup();
    const single = render(<StackedBarChart keys={KEYS} data={[{ label: 'Jan', segments: [{ key: 'a', value: 5 }] }]} />);
    expect(rects(single.container)).toHaveLength(1);
    expect(single.container.innerHTML).not.toMatch(/NaN/);
    cleanup();
    const zero = render(
      <StackedBarChart keys={KEYS} data={[{ label: 'Jan', segments: [{ key: 'a', value: 0 }, { key: 'b', value: 0 }] }]} overlay={[{ label: 'Jan', value: 0 }]} />,
    );
    expect(rects(zero.container)).toHaveLength(0);
    expect(zero.container.innerHTML).not.toMatch(/NaN/);
  });

  it('sets ariaLabel on the svg', () => {
    const { container } = render(<StackedBarChart keys={KEYS} data={[{ label: 'Jan', segments: [{ key: 'a', value: 1 }] }]} ariaLabel="Expenses by category" />);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe('Expenses by category');
  });

  it('hover shows signed per-segment values and the stack total', () => {
    const { container } = render(
      <StackedBarChart
        keys={KEYS}
        valueFormat={(n) => `$${n}`}
        data={[{ label: 'Jan', segments: [{ key: 'a', value: 30 }, { key: 'b', value: -10 }] }]}
      />,
    );
    fireEvent.mouseMove(rects(container)[0]!.el);
    const tip = container.querySelector('[data-testid="stacked-tooltip"]')!;
    expect(tip).not.toBeNull();
    // Header, then each segment as key + signed value (credit shown as -$10), then the net total.
    expect(tip.textContent).toBe('Jana$30b-$10Total$20');
  });
});

describe('StackedBarChart domain edge cases', () => {
  const PLOT = 250 - 22 - 36;
  it('an overlay value above the tallest stack widens the y domain', () => {
    const data = [{ label: 'Jan', segments: [{ key: 'a', value: 10 }] }];
    const without = rects(render(<StackedBarChart keys={KEYS} data={data} />).container);
    expect(without[0]!.h).toBeCloseTo(PLOT, 5); // lone stack fills the plot
    cleanup();
    const { container } = render(<StackedBarChart keys={KEYS} data={data} overlay={[{ label: 'Jan', value: 20 }]} />);
    const g = rects(container);
    expect(g[0]!.h).toBeCloseTo(PLOT / 2, 5); // domain [0,20] halves the bar
    const d = container.querySelector('svg path.overlay-line')!.getAttribute('d')!;
    const py = Number(d.match(/M[\d.-]+,([\d.-]+)/)![1]);
    expect(py).toBeGreaterThanOrEqual(0); // inside the plot, not clipped above it
    expect(py).toBeCloseTo(0, 5);
  });

  it('all-negative data hangs rects downward from the top baseline, none above it', () => {
    const { container } = render(
      <StackedBarChart
        keys={KEYS}
        data={[
          { label: 'Jan', segments: [{ key: 'a', value: -10 }] },
          { label: 'Feb', segments: [{ key: 'a', value: -10 }, { key: 'b', value: -20 }] },
        ]}
      />,
    );
    const g = rects(container);
    expect(g).toHaveLength(3);
    for (const r of g) {
      expect(r.h).toBeGreaterThan(0);
      expect(r.y).toBeGreaterThanOrEqual(0 - 1e-9); // baseline (domain max 0) is the plot top
    }
    const feb = g.filter((r) => r.x !== g[0]!.x);
    expect(feb[0]!.y).toBeCloseTo(0, 5);
    expect(feb[0]!.h + feb[1]!.h).toBeCloseTo(PLOT - 18, 5); // domain [-30,0], range stops 18px short
    expect(g[0]!.h).toBeCloseTo((PLOT - 18) / 3, 5);
    expect(container.innerHTML).not.toMatch(/NaN/);
  });
});
