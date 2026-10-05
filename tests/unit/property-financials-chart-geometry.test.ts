// @vitest-environment node
//
// tests/unit/property-financials-chart-geometry.test.ts — T5 of
// docs/superpowers/plans/2026-10-05-property-financials-module.md. The pure geometry behind the
// module's hand-built SVG charts (scale, nice axis top, gap-aware line path, nearest index for the
// crosshair, single-scale diverging layout). T6/T7 reuse these, so they are pinned here.
import { describe, expect, it } from 'vitest';
import {
  divergingLayout,
  linePath,
  linearScale,
  nearestIndex,
  niceStep,
  niceTop,
  tickValues,
} from '../../src/modules/property-financials/charts/geometry';

describe('linearScale', () => {
  it('maps the domain onto the range linearly (inverted y works too)', () => {
    const x = linearScale([0, 10], [40, 140]);
    expect(x(0)).toBe(40);
    expect(x(5)).toBe(90);
    expect(x(10)).toBe(140);
    const y = linearScale([0, 100], [250, 10]);
    expect(y(0)).toBe(250);
    expect(y(100)).toBe(10);
    expect(y(50)).toBe(130);
  });

  it('a zero-width domain maps everything to the middle of the range (no NaN)', () => {
    const s = linearScale([5, 5], [0, 100]);
    expect(s(5)).toBe(50);
    expect(s(99)).toBe(50);
  });
});

describe('niceStep / niceTop / tickValues', () => {
  it('rounds a raw step up to 1, 2, 2.5, 5 or 10 times a power of ten', () => {
    expect(niceStep(0.8)).toBe(1);
    expect(niceStep(1.7)).toBe(2);
    expect(niceStep(2.2)).toBe(2.5);
    expect(niceStep(3.1)).toBe(5);
    expect(niceStep(7)).toBe(10);
    expect(niceStep(41_000)).toBe(50_000);
    expect(niceStep(0)).toBe(1);
  });

  it('niceTop covers the max with whole steps over the requested intervals', () => {
    const t = niceTop(184_000, 4); // raw step 46K → 50K → top 200K
    expect(t.step).toBe(50_000);
    expect(t.top).toBe(200_000);
    expect(t.top).toBeGreaterThanOrEqual(184_000);
    expect(niceTop(0, 4)).toEqual({ top: 1, step: 1 });
  });

  it('tickValues returns count+1 evenly spaced values from min to max', () => {
    expect(tickValues(0, 200, 4)).toEqual([0, 50, 100, 150, 200]);
  });
});

describe('linePath', () => {
  const x = (i: number) => i * 10;
  const y = (v: number) => 100 - v;

  it('draws M then L segments, one decimal', () => {
    expect(linePath([1, 2, 3], x, y)).toBe('M0.0 99.0L10.0 98.0L20.0 97.0');
  });

  it('breaks the path at a null (a missing month is a gap, never a zero)', () => {
    expect(linePath([null, null, 5, 6, null, 8], x, y)).toBe('M20.0 95.0L30.0 94.0M50.0 92.0');
  });

  it('is empty when every value is null', () => {
    expect(linePath([null, null], x, y)).toBe('');
  });
});

describe('nearestIndex', () => {
  it('maps a pixel to the nearest category index across the plot', () => {
    // plot from x=44 to x=544 over 11 points: one step = 50px
    expect(nearestIndex(44, 44, 500, 11)).toBe(0);
    expect(nearestIndex(118, 44, 500, 11)).toBe(1); // 74px → 1.48 → 1
    expect(nearestIndex(121, 44, 500, 11)).toBe(2); // 77px → 1.54 → 2
    expect(nearestIndex(544, 44, 500, 11)).toBe(10);
  });

  it('clamps outside the plot and to an optional minimum (trailing windows start at 2)', () => {
    expect(nearestIndex(-50, 44, 500, 11)).toBe(0);
    expect(nearestIndex(9999, 44, 500, 11)).toBe(10);
    expect(nearestIndex(44, 44, 500, 11, { min: 2 })).toBe(2);
  });

  it('a single point is always index 0', () => {
    expect(nearestIndex(300, 0, 500, 1)).toBe(0);
  });
});

describe('divergingLayout', () => {
  it('uses ONE scale on both sides of zero: equal magnitudes draw equal lengths', () => {
    const l = divergingLayout([{ value: 100 }, { value: -100 }], { left: 0, width: 400 });
    expect(l.zero).toBe(200);
    expect(l.bars[0]!.width).toBeCloseTo(200, 6);
    expect(l.bars[1]!.width).toBeCloseTo(200, 6);
    expect(l.bars[0]!.x).toBe(200);
    expect(l.bars[1]!.x).toBeCloseTo(0, 6);
  });

  it('places zero in proportion to the largest negative vs largest positive', () => {
    const l = divergingLayout([{ value: 300 }, { value: -100 }, { value: 50 }], { left: 10, width: 400 });
    expect(l.zero).toBeCloseTo(110, 6); // 10 + 400 * 100/400
    expect(l.bars[0]!.width).toBeCloseTo(300, 6);
    expect(l.bars[1]!.width).toBeCloseTo(100, 6);
    expect(l.bars[1]!.x).toBeCloseTo(10, 6);
    expect(l.bars[2]!.x).toBeCloseTo(110, 6);
  });

  it('all-positive data puts zero at the left edge; all-zero data stays finite', () => {
    const l = divergingLayout([{ value: 5 }, { value: 10 }], { left: 20, width: 100 });
    expect(l.zero).toBe(20);
    expect(l.bars[1]!.width).toBeCloseTo(100, 6);
    const z = divergingLayout([{ value: 0 }], { left: 0, width: 100 });
    expect(Number.isFinite(z.zero)).toBe(true);
    expect(z.bars[0]!.width).toBe(0);
  });
});
