import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { detectDelinquencyBucketed, parseDelinquencyBucketed } from '../../server/ar/delinquency-bucketed';

function sheet(rows: (string | number | null)[][]): ExcelJS.Worksheet {
  const ws = new ExcelJS.Workbook().addWorksheet('Sheet1');
  rows.forEach((r) => ws.addRow(r));
  return ws;
}

const HEADER = ['Unit', 'Amount Receivable', 'Last Payment', 'Payment Amount', 'Tenant Status', 'Move In', 'Move Out', 'Deposit', '0-30', '30+'];
const PREAMBLE = [['Delinquency'], ['Exported On: 07/15/2026 11:58 AM'], [], [], [], [], []];

describe('detectDelinquencyBucketed', () => {
  it('recognizes the bucketed Delinquency export', () => {
    expect(detectDelinquencyBucketed(sheet([...PREAMBLE, HEADER]))).toBe(true);
  });

  it('recognizes the export when the as-of line is rich text, not a plain string', () => {
    // Real-file defect (found probing 2203-2207 Northwood, 2026-08-16): ExcelJS returns a
    // multi-font-run cell (bold "Exported On: " + regular timestamp) as { richText: [...] }, not a
    // string. A first pass of this detector's text() used String(v), which stringifies that object
    // to "[object Object]" and silently fails to detect the file at all — not a wrong parse, a
    // total miss (0 tenants, no quarantine reason, looks like an empty inbox file).
    const ws = new ExcelJS.Workbook().addWorksheet('Sheet1');
    ws.addRow(['Delinquency']);
    ws.getRow(2).getCell(1).value = {
      richText: [{ text: 'Exported On: ' }, { text: '07/15/2026 11:58 AM' }],
    };
    expect(detectDelinquencyBucketed(ws)).toBe(true);
  });

  it('rejects Delinquency (Detail) — the titles share a prefix', () => {
    expect(detectDelinquencyBucketed(sheet([['Delinquency (Detail)'], ['All Properties']]))).toBe(false);
  });

  it('rejects a DB Caption export', () => {
    expect(detectDelinquencyBucketed(sheet([['DB Caption:  LIVE'], ['Property', 'Customer']]))).toBe(false);
  });
});

describe('parseDelinquencyBucketed', () => {
  it('parses unit rows under their property group header', () => {
    const ws = sheet([...PREAMBLE, HEADER,
      ['grp-a - 100 Example Dr', 'grp-a - 100 Example Dr'], // merge echoes text into col2, per the real file
      ['4A', 1205.5, null, 1200, 'Current', null, null, 999.99, 1205.5, 0],
      ['11-12A', 2047.5, null, 1925, 'Current', null, null, 1598, 2047.5, 0],
    ]);
    const rows = parseDelinquencyBucketed(ws);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ unit: '4A', property: 'grp-a - 100 Example Dr', d30: 1205.5, d30plus: 0 });
    expect(rows[1]?.unit).toBe('11-12A');
  });

  it('switches property on each new group header', () => {
    const ws = sheet([...PREAMBLE, HEADER,
      ['grp-a - 100 Example Dr', 'grp-a - 100 Example Dr'], // merge echoes text into col2, per the real file
      ['4A', 1205.5, null, 1200, 'Current', null, null, 999.99, 1205.5, 0],
      ['grp-b - 200 Example Dr', 'grp-b - 200 Example Dr'],
      ['01B', 1102.53, null, 955, 'Current', null, null, 799, 1102.5, 0.03],
    ]);
    const rows = parseDelinquencyBucketed(ws);
    expect(rows[1]?.property).toBe('grp-b - 200 Example Dr');
    expect(rows[1]?.d30plus).toBeCloseTo(0.03, 2);
  });

  it('skips per-property subtotal rows (blank Unit)', () => {
    const ws = sheet([...PREAMBLE, HEADER,
      ['grp-a - 100 Example Dr', 'grp-a - 100 Example Dr'], // merge echoes text into col2, per the real file
      ['4A', 1205.5, null, 1200, 'Current', null, null, 999.99, 1205.5, 0],
      [null, 4266.75, null, 3325, null, null, null, 3997.99, 4066.75, 200],
    ]);
    expect(parseDelinquencyBucketed(ws)).toHaveLength(1);
  });

  it('excludes the final Total row', () => {
    const ws = sheet([...PREAMBLE, HEADER,
      ['grp-a - 100 Example Dr', 'grp-a - 100 Example Dr'], // merge echoes text into col2, per the real file
      ['4A', 1205.5, null, 1200, 'Current', null, null, 999.99, 1205.5, 0],
      ['Total', 10094.37, null, 4910, null, null, null, 7693.99, 8549.69, 1544.68],
    ]);
    const rows = parseDelinquencyBucketed(ws);
    expect(rows).toHaveLength(1);
    expect(rows.some((r) => r.unit.toLowerCase() === 'total')).toBe(false);
  });

  it('clamps credit balances to zero', () => {
    const ws = sheet([...PREAMBLE, HEADER,
      ['grp-a - 100 Example Dr', 'grp-a - 100 Example Dr'], // merge echoes text into col2, per the real file
      ['9B', -398, null, 0, 'Current', null, null, 0, -398, 0],
    ]);
    expect(parseDelinquencyBucketed(ws)[0]?.d30).toBe(0);
  });

  it('does not mistake a merged property-header row for a unit row with a fabricated amount', () => {
    // Real-file defect class (found in Format C, reproduced here deliberately): ExcelJS echoes a
    // merged banner's text into EVERY column in the merge, including the Amount Receivable column —
    // so "is Amount Receivable populated" is NOT a valid header-vs-unit discriminator. The correct
    // signal is that the banner text is IDENTICAL across the unit and receivable columns; a real
    // unit row's Amount Receivable is always numeric and therefore never equals its own unit label.
    const banner = 'nbc-a - 2207 Nothwood Drive Bldg A Salisbury, MD 21801';
    const ws = sheet([...PREAMBLE, HEADER,
      [banner, banner, banner, banner, banner, banner, banner, banner, banner, banner],
      ['4A', 1205.5, null, 1200, 'Current', null, null, 999.99, 1205.5, 0],
    ]);
    const rows = parseDelinquencyBucketed(ws);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.property).toBe(banner);
    expect(rows[0]?.unit).toBe('4A');
  });
});
