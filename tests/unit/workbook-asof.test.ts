// tests/unit/workbook-asof.test.ts
//
// OI-023 — snapshot provenance decouple (2026-07-22). The snapshot's provenance labels
// (meta.asOf, cash.asOf, assumptions.asOf) were pinned to the WORKBOOK_AS_OF config constant
// ('2026-06-01'), so portfolio.json reported June while the underlying rent-roll data was
// July-current (the workbook's own "Master Tenant Rent Roll" header read "As of July 17, 2026").
// These tests pin the fix:
//   (1) each provenance label reads the WORKBOOK'S OWN "As of" dateline (the cached formula
//       result the sheet header already carries), per sheet — the Cash Balances dateline is
//       data-derived (MAX of the Cash Data date row) and can legitimately differ from the
//       rent roll's TODAY()-cached stamp;
//   (2) when a sheet carries no parseable dateline, the label falls back (cash/assumptions →
//       the rent-roll dateline; meta → WORKBOOK_AS_OF) and the degradation is LOUD — a
//       DataQualityFlag, never a silent June pin;
//   (3) the workbook data-month column selection (parse.ts monthCol) STAYS bound to
//       WORKBOOK_AS_OF — the dateline must never leak into data-month selection (see the
//       parse.ts comment above parseLeases; early in a month the workbook may not carry the
//       run month's column yet).
import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { WORKBOOK_AS_OF } from '../../server/config';
import { parseWorkbook, datelineToIso } from '../../server/workbook/parse';

const ORIGINAL_REPORT_DATE = process.env.REPORT_DATE;
afterEach(() => {
  if (ORIGINAL_REPORT_DATE === undefined) delete process.env.REPORT_DATE;
  else process.env.REPORT_DATE = ORIGINAL_REPORT_DATE;
});

// ── (0) datelineToIso — deterministic string parse, no Date() timezone semantics ────────────────
describe('datelineToIso', () => {
  it('parses the rent-roll header shape (text after the date is ignored)', () => {
    expect(
      datelineToIso('As of July 17, 2026   │   137 tenants   │   513,000 SF leased'),
    ).toBe('2026-07-17');
  });

  it('parses the cash-sheet shape (no trailing text) and is case-insensitive', () => {
    expect(datelineToIso('As of July 10, 2026')).toBe('2026-07-10');
    expect(datelineToIso('AS OF JULY 9, 2026')).toBe('2026-07-09');
  });

  it('accepts 3-letter month abbreviations', () => {
    expect(datelineToIso('As of Jul 17, 2026')).toBe('2026-07-17');
  });

  it('rejects garbage, missing dates, and implausible values', () => {
    expect(datelineToIso('TENANT ROSTER')).toBeNull();
    expect(datelineToIso('As of yesterday')).toBeNull();
    expect(datelineToIso('As of July 17')).toBeNull(); // no year
    expect(datelineToIso('As of July 17, 1889')).toBeNull(); // implausible year
    expect(datelineToIso('As of July 32, 2026')).toBeNull(); // implausible day
  });
});

// ── fixture ──────────────────────────────────────────────────────────────────────────────────────
const PROPERTY_NAME = 'Fixture Property Gamma';

interface FixtureOpts {
  /** Rent-roll A2 dateline; omit for a sheet with no dateline. */
  rentRollDateline?: string;
  /** Write the rent-roll dateline as a cached-formula object (the REAL workbook's shape). */
  rentRollDatelineAsFormula?: boolean;
  /** Cash Balances A2 dateline; omit for none. */
  cashDateline?: string;
  /** Assumptions A2 dateline; omit for none. */
  assumptionsDateline?: string;
  /** Monthly Checklist glyph columns: [WORKBOOK_AS_OF month col, other month col]. */
  taskCols?: [number, number];
}

async function writeFixture(path: string, opts: FixtureOpts): Promise<void> {
  const wb = new ExcelJS.Workbook();

  const noi = wb.addWorksheet('Property NOI');
  noi.addRow(['OXFORD REALTY ADVISORS — PROPERTY PORTFOLIO']);
  noi.addRow([
    1, PROPERTY_NAME, 'Industrial', 50000, 1, 0.9, new Date('2020-01-01'),
    1000000, 1, 1000000, 100000, 20000, 80000, 80000, 0, 80000, 0.08, null, null, 0,
  ]);

  const rr = wb.addWorksheet('Master Tenant Rent Roll');
  rr.addRow(['OXFORD REALTY ADVISORS  —  MASTER TENANT RENT ROLL']);
  if (opts.rentRollDateline !== undefined) {
    if (opts.rentRollDatelineAsFormula) {
      // Cached-formula shape, exactly as the real workbook stores the dateline. (Written via
      // addRow — the row-based API sets the same cell value as addressing A2 directly.)
      rr.addRow([
        {
          formula: '"As of " & TEXT(TODAY(),"mmmm d, yyyy")',
          result: opts.rentRollDateline,
        } as ExcelJS.CellValue,
      ]);
    } else {
      rr.addRow([opts.rentRollDateline]);
    }
  } else {
    rr.addRow([null]);
  }
  rr.addRow([
    PROPERTY_NAME, 'Fixture Tenant', 'A', 'Fixture Tenant',
    1000, 1000, 12, new Date('2022-01-01'), new Date('2027-01-01'), null, null, 'Active', 12000,
  ]);

  wb.addWorksheet('Loan Index');

  const cash = wb.addWorksheet('Cash Balances');
  cash.addRow(['OXFORD REALTY ADVISORS — ENTITY CASH BALANCE SUMMARY']);
  cash.addRow([opts.cashDateline ?? null]);

  wb.addWorksheet('Insurance Renewals');

  const tasks = wb.addWorksheet('Monthly Checklist');
  if (opts.taskCols) {
    const [dataMonthCol, otherMonthCol] = opts.taskCols;
    const row: unknown[] = [];
    row[0] = 'Fixture recurring task'; // label (col 1)
    row[3] = 'Recurring'; // type (col 4)
    row[4] = '15'; // dueDay (col 5)
    row[dataMonthCol - 1] = '✅'; // status in the WORKBOOK_AS_OF month column
    row[otherMonthCol - 1] = '⚠'; // status in the dateline-month column
    row[18] = 'Ops'; // section (col 19)
    row[19] = 'task-1'; // RowID (col 20)
    tasks.addRow(row);
  }

  const assumptions = wb.addWorksheet('Assumptions');
  assumptions.addRow(['OXFORD REALTY ADVISORS — MODEL ASSUMPTIONS & KEY INPUTS']);
  assumptions.addRow([opts.assumptionsDateline ?? null]);

  await wb.xlsx.writeFile(path);
}

