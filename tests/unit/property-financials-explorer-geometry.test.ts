// @vitest-environment node
//
// tests/unit/property-financials-explorer-geometry.test.ts — T7 of
// docs/superpowers/plans/2026-10-05-property-financials-module.md. The pure geometry behind the
// Property explorer's hand-built SVG charts: the bar value axis, grouped and stacked bar layouts,
// the lease-schedule step chart on a time scale, rent-step markers, the card sparkline and the
// scroll width of a wide chart. Mirrors the reference artifact's barChart / stepChart / sparkNoi.
import { describe, expect, it } from 'vitest';
import {
  barAxis,
  chartWidth,
  groupedBarsLayout,
  markerPath,
  sparklineGeometry,
  stackedBarsLayout,
  stepChartLayout,
} from '../../src/modules/property-financials/charts/geometry';

const PLOT = { left: 52, top: 12, width: 500, height: 222 } as const;

describe('barAxis', () => {
  it('positive values: zero floor, nice step from max/3.6, top covers the max', () => {
    const a = barAxis([400_000, 120_000, 280_000]);
    // 400K / 3.6 = 111K → 200K step... niceStep(111_111) = 200_000; top = ceil(400K/200K)*200K = 400K
    expect(a.step).toBe(200_000);
    expect(a.min).toBe(0);
    expect(a.top).toBe(400_000);
    expect(a.ticks).toEqual([0, 200_000, 400_000]);
  });

  it('negative values extend the floor below zero in whole steps (grouped mode)', () => {
    const a = barAxis([300_000, -82_591]);
    expect(a.min).toBeLessThan(0);
    expect(a.min % a.step).toBe(-0);
    expect(a.min).toBeLessThanOrEqual(-82_591);
    expect(a.ticks[0]).toBe(a.min);
    expect(a.ticks).toContain(0);
  });

  it('stacked mode always floors at zero', () => {
    expect(barAxis([100, -50], { floorAtZero: true }).min).toBe(0);
  });

  it('all-zero / empty input never yields a zero-height axis (no NaN downstream)', () => {
    for (const a of [barAxis([]), barAxis([0, 0])]) {
      expect(a.top).toBeGreaterThan(a.min);
      expect(Number.isFinite(a.step)).toBe(true);
    }
  });

  it('all-negative input keeps zero on the axis', () => {
    const a = barAxis([-10, -40]);
    expect(a.top).toBeGreaterThan(0);
    expect(a.min).toBeLessThanOrEqual(-40);
  });
});

describe('groupedBarsLayout', () => {
  const groups = [
    [300, 100, 200],
    [400, 150, -50],
  ];
  const axis = barAxis(groups.flat());
  const L = groupedBarsLayout(groups, PLOT, axis);

  it('one slot per group, centres evenly spaced', () => {
    expect(L.slot).toBeCloseTo(250);
    expect(L.centers).toEqual([PLOT.left + 125, PLOT.left + 375]);
  });

  it('bars of a group sit side by side around the centre, same width', () => {
    const g = L.bars[0]!;
    expect(g).toHaveLength(3);
    const w = g[0]!.width;
    expect(g.every((b) => b.width === w)).toBe(true);
    expect(w).toBeLessThanOrEqual(22);
    expect(g[1]!.x + w / 2).toBeCloseTo(L.centers[0]!);
    expect(g[0]!.x).toBeLessThan(g[1]!.x);
    expect(g[2]!.x).toBeGreaterThan(g[1]!.x);
  });

  it('positive bars rise from zero; negative bars hang below it', () => {
    const pos = L.bars[0]![0]!;
    expect(pos.y + pos.height).toBeCloseTo(L.zeroY);
    const neg = L.bars[1]![2]!;
    expect(neg.y).toBeCloseTo(L.zeroY);
    expect(neg.height).toBeGreaterThan(0);
  });

  it('height is proportional to value on ONE scale', () => {
    const a = L.bars[0]![0]!; // 300
    const b = L.bars[1]![0]!; // 400
    expect(b.height / a.height).toBeCloseTo(4 / 3, 5);
  });

  it('a zero value still draws a 1px mark (hover target)', () => {
    const z = groupedBarsLayout([[0, 10]], PLOT, barAxis([10]));
    expect(z.bars[0]![0]!.height).toBe(1);
  });
});

