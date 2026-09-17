// tests/unit/lease-market-costar-parse.test.ts
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CostarHeaderMap, cellHyperlink, cellText, parseClearHeight, parseCoordinate, parseCostarListingsFile, parseNumber,
  parsePercent, parseTimeOnMarketDuration, timeOnMarketTextToDate,
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

  // R4: a numeric fields.rentLow column has no unit of its own -- rentPeriodDefault is the ONLY thing
  // that says whether its figures are annual or monthly. A verified map that maps rentLow but leaves
  // rentPeriodDefault null would silently read a monthly rate as annual (e.g. $3.00/SF/MO ingested as
  // $3.00/SF/YR), so this must hard-fail at header-map validation time, before any row is read.
  it('hard-fails when fields.rentLow is mapped but rentPeriodDefault is null (R4)', async () => {
    const f = await writeCostarFixture(dir(), 'a.xlsx', [{ address: '1 Main St', sf: 1000, rentLow: 3.0 }]);
    await expect(parseCostarListingsFile(f, testHeaderMap({ rentPeriodDefault: null }))).rejects.toThrow(/rentPeriodDefault/);
  });

  it('does not hard-fail on a null rentPeriodDefault when fields.rentLow is itself unmapped (free-text rentText only)', async () => {
    const base = testHeaderMap();
    const map = testHeaderMap({ rentPeriodDefault: null, fields: { ...base.fields, rentText: 'Rent Low', rentLow: null, rentHigh: null, rentBasis: null } });
    const f = await writeCostarFixture(dir(), 'a.xlsx', [{ address: '1 Main St', sf: 1000, rentLow: '$9.00/SF/YR NNN', rentType: null }]);
    await expect(parseCostarListingsFile(f, map)).resolves.toBeTruthy();
  });

  it('maps rows to canonical listings, including location and broker, and skips rows without SF', async () => {
    const f = await writeCostarFixture(dir(), 'a.xlsx', [
      // R12: officePct is already in percentage points (25, not the fraction 0.25) — the default
      // header map has no officePctIsFraction flag, so a bare number is no longer ×100'd by a
      // value-magnitude guess. A fractional-source export is covered separately below.
      { id: 'C1', address: '10 Alpha Rd', suite: 'Suite 100', sf: 12000, rentLow: 8.5, rentType: 'NNN', officePct: 25, dateOnMarket: new Date(Date.UTC(2025, 10, 1)), url: 'https://example.test/1' },
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

  it('officePct: no value-magnitude guess by default (R12) — a raw "1" stays 1%, not 100%', async () => {
    // The exact regression named in the fix request: a genuine 1% office share, stored by CoStar as
    // the bare number 1, was previously multiplied ×100 into 100% because 1 falls in the old
    // heuristic's (0,1] "must be a fraction" range. With no header-map flag set, it must not convert.
    const f = await writeCostarFixture(dir(), 'a.xlsx', [{ address: '1 Main St', sf: 1000, officePct: 1 }]);
    const r = await parseCostarListingsFile(f, testHeaderMap());
    expect(r.rows[0]).toMatchObject({ officePct: 1 });
  });

  it('officePct: converts ×100 only when the header map declares the column fractional (R12)', async () => {
    const f = await writeCostarFixture(dir(), 'a.xlsx', [{ address: '1 Main St', sf: 1000, officePct: 0.5 }]);
    const r = await parseCostarListingsFile(f, testHeaderMap({ officePctIsFraction: true }));
    expect(r.rows[0]).toMatchObject({ officePct: 50 });
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

  it('a performance-guard-capped free-text quote (rentLow/rentHigh both null) stays UNKNOWN, not WITHHELD', async () => {
    // parseRentText's own >200-char-after-collapse performance guard (fix round 4) returns
    // rentLow: null, rentHigh: null, ambiguous: true, withheld: false. Round 5 fixes a bug where the
    // parser's blanket "both rentLow/rentHigh null => WITHHELD" fallback clobbered that ambiguity-
    // driven UNKNOWN back to WITHHELD — WITHHELD means "no quote at all," a stronger and different
    // claim than "a quote existed but was too long to trust."
    const prefix = '$8.50/SF/YR NNN ';
    const longRentText = prefix + 'x'.repeat(250 - prefix.length);
    expect(longRentText.length).toBe(250);
    expect(longRentText.startsWith('$8.50/SF/YR NNN')).toBe(true);
    const base = testHeaderMap();
    const map = testHeaderMap({ fields: { ...base.fields, rentText: 'Rent Low', rentLow: null, rentHigh: null, rentBasis: null } });
    const f = await writeCostarFixture(dir(), 'a.xlsx', [{ address: '1 Main St', sf: 1000, rentLow: longRentText, rentType: null }]);
    const r = await parseCostarListingsFile(f, map);
    expect(r.rows[0]).toMatchObject({ rentBasis: 'UNKNOWN', rentLow: null, rentHigh: null });
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
      'Leasing Company': 'Acme Realty', 'Listing URL': null, 'Time On Market': null, 'Max SF Available': null,
      'Contig SF Available': null,
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

  // R14: a blank Address must be counted as skipped (with a clear reason), not silently dropped —
  // previously it was neither in `skipped` nor in `rowCount`, so the completeness ratio
  // (exportMinRowRatio) and the Data Quality tab's lastExportSkipped both understated the real loss.
  it('a blank Address cell is skipped with a clear reason, and counted in rowCount', async () => {
    const f = await writeCostarFixture(dir(), 'blank-address.xlsx', [
      { address: 'placeholder', sf: 1000 }, // row 2 — its address cell is blanked below
      { address: '2 Main St', sf: 2000 },
    ]);
    await patchDataCell(f, 'Address', '');
    const r = await parseCostarListingsFile(f, testHeaderMap());
    expect(r.skipped).toEqual([{ rowNumber: 2, reason: 'address missing or blank' }]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.address).toBe('2 Main St');
    // rowCount = rows.length + skipped.length: the blank-address row must be counted, not dropped
    // silently as though it never existed in the export.
    expect(r.rowCount).toBe(2);
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

  it('parsePercent: a %-suffix is always points; a bare number is points UNLESS the header map says the column is fractional (R12)', () => {
    // A "%"-suffixed value is unambiguous regardless of isFraction.
    expect(parsePercent('25%')).toBe(25);
    expect(parsePercent('1%')).toBe(1);
    expect(parsePercent('1%', true)).toBe(1);
    // R12: no value-magnitude heuristic left — a bare number stays in points by default (isFraction
    // omitted/false). Previously a bare "1" (meaning 1%) was silently ×100'd into 100 because it fell
    // in (0,1]; that defect is exactly what this default-false behavior closes.
    expect(parsePercent('1')).toBe(1);
    expect(parsePercent('0.5')).toBe(0.5);
    expect(parsePercent('0.25')).toBe(0.25);
    expect(parsePercent('40')).toBe(40);
    // isFraction: true explicitly opts a column into the ×100 conversion.
    expect(parsePercent('0.25', true)).toBe(25);
    expect(parsePercent('0.5', true)).toBe(50);
    expect(parsePercent('1', true)).toBe(100);
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

  describe('parseTimeOnMarketDuration / timeOnMarketTextToDate ("Time on Market" duration -> costarDateOnMarket)', () => {
    it('parses every observed shape (unit words in descending-magnitude order, case-insensitive, singular or plural)', () => {
      expect(parseTimeOnMarketDuration('3 Months 12 Days')).toEqual({ years: 0, months: 3, days: 12 });
      expect(parseTimeOnMarketDuration('1 Year 2 Months')).toEqual({ years: 1, months: 2, days: 0 });
      expect(parseTimeOnMarketDuration('2 Years 3 Months')).toEqual({ years: 2, months: 3, days: 0 });
      expect(parseTimeOnMarketDuration('45 Days')).toEqual({ years: 0, months: 0, days: 45 });
      expect(parseTimeOnMarketDuration('1 Month 5 Days')).toEqual({ years: 0, months: 1, days: 5 });
      expect(parseTimeOnMarketDuration('4 Years')).toEqual({ years: 4, months: 0, days: 0 });
      expect(parseTimeOnMarketDuration('1 Year')).toEqual({ years: 1, months: 0, days: 0 });
      expect(parseTimeOnMarketDuration('6 Months 1 Day')).toEqual({ years: 0, months: 6, days: 1 });
      expect(parseTimeOnMarketDuration('7 Months')).toEqual({ years: 0, months: 7, days: 0 });
      expect(parseTimeOnMarketDuration('3 Years 1 Month')).toEqual({ years: 3, months: 1, days: 0 });
      expect(parseTimeOnMarketDuration('1 Month')).toEqual({ years: 0, months: 1, days: 0 });
      expect(parseTimeOnMarketDuration('1 Year 1 Month')).toEqual({ years: 1, months: 1, days: 0 });
      // case-insensitive
      expect(parseTimeOnMarketDuration('3 MONTHS 12 DAYS')).toEqual({ years: 0, months: 3, days: 12 });
      expect(parseTimeOnMarketDuration('3 months 12 days')).toEqual({ years: 0, months: 3, days: 12 });
    });

    it('rejects ascending or repeated unit order, unrecognized units, and unparseable/blank text', () => {
      expect(parseTimeOnMarketDuration('12 Days 3 Months')).toBeNull(); // ascending — never guess
      expect(parseTimeOnMarketDuration('1 Month 1 Month')).toBeNull(); // repeated unit
      expect(parseTimeOnMarketDuration('3 Months 1 Year')).toBeNull(); // ascending (months before years)
      expect(parseTimeOnMarketDuration('3 Fortnights')).toBeNull(); // unrecognized unit
      expect(parseTimeOnMarketDuration('~3 Months')).toBeNull(); // stray leading character
      expect(parseTimeOnMarketDuration('3 Months and 12 Days')).toBeNull(); // stray "and"
      expect(parseTimeOnMarketDuration('')).toBeNull();
      expect(parseTimeOnMarketDuration('   ')).toBeNull();
      expect(parseTimeOnMarketDuration('N/A')).toBeNull();
    });

    it('converts a duration to a date via whole-month arithmetic, clamped to a valid calendar date', () => {
      // 1 month back from Mar 31 -> Feb 28 (2026 is not a leap year), never rolls forward into March.
      expect(timeOnMarketTextToDate('1 Month', '2026-03-31')).toBe('2026-02-28');
      // Straightforward case spanning a year boundary.
      expect(timeOnMarketTextToDate('2 Months', '2026-01-15')).toBe('2025-11-15');
      // Years + months combined, then days subtracted after the month-clamped date.
      expect(timeOnMarketTextToDate('1 Year 2 Months', '2026-09-17')).toBe('2025-07-17');
      expect(timeOnMarketTextToDate('3 Months 12 Days', '2026-09-17')).toBe('2026-06-05');
      // Zero-duration resolves to exactly the export date (the upper bound is inclusive).
      expect(timeOnMarketTextToDate('0 Days', '2026-09-17')).toBe('2026-09-17');
    });

    it('bounds the result: rejects a duration resolving before 1990-01-01, accepts one landing exactly on it', () => {
      expect(timeOnMarketTextToDate('40 Years', '2026-09-17')).toBeNull(); // resolves to 1986-09-17 — before 1990
      expect(timeOnMarketTextToDate('37 Years', '2026-09-17')).toBeNull(); // resolves to 1989-09-17 — before 1990
      expect(timeOnMarketTextToDate('36 Years', '2026-09-17')).toBe('1990-09-17'); // on-or-after the floor: kept
      expect(timeOnMarketTextToDate('36 Years 8 Months 16 Days', '2026-09-17')).toBe('1990-01-01'); // exactly the floor
      expect(timeOnMarketTextToDate('1 Day', '2026-09-17')).toBe('2026-09-16');
    });

    it('yields null, never a throw, for blank/unparseable duration text or a malformed export date', () => {
      expect(timeOnMarketTextToDate('', '2026-09-17')).toBeNull();
      expect(timeOnMarketTextToDate('garbage', '2026-09-17')).toBeNull();
      expect(timeOnMarketTextToDate('3 Months', 'not-a-date')).toBeNull();
      expect(() => timeOnMarketTextToDate('garbage', 'not-a-date')).not.toThrow();
    });

    it('parses a real row: timeOnMarketText feeds costarDateOnMarket when dateOnMarket is unmapped', async () => {
      const base = testHeaderMap();
      const map = testHeaderMap({
        fields: { ...base.fields, dateOnMarket: null, timeOnMarketText: 'Time On Market' },
      });
      const f = await writeCostarFixture(dir(), 'a.xlsx', [
        { address: '1 Main St', sf: 1000, timeOnMarket: '3 Months 12 Days' },
        { address: '2 Main St', sf: 1000, timeOnMarket: null },
        { address: '3 Main St', sf: 1000, timeOnMarket: 'garbage' },
      ]);
      const r = await parseCostarListingsFile(f, map, '2026-09-17');
      expect(r.rows[0]).toMatchObject({ costarDateOnMarket: '2026-06-05' });
      expect(r.rows[1]).toMatchObject({ costarDateOnMarket: null });
      expect(r.rows[2]).toMatchObject({ costarDateOnMarket: null });
    });

    it('an explicit dateOnMarket column wins over timeOnMarketText when both are mapped (per header-map field, not per-row)', async () => {
      const base = testHeaderMap();
      // Both dateOnMarket ("Date On Market") and timeOnMarketText ("Time On Market") mapped: the
      // explicit date column is authoritative and timeOnMarketText is never consulted, even on a row
      // where the explicit column is blank and timeOnMarketText carries a perfectly good duration.
      const map = testHeaderMap({
        fields: { ...base.fields, dateOnMarket: 'Date On Market', timeOnMarketText: 'Time On Market' },
      });
      const f = await writeCostarFixture(dir(), 'a.xlsx', [
        { address: '1 Main St', sf: 1000, dateOnMarket: '2025-01-01', timeOnMarket: '3 Months 12 Days' },
        { address: '2 Main St', sf: 1000, dateOnMarket: null, timeOnMarket: '3 Months 12 Days' },
      ]);
      const r = await parseCostarListingsFile(f, map, '2026-09-17');
      expect(r.rows[0]).toMatchObject({ costarDateOnMarket: '2025-01-01' }); // explicit column wins, not '2026-06-05'
      expect(r.rows[1]).toMatchObject({ costarDateOnMarket: null }); // explicit column mapped but blank -> null, no duration fallback
    });

    it('defaults the export date to today when the caller (e.g. a bare unit test) does not pass one', async () => {
      const base = testHeaderMap();
      const map = testHeaderMap({ fields: { ...base.fields, dateOnMarket: null, timeOnMarketText: 'Time On Market' } });
      const f = await writeCostarFixture(dir(), 'a.xlsx', [{ address: '1 Main St', sf: 1000, timeOnMarket: '0 Days' }]);
      const r = await parseCostarListingsFile(f, map); // no exportDate argument
      expect(r.rows[0]!.costarDateOnMarket).toBe(new Date().toISOString().slice(0, 10));
    });
  });

  describe('availableSf max-else-min fallback (availableSfMax paired with the required availableSf/min column)', () => {
    it('unchanged behavior when availableSfMax is unmapped: availableSf is whatever the single mapped column holds', async () => {
      const f = await writeCostarFixture(dir(), 'a.xlsx', [{ address: '1 Main St', sf: 12000 }]);
      const r = await parseCostarListingsFile(f, testHeaderMap());
      expect(r.rows[0]).toMatchObject({ availableSf: 12000, minDivisibleSf: null });
    });

    it('takes Max when populated, and carries the Min forward as minDivisibleSf', async () => {
      const base = testHeaderMap();
      const map = testHeaderMap({ fields: { ...base.fields, availableSfMax: 'Max SF Available' } });
      const f = await writeCostarFixture(dir(), 'a.xlsx', [{ address: '1 Main St', sf: 5000, sfMax: 20000 }]);
      const r = await parseCostarListingsFile(f, map);
      expect(r.rows[0]).toMatchObject({ availableSf: 20000, minDivisibleSf: 5000 });
    });

    it('falls back to Min when Max is blank on that row, without dropping the row', async () => {
      const base = testHeaderMap();
      const map = testHeaderMap({ fields: { ...base.fields, availableSfMax: 'Max SF Available' } });
      const f = await writeCostarFixture(dir(), 'a.xlsx', [{ address: '1 Main St', sf: 8000, sfMax: null }]);
      const r = await parseCostarListingsFile(f, map);
      expect(r.rows[0]).toMatchObject({ availableSf: 8000, minDivisibleSf: 8000 });
    });

    it('a distinct, separately-mapped minDivisibleSf column wins over the max/min pair fallback', async () => {
      const base = testHeaderMap();
      // Reuses the "Rent High" column as a stand-in numeric column for minDivisibleSf — only the
      // priority rule (explicit mapping beats the derived max/min pair fallback) is under test here,
      // not the semantics of any particular CoStar column.
      const map = testHeaderMap({
        fields: { ...base.fields, availableSfMax: 'Max SF Available', minDivisibleSf: 'Rent High' },
      });
      const f = await writeCostarFixture(dir(), 'a.xlsx', [
        { address: '1 Main St', sf: 5000, sfMax: 20000, rentHigh: 2500 },
      ]);
      const r = await parseCostarListingsFile(f, map);
      expect(r.rows[0]).toMatchObject({ availableSf: 20000, minDivisibleSf: 2500 });
    });

    it('still skips the row when both Min and Max are missing/zero', async () => {
      const base = testHeaderMap();
      const map = testHeaderMap({ fields: { ...base.fields, availableSfMax: 'Max SF Available' } });
      const f = await writeCostarFixture(dir(), 'a.xlsx', [{ address: '1 Main St', sf: 0, sfMax: null }]);
      const r = await parseCostarListingsFile(f, map);
      expect(r.skipped).toEqual([{ rowNumber: 2, reason: 'available SF missing, zero or unparseable' }]);
    });
  });

  // H1: `Max Avail Size SF` is the property's TOTAL available SF across every (possibly
  // non-contiguous) space CoStar rolled into one row, not one space's size — 73 in-scope rows in the
  // first real export have Max > `Building Contig SF`, mis-banding 31 of them (one of which drops out
  // of every band entirely, since it lands over benchmarkMaxBuildingSf). `Building Contig SF` is
  // present in the export but was unmapped. Fixed by mapping it and preferring it: contig ?? max ??
  // min. Tests use the three real rows named in the fix request.
  describe('availableSf: buildingContigSf wins over the max-else-min fallback (H1)', () => {
    it('22 N 1st St: Max 47,000 (band 30-50K) vs Building Contig SF 20,000 (band 15-30K) — contig wins', async () => {
      const base = testHeaderMap();
      const map = testHeaderMap({ fields: { ...base.fields, availableSfMax: 'Max SF Available', buildingContigSf: 'Contig SF Available' } });
      const f = await writeCostarFixture(dir(), 'a.xlsx', [
        { address: '22 N 1st St', type: 'Flex', secondary: 'Light Distribution', sf: 3500, sfMax: 47000, contigSf: 20000, rentLow: 8.25, rentType: 'NNN' },
      ]);
      const r = await parseCostarListingsFile(f, map);
      expect(r.rows[0]).toMatchObject({ availableSf: 20000, minDivisibleSf: 3500 });
    });

    it('2781 Westbelt Dr: Max 100,333 (over benchmarkMaxBuildingSf, drops out of every band) vs Building Contig SF 70,333 (band 50-80K) — contig wins and brings it back into scope', async () => {
      const base = testHeaderMap();
      const map = testHeaderMap({ fields: { ...base.fields, availableSfMax: 'Max SF Available', buildingContigSf: 'Contig SF Available' } });
      const f = await writeCostarFixture(dir(), 'a.xlsx', [
        { address: '2781 Westbelt Dr', sf: 30000, sfMax: 100333, contigSf: 70333, rentLow: null, rentType: null },
      ]);
      const r = await parseCostarListingsFile(f, map);
      expect(r.rows[0]).toMatchObject({ availableSf: 70333, minDivisibleSf: 30000 });
    });

    it('651 Lakeview Plaza Blvd: Max 8,394 (band 5-15K) vs Building Contig SF 4,949 (band <5K), NNN $10 quoted — contig wins', async () => {
      const base = testHeaderMap();
      const map = testHeaderMap({ fields: { ...base.fields, availableSfMax: 'Max SF Available', buildingContigSf: 'Contig SF Available' } });
      const f = await writeCostarFixture(dir(), 'a.xlsx', [
        { address: '651 Lakeview Plaza Blvd', type: 'Flex', secondary: 'Light Manufacturing', sf: 3445, sfMax: 8394, contigSf: 4949, rentLow: 10, rentType: 'NNN' },
      ]);
      const r = await parseCostarListingsFile(f, map);
      expect(r.rows[0]).toMatchObject({ availableSf: 4949, minDivisibleSf: 3445, rentLow: 10, rentBasis: 'NNN' });
    });

    it('falls back to Max when Contig is blank on that row, without dropping the row', async () => {
      const base = testHeaderMap();
      const map = testHeaderMap({ fields: { ...base.fields, availableSfMax: 'Max SF Available', buildingContigSf: 'Contig SF Available' } });
      const f = await writeCostarFixture(dir(), 'a.xlsx', [{ address: '1 Main St', sf: 5000, sfMax: 20000, contigSf: null }]);
      const r = await parseCostarListingsFile(f, map);
      expect(r.rows[0]).toMatchObject({ availableSf: 20000 });
    });

    it('a non-positive Contig is treated as absent, falling back to Max', async () => {
      const base = testHeaderMap();
      const map = testHeaderMap({ fields: { ...base.fields, availableSfMax: 'Max SF Available', buildingContigSf: 'Contig SF Available' } });
      const f = await writeCostarFixture(dir(), 'a.xlsx', [{ address: '1 Main St', sf: 5000, sfMax: 20000, contigSf: 0 }]);
      const r = await parseCostarListingsFile(f, map);
      expect(r.rows[0]).toMatchObject({ availableSf: 20000 });
    });

    it('unmapped buildingContigSf (field left null): unchanged max-else-min behavior, byte-for-byte', async () => {
      const base = testHeaderMap();
      const map = testHeaderMap({ fields: { ...base.fields, availableSfMax: 'Max SF Available' } }); // buildingContigSf left null
      const f = await writeCostarFixture(dir(), 'a.xlsx', [{ address: '1 Main St', sf: 5000, sfMax: 20000 }]);
      const r = await parseCostarListingsFile(f, map);
      expect(r.rows[0]).toMatchObject({ availableSf: 20000 });
    });
  });

  // C1: the working tree already carried skipPropertyTypes (the header-map schema field, the
  // skip-not-throw branch at the subtype lookup) and the real Office/Retail/Specialty entries in
  // config/lease-market.costar-headers.json, uncommitted, with no test coverage — without it the real
  // export throws on row 5 (an "Office|" row) and ingests 0 of 386 rows. These tests cover the
  // behavior directly against the real production combos.
  describe('skipPropertyTypes (C1): a listed out-of-scope type is skipped with a reason, not thrown', () => {
    it('real CoStar combos (Office|, Retail|Freestanding, Specialty|Airplane Hangar, Office & Flex|Light Distribution & Medical) are counted in skipped with a reason and in rowCount — never thrown', async () => {
      const base = testHeaderMap();
      const map = testHeaderMap({
        skipPropertyTypes: ['Office|*', 'Retail|*', 'Specialty|*', 'Office & Retail|*', 'Office & Flex|*'],
      });
      expect(map.fields).toEqual(base.fields); // sanity: patch above didn't disturb fields
      const f = await writeCostarFixture(dir(), 'a.xlsx', [
        { address: '1 Office Row', sf: 1000, type: 'Office', secondary: '' },
        { address: '2 Retail Row', sf: 2000, type: 'Retail', secondary: 'Freestanding' },
        { address: '3 Specialty Row', sf: 3000, type: 'Specialty', secondary: 'Airplane Hangar' },
        { address: '4 Office Flex Row', sf: 4000, type: 'Office & Flex', secondary: 'Light Distribution & Medical' },
        { address: '5 Warehouse Row', sf: 5000 }, // default Industrial|Warehouse — mapped normally, not skipped
      ]);
      const r = await parseCostarListingsFile(f, map);
      expect(r.skipped).toEqual([
        { rowNumber: 2, reason: 'property type "Office|" is out of scope' },
        { rowNumber: 3, reason: 'property type "Retail|Freestanding" is out of scope' },
        { rowNumber: 4, reason: 'property type "Specialty|Airplane Hangar" is out of scope' },
        { rowNumber: 5, reason: 'property type "Office & Flex|Light Distribution & Medical" is out of scope' },
      ]);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({ address: '5 Warehouse Row', subtype: 'warehouse' });
      // rowCount = rows.length + skipped.length: the skip-listed rows are counted, not dropped as
      // though they never existed in the export (Data Quality / exportMinRowRatio depend on this).
      expect(r.rowCount).toBe(5);
    });

    it('matching is case-insensitive on both the property-type text and the configured skip key', async () => {
      const map = testHeaderMap({ skipPropertyTypes: ['office|*'] }); // lower-case key
      const f = await writeCostarFixture(dir(), 'a.xlsx', [{ address: '1 Main St', sf: 1000, type: 'OFFICE', secondary: 'Anything' }]); // upper-case value
      const r = await parseCostarListingsFile(f, map);
      expect(r.skipped).toEqual([{ rowNumber: 2, reason: 'property type "OFFICE|Anything" is out of scope' }]);
      expect(r.rows).toHaveLength(0);
    });

    it('an exact (non-wildcard) skip key matches only that secondary type — a different secondary under the same primary still throws', async () => {
      const map = testHeaderMap({ skipPropertyTypes: ['Retail|Freestanding'] }); // exact key, no wildcard
      const f = await writeCostarFixture(dir(), 'a.xlsx', [{ address: '1 Main St', sf: 1000, type: 'Retail', secondary: 'Freestanding' }]);
      const r = await parseCostarListingsFile(f, map);
      expect(r.skipped).toEqual([{ rowNumber: 2, reason: 'property type "Retail|Freestanding" is out of scope' }]);

      const d = dir();
      await expect(
        parseCostarListingsFile(
          await writeCostarFixture(d, 'b.xlsx', [{ address: '1 Main St', sf: 1000, type: 'Retail', secondary: 'Strip Center' }]),
          map,
        ),
      ).rejects.toThrow(/unmapped property type "Retail\|Strip Center"/);
    });

    it('an unlisted, unmapped type still throws with the improved message even when skipPropertyTypes is configured', async () => {
      const map = testHeaderMap({ skipPropertyTypes: ['Office|*'] });
      await expect(
        parseCostarListingsFile(await writeCostarFixture(dir(), 'a.xlsx', [{ address: '1 Main St', sf: 1000, type: 'Storage' }]), map),
      ).rejects.toThrow(/unmapped property type "Storage\|Warehouse" — add it to subtypeMap, or to skipPropertyTypes if it is out of scope/);
    });

    it('omitted skipPropertyTypes (undefined) behaves exactly as before this field existed — every unmapped type throws', async () => {
      const map = testHeaderMap(); // no skipPropertyTypes
      expect(map.skipPropertyTypes).toBeUndefined();
      await expect(
        parseCostarListingsFile(await writeCostarFixture(dir(), 'a.xlsx', [{ address: '1 Main St', sf: 1000, type: 'Office' }]), map),
      ).rejects.toThrow(/unmapped property type "Office\|Warehouse"/);
    });
  });

  // M3: Industrial|* and Flex|* are broad wildcards in subtypeMap — a specialist-stock secondary type
  // (a truck terminal, cold storage, a showroom, food processing) still falls through the wildcard into
  // 'warehouse' unless it is EXPLICITLY skip-listed. The exact skip key must win over the wildcard
  // subtype mapping, not the other way around — this is the real row (1000 E 5th Ave, $15.00 NNN,
  // 22,890 SF) whose $15 asking would otherwise land in the 15-30K warehouse cell alongside a ~$10
  // median for genuine warehouse stock.
  describe('M3: an exact skipPropertyTypes key wins over the Industrial|*/Flex|* wildcard subtype mapping', () => {
    it('"Industrial|Truck Terminal" is skipped even though "Industrial|*" is mapped to warehouse in subtypeMap', async () => {
      const map = testHeaderMap({ skipPropertyTypes: ['Industrial|Truck Terminal'] }); // subtypeMap keeps testHeaderMap()'s 'Industrial|*': 'warehouse'
      const f = await writeCostarFixture(dir(), 'a.xlsx', [
        { address: '1000 E 5th Ave', sf: 22890, type: 'Industrial', secondary: 'Truck Terminal', rentLow: 15, rentType: 'NNN' },
        { address: '2 Warehouse Row', sf: 22000, type: 'Industrial', secondary: 'Distribution', rentLow: 10, rentType: 'NNN' },
      ]);
      const r = await parseCostarListingsFile(f, map);
      expect(r.skipped).toEqual([{ rowNumber: 2, reason: 'property type "Industrial|Truck Terminal" is out of scope' }]);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({ address: '2 Warehouse Row', subtype: 'warehouse' });
    });

    it('the shipped header map skip-lists all four M3 specialist-stock secondary types under Industrial, not Flex|Showroom', async () => {
      const shipped = CostarHeaderMap.parse(JSON.parse(readFileSync(join(process.cwd(), 'config', 'lease-market.costar-headers.json'), 'utf8')));
      const skip = shipped.skipPropertyTypes ?? [];
      expect(skip).toEqual(
        expect.arrayContaining(['Industrial|Truck Terminal', 'Industrial|Refrigeration/Cold Storage', 'Industrial|Showroom', 'Industrial|Food Processing']),
      );
      // Flex|Showroom is deliberately NOT skip-listed: under CoStar's own taxonomy it is marketed as
      // Flex stock (Primary Property Type "Flex", alongside Light Distribution/Light Manufacturing/R&D
      // in the same real export), not a pure showroom — it lands in the flex subtype's cells, not the
      // warehouse cells the M3 contamination finding was about, and there is no evidence in the real
      // export of it distorting a flex benchmark the way the Industrial secondary types distort warehouse.
      expect(skip).not.toContain('Flex|Showroom');
    });
  });
});
