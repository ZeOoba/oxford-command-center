### Task 11: Oxford Rent Position + listing hygiene

**Files:**
- Create: `server/warehouse/lease-market/positioning.ts`
- Test: `tests/unit/lease-market-positioning.test.ts`

**Interfaces:**
- Consumes: Task 02 `LeaseMarketConfig`, `PositioningRow`, `ListedButLeased`, `ComparableStats`, `CompRow`; Task 03 `normalizeSuite`; Task 04 `midRankPercentile`; Task 05 `resolveComparables`, `ResolvedComparables`; Task 10 `MarketState`, `SpaceState`, `isActive`, `oraSubject`; Task 06 `effectiveDom`.
- Produces:
  - `interface VacantUnit { propertyKey: string; unit: string | null; sf: number }`
  - `recommendationFor(input: { asking: number|null; stats: ResolvedComparables|null; bandPct: number }): string`
  - `computePositioning(units: readonly VacantUnit[], config: LeaseMarketConfig, state: MarketState, rowLevel: boolean): { rows: PositioningRow[]; unconfiguredPropertyKeys: string[]; listedButLeased: ListedButLeased[] }`

**Rules (spec rev 3 §3.9):**
- Units whose `propertyKey` is not configured ⇒ `unconfiguredPropertyKeys` (unique, sorted), no row.
- Subject = `oraSubject(config property, state, unit SF > 0 ? unit SF : typicalUnitSf)`; comparables = `resolveComparables(profile, matchedPropertyId, state.candidates, target ? state.cellFor(target) : null, weights, thresholds)`; `stats` null only when `target` is null (no size band).
- ORA spaces for the property = active spaces whose `property.oraPropertyKey` equals the key. Match: same non-empty normalized suite ▸ the only ORA space ▸ none. No match ⇒ `flags: ['not_listed']`, asking null.
- `percentile` = mid-rank of asking within `stats.values`; `gapPct` = (asking − median) ÷ median; band `above` > `positioningBandPct`, `below` < −`positioningBandPct`, `in_band` otherwise, `unknown` when gap is null.
- `comps` = up to 15 `CompRow` from `stats.comps` (address null when `rowLevel` is false; `score` rounded; `distanceMi` rounded to 0.1).
- `brokerName`, `listingUrl` from the matched ORA space (null when `rowLevel` is false); `dateListed` = its `costarDateOnMarket ?? firstSeen`; `effectiveDom` from the matched space.
- `listedButLeased`: every active ORA space whose property is configured and whose suite does not equal any vacant unit's normalized suite for that property (when the property has exactly one ORA space and ≥ 1 vacant unit, it counts as matched). `address` null when `rowLevel` is false.
- **Recommendation** (deterministic, first match wins):
  1. `stats` null or `stats.median` null ⇒ `No comparable asking rents yet for this size and type.`
  2. asking null ⇒ `No ORA asking rent found in CoStar — confirm the unit is being marketed. Comparable range $P25–$P75.`
  3. confidence LOW ⇒ prefix `Thin comparable set (n=N) — indicative only. ` to the sentence chosen by rule 4–6.
  4. gap > band ⇒ `Asking is X% above the comparable median ($M); comparable range $P25–$P75.`
  5. gap < −band ⇒ `Asking is X% below the comparable median ($M); room to move toward $P25–$M.`
  6. otherwise ⇒ `Within the comparable range ($P25–$P75).`
  Money formatted `$0.00`; X = rounded absolute percent.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/lease-market-positioning.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWarehouse } from '../../server/warehouse/db';
import { ingestCostarListingsFile } from '../../server/warehouse/lease-market/ingest';
import { loadMarketState } from '../../server/warehouse/lease-market/compute';
import { computePositioning, recommendationFor } from '../../server/warehouse/lease-market/positioning';
import type { ResolvedComparables } from '../../src/analytics/lease-market/similarity';
import { stubScreen, testConfig, testHeaderMap, writeCostarFixture, type FixtureListing } from './lease-market-fixtures';

