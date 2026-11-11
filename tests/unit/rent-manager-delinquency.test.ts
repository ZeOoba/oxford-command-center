import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  parseRentManagerRows,
  parseAsOfDateFromText,
  parseRentManagerWorksheet,
  detectRentManagerDelinquencyDetail,
  type RmDetailCell,
} from '../../server/ar/rent-manager-delinquency';

const ASOF = new Date(Date.UTC(2026, 6, 15)); // 2026-07-15, matches the real "as of 07/15/26" files

/** Minimal cell builders — one per row-shape observed in the real files. */
const propHeader = (name: string): RmDetailCell => ({ colA: name, tenantName: null, rentAmount: null, otherAmount: null, charge: null, date: null });
const totalForProperty = (): RmDetailCell => ({ colA: 'Total Delinquent for Property:', tenantName: null, rentAmount: null, otherAmount: null, charge: null, date: null });
const reportSummary = (): RmDetailCell => ({ colA: 'Report Summary', tenantName: null, rentAmount: null, otherAmount: null, charge: null, date: null });
const tenantCharge = (
  tenant: string | null,
  amount: { rent?: number; other?: number },
  charge: string,
  date: Date,
): RmDetailCell => ({ colA: null, tenantName: tenant, rentAmount: amount.rent ?? null, otherAmount: amount.other ?? null, charge, date });
const subtotal = (rent: number, other: number): RmDetailCell => ({ colA: null, tenantName: null, rentAmount: rent, otherAmount: other, charge: null, date: null });

describe('parseAsOfDateFromText', () => {
  it('parses "Current tenants as of MM/DD/YY"', () => {
    expect(parseAsOfDateFromText('Current tenants as of 07/15/26')).toEqual(new Date(Date.UTC(2026, 6, 15)));
  });
  it('parses a 4-digit year', () => {
    expect(parseAsOfDateFromText('Current tenants as of 07/15/2026')).toEqual(new Date(Date.UTC(2026, 6, 15)));
  });
  it('returns null for missing/malformed text', () => {
    expect(parseAsOfDateFromText(null)).toBeNull();
    expect(parseAsOfDateFromText('')).toBeNull();
    expect(parseAsOfDateFromText('nothing relevant here')).toBeNull();
  });
  it('returns null for a date that does not round-trip (e.g. day 45)', () => {
    expect(parseAsOfDateFromText('Current tenants as of 13/45/26')).toBeNull();
  });
});

