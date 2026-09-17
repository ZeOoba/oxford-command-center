// src/analytics/lease-market/benchmarks.ts
//
// Lease Market Intelligence — comparable-cell benchmarks (spec §3.5). Pure; no I/O.
// Robust stats only (median / P25 / P75), never means. Financial-decision source: refute pass required.
import { SIZE_BANDS, type CellBenchmark, type LmSubtype, type OfficeStratum, type SizeBand } from '../../contracts/lease-market';

export function quantileSorted(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  return a + (b - a) * (pos - lo);
}

export function medianOf(values: readonly number[]): number | null {
  return quantileSorted([...values].sort((x, y) => x - y), 0.5);
}

export function midRankPercentile(value: number, sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  let below = 0;
  let equal = 0;
  for (const v of sorted) {
    if (v < value) below++;
    else if (v === value) equal++;
  }
  return (below + 0.5 * equal) / sorted.length;
}

export interface BenchRow {
  listingId: number;
  marketId: string;
  submarket: string | null;
  subtype: LmSubtype;
  sizeBand: SizeBand;
  officeStratum: OfficeStratum;
  askingNnnEq: number | null;
  eligible: boolean;
  clearHeightFt: number | null;
  yearBuilt: number | null;
  docks: number | null;
}

export interface CellTarget {
  marketId: string;
  submarket: string | null;
  subtype: LmSubtype;
  sizeBand: SizeBand;
  officeStratum: OfficeStratum;
}

export interface ComputedCell extends CellBenchmark {
  values: number[];
  physicalMedians: { clearHeightFt: number | null; yearBuilt: number | null; docks: number | null };
}

export interface BenchmarkParams {
  minN: number;
  lowCoverageShare: number;
}

interface Attempt {
  rolledUp: CellBenchmark['rolledUp'];
  anySubmarket: boolean;
  widen: boolean;
}

function bandWindow(band: SizeBand, widen: boolean): SizeBand[] {
  if (!widen) return [band];
  const i = SIZE_BANDS.indexOf(band);
  return SIZE_BANDS.slice(Math.max(0, i - 1), Math.min(SIZE_BANDS.length, i + 2));
}

function nonNull(values: ReadonlyArray<number | null>): number[] {
  return values.filter((v): v is number => v !== null);
}

export function computeCell(target: CellTarget, rows: readonly BenchRow[], p: BenchmarkParams): ComputedCell {
  const attempts: Attempt[] =
    target.submarket === null
      ? [
          { rolledUp: 'market', anySubmarket: true, widen: false },
          { rolledUp: 'market', anySubmarket: true, widen: true },
        ]
      : [
          { rolledUp: 'none', anySubmarket: false, widen: false },
          { rolledUp: 'size_band', anySubmarket: false, widen: true },
          { rolledUp: 'market', anySubmarket: true, widen: true },
        ];

  let last: ComputedCell | null = null;
  for (const a of attempts) {
    const bands = bandWindow(target.sizeBand, a.widen);
    const matched = rows.filter(
      (r) =>
        r.marketId === target.marketId &&
        r.subtype === target.subtype &&
        r.officeStratum === target.officeStratum &&
        bands.includes(r.sizeBand) &&
        (a.anySubmarket || r.submarket === target.submarket),
    );
    const values = matched
      .filter((r) => r.eligible && r.askingNnnEq !== null)
      .map((r) => r.askingNnnEq as number)
      .sort((x, y) => x - y);
    const n = values.length;
    const totalN = matched.length;
    const quotedShare = totalN > 0 ? n / totalN : 0;
    const enough = n >= p.minN;
    const bandLabel = bands.length === 1 ? bands[0]! : `${bands[0]!}~${bands[bands.length - 1]!}`;
    const submarket = a.anySubmarket ? null : target.submarket;

    const cell: ComputedCell = {
      cellKey: [target.marketId, submarket ?? '*', target.subtype, bandLabel, target.officeStratum].join('|'),
      marketId: target.marketId,
      submarket,
      subtype: target.subtype,
      sizeBand: target.sizeBand,
      officeStratum: target.officeStratum,
      rolledUp: a.rolledUp,
      n,
      totalN,
      quotedShare,
      p25: enough ? quantileSorted(values, 0.25) : null,
      median: enough ? quantileSorted(values, 0.5) : null,
      p75: enough ? quantileSorted(values, 0.75) : null,
      lowCoverage: quotedShare < p.lowCoverageShare,
      values: enough ? values : [],
      physicalMedians: {
        clearHeightFt: medianOf(nonNull(matched.map((r) => r.clearHeightFt))),
        yearBuilt: medianOf(nonNull(matched.map((r) => r.yearBuilt))),
        docks: medianOf(nonNull(matched.map((r) => r.docks))),
      },
    };
    if (enough) return cell;
    last = cell;
  }
  return last!;
}

// Sentinel for a null submarket in the memo key — an escape character, never a value a real
// submarket string (including one that happens to be literally " ") could collide with.
const NULL_SUBMARKET_KEY = '\u0000';

export function cellIndex(rows: readonly BenchRow[], p: BenchmarkParams): (target: CellTarget) => ComputedCell {
  const memo = new Map<string, ComputedCell>();
  return (target) => {
    const key = [target.marketId, target.submarket ?? NULL_SUBMARKET_KEY, target.subtype, target.sizeBand, target.officeStratum].join('|');
    let cell = memo.get(key);
    if (!cell) {
      cell = computeCell(target, rows, p);
      memo.set(key, cell);
    }
    return cell;
  };
}

export function toCellBenchmark(c: ComputedCell): CellBenchmark {
  const { values: _values, physicalMedians: _physical, ...rest } = c;
  return rest;
}
