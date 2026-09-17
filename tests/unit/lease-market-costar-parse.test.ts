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
