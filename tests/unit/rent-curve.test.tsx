import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { RentCurve } from '../../src/charts/RentCurve';
import { curveDomains, sizeBands, type CurveDatum } from '../../src/charts/rent-curve-layout';

// jsdom doesn't ship ResizeObserver; RentCurve's useMeasure hook requires it (same pattern as
// grader-view.test.tsx / market-module-smoke.test.tsx). No-op stub.
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
});

describe('RentCurve', () => {
  it('renders the empty state without NaN', () => {
    render(<RentCurve points={[]} />);
    expect(screen.getByText('No quoted asking rents yet.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/NaN/);
  });
});
