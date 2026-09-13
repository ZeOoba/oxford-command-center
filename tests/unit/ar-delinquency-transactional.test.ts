import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { detectDelinquencyTransactional, parseDelinquencyTransactional } from '../../server/ar/delinquency-transactional';

function sheet(rows: (string | number | Date | null)[][]): ExcelJS.Worksheet {
  const ws = new ExcelJS.Workbook().addWorksheet('Report1');
  rows.forEach((r) => ws.addRow(r));
  return ws;
}

const H = ['Property', 'Customer', 'Lease', 'Status', 'Tran#', 'Charge', 'Date', 'Month', 'Current'];
const AS_OF = new Date('2026-07-15T00:00:00Z');
const d = (s: string): Date => new Date(`${s}T00:00:00Z`);

describe('detectDelinquencyTransactional', () => {
  it('recognizes the DB Caption export', () => {
    expect(detectDelinquencyTransactional(sheet([['DB Caption:  LIVE   All Selected P'], H]))).toBe(true);
  });

  it('rejects Format A and Format B so detectors cannot collide', () => {
    expect(detectDelinquencyTransactional(sheet([['Delinquency (Detail)']]))).toBe(false);
    expect(detectDelinquencyTransactional(sheet([['Delinquency'], ['Exported On: 07/15/2026']]))).toBe(false);
  });
});

