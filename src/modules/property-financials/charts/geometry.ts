// src/modules/property-financials/charts/geometry.ts
//
// Pure geometry for the Property Financials hand-built SVG charts (plan T5). No React, no DOM:
// the components in this folder are thin renderers over these functions, and T6/T7 (Explorer,
// Levers, Watchlist) reuse them. Pinned in tests/unit/property-financials-chart-geometry.test.ts.

/** Linear map from `domain` onto `range`. A zero-width domain maps to the range midpoint. */
export function linearScale(domain: readonly [number, number], range: readonly [number, number]): (v: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  if (d1 === d0) {
    const mid = (r0 + r1) / 2;
    return () => mid;
  }
  const k = (r1 - r0) / (d1 - d0);
  return (v: number) => r0 + (v - d0) * k;
}

/** Round a raw step up to 1, 2, 2.5, 5 or 10 x a power of ten (the reference artifact's niceStep). */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  const m = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return m * p;
}

/** A nice axis top that covers `max` in whole steps over `intervals` gridline gaps. */
export function niceTop(max: number, intervals = 4): { top: number; step: number } {
  if (!(max > 0) || !Number.isFinite(max)) return { top: 1, step: 1 };
  const step = niceStep(max / intervals);
  return { top: Math.ceil(max / step) * step, step };
}

/** `count + 1` evenly spaced values from min to max inclusive (gridlines / tick labels). */
export function tickValues(min: number, max: number, count: number): number[] {
  return Array.from({ length: count + 1 }, (_, i) => min + ((max - min) * i) / count);
}

