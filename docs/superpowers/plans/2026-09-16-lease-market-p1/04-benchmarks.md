### Task 04: Benchmarks — quantiles, cell rollup, percentile (pure)

> **Plan rev 2:** unchanged from rev 1. Implement this task BEFORE Task 03 (normalize imports `medianOf`).

**Files:**
- Create: `src/analytics/lease-market/benchmarks.ts`
- Test: `tests/unit/lease-market-benchmarks.test.ts`

**Interfaces:**
- Consumes (Task 02): `SIZE_BANDS`, `CellBenchmark`, `LmSubtype`, `OfficeStratum`, `SizeBand` from `src/contracts/lease-market.ts`.
- Produces:
  - `quantileSorted(sorted: readonly number[], q: number): number | null` (linear interpolation, type 7)
  - `medianOf(values: readonly number[]): number | null`
  - `midRankPercentile(value: number, sorted: readonly number[]): number | null`
  - `interface BenchRow { listingId: number; marketId: string; submarket: string | null; subtype: LmSubtype; sizeBand: SizeBand; officeStratum: OfficeStratum; askingNnnEq: number | null; eligible: boolean; clearHeightFt: number | null; yearBuilt: number | null; docks: number | null }`
  - `interface CellTarget { marketId: string; submarket: string | null; subtype: LmSubtype; sizeBand: SizeBand; officeStratum: OfficeStratum }`
  - `interface ComputedCell extends CellBenchmark { values: number[]; physicalMedians: { clearHeightFt: number | null; yearBuilt: number | null; docks: number | null } }`
  - `interface BenchmarkParams { minN: number; lowCoverageShare: number }`
  - `computeCell(target: CellTarget, rows: readonly BenchRow[], p: BenchmarkParams): ComputedCell`
  - `cellIndex(rows: readonly BenchRow[], p: BenchmarkParams): (target: CellTarget) => ComputedCell` (memoized)
  - `toCellBenchmark(c: ComputedCell): CellBenchmark` (drops `values` and `physicalMedians`)

Rules (spec §3.5): `n` = eligible rows with a rent; `totalN` = all matched rows; `quotedShare = n / totalN` (0 when totalN = 0); `lowCoverage = quotedShare < lowCoverageShare`. Attempt order when `target.submarket !== null`: exact (`rolledUp 'none'`) ▸ same submarket, size band widened one step each side (`'size_band'`) ▸ any submarket, widened (`'market'`). When `target.submarket === null`: any submarket exact band ▸ any submarket widened, both `'market'`. First attempt with `n >= minN` wins; otherwise the LAST attempt is returned with `p25/median/p75 = null` and `values = []`. `cellKey` = `marketId|submarket-or-*|subtype|band-or-lo~hi|officeStratum`. The returned `sizeBand` is always the target's band.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/lease-market-benchmarks.test.ts
import { describe, it, expect } from 'vitest';
import {
  cellIndex, computeCell, medianOf, midRankPercentile, quantileSorted, toCellBenchmark,
  type BenchRow, type CellTarget,
} from '../../src/analytics/lease-market/benchmarks';

const P = { minN: 5, lowCoverageShare: 0.5 };
const TARGET: CellTarget = { marketId: 'columbus', submarket: 'East', subtype: 'warehouse', sizeBand: '15-30K', officeStratum: 'all' };
let nextId = 1;
function row(patch: Partial<BenchRow>): BenchRow {
  return {
    listingId: nextId++, marketId: 'columbus', submarket: 'East', subtype: 'warehouse', sizeBand: '15-30K',
    officeStratum: 'all', askingNnnEq: 8, eligible: true, clearHeightFt: null, yearBuilt: null, docks: null, ...patch,
  };
}

