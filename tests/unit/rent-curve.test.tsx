import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { RentCurve } from '../../src/charts/RentCurve';
import { curveDomains, curveTickValues, sfFormat, sizeBands, validCurvePoints, type CurveDatum } from '../../src/charts/rent-curve-layout';

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

  it('sizeBands treats sf<=0 as invalid even at a lowered n threshold (fails without the filter)', () => {
    // 3 of these 5 points have sf=0, which alone satisfies the raw <5K band's `sf >= 0` check --
    // at minN=3 that's enough to form a phantom band under pre-fix (unfiltered) logic. With the
    // sf<=0 filter, all 5 (0s and -50s alike) are invalid, so no band forms at all.
    const pts = [pt(1, 0, 5), pt(2, 0, 6), pt(3, 0, 7), pt(4, -50, 8), pt(5, -50, 9)];
    expect(sizeBands(pts, 3)).toEqual([]);
  });

  it('curveTickValues filters the fixed candidate set to the domain', () => {
    expect(curveTickValues([720, 86000])).toEqual([1000, 2000, 5000, 10000, 20000, 50000]);
  });

  it('curveTickValues falls back to 3 evenly-log-spaced values for a narrow domain', () => {
    const a = curveTickValues([5400, 8800]);
    expect(a).toHaveLength(3);
    expect(a[0]).toBeLessThan(a[1]!);
    expect(a[1]).toBeLessThan(a[2]!);
    expect(a[0]).toBeGreaterThanOrEqual(5400);
    expect(a[2]).toBeLessThanOrEqual(8800);

    const b = curveTickValues([10800, 13200]);
    expect(b).toHaveLength(3);
    expect(b[0]).toBeLessThan(b[1]!);
    expect(b[1]).toBeLessThan(b[2]!);
  });

  it('validCurvePoints keeps only finite sf>0 / value points', () => {
    const mixed = [pt(1, 8000, 10), { ...pt(2, NaN, 5) }, { ...pt(3, 8000, Infinity) }, pt(4, 0, 5)];
    expect(validCurvePoints(mixed).map((p) => p.id)).toEqual(['1']);
  });

  it('sfFormat: sub-1K integer, 1K-10K one-decimal thousands, >=10K whole thousands', () => {
    expect(sfFormat(800)).toBe('800');
    expect(sfFormat(1800)).toBe('1.8K');
    expect(sfFormat(2000)).toBe('2.0K');
    expect(sfFormat(2200)).toBe('2.2K');
    expect(sfFormat(12000)).toBe('12K');
  });

  it('curveTickValues drops duplicate-labeled ticks (unique sfFormat labels, >= 2 ticks)', () => {
    const domains: [number, number][] = [
      [1800, 2200],
      [2700, 3630],
      [5544, 6776],
    ];
    for (const d of domains) {
      const labels = curveTickValues(d).map(sfFormat);
      expect(new Set(labels).size).toBe(labels.length);
      expect(labels.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('pins the fallback ticks for a single sf=1112 point to [1100, 1200]', () => {
    // sf=1112 -> x domain [1000.8, 1223.2] (0.9x floor / 1.1x ceiling). No LOG_TICK_CANDIDATES value
    // (500/1000/2000/...) falls inside that narrow band, so this exercises the 3-value fallback path,
    // whose ceil/floor-to-2-sig-figs endpoints round to 1100/1200 and whose midpoint (~1106) dedupes
    // against the 1100 endpoint's "1.1K" label, leaving exactly these two ticks.
    const d = curveDomains([pt(1, 1112, 9)])!;
    expect(curveTickValues(d.x)).toEqual([1100, 1200]);
  });

  it('curveTickValues fallback ticks stay within the domain (ceil/floor endpoints + clamped middle)', () => {
    const d: [number, number] = [5544, 6776];
    const ticks = curveTickValues(d);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(d[0]);
      expect(t).toBeLessThanOrEqual(d[1]);
    }
  });
});

describe('RentCurve', () => {
  it('renders the empty state without NaN', () => {
    render(<RentCurve points={[]} />);
    expect(screen.getByText('No quoted asking rents yet.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/NaN/);
  });

  it('filters invalid points before rendering: 3 valid dots, correct aria-label count, no NaN/Infinity', async () => {
    vi.stubGlobal('ResizeObserver', ImmediateResizeObserver);

    const points: CurveDatum[] = [
      pt(1, 8000, 8),
      pt(2, 12000, 9),
      pt(3, 20000, 10),
      { ...pt(4, NaN, 5) },
      { ...pt(5, 8000, Infinity) },
      pt(6, 0, 5),
    ];

    const { container } = render(<RentCurve points={points} />);

    await waitFor(() => {
      expect(container.querySelectorAll('circle')).toHaveLength(3);
    });
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-label')).toBe('Asking rent by available square feet, 3 listings');
    expect(container.innerHTML).not.toMatch(/NaN/);
    expect(container.innerHTML).not.toMatch(/Infinity/);
  });

  it('renders the full scatter: svg, all dots (incl. hollow), no NaN, band, ticks, highlighted-on-top', async () => {
    vi.stubGlobal('ResizeObserver', ImmediateResizeObserver);

    const points: CurveDatum[] = [
      // Highlighted point placed FIRST -- if RentCurve stopped sorting highlighted points last,
      // this would be the first rendered <circle>, not the last, and the r="5" assertion below
      // would fail against the wrong element. Ordering it last in the input would let that
      // regression slip through undetected.
      { id: 'ora', sf: 60000, value: 14, solid: true, highlight: true, label: 'ORA space' }, // 1 highlighted
      ...[8, 9, 10, 11, 12, 13].map((v, i) => pt(i, 20000 + i * 100, v)), // 6 solid, 15-30K
      ...[8, 9, 10, 11, 12].map((v, i) => pt(20 + i, 35000 + i * 100, v)), // 5 solid, 30-50K
      pt(30, 25000, 10.5, false), // 1 hollow (converted) point
    ];
    expect(points).toHaveLength(13);

    const { container } = render(<RentCurve points={points} />);

    await waitFor(() => {
      expect(container.querySelector('svg')).toBeTruthy();
      expect(container.querySelectorAll('circle')).toHaveLength(13);
    });
    expect(container.innerHTML).not.toMatch(/NaN/);
    expect(container.querySelectorAll('rect').length).toBeGreaterThanOrEqual(1);

    // Hollow (converted) point renders unfilled.
    expect(container.querySelectorAll('circle[fill="transparent"]').length).toBeGreaterThanOrEqual(1);

    // Highlighted (ORA) point renders last, on top of the general cloud, at the highlight radius.
    const circles = container.querySelectorAll('circle');
    const lastCircle = circles[circles.length - 1]!;
    expect(lastCircle.getAttribute('r')).toBe('5');

    // At least 2 x-axis tick labels (distinguished from the $-formatted y-axis labels).
    const xAxisLabels = Array.from(container.querySelectorAll('text')).filter((t) => /^\d+K?$/.test(t.textContent ?? ''));
    expect(xAxisLabels.length).toBeGreaterThanOrEqual(2);
  });

  it('renders decimal-thousands x-axis tick labels (e.g. "1.8K") for a low-SF domain', async () => {
    vi.stubGlobal('ResizeObserver', ImmediateResizeObserver);

    // sfFormat renders 1,000-9,999 SF as one decimal of thousands ("1.8K", "2.2K") -- a plain
    // `/^\d+K?$/` label regex (no decimal point) would silently fail to count these, which is
    // exactly the shape of tick label this test pins down.
    const points: CurveDatum[] = [pt(1, 1500, 8), pt(2, 2200, 9), pt(3, 3600, 10)];

    const { container } = render(<RentCurve points={points} />);

    await waitFor(() => {
      expect(container.querySelectorAll('circle')).toHaveLength(3);
    });
    // Widened to accept an optional one-decimal-place thousands label ("1.8K"), not just a bare
    // integer ("18K") -- sfFormat's own 1K-10K branch always emits one decimal.
    const xAxisLabels = Array.from(container.querySelectorAll('text')).filter((t) => /^\d+(\.\d)?K?$/.test(t.textContent ?? ''));
    expect(xAxisLabels.length).toBeGreaterThanOrEqual(2);
    expect(xAxisLabels.some((t) => /^\d+\.\dK$/.test(t.textContent ?? ''))).toBe(true);
  });
});

// Roadmap 2.6: RentCurve renders in the shared kit's MarkFrame.
describe('RentCurve kit frame', () => {
  it('arrow keys walk the listings left to right by SF, even though ORA draws last', () => {
    vi.stubGlobal('ResizeObserver', ImmediateResizeObserver);
    const points: CurveDatum[] = [
      { id: 'ora', sf: 9000, value: 14, solid: true, highlight: true, label: 'ORA suite' },
      pt(1, 20000, 9),
      pt(2, 4000, 11, false),
    ];
    const { container } = render(<RentCurve points={points} />);
    const group = container.querySelector('.ck-chart-focus') as HTMLElement;
    fireEvent.focus(group);
    const tip = () => container.querySelector('[role="status"]')!.textContent;
    expect(tip()).toBe('p24,000 SF · $11.00Converted / low confidence');
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(tip()).toBe('ORA suite9,000 SF · $14.00Quoted NNNORA space');
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(tip()).toMatch(/^p120,000 SF/);
  });

  it('the data table lists every listing, and every size band when there are any', () => {
    vi.stubGlobal('ResizeObserver', ImmediateResizeObserver);
    const points: CurveDatum[] = [...[8, 9, 10, 11, 12].map((v, i) => pt(i, 20000 + i * 100, v)), pt(9, 6000, 7, false)];
    const { container } = render(<RentCurve points={points} />);
    const tables = container.querySelectorAll('details.ck-tablefb table');
    expect(tables).toHaveLength(2);
    expect(tables[0]!.querySelectorAll('tbody tr')).toHaveLength(6);
    expect(tables[0]!.querySelector('tbody tr')!.textContent).toBe('p96,000$7.00Converted / low confidence');
    const band = [...tables[1]!.querySelectorAll('tbody tr')].map((r) => [...r.children].map((c) => c.textContent));
    expect(band).toHaveLength(1);
    expect(band[0]!.slice(1)).toEqual(['5', '$9.00', '$10.00', '$11.00']);
  });
});