describe('parseRentManagerRows — bucket computation', () => {
  it('returns unsupportedReason (not a silent empty result) when asOfDate is null', () => {
    const r = parseRentManagerRows([tenantCharge('X', { rent: 100 }, 'Rent Charge', ASOF), subtotal(100, 0)], null);
    expect(r.rows).toEqual([]);
    expect(r.unsupportedReason).toMatch(/as of/i);
  });

  it('buckets a single charge into d30 for age 0-30 days (the real reports\' inclusive-0 convention)', () => {
    const chargeDate = new Date(Date.UTC(2026, 6, 1)); // 14 days before as-of
    const cells = [tenantCharge('Acme', { rent: 500 }, 'Rent Charge', chargeDate), subtotal(500, 0)];
    const r = parseRentManagerRows(cells, ASOF);
    expect(r.rows).toEqual([{ tenant: 'Acme', property: null, d30: 500, d60: 0, d90: 0, d90plus: 0 }]);
  });

  it('boundary ages: exactly 30/31/60/61/90/91 days land in the correct bucket', () => {
    const dayOffset = (n: number) => new Date(ASOF.getTime() - n * 86400000);
    const cells = [
      tenantCharge('T', { other: 30 }, 'Water', dayOffset(30)),
      tenantCharge(null, { other: 31 }, 'Water', dayOffset(31)),
      tenantCharge(null, { other: 60 }, 'Water', dayOffset(60)),
      tenantCharge(null, { other: 61 }, 'Water', dayOffset(61)),
      tenantCharge(null, { other: 90 }, 'Water', dayOffset(90)),
      tenantCharge(null, { other: 91 }, 'Water', dayOffset(91)),
      subtotal(0, 30 + 31 + 60 + 61 + 90 + 91),
    ];
    const r = parseRentManagerRows(cells, ASOF);
    expect(r.rows).toEqual([{ tenant: 'T', property: null, d30: 30, d60: 31 + 60, d90: 61 + 90, d90plus: 91 }]);
  });

  it('sums multiple charges across a tenant block into the right buckets (mirrors the real Pedro\'s Flooring block)', () => {
    const cells = [
      tenantCharge('Pedro', { other: 33.33 }, 'Water', new Date(Date.UTC(2026, 5, 23))), // 22d -> d30
      tenantCharge(null, { rent: 1111.5 }, 'Rent Charge', new Date(Date.UTC(2026, 6, 1))), // 14d -> d30
      tenantCharge(null, { other: 111.15 }, 'Late Charge', new Date(Date.UTC(2026, 6, 10))), // 5d -> d30
      subtotal(1111.5, 144.48),
    ];
    const r = parseRentManagerRows(cells, ASOF);
    expect(r.rows).toEqual([{ tenant: 'Pedro', property: null, d30: 1111.5 + 144.48, d60: 0, d90: 0, d90plus: 0 }]);
    expect(r.subtotalMismatches).toEqual([]);
  });

  it('flags a subtotal mismatch (computed vs reported) without dropping the row', () => {
    const cells = [tenantCharge('Bad', { rent: 100 }, 'Rent Charge', new Date(Date.UTC(2026, 6, 1))), subtotal(999, 0)];
    const r = parseRentManagerRows(cells, ASOF);
    expect(r.rows).toEqual([{ tenant: 'Bad', property: null, d30: 100, d60: 0, d90: 0, d90plus: 0 }]);
    expect(r.subtotalMismatches).toEqual([{ tenant: 'Bad', property: null, computedTotal: 100, reportedTotal: 999 }]);
  });

  it('does NOT flag a mismatch for a float-rounding-only difference (sub-cent)', () => {
    const cells = [tenantCharge('OK', { other: 170.46 }, 'Water', new Date(Date.UTC(2026, 6, 1))), subtotal(0, 170.46)];
    const r = parseRentManagerRows(cells, ASOF);
    expect(r.subtotalMismatches).toEqual([]);
  });

  it('clamps a negative (credit) charge amount to 0', () => {
    const cells = [tenantCharge('Credit Co', { other: -50 }, 'Adjustment', new Date(Date.UTC(2026, 6, 1))), subtotal(0, -50)];
    const r = parseRentManagerRows(cells, ASOF);
    expect(r.rows[0]!.d30).toBe(0);
  });

  it('handles an explicit K=0 subtotal (all delinquency in Other) — matches the real Sepich file', () => {
    const cells = [
      tenantCharge('Granite', { other: 123.45 }, 'Water', new Date(Date.UTC(2025, 11, 24))),
      subtotal(0, 123.45),
    ];
    const r = parseRentManagerRows(cells, ASOF);
    expect(r.rows[0]).toMatchObject({ tenant: 'Granite', d90plus: 123.45 });
  });

  it('skips property-header rows and attaches the current property to subsequent tenants', () => {
    const cells = [
      propHeader('2000 Zettler Rd'),
      tenantCharge('T1', { rent: 100 }, 'Rent Charge', new Date(Date.UTC(2026, 6, 1))),
      subtotal(100, 0),
      totalForProperty(),
      propHeader('2012 Zettler Rd'),
      tenantCharge('T2', { rent: 200 }, 'Rent Charge', new Date(Date.UTC(2026, 6, 1))),
      subtotal(200, 0),
    ];
    const r = parseRentManagerRows(cells, ASOF);
    expect(r.rows).toEqual([
      { tenant: 'T1', property: '2000 Zettler Rd', d30: 100, d60: 0, d90: 0, d90plus: 0 },
      { tenant: 'T2', property: '2012 Zettler Rd', d30: 200, d60: 0, d90: 0, d90plus: 0 },
    ]);
  });

  it('stops at "Report Summary" and ignores everything after it', () => {
    const cells = [
      tenantCharge('T1', { rent: 100 }, 'Rent Charge', new Date(Date.UTC(2026, 6, 1))),
      subtotal(100, 0),
      totalForProperty(),
      reportSummary(),
      tenantCharge('GHOST', { rent: 999 }, 'Rent Charge', new Date(Date.UTC(2026, 6, 1))), // must be ignored
      subtotal(999, 0),
    ];
    const r = parseRentManagerRows(cells, ASOF);
    expect(r.rows).toEqual([{ tenant: 'T1', property: null, d30: 100, d60: 0, d90: 0, d90plus: 0 }]);
  });

  it('defensively flushes a tenant block missing its subtotal row (malformed export) rather than dropping it', () => {
    const cells = [
      tenantCharge('Orphan', { rent: 50 }, 'Rent Charge', new Date(Date.UTC(2026, 6, 1))),
      // no subtotal row — a new tenant starts immediately
      tenantCharge('Next', { rent: 75 }, 'Rent Charge', new Date(Date.UTC(2026, 6, 1))),
      subtotal(75, 0),
    ];
    const r = parseRentManagerRows(cells, ASOF);
    expect(r.rows).toEqual([
      { tenant: 'Orphan', property: null, d30: 50, d60: 0, d90: 0, d90plus: 0 },
      { tenant: 'Next', property: null, d30: 75, d60: 0, d90: 0, d90plus: 0 },
    ]);
  });

  it('flushes a trailing tenant block at end-of-sheet even with no subtotal row', () => {
    const cells = [tenantCharge('Last', { rent: 10 }, 'Rent Charge', new Date(Date.UTC(2026, 6, 1)))];
    const r = parseRentManagerRows(cells, ASOF);
    expect(r.rows).toEqual([{ tenant: 'Last', property: null, d30: 10, d60: 0, d90: 0, d90plus: 0 }]);
  });

  it('handles a multi-property portfolio file (Sepich-style) with independent tenant totals per property', () => {
    const cells = [
      propHeader('2000 Zettler Rd'),
      tenantCharge('A', { other: 50 }, 'Water', new Date(Date.UTC(2026, 6, 1))),
      subtotal(0, 50),
      totalForProperty(),
      propHeader('2012 Zettler Rd'),
      tenantCharge('B', { rent: 1650 }, 'Rent Charge', new Date(Date.UTC(2026, 6, 1))),
      tenantCharge(null, { other: 198 }, 'Late Charge', new Date(Date.UTC(2026, 5, 11))),
      subtotal(1650, 198),
      totalForProperty(),
      reportSummary(),
    ];
    // A's water charge: 2026-07-01, 14 days before as-of -> d30.
    // B's rent charge: 2026-07-01, 14 days before as-of -> d30. B's late charge: 2026-06-11, 34 days
    // before as-of -> d60 (31-60).
    const r = parseRentManagerRows(cells, ASOF);
    expect(r.rows).toEqual([
      { tenant: 'A', property: '2000 Zettler Rd', d30: 50, d60: 0, d90: 0, d90plus: 0 },
      { tenant: 'B', property: '2012 Zettler Rd', d30: 1650, d60: 198, d90: 0, d90plus: 0 },
    ]);
  });

  it('returns [] for an empty sheet (no cells)', () => {
    const r = parseRentManagerRows([], ASOF);
    expect(r.rows).toEqual([]);
    expect(r.subtotalMismatches).toEqual([]);
  });

  // Real defect (2026-09-06 adversarial review, MEDIUM): the bucket accumulator was a plain
  // running float sum with no cent-rounding, so a tenant's total depended on the ORDER the
  // charge rows happened to appear in the worksheet -- an identical re-export with the same
  // charges enumerated in a different row order could sum to a different last-ulp float (e.g.
  // 734.8599999999999 vs 734.86). resolve-latest.ts's sameBuckets compares with `===`, so that
  // ulp difference made an unchanged re-import look like two reports "disagreeing" and stranded
  // the write behind a false ambiguousTies conflict. Verified on the real archived exports.
  it('sums to the same cent-precise total regardless of charge-row order (float-drift regression)', () => {
    const chargesForward = [
      tenantCharge('Embody Dance', { other: 234.56 }, 'Late Fee', new Date(ASOF.getTime() - 5 * 86400000)),
      tenantCharge(null, { rent: 400 }, 'Rent Charge', new Date(ASOF.getTime() - 10 * 86400000)),
      tenantCharge(null, { other: 100.3 }, 'Water', new Date(ASOF.getTime() - 15 * 86400000)),
    ];
    const chargesReversed = [chargesForward[2]!, chargesForward[1]!, { ...chargesForward[0]!, tenantName: 'Embody Dance' }];
    // The order-dependence is real for these inputs (asserted so a future edit cannot silently lose it).
    expect(234.56 + 400 + 100.3).not.toBe(100.3 + 400 + 234.56);
    const forward = parseRentManagerRows([...chargesForward, subtotal(400, 334.86)], ASOF);
    const reversed = parseRentManagerRows([...chargesReversed, subtotal(400, 334.86)], ASOF);
    const totalOf = (r: typeof forward) => r.rows[0]!.d30 + r.rows[0]!.d60 + r.rows[0]!.d90 + r.rows[0]!.d90plus;
    expect(totalOf(forward)).toBe(totalOf(reversed));
    expect(totalOf(forward)).toBe(734.86); // exact cent value, not 734.8599999999999
  });
});

