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