const stats = (patch: Partial<ResolvedComparables> = {}): ResolvedComparables => ({
  basis: 'similarity', n: 12, low: 7, p25: 9, median: 10, p75: 11, high: 12, values: [8, 9, 10, 11, 12], confidence: 'MEDIUM', cellKey: null, comps: [], ...patch,
});

describe('recommendationFor', () => {
  it('covers every branch', () => {
    expect(recommendationFor({ asking: 10, stats: null, bandPct: 0.1 })).toBe('No comparable asking rents yet for this size and type.');
    expect(recommendationFor({ asking: null, stats: stats(), bandPct: 0.1 })).toBe('No ORA asking rent found in CoStar — confirm the unit is being marketed. Comparable range $9.00–$11.00.');
    expect(recommendationFor({ asking: 11.5, stats: stats(), bandPct: 0.1 })).toBe('Asking is 15% above the comparable median ($10.00); comparable range $9.00–$11.00.');
    expect(recommendationFor({ asking: 8.5, stats: stats(), bandPct: 0.1 })).toBe('Asking is 15% below the comparable median ($10.00); room to move toward $9.00–$10.00.');
    expect(recommendationFor({ asking: 10.5, stats: stats(), bandPct: 0.1 })).toBe('Within the comparable range ($9.00–$11.00).');
    expect(recommendationFor({ asking: 10.5, stats: stats({ confidence: 'LOW', n: 3 }), bandPct: 0.1 })).toBe('Thin comparable set (n=3) — indicative only. Within the comparable range ($9.00–$11.00).');
  });
});

async function state(extraOra: FixtureListing[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'lm-pos-'));
  const db = openWarehouse(join(dir, 't.sqlite'));
  const config = testConfig();
  const comps: FixtureListing[] = [8, 8.5, 9, 9.25, 9.5, 9.75, 10, 10.25, 10.5, 11].map((rent, i) => ({ id: `C${i}`, address: `${200 + i} Commerce Dr`, sf: 8000, rentLow: rent }));
  const ora: FixtureListing[] = [{ address: '1100 Rarig Ave', suite: 'B', sf: 8000, rentLow: 11.5, owner: 'OXFORD RARIG LLC', broker: 'Lee Lister', url: 'https://example.test/rarig-b' }, ...extraOra];
  await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-15.xlsx', [...comps, ...ora]), {
    config, headerMap: testHeaderMap(), rawDir: join(dir, 'raw'), now: () => '2026-02-16T00:00:00Z', screen: stubScreen,
  });
  return { config, s: loadMarketState(db, config, '2026-03-01') };
}