/** SVG path through the non-null points; a null breaks the line (a missing month is a gap, never 0). */
export function linePath(values: ReadonlyArray<number | null>, x: (i: number) => number, y: (v: number) => number): string {
  let d = '';
  let on = false;
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      on = false;
      return;
    }
    d += `${on ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    on = true;
  });
  return d;
}

/**
 * The category index nearest to pixel `px` on a plot spanning [left, left + width] with `n` evenly
 * spaced points, clamped to [min, max] (default the whole series).
 */
export function nearestIndex(px: number, left: number, width: number, n: number, opts: { min?: number; max?: number } = {}): number {
  if (n <= 1 || width <= 0) return 0;
  const raw = Math.round(((px - left) / width) * (n - 1));
  const lo = Math.max(0, opts.min ?? 0);
  const hi = Math.min(n - 1, opts.max ?? n - 1);
  return Math.max(lo, Math.min(hi, raw));
}

export interface DivergingBarGeometry {
  /** Left edge of the bar. */
  readonly x: number;
  readonly width: number;
}

export interface DivergingLayout {
  /** x of the zero line. */
  readonly zero: number;
  /** Pixels per unit, identical on both sides of zero. */
  readonly pxPerUnit: number;
  readonly bars: readonly DivergingBarGeometry[];
}

/**
 * Horizontal diverging bars on ONE scale: zero sits where the largest negative and the largest
 * positive both just fit, so a -$X bar is exactly as long as a +$X bar. (The reference artifact
 * pinned zero at 30% and scaled each side separately, which drew unequal lengths for equal
 * magnitudes — an intentional correction.)
 */
export function divergingLayout(items: ReadonlyArray<{ value: number }>, plot: { left: number; width: number }): DivergingLayout {
  const maxPos = Math.max(0, ...items.map((i) => i.value));
  const maxNeg = Math.max(0, ...items.map((i) => -i.value));
  const total = maxPos + maxNeg;
  if (total === 0) {
    return { zero: plot.left, pxPerUnit: 0, bars: items.map(() => ({ x: plot.left, width: 0 })) };
  }
  const pxPerUnit = plot.width / total;
  const zero = plot.left + maxNeg * pxPerUnit;
  return {
    zero,
    pxPerUnit,
    bars: items.map((i) => {
      const w = Math.abs(i.value) * pxPerUnit;
      return { x: i.value >= 0 ? zero : zero - w, width: w };
    }),
  };
}

// -------------------------------------------------------------------------------------------------
// Property explorer charts (plan T7): grouped / stacked period bars, lease step chart, rent-step
// markers, card sparkline. Pinned in tests/unit/property-financials-explorer-geometry.test.ts.
// -------------------------------------------------------------------------------------------------

export interface PlotBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface BarAxis {
  readonly min: number;
  readonly top: number;
  readonly step: number;
  /** Gridline values from min to top inclusive, one per step. */
  readonly ticks: readonly number[];
}

/**
 * Value axis for period bars (the reference artifact's barChart axis): step = niceStep of the
 * largest magnitude / 3.6, top = whole steps above the max, floor = whole steps below the most
 * negative value (or zero; always zero when `floorAtZero`, i.e. stacked bars). Zero is always on
 * the axis and the axis never collapses to zero height.
 */
export function barAxis(values: readonly number[], opts: { floorAtZero?: boolean } = {}): BarAxis {
  const finite = values.filter((v) => Number.isFinite(v));
  const mx = Math.max(0, ...finite);
  const mnRaw = opts.floorAtZero ? 0 : Math.min(0, ...finite);
  const step = niceStep(Math.max(mx, -mnRaw) / 3.6);
  const top = Math.ceil(mx / step) * step || step;
  const min = mnRaw < 0 ? -Math.ceil(-mnRaw / step) * step : 0;
  const ticks: number[] = [];
  const count = Math.round((top - min) / step);
  for (let i = 0; i <= count; i++) ticks.push(min + i * step);
  return { min, top, step, ticks };
}

/** y of value v on a bar axis inside the plot. */
export function barY(axis: BarAxis, plot: PlotBox): (v: number) => number {
  return linearScale([axis.min, axis.top], [plot.top + plot.height, plot.top]);
}

export interface BarRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly value: number;
}

export interface GroupedBarsLayout {
  readonly slot: number;
  readonly centers: readonly number[];
  /** [group][series] */
  readonly bars: ReadonlyArray<readonly BarRect[]>;
  readonly zeroY: number;
}

/** Side-by-side bars per group (period), one scale, rising from or hanging below zero. */
export function groupedBarsLayout(groups: ReadonlyArray<readonly number[]>, plot: PlotBox, axis: BarAxis): GroupedBarsLayout {
  const n = Math.max(1, groups.length);
  const slot = plot.width / n;
  const y = barY(axis, plot);
  const zeroY = y(0);
  const centers = groups.map((_, i) => plot.left + slot * (i + 0.5));
  const bw = Math.min(22, slot * 0.26);
  const bars = groups.map((vals, gi) => {
    const cx = centers[gi]!;
    const k = vals.length;
    return vals.map((v, si) => {
      const val = Number.isFinite(v) ? v : 0;
      const x = cx + (si - (k - 1) / 2) * (bw + 2) - bw / 2;
      const y1 = y(val);
      return { x, y: Math.min(zeroY, y1), width: bw, height: Math.max(1, Math.abs(zeroY - y1)), value: val };
    });
  });
  return { slot, centers, bars, zeroY };
}

export interface StackSegment extends BarRect {
  /** Index of the segment's series (category) in the input order. */
  readonly index: number;
}

export interface StackedBarsLayout {
  readonly slot: number;
  readonly centers: readonly number[];
  /** [group][drawn segment]; zero / negative segments are not drawn. */
  readonly segments: ReadonlyArray<readonly StackSegment[]>;
  /** Sum of the positive segments per group. */
  readonly totals: readonly number[];
  /** y of each group's total (the label sits above it). */
  readonly totalY: readonly number[];
}

/** Stacked bars per group, bottom-up in input order, with a 1.5px gap between segments. */
export function stackedBarsLayout(groups: ReadonlyArray<readonly number[]>, plot: PlotBox, axis: BarAxis): StackedBarsLayout {
  const n = Math.max(1, groups.length);
  const slot = plot.width / n;
  const y = barY(axis, plot);
  const centers = groups.map((_, i) => plot.left + slot * (i + 0.5));
  const bw = Math.min(34, slot * 0.62);
  const totals: number[] = [];
  const segments = groups.map((vals, gi) => {
    const cx = centers[gi]!;
    let acc = 0;
    const out: StackSegment[] = [];
    vals.forEach((raw, index) => {
      const v = Number.isFinite(raw) ? Math.max(0, raw) : 0;
      if (v <= 0) return;
      const y0 = y(acc);
      const y1 = y(acc + v);
      acc += v;
      out.push({ index, x: cx - bw / 2, y: y1, width: bw, height: Math.max(0, y0 - y1 - 1.5), value: v });
    });
    totals.push(acc);
    return out;
  });
  return { slot, centers, segments, totals, totalY: totals.map((t) => y(t)) };
}

export interface ScheduleStep {
  /** ISO date YYYY-MM-DD */
  readonly from: string;
  readonly to: string;
  /** Monthly amount. */
  readonly value: number;
}

export interface StepChartLayout {
  readonly path: string;
  readonly points: ReadonlyArray<{ readonly x: number; readonly y: number; readonly step: ScheduleStep }>;
  readonly top: number;
  readonly endX: number;
  /** x of `today`, or null when today is outside the schedule. */
  readonly todayX: number | null;
  readonly yearLabels: ReadonlyArray<{ readonly x: number; readonly text: string; readonly anchor: 'start' | 'end' }>;
  /** y of value v. */
  readonly y: (v: number) => number;
}

const isoMs = (d: string): number => Date.parse(`${d}T00:00:00Z`);

/** Lease rent schedule as a step line on a time axis, y from 0 to 112% of the largest step. */
export function stepChartLayout(steps: readonly ScheduleStep[], plot: PlotBox, today: string): StepChartLayout {
  const right = plot.left + plot.width;
  const bottom = plot.top + plot.height;
  if (steps.length === 0) return { path: '', points: [], top: 1, endX: right, todayX: null, yearLabels: [], y: () => bottom };
  const t0 = isoMs(steps[0]!.from);
  const t1 = isoMs(steps[steps.length - 1]!.to);
  const span = t1 - t0 || 1;
  const top = Math.max(...steps.map((s) => s.value)) * 1.12 || 1;
  const X = (t: number) => plot.left + (plot.width * (t - t0)) / span;
  const Y = (v: number) => plot.top + plot.height * (1 - v / top);
  let path = '';
  steps.forEach((s, i) => {
    path += `${i ? 'L' : 'M'}${r1(X(isoMs(s.from)))} ${r1(Y(s.value))}L${r1(X(isoMs(s.to)))} ${r1(Y(s.value))}`;
  });
  const tn = isoMs(today);
  const year = (t: number) => String(new Date(t).getUTCFullYear());
  return {
    path,
    points: steps.map((s) => ({ x: X(isoMs(s.from)), y: Y(s.value), step: s })),
    top,
    endX: X(t1),
    todayX: tn >= t0 && tn <= t1 ? X(tn) : null,
    yearLabels: [
      { x: X(t0), text: year(t0), anchor: 'start' },
      { x: X(t1), text: year(t1), anchor: 'end' },
    ],
    y: Y,
  };
}

/** One decimal, trailing .0 dropped (compact, stable path strings). */
function r1(v: number): number {
  return Number(v.toFixed(1));
}

/** Rent-step marker: a triangle pointing up (step up) or down (step down): shape, not colour alone. */
export function markerPath(cx: number, cy: number, dir: 'up' | 'down', r = 6): string {
  const h = r / 2;
  return dir === 'up'
    ? `M${r1(cx)} ${r1(cy - r)}L${r1(cx + r)} ${r1(cy + h)}L${r1(cx - r)} ${r1(cy + h)}Z`
    : `M${r1(cx)} ${r1(cy + r)}L${r1(cx + r)} ${r1(cy - h)}L${r1(cx - r)} ${r1(cy - h)}Z`;
}

/** Card sparkline (the artifact's sparkNoi): 3px side padding, 4px top / bottom. */
export function sparklineGeometry(values: readonly number[], W: number, H: number): { path: string; last: { x: number; y: number } | null } {
  if (values.length < 2) return { path: '', last: null };
  const mn = Math.min(...values);
  const rg = Math.max(...values) - mn || 1;
  const pts = values.map((v, i) => ({ x: 3 + ((W - 6) * i) / (values.length - 1), y: H - 4 - ((H - 8) * (v - mn)) / rg }));
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('');
  const lp = pts[pts.length - 1]!;
  return { path, last: { x: r1(lp.x), y: r1(lp.y) } };
}

/** Chart width: the container's, unless `count` marks need `perMark` px each (+ `extra`); then wider, scrolling inside. */
export function chartWidth(measured: number, count: number, perMark: number, extra: number, fallback = 600): number {
  const base = measured > 0 ? measured : fallback;
  return Math.max(base, count * perMark + extra);
}
