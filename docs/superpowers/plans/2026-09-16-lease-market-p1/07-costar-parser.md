### Task 07: CoStar export parser (header-map driven) + shared test fixtures

**Start from the rev 1 code:** `git show a4f075a:docs/superpowers/plans/2026-09-16-lease-market-p1/06-costar-parser.md` holds the full rev 1 parser, fixtures and pending header map. Implement that code **with the deltas below**; the deltas are authoritative where they differ.

**Files:**
- Create: `server/warehouse/lease-market/costar-parse.ts`
- Create: `config/lease-market.costar-headers.json`
- Create: `tests/unit/lease-market-fixtures.ts` (helper module)
- Test: `tests/unit/lease-market-costar-parse.test.ts`

**Interfaces:**
- Consumes: Task 02 `CanonicalListingRow`, `RentBasis`, `LmSubtype`, `BuildingStatus`, `LeaseMarketConfig`, `LmThresholds`; Task 03 `parseRentText`.
- Produces: `CostarHeaderMap` (schema + type), `HeaderField`, `CostarParseError`, `SkippedRow`, `ParsedCostarExport { headerFingerprint; marketNames; rows; skipped; rowCount }`, `sha256File`, `cellText`, `parseNumber`, `parseIsoDate`, `parseCostarListingsFile(filePath, map)`. Fixtures: `TEST_HEADERS`, `FixtureListing`, `writeCostarFixture(dir, fileName, listings, opts?)`, `testHeaderMap(patch?)`, `TEST_THRESHOLDS`, `testConfig(patch?)`.

#### Deltas vs. rev 1

1. **Header map `fields`** gains seven nullable columns: `zip`, `lat`, `lon`, `brokerName`, `brokerCompany`, `listingUrl`, `description`. Add them to the Zod `fields` object and to the shipped pending JSON (all `null`).
2. **Candidate row** gains: `zip: nullIfEmpty(get('zip'))`, `lat: parseCoordinate(get('lat'), 90)`, `lon: parseCoordinate(get('lon'), 180)`, `brokerName`, `brokerCompany`, `listingUrl` (all `nullIfEmpty`), `description: nullIfEmpty(get('description'))?.slice(0, 4000) ?? null`, `sourceRow: r`, `rentIsTotal`, `opexQuotedPsf`. Add:

```ts
export function parseCoordinate(text: string, limit: number): number | null {
  const n = parseNumber(text);
  return n === null || Math.abs(n) > limit || n === 0 ? null : n;
}
```

   (`parseNumber` strips everything except digits, `.` and `-`, so a negative longitude survives.)
3. **Rent handling** replaces the rev 1 block:

```ts
    let rentLow: number | null = null;
    let rentHigh: number | null = null;
    let rentPeriod = map.rentPeriodDefault;
    let rentIsTotal = false;
    let opexQuotedPsf: number | null = null;
    if (idx.rentLow !== null) {
      rentLow = parseNumber(get('rentLow'));
      rentHigh = idx.rentHigh !== null ? parseNumber(get('rentHigh')) : null;
    }
    if (rentLow === null && rentHigh === null && idx.rentText !== null) {
      const parsed = parseRentText(get('rentText'));
      rentLow = parsed.rentLow;
      rentHigh = parsed.rentHigh;
      if (parsed.rentPeriod) rentPeriod = parsed.rentPeriod;
      rentIsTotal = parsed.isTotal;
      opexQuotedPsf = parsed.opexQuoted;
      if (parsed.withheld) rentBasis = 'WITHHELD';
      else if (parsed.ambiguous) rentBasis = 'UNKNOWN';
      else if (!basisText && parsed.basis) rentBasis = parsed.basis;
    }
    if (rentLow === null && rentHigh === null && rentBasis !== 'UNKNOWN') rentBasis = 'WITHHELD';
```