describe('stackedBarsLayout', () => {
  const groups = [
    [100, 50, 0, 25],
    [200, 0, 80, -30],
  ];
  const axis = barAxis(groups.map((g) => g.reduce((a, v) => a + Math.max(0, v), 0)), { floorAtZero: true });
  const L = stackedBarsLayout(groups, PLOT, axis);

  it('totals ignore negative segments (opex categories cannot stack below zero)', () => {
    expect(L.totals).toEqual([175, 280]);
  });

  it('segments stack bottom-up in input order; zero / negative segments draw nothing', () => {
    const g0 = L.segments[0]!;
    expect(g0.map((s) => s.index)).toEqual([0, 1, 3]);
    expect(g0[0]!.y).toBeGreaterThan(g0[1]!.y);
    expect(L.segments[1]!.map((s) => s.index)).toEqual([0, 2]);
  });

  it('the stack top equals the scaled total', () => {
    const g0 = L.segments[0]!;
    const topSeg = g0[g0.length - 1]!;
    const yTotal = L.totalY[0]!;
    expect(topSeg.y).toBeCloseTo(yTotal);
  });

  it('bar width is capped at 34px and centred in the slot', () => {
    const s = L.segments[0]![0]!;
    expect(s.width).toBeLessThanOrEqual(34);
    expect(s.x + s.width / 2).toBeCloseTo(L.centers[0]!);
  });
});

describe('stepChartLayout', () => {
  const steps = [
    { from: '2025-04-01', to: '2026-03-31', value: 8950.5 },
    { from: '2026-04-01', to: '2027-03-31', value: 13005 },
    { from: '2027-04-01', to: '2028-03-31', value: 13464 },
  ];
  const L = stepChartLayout(steps, PLOT, '2026-10-05');

  it('x spans first from to last to; y tops out at 12% above the max step', () => {
    expect(L.points[0]!.x).toBeCloseTo(PLOT.left);
    expect(L.top).toBeCloseTo(13464 * 1.12);
    expect(L.endX).toBeCloseTo(PLOT.left + PLOT.width);
  });

  it('path draws a horizontal run per step joined by verticals', () => {
    expect(L.path.startsWith('M')).toBe(true);
    expect((L.path.match(/L/g) ?? []).length).toBe(steps.length * 2 - 1);
  });

  it('each step has a point at its start, higher value = smaller y', () => {
    expect(L.points).toHaveLength(3);
    expect(L.points[1]!.y).toBeLessThan(L.points[0]!.y);
  });

  it('today marker inside the term; null outside it', () => {
    expect(L.todayX).not.toBeNull();
    expect(L.todayX!).toBeGreaterThan(L.points[1]!.x);
    expect(stepChartLayout(steps, PLOT, '2030-01-01').todayX).toBeNull();
  });

  it('first and last year labels', () => {
    expect(L.yearLabels).toEqual([
      { x: PLOT.left, text: '2025', anchor: 'start' },
      { x: PLOT.left + PLOT.width, text: '2028', anchor: 'end' },
    ]);
  });

  it('empty schedule → empty layout, no NaN', () => {
    const e = stepChartLayout([], PLOT, '2026-10-05');
    expect(e.path).toBe('');
    expect(e.points).toEqual([]);
  });
});

describe('markerPath', () => {
  it('up = triangle pointing up, down = triangle pointing down (shape, not colour alone)', () => {
    expect(markerPath(10, 20, 'up', 6)).toBe('M10 14L16 23L4 23Z');
    expect(markerPath(10, 20, 'down', 6)).toBe('M10 26L16 17L4 17Z');
  });
});

describe('sparklineGeometry', () => {
  it('maps values into the box with padding; last point exposed for the end dot', () => {
    const s = sparklineGeometry([1, 3, 2], 96, 30);
    expect(s.path).toBe('M3.0 26.0L48.0 4.0L93.0 15.0');
    expect(s.last).toEqual({ x: 93, y: 15 });
  });

  it('fewer than two points → no line', () => {
    expect(sparklineGeometry([5], 96, 30).path).toBe('');
  });

  it('flat series does not divide by zero', () => {
    expect(sparklineGeometry([2, 2], 96, 30).path).not.toMatch(/NaN/);
  });
});

describe('chartWidth', () => {
  it('fits the container unless the marks need more room (then the container scrolls)', () => {
    expect(chartWidth(800, 5, 84, 60)).toBe(800);
    expect(chartWidth(360, 14, 84, 60)).toBe(14 * 84 + 60);
    expect(chartWidth(0, 2, 84, 60, 600)).toBe(600);
  });
});
