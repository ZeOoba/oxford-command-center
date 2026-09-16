### Task 12: Market-rent feed → lease-forecast (manual overlay always wins)

**Files:**
- Create: `server/warehouse/lease-market/feed.ts`
- Modify: `src/contracts/lease-forecast.ts` (MarketRentGap.provenance enum — architect-owned; declared in Task 99)
- Modify: `src/analytics/lease-forecast.ts` (`marketRentGaps` signature)
- Modify: `server/warehouse/lease-forecast-api.ts` (three call sites)
- Modify: `src/modules/leasing/hooks.ts` (chip label for the new provenance)
- Test: `tests/unit/lease-market-feed.test.ts`; keep `tests/unit/lease-forecast-*.test.ts` green

**Interfaces:**
- Consumes: Task 01 `lm_market_rent_feed`; existing `marketRentGaps(leases, marketRents)`, `rentForecast(leases, refDate, input, marketRents)`, `gapChipLabel` in `src/modules/leasing/hooks.ts`.
- Produces:
  - `loadMarketRentFeed(db: WarehouseDb): Record<string, number>` — keyed by ORA propertyKey
  - `mergeMarketRents(feed: Record<string, number>, manual: Record<string, number>): Record<string, number>` — `{ ...feed, ...manual }`
  - `MarketRentGap.provenance` enum becomes `['real', 'derived', 'derived-asking', 'absent']`
  - `marketRentGaps(leases: Lease[], marketRents: Record<string, number>, feedRents: Record<string, number> = {}): MarketRentGap[]`

Rules (spec §3.7): lookup order per lease = manual `marketRents[lease.id]` ▸ manual `marketRents[lease.propertyKey]` ▸ `feedRents[lease.propertyKey]`. Manual hit ⇒ provenance `derived` (unchanged behavior). Feed hit ⇒ `derived-asking`. Neither ⇒ `absent`. `rentForecast` receives `mergeMarketRents(feed, manual)` so a manual value always wins. The feed is never written into `overlay.json`. If the warehouse is unavailable, the feed is `{}` (existing behavior preserved).

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/lease-market-feed.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWarehouse } from '../../server/warehouse/db';
import { loadMarketRentFeed, mergeMarketRents } from '../../server/warehouse/lease-market/feed';
import { marketRentGaps } from '../../src/analytics/lease-forecast';
import type { Lease } from '../../src/contracts/lease';

function lease(patch: Partial<Lease> = {}): Lease {
  return {
    id: 'L1', propertyKey: '1100 Rarig', propertyId: null, tenantName: 'Acme', unit: 'B', company: null, sf: 8000,
    monthlyRent: 5000, rentPerSf: 7.5, leaseStart: null, leaseEnd: null, escalationDate: null, escalationPct: null,
    status: 'Active', annualRent: 60000, monthsToExpiry: 12, flags: [], ...patch,
  };
}

describe('marketRentGaps with a feed', () => {
  it('uses the feed when no manual value exists, tagged derived-asking', () => {
    const [g] = marketRentGaps([lease()], {}, { '1100 Rarig': 9.3 });
    expect(g).toMatchObject({ marketRentPsf: 9.3, provenance: 'derived-asking', underMarket: true });
    expect(g!.gapPsf).toBeCloseTo(1.8);
  });
  it('a manual property value beats the feed', () => {
    expect(marketRentGaps([lease()], { '1100 Rarig': 11 }, { '1100 Rarig': 9.3 })[0]).toMatchObject({ marketRentPsf: 11, provenance: 'derived' });
  });
  it('a manual lease value beats the feed', () => {
    expect(marketRentGaps([lease()], { L1: 8 }, { '1100 Rarig': 9.3 })[0]).toMatchObject({ marketRentPsf: 8, provenance: 'derived' });
  });
  it('stays absent with neither', () => {
    expect(marketRentGaps([lease()], {}, {})[0]!.provenance).toBe('absent');
    expect(marketRentGaps([lease()], {})[0]!.provenance).toBe('absent');
  });
});