describe('computePositioning', () => {
  it('positions a matched ORA suite against similarity comps with evidence', async () => {
    const { config, s } = await state();
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: 'Suite B', sf: 8000 }], config, s, true);
    const row = r.rows[0]!;
    expect(row).toMatchObject({ propertyKey: '1100 Rarig', unit: 'Suite B', oraAskingNnnEq: 11.5, band: 'above', flags: [], brokerName: 'Lee Lister', listingUrl: 'https://example.test/rarig-b', dateListed: '2026-01-15', effectiveDom: 45 });
    expect(row.stats).toMatchObject({ basis: 'similarity', n: 10, confidence: 'MEDIUM', low: 8, high: 11 });
    expect(row.stats!.median).toBeCloseTo(9.625);
    expect(row.gapPct).toBeCloseTo(11.5 / 9.625 - 1);
    expect(row.percentile).toBe(1);
    expect(row.comps).toHaveLength(10);
    expect(row.comps[0]!.address).toMatch(/Commerce Dr/);
    expect(row.recommendation).toMatch(/^Asking is 19% above the comparable median \(\$9\.63\)/);
    expect(r.listedButLeased).toEqual([]);
  });

  it('flags a vacant unit that is not listed, and a listed suite that is not vacant', async () => {
    const { config, s } = await state([{ address: '1100 Rarig Ave', suite: 'C', sf: 6000, rentLow: 10, owner: 'OXFORD RARIG LLC' }]);
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: 'D', sf: 5000 }], config, s, true);
    expect(r.rows[0]).toMatchObject({ unit: 'D', oraAskingNnnEq: null, flags: ['not_listed'], band: 'unknown', effectiveDom: null });
    expect(r.rows[0]!.recommendation).toMatch(/^No ORA asking rent found in CoStar/);
    expect(r.listedButLeased.map((l) => l.suite).sort()).toEqual(['B', 'C']);
  });

  it('strips row-level identifiers and lists unconfigured properties', async () => {
    const { config, s } = await state();
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: 'B', sf: 8000 }, { propertyKey: 'Sepich', unit: '1', sf: 2000 }, { propertyKey: 'Sepich', unit: '2', sf: 2000 }], config, s, false);
    expect(r.unconfiguredPropertyKeys).toEqual(['Sepich']);
    expect(r.rows[0]).toMatchObject({ brokerName: null, listingUrl: null });
    expect(r.rows[0]!.comps.every((c) => c.address === null)).toBe(true);
  });
});
```

- [ ] **Step 2:** `npx vitest run tests/unit/lease-market-positioning.test.ts` — Expected: FAIL.

- [ ] **Step 3: Write positioning.ts**

```ts
// server/warehouse/lease-market/positioning.ts
//
// Lease Market Intelligence — Oxford Rent Position and listing hygiene (spec rev 3 §3.9, cross-exam A7/A8).
// Pure over MarketState; the API supplies vacant units from the live rent-roll snapshot.
import type { CompRow, LeaseMarketConfig, ListedButLeased, PositioningRow } from '../../../src/contracts/lease-market';
import { normalizeSuite } from '../../../src/analytics/lease-market/normalize';
import { midRankPercentile } from '../../../src/analytics/lease-market/benchmarks';
import { resolveComparables, type ResolvedComparables } from '../../../src/analytics/lease-market/similarity';
import { effectiveDom } from '../../../src/analytics/lease-market/signals';
import { isActive, oraSubject, type MarketState, type SpaceState } from './compute';

export interface VacantUnit {
  propertyKey: string;
  unit: string | null;
  sf: number;
}

const money = (v: number | null) => (v === null ? '—' : `$${v.toFixed(2)}`);

export function recommendationFor(input: { asking: number | null; stats: ResolvedComparables | null; bandPct: number }): string {
  const s = input.stats;
  if (!s || s.median === null) return 'No comparable asking rents yet for this size and type.';
  const range = `${money(s.p25)}–${money(s.p75)}`;
  if (input.asking === null) return `No ORA asking rent found in CoStar — confirm the unit is being marketed. Comparable range ${range}.`;
  const gap = (input.asking - s.median) / s.median;
  const pct = Math.round(Math.abs(gap) * 100);
  const sentence =
    gap > input.bandPct
      ? `Asking is ${pct}% above the comparable median (${money(s.median)}); comparable range ${range}.`
      : gap < -input.bandPct
        ? `Asking is ${pct}% below the comparable median (${money(s.median)}); room to move toward ${money(s.p25)}–${money(s.median)}.`
        : `Within the comparable range (${range}).`;
  return s.confidence === 'LOW' ? `Thin comparable set (n=${s.n}) — indicative only. ${sentence}` : sentence;
}