/** Builds an in-memory worksheet mirroring the REAL 1100 Rarig file's exact layout (verified
 *  2026-07-22 against the live export) — portable (no OneDrive dependency) while still exercising
 *  the real ExcelJS cell-reading code path (CellValue types, not plain-array fixtures). */
function buildRealShapeWorksheet(): ExcelJS.Worksheet {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.getCell('B1').value = 'Delinquency (Detail)';
  ws.getCell('B2').value = 'Property: 1100 Rarig Ave';
  ws.getCell('B3').value = 'Current tenants as of 07/15/26';
  ws.getCell('C4').value = 'Tenant Name';
  ws.getCell('D4').value = 'Acc';
  ws.getCell('F4').value = 'Unit';
  ws.getCell('H4').value = 'Unit Type';
  ws.getCell('K4').value = 'Rent Amount';
  ws.getCell('L4').value = 'Other Amount';
  ws.getCell('M4').value = 'Charge';
  ws.getCell('P4').value = 'Date';
  ws.getCell('Q4').value = 'Per Day Late';
  // Real files merge the label across A:C (verified 2026-07-22 against the live 1100 Rarig export via
  // ExcelJS's own .value echo) — set C5 to the SAME text as A5 to reproduce that merge artifact
  // rather than only the un-merged shape a hand-built fixture would otherwise default to.
  ws.getCell('A5').value = '1100 Rarig Ave';
  ws.mergeCells('A5:C5');
  ws.getCell('C6').value = "PEDRO'S FLOORING LLC";
  ws.getCell('D6').value = '18387';
  ws.getCell('F6').value = '1100 Rarig Ave #B';
  ws.getCell('H6').value = 'Commercial unit';
  ws.getCell('L6').value = 33.33;
  ws.getCell('M6').value = 'Water';
  ws.getCell('P6').value = new Date(Date.UTC(2026, 5, 23));
  ws.getCell('Q6').value = 0;
  ws.getCell('K7').value = 1111.5;
  ws.getCell('M7').value = 'Rent Charge';
  ws.getCell('P7').value = new Date(Date.UTC(2026, 6, 1));
  ws.getCell('Q7').value = 0;
  ws.getCell('L8').value = 111.15;
  ws.getCell('M8').value = 'Late Charge';
  ws.getCell('P8').value = new Date(Date.UTC(2026, 6, 10));
  ws.getCell('Q8').value = 0;
  ws.getCell('K9').value = 1111.5;
  ws.getCell('L9').value = 144.48;
  ws.getCell('Q9').value = 0;
  ws.getCell('A10').value = 'Total Delinquent for Property:';
  ws.mergeCells('A10:C10');
  ws.getCell('E10').value = 1111.5 + 144.48;
  ws.getCell('A11').value = 'Report Summary';
  ws.mergeCells('A11:C11');
  return ws;
}