4. **Required map fields** unchanged (`address`, `propertyType`, `availableSf`, and `rentText` or `rentLow`).
5. **Fixtures:** `TEST_HEADERS` appends `'Zip', 'Latitude', 'Longitude', 'Leasing Broker', 'Leasing Company', 'Listing URL'` (no description column in fixtures). `FixtureListing` gains `zip?`, `lat?: number | null`, `lon?: number | null`, `broker?: string | null`, `brokerCompany?: string | null`, `url?: string | null`; `rowValues` appends `pick(l,'zip','43219')`, `pick(l,'lat',39.99)`, `pick(l,'lon',-82.93)`, `pick(l,'broker','Pat Broker')`, `pick(l,'brokerCompany','Acme Realty')`, `pick(l,'url',null)`. `testHeaderMap()` maps `zip:'Zip', lat:'Latitude', lon:'Longitude', brokerName:'Leasing Broker', brokerCompany:'Leasing Company', listingUrl:'Listing URL', description: null`. `writeCostarFixture` sets `wb.subject = fileName` (distinct bytes per file name). `TEST_THRESHOLDS` is the full spec rev 3 threshold object (copy the `thresholds` block from `config/lease-market.json`). `testConfig()` adds `similarityWeights: { location: 30, size: 25, clearHeight: 15, age: 10, loading: 10, office: 10 }`, sets `enabled: true` on both test markets, and each `oraProperties` entry gains `lat: null, lon: null, clearHeightFt: null, yearBuilt: null, docks: null, driveIns: null`.

- [ ] **Step 1: Write fixtures (rev 1 + deltas) and the failing test**

