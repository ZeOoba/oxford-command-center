### Task 10: ORA positioning (pure over state)

**Files:**
- Create: `server/warehouse/lease-market/positioning.ts`
- Test: `tests/unit/lease-market-positioning.test.ts`

**Interfaces:**
- Consumes: Task 02 `LeaseMarketConfig`, `PositioningRow`; Task 03 `normalizeSuite`, `officeStratumFor`, `sizeBandFor`; Task 04 `CellTarget`, `ComputedCell`, `midRankPercentile`, `toCellBenchmark`.
- Produces:
  - `interface VacantUnit { propertyKey: string; unit: string | null; sf: number }`
  - `interface OraListingState { oraPropertyKey: string; suiteNorm: string; askingNnnEq: number | null; effectiveDom: number }`
  - `computePositioning(units: readonly VacantUnit[], config: LeaseMarketConfig, oraListings: readonly OraListingState[], cellFor: (t: CellTarget) => ComputedCell): { rows: PositioningRow[]; unconfiguredPropertyKeys: string[] }`

Rules (spec §3.6 `ora_positioning`): units whose `propertyKey` is not in `config.oraProperties` go to `unconfiguredPropertyKeys` (unique, sorted) and produce no row. Size band from the unit SF, falling back to `typicalUnitSf` when the unit SF is 0. ORA listing match: same non-empty normalized suite ▸ the only ORA listing for that property ▸ none. `percentile` = mid-rank of the ORA asking within the cell's values (null when either is missing). `gapPct = (asking − median) / median`. Band: `above` when gap > `positioningBandPct`, `below` when gap < −`positioningBandPct`, `in_band` otherwise, `unknown` when gap is null. Rows keep config order of units as given.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/lease-market-positioning.test.ts
import { describe, it, expect } from 'vitest';
import { computePositioning, type OraListingState } from '../../server/warehouse/lease-market/positioning';
import type { CellTarget, ComputedCell } from '../../src/analytics/lease-market/benchmarks';
import { testConfig } from './lease-market-fixtures';

const CELL: ComputedCell = {
  cellKey: 'columbus|East|warehouse|5-15K|all', marketId: 'columbus', submarket: 'East', subtype: 'warehouse', sizeBand: '5-15K',
  officeStratum: 'all', rolledUp: 'none', n: 5, totalN: 6, quotedShare: 5 / 6, p25: 9, median: 10, p75: 11, lowCoverage: false,
  values: [8, 9, 10, 11, 12], physicalMedians: { clearHeightFt: null, yearBuilt: null, docks: null },
};
const targets: CellTarget[] = [];
const cellFor = (t: CellTarget) => {
  targets.push(t);
  return CELL;
};
const listing = (suiteNorm: string, askingNnnEq: number | null): OraListingState => ({ oraPropertyKey: '1100 Rarig', suiteNorm, askingNnnEq, effectiveDom: 40 });