describe('parseRentManagerWorksheet — real ExcelJS adapter (mirrors the live 1100 Rarig shape)', () => {
  it('detects the format from the title cell', () => {
    expect(detectRentManagerDelinquencyDetail(buildRealShapeWorksheet())).toBe(true);
    const other = new ExcelJS.Workbook().addWorksheet('X');
    other.getCell('A1').value = 'Some Other Report';
    expect(detectRentManagerDelinquencyDetail(other)).toBe(false);
  });

  it('parses the as-of date from the real B3 cell text', () => {
    const r = parseRentManagerWorksheet(buildRealShapeWorksheet());
    expect(r.asOfDate).toEqual(new Date(Date.UTC(2026, 6, 15)));
  });

  it('locates columns by header label (not hardcoded letters) and produces the correct tenant row', () => {
    const r = parseRentManagerWorksheet(buildRealShapeWorksheet());
    expect(r.unsupportedReason).toBeUndefined();
    expect(r.rows).toEqual([
      { tenant: "PEDRO'S FLOORING LLC", property: '1100 Rarig Ave', d30: 1111.5 + 144.48, d60: 0, d90: 0, d90plus: 0 },
    ]);
    expect(r.subtotalMismatches).toEqual([]);
  });

  it('does NOT create a phantom tenant from a merged-cell label row echoing into the tenant-name column (real-file regression, found 2026-07-22)', () => {
    // Verified against all 5 live Rent Manager exports: property-header, "Total Delinquent for
    // Property:", and "Report Summary" label rows merge their text across columns A-C, so ExcelJS's
    // per-cell .value echoes the SAME string into the tenant-name column — indistinguishable from a
    // genuine tenant unless explicitly filtered. Before the fix, this fixture produced TWO rows:
    // the real "PEDRO'S FLOORING LLC" tenant AND a phantom "1100 Rarig Ave" (property name) tenant
    // with an all-zero bucket vector.
    const r = parseRentManagerWorksheet(buildRealShapeWorksheet());
    expect(r.rows).toHaveLength(1);
    expect(r.rows.some((row) => row.tenant === '1100 Rarig Ave')).toBe(false);
  });

  it('returns unsupportedReason when the expected columns are not found', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Blank');
    ws.getCell('A1').value = 'Not a delinquency report';
    const r = parseRentManagerWorksheet(ws);
    expect(r.rows).toEqual([]);
    expect(r.unsupportedReason).toMatch(/column headers/i);
  });
});