```ts
// tests/unit/lease-market-costar-parse.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CostarHeaderMap, parseCoordinate, parseCostarListingsFile } from '../../server/warehouse/lease-market/costar-parse';
import { testHeaderMap, writeCostarFixture } from './lease-market-fixtures';

const dir = () => mkdtempSync(join(tmpdir(), 'lm-parse-'));

describe('parseCostarListingsFile', () => {
  it('refuses a pending-sample header map', async () => {
    const f = await writeCostarFixture(dir(), 'a.xlsx', [{ address: '1 Main St', sf: 1000 }]);
    await expect(parseCostarListingsFile(f, testHeaderMap({ status: 'pending-sample' }))).rejects.toThrow(/pending-sample/);
  });

  it('maps rows to canonical listings, including location and broker, and skips rows without SF', async () => {
    const f = await writeCostarFixture(dir(), 'a.xlsx', [
      { id: 'C1', address: '10 Alpha Rd', suite: 'Suite 100', sf: 12000, rentLow: 8.5, rentType: 'NNN', officePct: 0.25, dateOnMarket: new Date(Date.UTC(2025, 10, 1)), url: 'https://example.test/1' },
      { id: 'C2', address: '20 Beta Dr', type: 'Flex', sf: 3000, rentLow: null, rentType: null, spaceUse: 'Sublet', lat: null, lon: null },
      { address: '30 Gamma Way', sf: 0 },
    ]);
    const r = await parseCostarListingsFile(f, testHeaderMap());
    expect(r.rowCount).toBe(3);
    expect(r.marketNames).toEqual(['Columbus']);
    expect(r.skipped).toEqual([{ rowNumber: 4, reason: expect.stringMatching(/available SF/) }]);
    expect(r.rows[0]).toEqual({
      costarPropertyId: 'C1', address: '10 Alpha Rd', suite: 'Suite 100', city: 'Columbus', state: 'OH', zip: '43219', lat: 39.99, lon: -82.93,
      submarket: 'East', subtype: 'warehouse', buildingStatus: 'existing', buildingSf: 40000, yearBuilt: 1990, clearHeightFt: 20, docks: 2,
      driveIns: 1, officePct: 25, ownerName: 'SMITH FAMILY LLC', availableSf: 12000, minDivisibleSf: null, rentLow: 8.5, rentHigh: null,
      rentPeriod: 'yr', rentIsTotal: false, rentBasis: 'NNN', opexQuotedPsf: null, isSublease: false, costarDateOnMarket: '2025-11-01',
      brokerName: 'Pat Broker', brokerCompany: 'Acme Realty', listingUrl: 'https://example.test/1', description: null, sourceRow: 2,
    });
    expect(r.rows[1]).toMatchObject({ costarPropertyId: 'C2', subtype: 'flex', rentBasis: 'WITHHELD', isSublease: true, lat: null, lon: null, sourceRow: 3 });
  });

  it('hard-fails on a missing mapped column and on unmapped values', async () => {
    const d = dir();
    await expect(parseCostarListingsFile(await writeCostarFixture(d, 'm.xlsx', [{ address: '1 Main St', sf: 1000 }], { omitHeader: 'Docks' }), testHeaderMap())).rejects.toThrow(/missing column "Docks"/);
    await expect(parseCostarListingsFile(await writeCostarFixture(d, 'r.xlsx', [{ address: '1 Main St', sf: 1000, type: 'Retail' }]), testHeaderMap())).rejects.toThrow(/unmapped property type "Retail\|Warehouse"/);
    await expect(parseCostarListingsFile(await writeCostarFixture(d, 'n.xlsx', [{ address: '1 Main St', sf: 1000, rentType: 'Net' }]), testHeaderMap())).rejects.toThrow(/unmapped rent basis "Net"/);
  });

  it('fingerprints the header set, not the rows', async () => {
    const d = dir();
    const a = await parseCostarListingsFile(await writeCostarFixture(d, 'a.xlsx', [{ address: '1 Main St', sf: 1000 }]), testHeaderMap());
    const b = await parseCostarListingsFile(await writeCostarFixture(d, 'b.xlsx', [{ address: '2 Main St', sf: 2000 }]), testHeaderMap());
    const c = await parseCostarListingsFile(await writeCostarFixture(d, 'c.xlsx', [{ address: '3 Main St', sf: 3000 }], { extraHeader: 'Notes' }), testHeaderMap());
    expect(a.headerFingerprint).toBe(b.headerFingerprint);
    expect(c.headerFingerprint).not.toBe(a.headerFingerprint);
  });

  it('free-text rent column: base + expense, totals, and ambiguous amounts', async () => {
    const base = testHeaderMap();
    const map = testHeaderMap({ fields: { ...base.fields, rentText: 'Rent Low', rentLow: null, rentHigh: null, rentBasis: null } });
    const f = await writeCostarFixture(dir(), 'a.xlsx', [
      { address: '1 Main St', sf: 1000, rentLow: '$0.75/SF/MO IG', rentType: null },
      { address: '2 Main St', sf: 16000, rentLow: '$7.25/SF + $2.50 NNN', rentType: null },
      { address: '3 Main St', sf: 16000, rentLow: '$12,000/month + expenses', rentType: null },
      { address: '4 Main St', sf: 2000, rentLow: '$150', rentType: null },
    ]);
    const r = await parseCostarListingsFile(f, map);
    expect(r.rows[0]).toMatchObject({ rentLow: 0.75, rentPeriod: 'mo', rentBasis: 'IG', rentIsTotal: false });
    expect(r.rows[1]).toMatchObject({ rentLow: 7.25, rentBasis: 'NNN', opexQuotedPsf: 2.5, rentIsTotal: false });
    expect(r.rows[2]).toMatchObject({ rentLow: 12000, rentPeriod: 'mo', rentBasis: 'NNN', rentIsTotal: true });
    expect(r.rows[3]).toMatchObject({ rentLow: 150, rentBasis: 'UNKNOWN' });
  });

  it('parseCoordinate rejects zero and out-of-range values', () => {
    expect(parseCoordinate('-82.93', 180)).toBe(-82.93);
    expect(parseCoordinate('0', 90)).toBeNull();
    expect(parseCoordinate('95', 90)).toBeNull();
    expect(parseCoordinate('', 90)).toBeNull();
  });

  it('the shipped header map parses and is still pending a real sample', () => {
    const shipped = CostarHeaderMap.parse(JSON.parse(readFileSync(join(process.cwd(), 'config', 'lease-market.costar-headers.json'), 'utf8')));
    expect(['pending-sample', 'verified']).toContain(shipped.status);
    expect(shipped.fields).toHaveProperty('lat');
  });
});
```

- [ ] **Step 2:** `npx vitest run tests/unit/lease-market-costar-parse.test.ts` — Expected: FAIL.
- [ ] **Step 3:** Implement `costar-parse.ts` (rev 1 + deltas 1–4) and write `config/lease-market.costar-headers.json` (rev 1 pending map + the seven new `null` fields).
- [ ] **Step 4:** `npx vitest run tests/unit/lease-market-costar-parse.test.ts && npm run typecheck && npx eslint server/warehouse/lease-market tests/unit/lease-market-fixtures.ts tests/unit/lease-market-costar-parse.test.ts --max-warnings 0` — Expected: PASS / clean.
- [ ] **Step 5: Commit** — `git add server/warehouse/lease-market/costar-parse.ts config/lease-market.costar-headers.json tests/unit/lease-market-fixtures.ts tests/unit/lease-market-costar-parse.test.ts` ("feat(warehouse): header-mapped CoStar listing parser").