describe('computePositioning', () => {
  it('positions a matched suite above the band', () => {
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: 'Suite B', sf: 8000 }], testConfig(), [listing('B', 11.5), listing('C', 9)], cellFor);
    expect(r.unconfiguredPropertyKeys).toEqual([]);
    expect(r.rows[0]).toMatchObject({ propertyKey: '1100 Rarig', unit: 'Suite B', oraAskingNnnEq: 11.5, percentile: 0.8, band: 'above', effectiveDom: 40 });
    expect(r.rows[0]!.gapPct).toBeCloseTo(0.15);
    expect((r.rows[0]!.cell as Record<string, unknown>).values).toBeUndefined();
    expect(targets.at(-1)).toEqual({ marketId: 'columbus', submarket: 'East', subtype: 'warehouse', sizeBand: '5-15K', officeStratum: 'all' });
  });

  it('classifies in-band and below', () => {
    const inBand = computePositioning([{ propertyKey: '1100 Rarig', unit: 'B', sf: 8000 }], testConfig(), [listing('B', 10.5)], cellFor);
    expect(inBand.rows[0]!.band).toBe('in_band');
    const below = computePositioning([{ propertyKey: '1100 Rarig', unit: 'B', sf: 8000 }], testConfig(), [listing('B', 8.5)], cellFor);
    expect(below.rows[0]!.band).toBe('below');
  });

  it('falls back to the only ORA listing when suites do not match', () => {
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: 'Unit 7', sf: 8000 }], testConfig(), [listing('B', 10.5)], cellFor);
    expect(r.rows[0]!.oraAskingNnnEq).toBe(10.5);
  });

  it('reports unknown when there is no ORA asking rent, but still shows the cell', () => {
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: 'D', sf: 0 }], testConfig(), [listing('B', 10), listing('C', 10)], cellFor);
    expect(r.rows[0]).toMatchObject({ oraAskingNnnEq: null, percentile: null, gapPct: null, band: 'unknown', effectiveDom: null });
    expect(r.rows[0]!.cell?.median).toBe(10);
  });

  it('lists unconfigured properties once', () => {
    const r = computePositioning(
      [{ propertyKey: 'Sepich', unit: '1', sf: 2000 }, { propertyKey: 'Sepich', unit: '2', sf: 2000 }, { propertyKey: 'Arcade', unit: null, sf: 1000 }],
      testConfig(),
      [],
      cellFor,
    );
    expect(r.rows).toEqual([]);
    expect(r.unconfiguredPropertyKeys).toEqual(['Arcade', 'Sepich']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/lease-market-positioning.test.ts`
Expected: FAIL — cannot resolve `positioning`.

- [ ] **Step 3: Write the implementation**

```ts
// server/warehouse/lease-market/positioning.ts
//
// Lease Market Intelligence — where each vacant ORA unit's asking rent sits in its comparable cell
// (spec §3.6 ora_positioning). Pure over its inputs; the API supplies vacant units from the live snapshot.
import type { LeaseMarketConfig, PositioningRow } from '../../../src/contracts/lease-market';
import { normalizeSuite, officeStratumFor, sizeBandFor } from '../../../src/analytics/lease-market/normalize';
import { midRankPercentile, toCellBenchmark, type CellTarget, type ComputedCell } from '../../../src/analytics/lease-market/benchmarks';

export interface VacantUnit {
  propertyKey: string;
  unit: string | null;
  sf: number;
}

export interface OraListingState {
  oraPropertyKey: string;
  suiteNorm: string;
  askingNnnEq: number | null;
  effectiveDom: number;
}

export function computePositioning(
  units: readonly VacantUnit[],
  config: LeaseMarketConfig,
  oraListings: readonly OraListingState[],
  cellFor: (t: CellTarget) => ComputedCell,
): { rows: PositioningRow[]; unconfiguredPropertyKeys: string[] } {
  const t = config.thresholds;
  const props = new Map(config.oraProperties.map((p) => [p.propertyKey, p]));
  const unconfigured = new Set<string>();
  const rows: PositioningRow[] = [];

  for (const u of units) {
    const p = props.get(u.propertyKey);
    if (!p) {
      unconfigured.add(u.propertyKey);
      continue;
    }
    const band = sizeBandFor(u.sf > 0 ? u.sf : p.typicalUnitSf);
    const cell = band
      ? cellFor({ marketId: p.marketId, submarket: p.submarket, subtype: p.subtype, sizeBand: band, officeStratum: officeStratumFor(p.subtype, p.officePct, t.flexOfficeSplitPct) })
      : null;

    const candidates = oraListings.filter((l) => l.oraPropertyKey === p.propertyKey);
    const suite = normalizeSuite(u.unit);
    const match = (suite !== '' ? candidates.find((l) => l.suiteNorm === suite) : undefined) ?? (candidates.length === 1 ? candidates[0] : undefined);

    const asking = match?.askingNnnEq ?? null;
    const percentile = asking !== null && cell && cell.values.length > 0 ? midRankPercentile(asking, cell.values) : null;
    const gapPct = asking !== null && cell && cell.median !== null && cell.median > 0 ? (asking - cell.median) / cell.median : null;
    const positioningBand: PositioningRow['band'] =
      gapPct === null ? 'unknown' : gapPct > t.positioningBandPct ? 'above' : gapPct < -t.positioningBandPct ? 'below' : 'in_band';

    rows.push({
      propertyKey: u.propertyKey,
      unit: u.unit,
      sf: u.sf,
      oraAskingNnnEq: asking,
      cell: cell ? toCellBenchmark(cell) : null,
      percentile,
      gapPct,
      band: positioningBand,
      effectiveDom: match ? match.effectiveDom : null,
    });
  }
  return { rows, unconfiguredPropertyKeys: [...unconfigured].sort() };
}
```

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `npx vitest run tests/unit/lease-market-positioning.test.ts && npm run typecheck && npx eslint server/warehouse/lease-market tests/unit/lease-market-positioning.test.ts --max-warnings 0`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add server/warehouse/lease-market/positioning.ts tests/unit/lease-market-positioning.test.ts
git commit -F <message-file>   # "feat(warehouse): ORA vacant-unit rent positioning"
```