export function computePositioning(
  units: readonly VacantUnit[],
  config: LeaseMarketConfig,
  state: MarketState,
  rowLevel: boolean,
): { rows: PositioningRow[]; unconfiguredPropertyKeys: string[]; listedButLeased: ListedButLeased[] } {
  const t = config.thresholds;
  const props = new Map(config.oraProperties.map((p) => [p.propertyKey, p]));
  const oraSpaces = new Map<string, SpaceState[]>();
  for (const s of state.spaces) {
    const key = s.property.oraPropertyKey;
    if (key === null || !isActive(s) || !props.has(key)) continue;
    const list = oraSpaces.get(key) ?? [];
    list.push(s);
    oraSpaces.set(key, list);
  }

  const unconfigured = new Set<string>();
  const matchedSpaceIds = new Set<number>();
  const vacantSuites = new Map<string, Set<string>>();
  const rows: PositioningRow[] = [];

  for (const u of units) {
    const p = props.get(u.propertyKey);
    if (!p) {
      unconfigured.add(u.propertyKey);
      continue;
    }
    const suite = normalizeSuite(u.unit);
    const suites = vacantSuites.get(p.propertyKey) ?? new Set<string>();
    suites.add(suite);
    vacantSuites.set(p.propertyKey, suites);

    const sf = u.sf > 0 ? u.sf : p.typicalUnitSf;
    const { profile, matchedPropertyId, target } = oraSubject(p, state, sf, t);
    const stats = target
      ? resolveComparables(profile, matchedPropertyId, state.candidates, state.cellFor(target), config.similarityWeights, t)
      : null;

    const candidates = oraSpaces.get(p.propertyKey) ?? [];
    const match = (suite !== '' ? candidates.find((s) => s.suiteNorm === suite) : undefined) ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (match) matchedSpaceIds.add(match.listingId);
    const asking = match ? (match.observations[match.observations.length - 1]!.askingNnnEq ?? null) : null;

    const percentile = asking !== null && stats && stats.values.length > 0 ? midRankPercentile(asking, stats.values) : null;
    const gapPct = asking !== null && stats && stats.median !== null && stats.median > 0 ? (asking - stats.median) / stats.median : null;
    const band: PositioningRow['band'] =
      gapPct === null ? 'unknown' : gapPct > t.positioningBandPct ? 'above' : gapPct < -t.positioningBandPct ? 'below' : 'in_band';
    const comps: CompRow[] = (stats?.comps ?? []).slice(0, 15).map((c) => ({
      listingId: c.candidate.listingId,
      propertyId: c.candidate.propertyId,
      address: rowLevel ? c.candidate.addressDisplay : null,
      availableSf: c.candidate.availableSf,
      askingNnnEq: c.candidate.askingNnnEq,
      score: Math.round(c.similarity.score),
      distanceMi: c.similarity.distanceMi === null ? null : Math.round(c.similarity.distanceMi * 10) / 10,
    }));

    rows.push({
      propertyKey: u.propertyKey,
      unit: u.unit,
      sf: u.sf,
      oraListingId: match?.listingId ?? null,
      oraAskingNnnEq: asking,
      stats: stats
        ? { basis: stats.basis, n: stats.n, low: stats.low, p25: stats.p25, median: stats.median, p75: stats.p75, high: stats.high, confidence: stats.confidence, cellKey: stats.cellKey }
        : null,
      comps,
      percentile,
      gapPct,
      band,
      recommendation: recommendationFor({ asking, stats, bandPct: t.positioningBandPct }),
      flags: match ? [] : ['not_listed'],
      effectiveDom: match ? effectiveDom(match, state.asOf) : null,
      brokerName: rowLevel ? (match?.brokerName ?? null) : null,
      listingUrl: rowLevel ? (match?.listingUrl ?? null) : null,
      dateListed: match ? (match.costarDateOnMarket ?? match.firstSeen) : null,
    });
  }

  const listedButLeased: ListedButLeased[] = [];
  for (const [key, spaces] of oraSpaces) {
    const vacant = vacantSuites.get(key) ?? new Set<string>();
    for (const s of spaces) {
      if (matchedSpaceIds.has(s.listingId) || vacant.has(s.suiteNorm)) continue;
      listedButLeased.push({
        propertyKey: key,
        listingId: s.listingId,
        suite: s.suiteNorm,
        askingNnnEq: s.observations[s.observations.length - 1]!.askingNnnEq,
        effectiveDom: effectiveDom(s, state.asOf),
        address: rowLevel ? s.addressDisplay : null,
      });
    }
  }

  return { rows, unconfiguredPropertyKeys: [...unconfigured].sort(), listedButLeased };
}
```

- [ ] **Step 4:** `npx vitest run tests/unit/lease-market-positioning.test.ts && npm run typecheck && npx eslint server/warehouse/lease-market tests/unit/lease-market-positioning.test.ts --max-warnings 0` — Expected: PASS / clean.

- [ ] **Step 5: Commit** — `git add server/warehouse/lease-market/positioning.ts tests/unit/lease-market-positioning.test.ts` ("feat(warehouse): Oxford rent position with comparables and listing hygiene").
