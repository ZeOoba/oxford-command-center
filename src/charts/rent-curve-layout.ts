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

export function curveDomains(points: readonly CurveDatum[]): { x: [number, number]; y: [number, number] } | null {
  if (points.length === 0) return null;
  const sfs = points.map((p) => p.sf);
  const values = points.map((p) => p.value);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const pad = Math.max((maxV - minV) * 0.05, 0.25);
  return {
    x: [Math.max(500, Math.min(...sfs) * 0.9), Math.max(...sfs) * 1.1],
    y: [Math.max(0, minV - pad), maxV + pad],
  };
}

export function sizeBands(points: readonly CurveDatum[], minN = 5): CurveBand[] {
  const out: CurveBand[] = [];
  for (let i = 0; i < BAND_EDGES.length - 1; i++) {
    const lo = BAND_EDGES[i]!;
    const hi = BAND_EDGES[i + 1]!;
    const values = points.filter((p) => p.solid && p.sf >= lo && (i === BAND_EDGES.length - 2 ? p.sf <= hi : p.sf < hi)).map((p) => p.value).sort((a, b) => a - b);
    if (values.length < minN) continue;
    out.push({ minSf: lo, maxSf: hi, p25: quantileSorted(values, 0.25)!, median: quantileSorted(values, 0.5)!, p75: quantileSorted(values, 0.75)!, n: values.length });
  }
  return out;
}