describe('feed loading and merge', () => {
  it('loads the feed table and lets manual values win on merge', () => {
    const db = openWarehouse(join(mkdtempSync(join(tmpdir(), 'lm-feed-')), 't.sqlite'));
    db.prepare(
      `INSERT INTO lm_market_rent_feed (ora_property_key, asking_nnn_eq, cell_key, n, quoted_share, computed_at) VALUES ('1100 Rarig', 9.3, 'k', 12, 1, '2026-03-01')`,
    ).run();
    const feed = loadMarketRentFeed(db);
    expect(feed).toEqual({ '1100 Rarig': 9.3 });
    expect(mergeMarketRents(feed, { '1100 Rarig': 11, L9: 7 })).toEqual({ '1100 Rarig': 11, L9: 7 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/lease-market-feed.test.ts`
Expected: FAIL — cannot resolve `feed`.

- [ ] **Step 3: Write feed.ts**

```ts
// server/warehouse/lease-market/feed.ts
//
// Lease Market Intelligence — read side of the market-rent feed (spec §3.7). The feed is merged UNDER the
// manual overlay at read time; it is never written into overlay.json.
import type { WarehouseDb } from '../db';

export function loadMarketRentFeed(db: WarehouseDb): Record<string, number> {
  const rows = db.prepare('SELECT ora_property_key, asking_nnn_eq FROM lm_market_rent_feed').all() as Array<{ ora_property_key: string; asking_nnn_eq: number }>;
  return Object.fromEntries(rows.map((r) => [r.ora_property_key, r.asking_nnn_eq]));
}

export function mergeMarketRents(feed: Record<string, number>, manual: Record<string, number>): Record<string, number> {
  return { ...feed, ...manual };
}
```

- [ ] **Step 4: Extend the contract and `marketRentGaps`**

In `src/contracts/lease-forecast.ts`, change the `MarketRentGap` provenance line to:

```ts
  provenance: z.enum(['real', 'derived', 'derived-asking', 'absent']), // derived-asking = lease-market feed (asking NNN-eq cell median)
```

In `src/analytics/lease-forecast.ts`, change the `marketRentGaps` signature and the market-rent lookup. Replace the lines from the signature through the `marketRentPsf` computation with:

```ts
export function marketRentGaps(
  leases: Lease[],
  marketRents: Record<string, number>,
  feedRents: Record<string, number> = {},
): MarketRentGap[] {
  const out: MarketRentGap[] = [];
  const valid = (v: number | undefined): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;

  for (const l of leases) {
    // Derive current PSF — prefer rentPerSf if available, else compute from annualRent/sf
    const currentRentPsf: number | null = (() => {
      if (l.rentPerSf !== null && Number.isFinite(l.rentPerSf)) return l.rentPerSf;
      if (l.sf > 0 && Number.isFinite(l.annualRent)) return l.annualRent / l.sf;
      return null;
    })();

    // Market rent lookup: manual leaseId ▸ manual propertyKey ▸ lease-market feed (propertyKey).
    const manual = valid(marketRents[l.id]) ?? valid(marketRents[l.propertyKey]);
    const fromFeed = manual === null ? valid(feedRents[l.propertyKey]) : null;
    const marketRentPsf: number | null = manual ?? fromFeed;
```

Then, in the non-absent `out.push({...})` at the bottom of the loop, replace `provenance: 'derived',` with:

```ts
      provenance: manual !== null ? 'derived' : 'derived-asking',
```

Leave the absent branch and everything else unchanged. Behavior note to preserve: previously a non-positive manual value fell through to "absent"; it now falls through to the feed, which is the intended precedence (a cleared manual override means "use the feed").

- [ ] **Step 5: Wire the API**

In `server/warehouse/lease-forecast-api.ts`:

1. Add the import: `import { loadMarketRentFeed, mergeMarketRents } from './lease-market/feed';`
2. Inside `leaseForecastApi`, below `withDb`, add:

```ts
  /** Lease-market feed; {} when the warehouse is unavailable (feed is optional context, never a hard dependency). */
  function feedOrEmpty(): Record<string, number> {
    try {
      return loadMarketRentFeed(getDb());
    } catch {
      return {};
    }
  }
```

3. `GET /forecast`: change `const marketGapsAll = marketRentGaps(leases, marketRents);` to `const marketGapsAll = marketRentGaps(leases, marketRents, loadMarketRentFeed(db));` (this handler already holds `db`).
4. `POST /rent-forecast`: change `results.push(rentForecast(leases, refDate, inputResult.data, marketRents));` to use a merged map computed once before the loop: `const mergedRents = mergeMarketRents(feedOrEmpty(), marketRents);` and `results.push(rentForecast(leases, refDate, inputResult.data, mergedRents));`
5. `GET /narrative`: change `const marketGapsAll = marketRentGaps(leases, marketRents);` to `const marketGapsAll = marketRentGaps(leases, marketRents, feedOrEmpty());`

Update the file header comment's route notes with one line: `Market rents: manual overlay values merged over the lease-market feed (server/warehouse/lease-market/feed.ts); manual always wins.`

- [ ] **Step 6: Label the new provenance in the leasing UI**

Run: `grep -rn "provenance" src/modules/leasing src/modules/intel src/brain 2>/dev/null`
In `src/modules/leasing/hooks.ts` `gapChipLabel`, feed-derived gaps must be distinguishable. Where the function builds its label for a non-absent gap, append ` (asking)` when `gap.provenance === 'derived-asking'`. Example — if the current return is `return \`${sign}$${Math.abs(gap.gapPsf).toFixed(2)}/SF\`;`, make it:

```ts
  const label = `${sign}$${Math.abs(gap.gapPsf).toFixed(2)}/SF`;
  return gap.provenance === 'derived-asking' ? `${label} (asking)` : label;
```

Match the function's actual existing format string; only add the suffix. Any other exhaustive switch/record over provenance found by the grep gets a `'derived-asking'` entry with the same meaning as `'derived'`. Add one test case to the existing `gapChipLabel` tests (find them with `grep -rln gapChipLabel tests/unit`) asserting the ` (asking)` suffix.

- [ ] **Step 7: Run all affected tests, typecheck, lint**

Run: `npx vitest run tests/unit/lease-market-feed.test.ts tests/unit/lease-forecast-analytics.test.ts tests/unit/lease-forecast-api.test.ts tests/unit/lease-forecast-contract.test.ts && npm run typecheck && npm run lint`
Expected: PASS / clean. If `lease-forecast-contract.test.ts` pins the provenance enum values, update that assertion to include `'derived-asking'`.

- [ ] **Step 8: Commit**

```bash
git add server/warehouse/lease-market/feed.ts src/contracts/lease-forecast.ts src/analytics/lease-forecast.ts server/warehouse/lease-forecast-api.ts src/modules/leasing/hooks.ts tests/unit/lease-market-feed.test.ts <any updated existing test files>
git commit -F <message-file>   # "feat(leasing): merge lease-market asking-rent feed under manual market rents"
```
