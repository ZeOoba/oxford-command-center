// tests/unit/bar-chart.test.tsx
//
// Minors (2026-09-23 review): BarChart's <svg role="img"> had no aria-label, unlike
// ScatterChart/Waterfall. Adds an optional `ariaLabel` prop passed straight through.
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

  it('renders no aria-label attribute when none is passed (no regression for existing callers)', () => {
    const { container } = render(<BarChart data={[{ label: 'A', value: 1 }]} />);
    expect(container.querySelector('svg')?.hasAttribute('aria-label')).toBe(false);
  });
});