describe('quantiles', () => {
  it('interpolates', () => {
    expect(quantileSorted([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantileSorted([1, 2, 3, 4], 0.25)).toBe(1.75);
    expect(quantileSorted([], 0.5)).toBeNull();
    expect(medianOf([3, 1, 2])).toBe(2);
  });
  it('mid-rank percentile counts ties as half', () => {
    expect(midRankPercentile(3, [1, 2, 3, 4])).toBe(0.625);
    expect(midRankPercentile(0.5, [1, 2])).toBe(0);
    expect(midRankPercentile(5, [])).toBeNull();
  });
});

describe('computeCell', () => {
  it('uses the exact cell when it has n >= 5', () => {
    const rows = [6, 7, 8, 9, 10].map((v) => row({ askingNnnEq: v })).concat([row({ eligible: false, askingNnnEq: null })]);
    const c = computeCell(TARGET, rows, P);
    expect(c.rolledUp).toBe('none');
    expect(c.cellKey).toBe('columbus|East|warehouse|15-30K|all');
    expect([c.n, c.totalN, c.median, c.p25, c.p75]).toEqual([5, 6, 8, 7, 9]);
    expect(c.quotedShare).toBeCloseTo(5 / 6);
    expect(c.lowCoverage).toBe(false);
    expect(c.values).toEqual([6, 7, 8, 9, 10]);
  });

  it('widens the size band before dropping the submarket', () => {
    const rows = [
      ...[7, 8, 9].map((v) => row({ askingNnnEq: v })),
      ...[10, 11].map((v) => row({ askingNnnEq: v, sizeBand: '30-50K' })),
      ...[1, 1, 1, 1, 1].map((v) => row({ askingNnnEq: v, submarket: 'West' })),
    ];
    const c = computeCell(TARGET, rows, P);
    expect(c.rolledUp).toBe('size_band');
    expect(c.cellKey).toBe('columbus|East|warehouse|5-15K~30-50K|all');
    expect(c.n).toBe(5);
    expect(c.median).toBe(9);
    expect(c.sizeBand).toBe('15-30K');
  });

  it('rolls to market level when the submarket is thin', () => {
    const rows = [...[7, 8].map((v) => row({ askingNnnEq: v })), ...[9, 10, 11].map((v) => row({ askingNnnEq: v, submarket: 'West' }))];
    const c = computeCell(TARGET, rows, P);
    expect(c.rolledUp).toBe('market');
    expect(c.submarket).toBeNull();
    expect(c.cellKey).toBe('columbus|*|warehouse|5-15K~30-50K|all');
    expect(c.median).toBe(9);
  });

  it('returns null stats when nothing reaches n', () => {
    const c = computeCell(TARGET, [row({ askingNnnEq: 7 }), row({ askingNnnEq: 8 })], P);
    expect(c.rolledUp).toBe('market');
    expect([c.n, c.median, c.p25, c.p75]).toEqual([2, null, null, null]);
    expect(c.values).toEqual([]);
  });

  it('flags low coverage when most rows are unquoted', () => {
    const rows = [...[6, 7, 8, 9, 10].map((v) => row({ askingNnnEq: v })), ...Array.from({ length: 6 }, () => row({ eligible: false, askingNnnEq: null }))];
    const c = computeCell(TARGET, rows, P);
    expect(c.lowCoverage).toBe(true);
    expect(c.median).toBe(8);
  });

  it('a null-submarket target is market level from the start', () => {
    const rows = [5, 6, 7, 8, 9].map((v, i) => row({ askingNnnEq: v, submarket: i % 2 ? 'East' : 'West' }));
    const c = computeCell({ ...TARGET, submarket: null }, rows, P);
    expect(c.rolledUp).toBe('market');
    expect(c.cellKey).toBe('columbus|*|warehouse|15-30K|all');
  });

  it('never mixes subtypes, markets, or office strata', () => {
    const rows = [
      ...[6, 7, 8, 9, 10].map((v) => row({ askingNnnEq: v, subtype: 'flex' })),
      ...[6, 7, 8, 9, 10].map((v) => row({ askingNnnEq: v, marketId: 'madison' })),
      ...[6, 7, 8, 9, 10].map((v) => row({ askingNnnEq: v, officeStratum: 'office_ge40' })),
    ];
    expect(computeCell(TARGET, rows, P).n).toBe(0);
  });

  it('reports physical medians over matched rows', () => {
    const rows = [18, 20, 24, 22, 20].map((h, i) => row({ askingNnnEq: 6 + i, clearHeightFt: h, yearBuilt: 1980 + i, docks: i }));
    const c = computeCell(TARGET, rows, P);
    expect(c.physicalMedians).toEqual({ clearHeightFt: 20, yearBuilt: 1982, docks: 2 });
  });
});

describe('cellIndex / toCellBenchmark', () => {
  it('memoizes by target and strips internal fields', () => {
    const rows = [6, 7, 8, 9, 10].map((v) => row({ askingNnnEq: v }));
    const idx = cellIndex(rows, P);
    const a = idx(TARGET);
    expect(idx({ ...TARGET })).toBe(a);
    const pub = toCellBenchmark(a) as Record<string, unknown>;
    expect(pub.values).toBeUndefined();
    expect(pub.physicalMedians).toBeUndefined();
    expect(pub.median).toBe(8);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/lease-market-benchmarks.test.ts`
Expected: FAIL — cannot resolve `benchmarks`.

- [ ] **Step 3: Write the implementation**

```ts
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

export function cellIndex(rows: readonly BenchRow[], p: BenchmarkParams): (target: CellTarget) => ComputedCell {
  const memo = new Map<string, ComputedCell>();
  return (target) => {
    const key = [target.marketId, target.submarket ?? '\u0000', target.subtype, target.sizeBand, target.officeStratum].join('|');
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
```

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `npx vitest run tests/unit/lease-market-benchmarks.test.ts && npm run typecheck && npx eslint src/analytics/lease-market tests/unit/lease-market-benchmarks.test.ts --max-warnings 0`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/analytics/lease-market/benchmarks.ts tests/unit/lease-market-benchmarks.test.ts
git commit -F <message-file>   # "feat(analytics): lease market cell benchmarks with n-gated rollup"
```

## Review fixes (plan rev 2.1)

12. `cellIndex`'s memo key now uses the `'\u0000'` escape as the null-submarket sentinel (not a literal space), so a target with a real submarket string of `' '` no longer collides with — and returns the wrong cached cell for — a null-submarket target.