describe('parseDelinquencyTransactional', () => {
  it('ages each charge into the right bucket relative to as-of', () => {
    const ws = sheet([
      ['DB Caption:  LIVE'], H, [null, null, null, null, null, 'Code', null, null, 'Owed'],
      ['prop1', null, 'Acme LLC', 'Current', 'R-1', 'Rent', d('2026-07-01'), '07/2026', 100],
      ['prop1', null, 'Acme LLC', 'Current', 'R-2', 'Rent', d('2026-06-01'), '06/2026', 200],
      ['prop1', null, 'Acme LLC', 'Current', 'R-3', 'Rent', d('2026-05-01'), '05/2026', 400],
      ['prop1', null, 'Acme LLC', 'Current', 'R-4', 'Rent', d('2026-01-01'), '01/2026', 800],
    ]);
    const rows = parseDelinquencyTransactional(ws, AS_OF);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant: 'Acme LLC', property: 'prop1', d30: 100, d60: 200, d90: 400, d90plus: 800 });
  });

  it('skips subtotal rows (blank Property) so balances are not doubled', () => {
    const ws = sheet([
      ['DB Caption:  LIVE'], H, [null, null, null, null, null, 'Code', null, null, 'Owed'],
      ['prop1', null, 'Acme LLC', 'Current', 'R-1', 'Rent', d('2026-07-01'), '07/2026', 100],
      [null, null, 'Acme LLC', null, null, null, null, null, 100],
    ]);
    const rows = parseDelinquencyTransactional(ws, AS_OF);
    expect(rows[0]?.d30).toBe(100);
  });

  it('treats an undated charge as oldest, never as current', () => {
    const ws = sheet([
      ['DB Caption:  LIVE'], H, [null, null, null, null, null, 'Code', null, null, 'Owed'],
      ['prop1', null, 'No Date Co', 'Current', 'R-7', 'Rent', null, '', 300],
    ]);
    const rows = parseDelinquencyTransactional(ws, AS_OF);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.d30).toBe(0);
    expect(rows[0]?.d90plus).toBe(300);
  });

  it('clamps a net credit to zero and drops tenants netting to nothing', () => {
    const ws = sheet([
      ['DB Caption:  LIVE'], H, [null, null, null, null, null, 'Code', null, null, 'Owed'],
      ['prop1', null, 'Prepay Co', 'Current', 'R-9', 'Prepay', d('2026-07-01'), '07/2026', -500],
      ['prop1', null, 'Even Steven', 'Current', 'R-8', 'Rent', d('2026-07-01'), '07/2026', 0],
    ]);
    expect(parseDelinquencyTransactional(ws, AS_OF)).toHaveLength(0);
  });

  it('reads a prepayment carried ONLY in the Pre-payments column (col 14, Current Owed=0) instead of dropping it', () => {
    // Real-file shape (29000 Info Lane, verified 2026-08-17): every prepayment row in the actual
    // export has 0 in the Current Owed column (9) and the credit amount ONLY in Pre-payments (14).
    // The old code read column 9 alone, so `if (owed === 0) continue` silently dropped every
    // credit before the clamp logic ever ran, making the documented offset dead code.
    const H14 = [...H, null, null, null, null, null]; // pad to col 14 (Pre-payments)
    const ws = sheet([
      ['DB Caption:  LIVE'], H14,
      [null, null, null, null, null, 'Code', null, null, 'Owed', null, null, null, null, 'payments'],
      ['prop1', null, 'Credit Co', 'Current', 'R-9', 'Prepay', d('2026-07-01'), '07/2026', 0, null, null, null, null, -500],
    ]);
    expect(parseDelinquencyTransactional(ws, AS_OF)).toHaveLength(0);
  });

  it('REGRESSION (refute-pass finding): a fully-offset tenant with cent-denominated amounts is dropped, not kept as a phantom $0.00 row from float residue', () => {
    // Pooling/applying credits across buckets via repeated float subtraction can leave a bucket at
    // a sub-cent positive residue (e.g. 3.55e-15) instead of exact 0. Without cent-rounding, the
    // keep-filter (sum > 0) would retain this tenant as delinquent despite owing nothing.
    const oldest = new Date(AS_OF.getTime() - 100 * 86_400_000);
    const older = new Date(AS_OF.getTime() - 65 * 86_400_000);
    const recentCredit = new Date(AS_OF.getTime() - 5 * 86_400_000);
    const ws = sheet([
      ['DB Caption:  LIVE'],
      [...H, null, null, null, null, null],
      [null, null, null, null, null, 'Code', null, null, 'Owed', null, null, null, null, 'payments'],
      ['prop1', null, 'Paid Off LLC', 'Current', 'R-1', 'Rent', oldest, '', 0.01],
      ['prop1', null, 'Paid Off LLC', 'Current', 'R-2', 'Rent', older, '', 16.26],
      ['prop1', null, 'Paid Off LLC', 'Current', 'R-3', 'Prepay', recentCredit, '', 0, null, null, null, null, -16.27],
    ]);
    expect(parseDelinquencyTransactional(ws, AS_OF)).toHaveLength(0);
  });

  it('nets a recent prepayment against an OLD charge instead of clamping each independently and overstating the balance', () => {
    // Real-file shape: a charge 100 days old (-> d90plus) and a credit dated near as-of (-> d30,
    // via col 14) for the SAME tenant. Old behavior clamped d30 to 0 (discarding the credit) while
    // leaving d90plus's full charge intact, overstating delinquency by the whole credit amount and
    // able to fire a false CRITICAL on a tenant who owes far less than reported.
    const oldCharge = new Date(AS_OF.getTime() - 100 * 86_400_000);
    const recentCredit = new Date(AS_OF.getTime() - 5 * 86_400_000);
    const ws = sheet([
      ['DB Caption:  LIVE'],
      [...H, null, null, null, null, null],
      [null, null, null, null, null, 'Code', null, null, 'Owed', null, null, null, null, 'payments'],
      ['prop1', null, 'Partial Payer LLC', 'Current', 'R-1', 'Rent', oldCharge, '', 1000],
      ['prop1', null, 'Partial Payer LLC', 'Current', 'R-2', 'Prepay', recentCredit, '', 0, null, null, null, null, -400],
    ]);
    const rows = parseDelinquencyTransactional(ws, AS_OF);
    expect(rows).toHaveLength(1);
    // Net owed is $600, applied against the OLDEST bucket first (d90plus), not left inflated at
    // $1000 with the credit silently discarded in d30.
    expect(rows[0]).toMatchObject({ tenant: 'Partial Payer LLC', d30: 0, d60: 0, d90: 0, d90plus: 600 });
  });

  it('skips a merged banner row where ExcelJS echoes one string into every column', () => {
    // Real-file defect (found probing 29000 Info Lane, 2026-08-16): a merged property/tenant-name
    // banner row makes ExcelJS report the SAME text for Property, Lease, and Current Owed on that
    // row. parseFloat then greedily reads a leading digit run out of an address string ("29000
    // Information Lane...") as a plausible-looking dollar amount, fabricating a $29,000 "tenant".
    const ws = sheet([
      ['DB Caption:  LIVE'], H, [null, null, null, null, null, 'Code', null, null, 'Owed'],
      ['29000 Information Lane (29000inf)', '29000 Information Lane (29000inf)', '29000 Information Lane (29000inf)', null, null, null, '29000 Information Lane (29000inf)', null, '29000 Information Lane (29000inf)'],
      ['prop1', null, 'Real Tenant Co', 'Current', 'R-1', 'Rent', d('2026-07-01'), '07/2026', 100],
    ]);
    const rows = parseDelinquencyTransactional(ws, AS_OF);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenant).toBe('Real Tenant Co');
  });

  it('aggregates multiple charges for one tenant into a single row', () => {
    const ws = sheet([
      ['DB Caption:  LIVE'], H, [null, null, null, null, null, 'Code', null, null, 'Owed'],
      ['prop1', null, 'Multi Co', 'Current', 'R-1', 'Rent', d('2026-07-01'), '07/2026', 100],
      ['prop1', null, 'Multi Co', 'Current', 'R-2', 'CAM', d('2026-07-05'), '07/2026', 50],
    ]);
    const rows = parseDelinquencyTransactional(ws, AS_OF);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.d30).toBe(150);
  });
});
