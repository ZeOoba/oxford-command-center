import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { RentCurve } from '../../src/charts/RentCurve';
import { curveDomains, curveTickValues, sizeBands, type CurveDatum } from '../../src/charts/rent-curve-layout';

// jsdom doesn't ship ResizeObserver; RentCurve's useMeasure hook requires it (same pattern as
// grader-view.test.tsx / market-module-smoke.test.tsx). No-op stub — doesn't drive width, so it's
// only good enough for assertions that don't depend on the `width > 0` render branch.
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

  it('does not invert the x domain for a tight/single-SF cluster', () => {
    const d = curveDomains([pt(1, 400, 5), pt(2, 400, 6), pt(3, 400, 7)])!;
    expect(d.x[0]).toBe(500);
    expect(d.x[1]).toBe(600);
    expect(d.x[1]).toBeGreaterThan(d.x[0]);
  });

  it('returns a non-degenerate x domain for a single point', () => {
    const d = curveDomains([pt(1, 20000, 10)])!;
    expect(d.x[1]).toBeGreaterThan(d.x[0]);
  });

  it('ignores points with sf <= 0 or non-finite sf/value', () => {
    const bad: CurveDatum[] = [
      pt(1, 0, 5),
      pt(2, -100, 5),
      { ...pt(3, Infinity, 5) },
      { ...pt(4, 5000, NaN) },
      pt(5, 8000, 10),
    ];
    const d = curveDomains(bad)!;
    expect(d.x[0]).toBeCloseTo(7200); // only pt 5 (sf=8000) is valid: 8000 * 0.9
    expect(d.y[0]).toBeCloseTo(9.75); // 10 - pad(0.25)

    // All-invalid input has no valid points at all.
    expect(curveDomains([pt(1, 0, 5), pt(2, -1, 3)])).toBeNull();

    // sizeBands: 5 solid, in-range points plus 2 invalid ones (sf<=0) that must not leak into the
    // <5K band (band edges start at 0, so an unfiltered sf=0/-100 point would otherwise qualify).
    const bandPts = [
      pt(90, 0, 1),
      pt(91, -50, 1),
      ...[8, 9, 10, 11, 12].map((v, i) => pt(100 + i, 8000, v)),
    ];
    const bands = sizeBands(bandPts);
    expect(bands).toEqual([{ minSf: 5000, maxSf: 15000, p25: 9, median: 10, p75: 11, n: 5 }]);
  });

  it('places boundary SF values in the correct band (5-15K / 15-30K / 50-80K)', () => {
    const pts = [
      ...[8, 9, 10, 11, 12].map((v, i) => pt(i, 5000, v)), // exactly 5,000 -> 5-15K
      ...[8, 9, 10, 11, 12].map((v, i) => pt(10 + i, 15000, v)), // exactly 15,000 -> 15-30K
      ...[8, 9, 10, 11, 12].map((v, i) => pt(20 + i, 80000, v)), // exactly 80,000 -> 50-80K
    ];
    const bands = sizeBands(pts);
    expect(bands).toEqual([
      { minSf: 5000, maxSf: 15000, p25: 9, median: 10, p75: 11, n: 5 },
      { minSf: 15000, maxSf: 30000, p25: 9, median: 10, p75: 11, n: 5 },
      { minSf: 50000, maxSf: 80000, p25: 9, median: 10, p75: 11, n: 5 },
    ]);
  });

  it('curveTickValues filters the fixed candidate set to the domain', () => {
    expect(curveTickValues([720, 86000])).toEqual([1000, 2000, 5000, 10000, 20000, 50000]);
  });
});

describe('RentCurve', () => {
  it('renders the empty state without NaN', () => {
    render(<RentCurve points={[]} />);
    expect(screen.getByText('No quoted asking rents yet.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/NaN/);
  });

  it('renders the full scatter: svg, all dots, no NaN, at least one band', async () => {
    // useMeasure reads e.contentRect.width off each ResizeObserverEntry passed to the callback --
    // stub observe() to invoke it immediately with a fixed width so the width>0 render branch fires.
    class ImmediateResizeObserver {
      #cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.#cb = cb;
      }
      observe() {
        this.#cb([{ contentRect: { width: 600 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ImmediateResizeObserver);

    const points: CurveDatum[] = [
      ...[8, 9, 10, 11, 12, 13].map((v, i) => pt(i, 20000 + i * 100, v)), // 6 solid, 15-30K
      ...[8, 9, 10, 11, 12].map((v, i) => pt(20 + i, 35000 + i * 100, v)), // 5 solid, 30-50K
      { id: 'ora', sf: 60000, value: 14, solid: true, highlight: true, label: 'ORA space' }, // 1 highlighted
    ];
    expect(points).toHaveLength(12);

    const { container } = render(<RentCurve points={points} />);

    await waitFor(() => {
      expect(container.querySelector('svg')).toBeTruthy();
      expect(container.querySelectorAll('circle')).toHaveLength(12);
    });
    expect(container.innerHTML).not.toMatch(/NaN/);
    expect(container.querySelectorAll('rect').length).toBeGreaterThanOrEqual(1);
  });
});