function tmpFile(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), 'fixture.xlsx');
}

// ── (1) provenance labels read the workbook's own datelines ─────────────────────────────────────
describe('parseWorkbook — provenance asOf reads the workbook dateline, per sheet', () => {
  it('meta/cash/assumptions asOf come from their sheets, NOT WORKBOOK_AS_OF (the OI-023 mislabel)', async () => {
    const file = tmpFile('asof-dateline-');
    await writeFixture(file, {
      rentRollDateline: 'As of July 17, 2026   │   137 tenants   │   513,000 SF leased',
      cashDateline: 'As of July 10, 2026',
      assumptionsDateline: 'As of July 17, 2026   |   Change values in Column C only',
    });

    const { snapshot, flags } = await parseWorkbook(file);

    expect(snapshot.meta.asOf).toBe('2026-07-17');
    expect(snapshot.meta.asOf).not.toBe(WORKBOOK_AS_OF); // the defect: label pinned to the constant
    // Cash keeps its OWN (data-derived) dateline — July 10, not the rent roll's July 17.
    expect(snapshot.cash.asOf).toBe('2026-07-10');
    expect(snapshot.assumptions.asOf).toBe('2026-07-17');
    // Clean read → no provenance-degradation flags.
    expect(flags.filter((f) => f.field === 'asOf')).toHaveLength(0);
  });

  it('unwraps the cached formula result (the real workbook stores the dateline as a formula)', async () => {
    const file = tmpFile('asof-formula-');
    await writeFixture(file, {
      rentRollDateline: 'As of July 17, 2026   │   137 tenants',
      rentRollDatelineAsFormula: true,
    });

    const { snapshot } = await parseWorkbook(file);
    expect(snapshot.meta.asOf).toBe('2026-07-17');
  });

  it('cash/assumptions with no own dateline fall back to the rent-roll dateline, with a LOUD flag', async () => {
    const file = tmpFile('asof-cashfall-');
    await writeFixture(file, {
      rentRollDateline: 'As of July 17, 2026   │   137 tenants',
      // no cashDateline, no assumptionsDateline
    });

    const { snapshot, flags } = await parseWorkbook(file);

    expect(snapshot.meta.asOf).toBe('2026-07-17');
    expect(snapshot.cash.asOf).toBe('2026-07-17'); // rent-roll dateline, NOT WORKBOOK_AS_OF
    expect(snapshot.assumptions.asOf).toBe('2026-07-17');
    const asOfFlags = flags.filter((f) => f.field === 'asOf');
    expect(asOfFlags.map((f) => f.entity).sort()).toEqual(['assumptions', 'cash']);
    expect(asOfFlags.every((f) => f.severity === 'warn')).toBe(true);
  });

  it('no dateline anywhere → falls back to WORKBOOK_AS_OF and flags meta (never a silent pin)', async () => {
    const file = tmpFile('asof-none-');
    await writeFixture(file, {});

    const { snapshot, flags } = await parseWorkbook(file);

    expect(snapshot.meta.asOf).toBe(WORKBOOK_AS_OF);
    expect(snapshot.cash.asOf).toBe(WORKBOOK_AS_OF);
    expect(snapshot.assumptions.asOf).toBe(WORKBOOK_AS_OF);
    const metaFlag = flags.find((f) => f.entity === 'meta' && f.field === 'asOf');
    expect(metaFlag).toBeDefined();
    expect(metaFlag!.severity).toBe('warn');
    expect(metaFlag!.issue).toContain(WORKBOOK_AS_OF);
  });
});

// ── (2) the dateline must NOT leak into data-month selection (monthCol) ─────────────────────────
describe('parseWorkbook — monthCol stays on WORKBOOK_AS_OF even when the dateline differs', () => {
  it('reads task status from the WORKBOOK_AS_OF month column, not the dateline month', async () => {
    // WORKBOOK_AS_OF is June ('2026-06-01' default); the dateline says July. If the dateline
    // ever leaked into monthCol, status would read '⚠' (overdue) from the July column.
    const dataMonthCol = 7 + new Date(WORKBOOK_AS_OF).getUTCMonth();
    const datelineMonthCol = 7 + 6; // July (0-based month 6)
    expect(datelineMonthCol).not.toBe(dataMonthCol); // sanity — or this proves nothing

    const file = tmpFile('asof-monthcol-');
    await writeFixture(file, {
      rentRollDateline: 'As of July 17, 2026   │   137 tenants',
      taskCols: [dataMonthCol, datelineMonthCol],
    });

    const { snapshot } = await parseWorkbook(file);
    expect(snapshot.meta.asOf).toBe('2026-07-17'); // provenance moved…
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]!.status).toBe('done'); // …data-month selection did not
  });
});
