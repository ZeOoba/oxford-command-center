// tests/unit/lease-market-costar-parse.test.ts
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CostarHeaderMap, cellHyperlink, cellText, parseClearHeight, parseCoordinate, parseCostarListingsFile, parseNumber,
  parsePercent,
} from '../../server/warehouse/lease-market/costar-parse';
import { TEST_HEADERS, testHeaderMap, writeCostarFixture } from './lease-market-fixtures';

const dir = () => mkdtempSync(join(tmpdir(), 'lm-parse-'));

// Overwrites a single data-row cell (row 2) in an already-written fixture, identified by its header
// label — used to plant a value FixtureListing's typed shape can't express (e.g. a non-numeric SF cell).
async function patchDataCell(filePath: string, headerLabel: string, value: unknown): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0]!;
  let col = -1;
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    if (cellText(cell.value) === headerLabel) col = colNumber;
  });
  if (col === -1) throw new Error(`header "${headerLabel}" not found in fixture`);
  ws.getRow(2).getCell(col).value = value as ExcelJS.CellValue;
  await wb.xlsx.writeFile(filePath);
  return filePath;
}

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
    expect(r.skipped).toEqual([{ rowNumber: 4, reason: 'available SF missing, zero or unparseable' }]);
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

  it('hard-fails when a mapped header label is duplicated in the export', async () => {
    // extraHeader appends a second "Docks" column (a genuine duplicate of the already-mapped one) —
    // reusing writeCostarFixture's existing opt rather than hand-building a workbook here.
    const f = await writeCostarFixture(dir(), 'dup.xlsx', [{ address: '1 Main St', sf: 1000 }], { extraHeader: 'Docks' });
    await expect(parseCostarListingsFile(f, testHeaderMap())).rejects.toThrow(/duplicate header column "Docks"/);
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

  it('free-text rent must not inherit map.rentPeriodDefault when the quote states no period', async () => {
    const base = testHeaderMap();
    // rentPeriodDefault: 'yr' on the map — the quote below states no period at all, and must end up
    // null rather than silently inheriting that default (the default applies only to the numeric
    // rentLow/rentHigh columns, never to free-text parsing).
    const map = testHeaderMap({ fields: { ...base.fields, rentText: 'Rent Low', rentLow: null, rentHigh: null, rentBasis: null } });
    expect(map.rentPeriodDefault).toBe('yr');
    const f = await writeCostarFixture(dir(), 'a.xlsx', [{ address: '1 Main St', sf: 1000, rentLow: '$20,000 NNN', rentType: null }]);
    const r = await parseCostarListingsFile(f, map);
    expect(r.rows[0]).toMatchObject({ rentIsTotal: true, rentPeriod: null });
  });

  it('an ambiguous free-text quote overrides even a mapped rentBasis column value', async () => {
    // '$4.00/SF/YR NNN, CAM $3.50' — the string named first in the fix request — IS flagged
    // `ambiguous: true` by normalize.ts's canonical-grammar gate at this HEAD (commit 1f3110c;
    // verified directly against parseRentText before writing this test), so it's used as-is.
    const base = testHeaderMap();
    const map = testHeaderMap({ fields: { ...base.fields, rentText: 'Rent Low', rentLow: null, rentHigh: null } });
    const f = await writeCostarFixture(dir(), 'a.xlsx', [{ address: '1 Main St', sf: 1000, rentLow: '$4.00/SF/YR NNN, CAM $3.50', rentType: 'NNN' }]);
    const r = await parseCostarListingsFile(f, map);
    expect(r.rows[0]).toMatchObject({ rentBasis: 'UNKNOWN' });
  });

  it('an ambiguous free-text quote nulls the add-on opex, even when one was parsed', async () => {
    // '$4.00/SF/YR NNN, CAM $3.50 + $1.20 CAM' — the string named in the follow-up request — is
    // flagged ambiguous:true with a non-null opexQuoted (1.2) by parseRentText at this HEAD
    // (verified directly before writing this test): the leading "NNN, CAM $3.50" reads as a stated
    // basis before the add-on split, contradicting the add-on's own implied NNN. That parsed 1.2
    // add-on must not reach the row once the quote is ambiguous.
    const base = testHeaderMap();
    const map = testHeaderMap({ fields: { ...base.fields, rentText: 'Rent Low', rentLow: null, rentHigh: null, rentBasis: null } });
    const f = await writeCostarFixture(dir(), 'a.xlsx', [{ address: '1 Main St', sf: 1000, rentLow: '$4.00/SF/YR NNN, CAM $3.50 + $1.20 CAM', rentType: null }]);
    const r = await parseCostarListingsFile(f, map);
    expect(r.rows[0]).toMatchObject({ rentBasis: 'UNKNOWN', opexQuotedPsf: null });
  });

  it('basis precedence: mapped column vs. text-parsed basis agree, disagree, or text states none', async () => {
    const d = dir();
    const base = testHeaderMap();
    const map = testHeaderMap({ fields: { ...base.fields, rentText: 'Rent Low', rentLow: null, rentHigh: null } });

    const agree = await parseCostarListingsFile(
      await writeCostarFixture(d, 'agree.xlsx', [{ address: '1 Main St', sf: 1000, rentLow: '$8.50/SF/YR NNN', rentType: 'NNN' }]),
      map,
    );
    expect(agree.rows[0]).toMatchObject({ rentBasis: 'NNN' });

    const disagree = await parseCostarListingsFile(
      await writeCostarFixture(d, 'disagree.xlsx', [{ address: '1 Main St', sf: 1000, rentLow: '$8.50/SF/YR NNN', rentType: 'MG' }]),
      map,
    );
    expect(disagree.rows[0]).toMatchObject({ rentBasis: 'UNKNOWN' });

    const textNoBasis = await parseCostarListingsFile(
      await writeCostarFixture(d, 'text-no-basis.xlsx', [{ address: '1 Main St', sf: 1000, rentLow: '$8.50/SF/YR', rentType: 'NNN' }]),
      map,
    );
    expect(textNoBasis.rows[0]).toMatchObject({ rentBasis: 'NNN' });
  });

  it('reads a hyperlink cell for listingUrl (falls back to cellText for a plain-text URL column)', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Listings');
    ws.addRow([...TEST_HEADERS]);
    const values: Record<(typeof TEST_HEADERS)[number], unknown> = {
      'Property ID': null, Address: '1 Main St', Suite: null, City: 'Columbus', State: 'OH', Market: 'Columbus',
      Submarket: 'East', Type: 'Industrial', 'Secondary Type': 'Warehouse', Status: 'Existing', RBA: 40000,
      'Year Built': 1990, 'Clear Height': 20, Docks: 2, 'Drive Ins': 1, 'Office %': null, Owner: 'SMITH FAMILY LLC',
      'SF Available': 1000, 'Rent Low': 9, 'Rent High': null, 'Rent Type': 'NNN', 'Space Use': 'Direct',
      'Date On Market': '2026-01-15', Zip: '43219', Latitude: 39.99, Longitude: -82.93, 'Leasing Broker': 'Pat Broker',
      'Leasing Company': 'Acme Realty', 'Listing URL': null,
    };
    const row = ws.addRow(TEST_HEADERS.map((h) => values[h] ?? null));
    const urlCol = TEST_HEADERS.indexOf('Listing URL') + 1;
    row.getCell(urlCol).value = { text: 'View Listing', hyperlink: 'https://example.test/x' };
    const f = join(dir(), 'hyperlink.xlsx');
    await wb.xlsx.writeFile(f);
    const r = await parseCostarListingsFile(f, testHeaderMap());
    expect(r.rows[0]).toMatchObject({ listingUrl: 'https://example.test/x' });
  });

  it('cellHyperlink returns null for a non-hyperlink cell value', () => {
    expect(cellHyperlink('https://example.test/plain')).toBeNull();
    expect(cellHyperlink(null)).toBeNull();
    expect(cellHyperlink({ text: 'no link here' })).toBeNull();
    expect(cellHyperlink({ text: 'View Listing', hyperlink: 'https://example.test/x' })).toBe('https://example.test/x');
  });

  it('an unparseable available-SF cell (a range) is skipped with the updated reason', async () => {
    const f = await writeCostarFixture(dir(), 'range.xlsx', [{ address: '1 Main St', sf: 1 }]);
    await patchDataCell(f, 'SF Available', '2,000 - 5,000');
    const r = await parseCostarListingsFile(f, testHeaderMap());
    expect(r.skipped).toEqual([{ rowNumber: 2, reason: 'available SF missing, zero or unparseable' }]);
  });

  it('parseNumber strips $/commas/units and rejects ranges and parenthetical negatives', () => {
    expect(parseNumber('2,000 - 5,000')).toBeNull();
    expect(parseNumber('(5)')).toBeNull();
    expect(parseNumber('-82.93')).toBe(-82.93);
    expect(parseNumber('12,500 SF')).toBe(12500);
    expect(parseNumber('$8.50')).toBe(8.5);
  });

  it('parseClearHeight parses feet-inches notation and plain numbers', () => {
    expect(parseClearHeight(`24'0"`)).toBe(24);
    expect(parseClearHeight(`24' 6"`)).toBe(24.5);
    expect(parseClearHeight(`24'`)).toBe(24);
    expect(parseClearHeight('24 ft')).toBe(24);
    expect(parseClearHeight('24')).toBe(24);
    expect(parseClearHeight('garbage')).toBeNull();
  });

  it('parsePercent treats a %-suffix as points and a bare fraction as ×100', () => {
    expect(parsePercent('25%')).toBe(25);
    expect(parsePercent('1%')).toBe(1);
    expect(parsePercent('0.25')).toBe(25);
    expect(parsePercent('40')).toBe(40);
  });

  it('parseCoordinate rejects zero and out-of-range values', () => {
    expect(parseCoordinate('-82.93', 180)).toBe(-82.93);
    expect(parseCoordinate('0', 90)).toBeNull();
    expect(parseCoordinate('95', 90)).toBeNull();
    expect(parseCoordinate('', 90)).toBeNull();
  });

  it('the shipped header map parses, and is internally consistent with its own status', () => {
    const shipped = CostarHeaderMap.parse(JSON.parse(readFileSync(join(process.cwd(), 'config', 'lease-market.costar-headers.json'), 'utf8')));
    expect(['pending-sample', 'verified']).toContain(shipped.status);
    expect(shipped.fields).toHaveProperty('lat');
    if (shipped.status === 'pending-sample') {
      expect(Object.values(shipped.fields).every((v) => v === null)).toBe(true);
      expect(Object.keys(shipped.subtypeMap)).toHaveLength(0);
      expect(Object.keys(shipped.buildingStatusMap)).toHaveLength(0);
      expect(Object.keys(shipped.rentBasisMap)).toHaveLength(0);
      expect(shipped.subleaseValues).toHaveLength(0);
    } else {
      expect(shipped.fields.address).not.toBeNull();
      expect(shipped.fields.propertyType).not.toBeNull();
      expect(shipped.fields.availableSf).not.toBeNull();
      expect(shipped.fields.rentText !== null || shipped.fields.rentLow !== null).toBe(true);
    }
  });
});
