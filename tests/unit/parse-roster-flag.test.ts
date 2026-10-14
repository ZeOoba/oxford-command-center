import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseWorkbook } from '../../server/workbook/parse';

// Wiring test: parseWorkbook must emit the aggregate roster flag when the roster is unavailable.
// (PR #457 adversarial review: deleting the push in parse.ts left every pure-function test green.)
const originalPath = process.env.CONFIDENTIAL_TERMS_PATH;
afterEach(() => {
  if (originalPath === undefined) delete process.env.CONFIDENTIAL_TERMS_PATH;
  else process.env.CONFIDENTIAL_TERMS_PATH = originalPath;
});

async function fixture(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'parse-roster-flag-'));
  const path = join(dir, 'f.xlsx');
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Property NOI').addRow([
    1, 'Fixture Prop', 'Industrial', 50000, 3, 0.92, new Date('2020-01-01'),
    5000000, 1, 5000000, 600000, 200000, 400000, 400000, 300000, 100000, 0.08, 1.3,
    'Fixture Bank', 3000000, 0.6, 100, 12, 1500000, 0.08, 5,
  ]);
  for (const n of ['Master Tenant Rent Roll', 'Loan Index', 'Cash Balances', 'Insurance Renewals', 'Monthly Checklist', 'Assumptions']) {
    wb.addWorksheet(n);
  }
  await wb.xlsx.writeFile(path);
  return path;
}

const isRosterFlag = (f: { entity: string; field: string }) => f.entity === 'deals' && f.field === 'confidential-roster';

describe('parseWorkbook — confidential-roster flag wiring', () => {
  it('emits the error flag when the roster is unreadable', async () => {
    const file = await fixture();
    process.env.CONFIDENTIAL_TERMS_PATH = join(tmpdir(), 'definitely-absent-roster.json');
    const { snapshot } = await parseWorkbook(file);
    const f = snapshot.dataQuality.filter(isRosterFlag);
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('error');
  });

  it('emits no roster flag when the (synthetic) roster is readable', async () => {
    const file = await fixture();
    const { snapshot } = await parseWorkbook(file);
    expect(snapshot.dataQuality.filter(isRosterFlag)).toHaveLength(0);
  });
});
