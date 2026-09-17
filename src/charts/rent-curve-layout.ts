// src/charts/rent-curve-layout.ts
//
// Pure layout helpers for RentCurve (kept out of the component file so react-refresh lint stays clean).
import { quantileSorted } from '@analytics/lease-market/benchmarks';

export interface CurveDatum {
  id: string;
  sf: number;
  value: number;
  solid: boolean;
  highlight: boolean;
  label: string;
}

export interface CurveBand {
  minSf: number;
  maxSf: number;
  p25: number;
  median: number;
  p75: number;
  n: number;
}

const BAND_EDGES = [0, 5000, 15000, 30000, 50000, 80000] as const;

// Candidate log-axis tick values (decade multiples of 1/2/5). d3's default log-scale ticks emit
// every 1-9 multiple per decade, which overlaps at chart widths this component actually renders
// at — this fixed, sparse candidate set (filtered to the live domain) replaces that.
const LOG_TICK_CANDIDATES = [500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000] as const;

function roundToSigFigs(n: number, figs: number): number {
  return n === 0 ? 0 : Number(n.toPrecision(figs));
}

/**
 * Filters the fixed log-tick candidate set down to the ones inside `domain`. A narrow domain
 * (e.g. a size band that's all one SF magnitude) can leave fewer than 2 candidates inside it,
 * which would render a bare or single-tick axis — fall back to 3 values evenly spaced in log
 * space between the domain ends in that case.
 */
export function curveTickValues(domain: readonly [number, number]): number[] {
  const [lo, hi] = domain;
  const inRange = LOG_TICK_CANDIDATES.filter((t) => t >= lo && t <= hi);
  if (inRange.length >= 2) return inRange;
  const logLo = Math.log10(lo);
  const logHi = Math.log10(hi);
  const step = (logHi - logLo) / 2;
  return [0, 1, 2].map((i) => roundToSigFigs(10 ** (logLo + step * i), 2));
}

function finitePositiveSf(p: CurveDatum): boolean {
  return p.sf > 0 && Number.isFinite(p.sf) && Number.isFinite(p.value);
}

/**
 * The single source of truth for "is this point plottable" — sf > 0 and finite, value finite.
 * `curveDomains` and `sizeBands` both filter through this, and `RentCurve` uses it once (via
 * `useMemo`) to derive the circles, the aria-label count, and the domains/bands it renders.
 */
export function validCurvePoints(points: readonly CurveDatum[]): CurveDatum[] {
  return points.filter(finitePositiveSf);
}

export function curveDomains(points: readonly CurveDatum[]): { x: [number, number]; y: [number, number] } | null {
  const valid = validCurvePoints(points);
  if (valid.length === 0) return null;
  const sfs = valid.map((p) => p.sf);
  const values = valid.map((p) => p.value);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const pad = Math.max((maxV - minV) * 0.05, 0.25);
  const x0 = Math.max(500, Math.min(...sfs) * 0.9);
  // max(...) rather than the raw *1.1 figure — for a tight/single-SF cluster, min*0.9 (floored at
  // 500) can exceed max*1.1, which inverted the domain (x1 < x0). Guarantee x1 stays comfortably
  // above x0 instead.
  const x1 = Math.max(x0 * 1.2, Math.max(...sfs) * 1.1);
  return {
    x: [x0, x1],
    y: [Math.max(0, minV - pad), maxV + pad],
  };
}

export function sizeBands(points: readonly CurveDatum[], minN = 5): CurveBand[] {
  const valid = validCurvePoints(points);
  const out: CurveBand[] = [];
  for (let i = 0; i < BAND_EDGES.length - 1; i++) {
    const lo = BAND_EDGES[i]!;
    const hi = BAND_EDGES[i + 1]!;
    const values = valid.filter((p) => p.solid && p.sf >= lo && (i === BAND_EDGES.length - 2 ? p.sf <= hi : p.sf < hi)).map((p) => p.value).sort((a, b) => a - b);
    if (values.length < minN) continue;
    out.push({ minSf: lo, maxSf: hi, p25: quantileSorted(values, 0.25)!, median: quantileSorted(values, 0.5)!, p75: quantileSorted(values, 0.75)!, n: values.length });
  }
  return out;
}
