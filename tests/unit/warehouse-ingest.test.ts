// tests/unit/warehouse-ingest.test.ts
import ExcelJS from 'exceljs';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { approveImport } from '../../server/warehouse/actions';
import { openWarehouse } from '../../server/warehouse/db';
import { ingestFile } from '../../server/warehouse/ingest';
import { seedMappings } from '../../server/warehouse/mapping';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import { PARSER_VERSION } from '../../server/warehouse/parse/qb-excel';

async function writeFixture(path: string, statedTotals?: { income: number; expense: number }): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  const rows: Array<[string | null, string | null, string | null, number | null]> = [
    ['Profit & Loss', null, null, null],
    ['Property: 1100 Rarig Ave', null, null, null],
    ['01/01/25 - 12/31/25  (cash basis)', null, null, null],
    [null, 'INCOME', null, null],
    [null, null, '     5002 RENTAL INCOME', null],
    [null, null, '          5064 Rent', 100000],
    [null, 'EXPENSE', null, null],
    [null, null, '     6160 REPAIR', null],
    [null, null, '          6285 HVAC Repair', 5000],
    [null, 'NON OPERATING EXPENSE', null, null],
    [null, null, '          7402 Distribution to Owner', 25000],
  ];
  if (statedTotals) {
    rows.push(
      [null, 'TOTAL', null, null],
      [null, null, 'INCOME', statedTotals.income],
      [null, null, 'EXPENSE', statedTotals.expense],
    );
  }
  for (const r of rows) ws.addRow(r);
  await wb.xlsx.writeFile(path);
}

const SEED = [
  { account: 'Rent', code: '5064', normalized_category: 'Rental Revenue', classification: 'revenue' },
  { account: 'HVAC Repair', code: '6285', normalized_category: 'Repairs & Maintenance', classification: 'opex' },
  { account: 'Distribution to Owner', code: '7402', normalized_category: 'Distributions', classification: 'excluded' },
];

describe('ingest pipeline', () => {
  it('commits a confident file: versioned import, classified ledger, NOI excludes distributions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeFixture(file);

    const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });
    expect(r.status).toBe('committed');
    const ledger = db.prepare(
      "SELECT raw_account, classification, amount FROM ledger_entries WHERE is_active=1 ORDER BY raw_account",
    ).all() as Array<{ raw_account: string; classification: string; amount: number }>;
    expect(ledger).toHaveLength(3);

    // NOI from active NOI-class rows only: 100000 (revenue) - 5000 (opex) = 95000; distribution excluded.
    // The income literal here is INTENTIONALLY hardcoded (not NOI_INCOME_CLASSES) so this stays an
    // independent oracle on the contract-derived production paths — importing it would make it tautological.
    const noi = db.prepare(`
      SELECT SUM(CASE WHEN classification IN ('revenue','recovery','other-income') THEN amount
                      WHEN classification = 'opex' THEN -amount ELSE 0 END) AS noi
      FROM ledger_entries WHERE is_active = 1 AND property_id = '1100-rarig-ave-columbus-oh' AND period = '2025'
    `).get() as { noi: number };
    expect(noi.noi).toBe(95000);
  });

  it('re-import of a corrected file supersedes prior ledger rows (rollback-able, never deleted)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeFixture(file);
    await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });

    // corrected file: different bytes (regenerate with one changed amount)
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const ws = wb.worksheets[0]!;
    ws.getCell('D6').value = 110000; // Rent corrected
    await wb.xlsx.writeFile(file);

    const r2 = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T01:00:00Z' });
    expect(r2.status).toBe('committed');
    expect(r2.version).toBe(2);

    const active = db.prepare("SELECT COUNT(*) AS c FROM ledger_entries WHERE is_active=1").get() as { c: number };
    const inactive = db.prepare("SELECT COUNT(*) AS c FROM ledger_entries WHERE is_active=0").get() as { c: number };
    expect(active.c).toBe(3);
    expect(inactive.c).toBe(3); // v1 preserved, deactivated
    const v1 = db.prepare("SELECT status FROM import_batches WHERE version=1").get() as { status: string };
    expect(v1.status).toBe('superseded');
  });

  it('empty parse (zero valued accounts) is never auto-committed: pending-review + empty-parse DQ issue', async () => {
    // Regression: six real files (tips-sheet-first .xlsm + column-indented layouts)
    // parsed to ZERO accounts and were silently committed with no ledger rows.
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('QuickBooks Desktop Export Tips');
    ws.addRow(['QuickBooks Desktop Export Tips']);
    ws.addRow(['This worksheet contains tips for working with your exported report.']);
    await wb.xlsx.writeFile(file);

    const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });
    expect(r.status).toBe('pending-review');
    const batch = db.prepare('SELECT status FROM import_batches WHERE id = ?').get(r.importId) as { status: string };
    expect(batch.status).toBe('pending-review');
    expect((db.prepare('SELECT COUNT(*) AS c FROM ledger_entries').get() as { c: number }).c).toBe(0);
    const issues = db.prepare('SELECT kind, severity FROM data_quality_issues WHERE import_id = ?').all(r.importId) as Array<{ kind: string; severity: string }>;
    expect(issues.map((i) => i.kind)).toContain('empty-parse');
    expect(issues.find((i) => i.kind === 'empty-parse')!.severity).toBe('error');
  });

  it('foots report-stated totals against inserted side sums: matching totals → zero foot-mismatch rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    // stated totals match the leaves: income 100000; the bare-TOTAL EXPENSE row (30000)
    // is a FILE-level total stated AFTER both expense sections — its synthetic
    // "EXPENSE (file total)" section foots against HVAC 5000 + Distribution 25000
    // (NON OPERATING EXPENSE is expense-side; ALL classifications count — stated
    // totals include rows the engine later excludes from NOI)
    await writeFixture(file, { income: 100000, expense: 30000 });

    const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });
    expect(r.status).toBe('committed');
    const issues = db.prepare("SELECT kind FROM data_quality_issues WHERE kind = 'foot-mismatch'").all();
    expect(issues).toHaveLength(0);
  });

  it('stated total ≠ parsed side sum → foot-mismatch DQ warn rows, commit status unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    // stated income total wildly off (simulates a dropped income leaf / wrong value column)
    await writeFixture(file, { income: 999999, expense: 30000 });

    const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });
    expect(r.status).toBe('committed'); // choke point reports — it does NOT block commit
    const issues = db.prepare(
      "SELECT kind, severity, detail FROM data_quality_issues WHERE import_id = ? AND kind = 'foot-mismatch' ORDER BY id",
    ).all(r.importId) as Array<{ kind: string; severity: string; detail: string }>;
    // both choke points fire: the income SIDE foot and the INCOME (file total) SECTION foot
    expect(issues).toHaveLength(2);
    for (const i of issues) {
      expect(i.severity).toBe('warn');
      expect(i.detail).toContain('999999');
      expect(i.detail).toContain('100000');
    }
    expect(issues.some((i) => i.detail.includes('INCOME (file total)'))).toBe(true);
  });

  it('expense section foot: stated 999 vs scoped leaves 30000 → exactly one foot-mismatch naming the section', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeFixture(file, { income: 100000, expense: 999 });

    const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });
    expect(r.status).toBe('committed');
    const issues = db.prepare(
      "SELECT severity, detail FROM data_quality_issues WHERE import_id = ? AND kind = 'foot-mismatch'",
    ).all(r.importId) as Array<{ severity: string; detail: string }>;
    expect(issues).toHaveLength(1); // income foots clean — only the expense section fires
    expect(issues[0]!.severity).toBe('warn');
    expect(issues[0]!.detail).toContain('EXPENSE (file total)');
    expect(issues[0]!.detail).toContain('999');
    expect(issues[0]!.detail).toContain('30000');
  });

  it('absolute values neutralize display sign conventions: stated -30000 vs positive scoped leaves 30000 → no mismatch', async () => {
    // QB/Rent-Manager summary blocks display expense totals NEGATIVE against positive
    // leaves (Rarig 2024: the stated total is the exact negation of the EXPENSE leaf sum)
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeFixture(file, { income: 100000, expense: -30000 });

    const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });
    expect(r.status).toBe('committed');
    const issues = db.prepare("SELECT kind FROM data_quality_issues WHERE kind = 'foot-mismatch'").all();
    expect(issues).toHaveLength(0);
  });

  it('unmapped accounts flag data quality and downgrade to pending-review', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED.slice(0, 1)); // only Rent mapped
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeFixture(file);
    const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });
    expect(r.status).toBe('pending-review');
    const issues = db.prepare("SELECT kind FROM data_quality_issues").all() as Array<{ kind: string }>;
    expect(issues.map((i) => i.kind)).toContain('unmapped-account');
  });
});

  it('normalizes negative-expense sign convention (9620-style charts): costs stored positive, contra refunds negative, NOI subtracts costs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, [
      { account: 'Rental Income', code: null, normalized_category: 'Rental Revenue', classification: 'revenue' },
      { account: 'INSURANCE EXPENSE', code: null, normalized_category: 'Insurance', classification: 'opex' },
      { account: 'MANAGEMENT FEE EXPENSE', code: null, normalized_category: 'Management Fees', classification: 'opex' },
      { account: 'Property Taxes', code: null, normalized_category: 'Taxes', classification: 'opex' },
    ]);
    // Peak REP / 9620-style QB export: expense rows booked as NEGATIVE outflows;
    // a positive value on the expense side is a contra (tax refund).
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    const rows: Array<[string | null, string | null, string | null, number | null]> = [
      ['Profit & Loss', null, null, null],
      ['Property: 350 Highway Center', null, null, null],
      ['01/01/25 - 12/31/25  (cash basis)', null, null, null],
      [null, 'INCOME', null, null],
      [null, null, '          Rental Income', 100000],
      [null, 'EXPENSE', null, null],
      [null, null, '          INSURANCE EXPENSE', -30000],
      [null, null, '          MANAGEMENT FEE EXPENSE', -10000],
      [null, null, '          Property Taxes', 5000],
      // stated total row in the SAME negative display convention as the leaves:
      // |-35000| vs |-30000 - 10000 + 5000| — the section foots in PARSE space,
      // independent of the sign-normalization applied to ledger rows below
      [null, null, '          Total Expense', -35000],
    ];
    for (const r of rows) ws.addRow(r);
    const file = join(dir, 'P&L 2025 -- 9620 State 350.xlsx');
    await wb.xlsx.writeFile(file);

    const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });
    expect(r.status).toBe('committed');

    const byName = new Map(
      (db.prepare("SELECT raw_account, amount FROM ledger_entries WHERE is_active=1").all() as Array<{ raw_account: string; amount: number }>)
        .map((x) => [x.raw_account, x.amount]),
    );
    expect(byName.get('Rental Income')).toBe(100000); // income side untouched (positive majority)
    expect(byName.get('INSURANCE EXPENSE')).toBe(30000); // flipped to positive cost
    expect(byName.get('MANAGEMENT FEE EXPENSE')).toBe(10000);
    expect(byName.get('Property Taxes')).toBe(-5000); // contra refund inverts with the side

    // Income literal INTENTIONALLY hardcoded — independent oracle on the contract-derived paths (see above).
    const noi = db.prepare(`
      SELECT SUM(CASE WHEN classification IN ('revenue','recovery','other-income') THEN amount
                      WHEN classification = 'opex' THEN -amount ELSE 0 END) AS noi
      FROM ledger_entries WHERE is_active = 1
    `).get() as { noi: number };
    expect(noi.noi).toBe(65000); // 100000 - (30000 + 10000 - 5000)

    const dq = db.prepare("SELECT kind, severity FROM data_quality_issues WHERE kind='sign-normalized'").all();
    expect(dq).toHaveLength(1); // normalization is recorded, never silent

    // 9620-style negative-leaf foot: stated -35000 vs scoped leaf sum -35000 → clean
    const foot = db.prepare("SELECT detail FROM data_quality_issues WHERE kind='foot-mismatch'").all();
    expect(foot).toHaveLength(0);
  });

describe('sign-flip is section-scoped, not account-scoped (defect class: OI-355 / cc-audit-army 2026-09-28)', () => {
  it('does not flip real opex when a large NEGATIVE trailing row sits under a lingering CLOSED section (Yardi financing rows)', async () => {
    // Bug: the old flip decision summed every account.total tagged with a matching
    // sectionSide, including trailing rows that stayed tagged with a section AFTER its
    // own "TOTAL OPERATING EXPENSES" row closed it (Yardi exports commonly trail a
    // refinance/mortgage-payoff row here — see warehouse-qb-excel.test.ts's
    // "trailing account under a lingering section" fixture). A single large negative
    // trailing row (-500000) could push that raw sum negative even though the section's
    // own leaves (Insurance +12000) are genuinely positive-convention — flipping real
    // opex to the wrong sign.
    // Fixed: the flip now sums each real section's signed leafSum (statedTotal is
    // display-signed and synthetic "(file total)" sections are restatements — both excluded),
    // which drops trailing rows past a section's own Total row.
    const dir = mkdtempSync(join(tmpdir(), 'wh-trailing-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, [
      { account: 'Rental Revenue', code: null, normalized_category: 'Rental Revenue', classification: 'revenue' },
      { account: 'Insurance Expense', code: null, normalized_category: 'Insurance', classification: 'opex' },
      { account: 'Mortgage Interest', code: null, normalized_category: 'Debt Service', classification: 'excluded' },
    ]);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Report1');
    const rows: Array<[string | null, string | null, string | null, number | null]> = [
      ['Profit & Loss', null, null, null],
      ['Property: 9620 State 350', null, null, null],
      ['01/01/25 - 12/31/25  (accrual basis)', null, null, null],
      [null, 'REVENUE', null, null],
      [null, null, '    Rental Revenue', 333333.3],
      [null, 'OPERATING EXPENSES', null, null],
      [null, null, '    Insurance Expense', 12000],
      [null, null, ' TOTAL OPERATING EXPENSES', 12000], // closes the section: statedTotal=12000
      // trailing row: still tagged section='OPERATING EXPENSES' (no new header), but the
      // section is already CLOSED — a real Yardi refinance/payoff row, large and negative.
      [null, null, '    Mortgage Interest', -500000],
    ];
    for (const r of rows) ws.addRow(r);
    const file = join(dir, 'P&L 2025 -- 9620 State 350.xlsx');
    await wb.xlsx.writeFile(file);

    const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-09-28T00:00:00Z' });
    expect(r.status).toBe('committed');

    const byName = new Map(
      (db.prepare('SELECT raw_account, amount FROM ledger_entries WHERE is_active=1').all() as Array<{ raw_account: string; amount: number }>)
        .map((x) => [x.raw_account, x.amount]),
    );
    // Insurance must stay positive: the section itself is positive-convention, and the
    // flip decision must not be swayed by the trailing financing row outside its scope.
    expect(byName.get('Insurance Expense')).toBe(12000);
    expect(byName.get('Mortgage Interest')).toBe(-500000); // trailing row itself is untouched

    const dq = db.prepare("SELECT kind FROM data_quality_issues WHERE kind='sign-normalized'").all();
    expect(dq).toHaveLength(0); // no flip should have been applied at all

    const noi = (db.prepare(`
      SELECT SUM(CASE WHEN classification IN ('revenue','recovery','other-income') THEN amount
                      WHEN classification = 'opex' THEN -amount ELSE 0 END) AS noi
      FROM ledger_entries WHERE is_active = 1
    `).get() as { noi: number }).noi;
    expect(noi).toBe(321333.3); // 333333.3 - 12000; the -500000 financing row is 'excluded', not opex
  });

  // refute-financial-change wf_e7c0dd32-4ae: the sign decision must come from booked LEAF values,
  // never from a stated total's DISPLAY sign, and never from the synthetic "(file total)" restatement.
  const SIGN_SEED = [
    { account: 'Rent', code: null, normalized_category: 'Rental Revenue', classification: 'revenue' },
    { account: 'HVAC Repair', code: null, normalized_category: 'Repairs & Maintenance', classification: 'opex' },
    { account: 'Insurance Expense', code: null, normalized_category: 'Insurance', classification: 'opex' },
    { account: 'Distribution to Owner', code: null, normalized_category: 'Distributions', classification: 'excluded' },
  ];
  type Row = [string | null, string | null, string | null, number | null];
  async function ingestRows(rows: Row[]) {
    const dir = mkdtempSync(join(tmpdir(), 'wh-signscope-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SIGN_SEED);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    const head: Row[] = [
      ['Profit & Loss', null, null, null],
      ['Property: 1100 Rarig Ave', null, null, null],
      ['01/01/25 - 12/31/25  (cash basis)', null, null, null],
    ];
    for (const r of [...head, ...rows]) ws.addRow(r);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await wb.xlsx.writeFile(file);
    const res = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-09-28T00:00:00Z' });
    const amt = new Map(
      (db.prepare('SELECT raw_account, amount FROM ledger_entries WHERE is_active=1').all() as Array<{ raw_account: string; amount: number }>)
        .map((x) => [x.raw_account, x.amount]),
    );
    const flips = db.prepare("SELECT 1 FROM data_quality_issues WHERE kind='sign-normalized'").all().length;
    return { res, amt, flips };
  }

  it('does NOT flip positive opex leaves under a display-NEGATIVE in-section "Total Expense" (QB/Rent-Manager display convention)', async () => {
    const { amt, flips } = await ingestRows([
      [null, 'INCOME', null, null],
      [null, null, '          Rent', 100000],
      [null, 'EXPENSE', null, null],
      [null, null, '          Insurance Expense', 30000],
      [null, null, '          HVAC Repair', 10000],
      [null, null, '          Total Expense', -40000], // display sign, independent of leaf booking
    ]);
    expect(amt.get('Insurance Expense')).toBe(30000);
    expect(amt.get('HVAC Repair')).toBe(10000);
    expect(flips).toBe(0);
  });

  it('a stated total a cent off in the negative direction does not flip positive leaves (no cancellation artefact)', async () => {
    const { amt, flips } = await ingestRows([
      [null, 'INCOME', null, null],
      [null, null, '          Rent', 100000],
      [null, 'EXPENSE', null, null],
      [null, null, '          HVAC Repair', 30000],
      [null, null, '          Total Expense', -30000.01],
    ]);
    expect(amt.get('HVAC Repair')).toBe(30000);
    expect(flips).toBe(0);
  });

  it('STILL flips genuinely negative-booked leaves even when the stated total is displayed POSITIVE', async () => {
    const { amt, flips } = await ingestRows([
      [null, 'INCOME', null, null],
      [null, null, '          Rent', 100000],
      [null, 'EXPENSE', null, null],
      [null, null, '          Insurance Expense', -30000],
      [null, null, '          HVAC Repair', -10000],
      [null, null, '          Total Expense', 40000],
    ]);
    expect(amt.get('Insurance Expense')).toBe(30000);
    expect(amt.get('HVAC Repair')).toBe(10000);
    expect(flips).toBe(1);
  });

  it('warns (never silent) when the section closes before any leaf and the tagged accounts are materially negative', async () => {
    // Section closed by a stray zero Total before its leaves: section-scoped sum is 0 (undecidable)
    // while the tagged accounts net -40000. HEAD's raw sum would have flipped; we cannot tell, so we
    // say so instead of silently committing an unflipped side.
    const dir = mkdtempSync(join(tmpdir(), 'wh-undecidable-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SIGN_SEED);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    const rows: Row[] = [
      ['Profit & Loss', null, null, null],
      ['Property: 1100 Rarig Ave', null, null, null],
      ['01/01/25 - 12/31/25  (cash basis)', null, null, null],
      [null, 'INCOME', null, null],
      [null, null, '          Rent', 100000],
      [null, 'EXPENSE', null, null],
      [null, null, '          Total Expense', 0],
      [null, null, '          Insurance Expense', -30000],
      [null, null, '          HVAC Repair', -10000],
    ];
    for (const r of rows) ws.addRow(r);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await wb.xlsx.writeFile(file);
    await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-09-28T00:00:00Z' });
    const und = db.prepare("SELECT severity FROM data_quality_issues WHERE kind='sign-undecidable'").all() as Array<{ severity: string }>;
    expect(und).toHaveLength(1);
    expect(und[0]!.severity).toBe('warn');
    // Fail closed (audit ingest-sign-undecidable-still-commits): an undecidable sign side must NOT
    // auto-commit — a committed, unflipped negative-booked side would silently serve inflated NOI.
    const batch = db.prepare('SELECT status FROM import_batches').get() as { status: string };
    expect(batch.status).toBe('pending-review');
    const active = db.prepare('SELECT COUNT(*) AS n FROM ledger_entries WHERE is_active = 1').get() as { n: number };
    expect(active.n).toBe(0);
  });

  it('a stale re-derive of an already-committed import that is now sign-undecidable keeps the prior committed ledger', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-undecidable-rederive-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SIGN_SEED);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    const rows: Row[] = [
      ['Profit & Loss', null, null, null],
      ['Property: 1100 Rarig Ave', null, null, null],
      ['01/01/25 - 12/31/25  (cash basis)', null, null, null],
      [null, 'INCOME', null, null],
      [null, null, '          Rent', 100000],
      [null, 'EXPENSE', null, null],
      [null, null, '          Total Expense', 0],
      [null, null, '          Insurance Expense', -30000],
      [null, null, '          HVAC Repair', -10000],
    ];
    for (const r of rows) ws.addRow(r);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await wb.xlsx.writeFile(file);
    const r1 = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-09-28T00:00:00Z' });
    const importId = r1.importId!;
    // Simulate a batch that auto-committed BEFORE the fail-closed rule: committed, stale parser, rows active.
    db.prepare("UPDATE import_batches SET status = 'committed', parser_version = 0 WHERE id = ?").run(importId);
    db.prepare('UPDATE ledger_entries SET is_active = 1 WHERE import_id = ?').run(importId);

    const r2 = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-09-28T02:00:00Z' });
    expect(r2.status).toBe('committed');
    expect(r2.reason).toBe('restale-skipped');
    const batch = db.prepare('SELECT status, parser_version FROM import_batches WHERE id = ?').get(importId) as { status: string; parser_version: number };
    expect(batch.status).toBe('committed');
    expect(batch.parser_version).toBe(0); // rolled back => stays stale, so a later fixed parser re-attempts
    // the skip is surfaced WITH its real cause (the rollback erases the in-tx sign-undecidable row)
    const skip = db.prepare("SELECT detail FROM data_quality_issues WHERE import_id = ? AND kind = 'restale-skipped'").all(importId) as Array<{ detail: string }>;
    expect(skip).toHaveLength(1);
    expect(skip[0]!.detail).toContain('sign-undecidable:');
    expect((db.prepare('SELECT COUNT(*) c FROM ledger_entries WHERE import_id = ? AND is_active = 1').get(importId) as { c: number }).c).toBe(3);
  });

  it('bare display-negative TOTAL|EXPENSE block does not cancel the real EXPENSE section and hand the decision to a NON OPERATING tail', async () => {
    const { amt, flips } = await ingestRows([
      [null, 'INCOME', null, null],
      [null, null, '          Rent', 100000],
      [null, 'EXPENSE', null, null],
      [null, null, '          HVAC Repair', 5000],
      [null, 'NON OPERATING EXPENSE', null, null],
      [null, null, '          Distribution to Owner', -3000],
      [null, 'TOTAL', null, null],
      [null, null, 'INCOME', 100000],
      [null, null, 'EXPENSE', -5000], // synthetic "EXPENSE (file total)" carries this display sign
    ]);
    expect(amt.get('HVAC Repair')).toBe(5000);
    expect(amt.get('Distribution to Owner')).toBe(-3000);
    expect(flips).toBe(0);
  });
});

describe('parser-version re-ingest (self-healing backfill)', () => {
  it('re-derives a committed import IN PLACE when its parser_version is stale — no manual delete', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeFixture(file);

    const r1 = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });
    expect(r1.status).toBe('committed');
    const importId = r1.importId!;
    // new imports are stamped with the current parser version
    expect((db.prepare('SELECT parser_version FROM import_batches WHERE id = ?').get(importId) as { parser_version: number }).parser_version)
      .toBe(PARSER_VERSION);

    // Simulate this row was produced by an OLDER parser that left the basis stale.
    db.prepare("UPDATE import_batches SET parser_version = 0, basis = 'unknown' WHERE id = ?").run(importId);
    const ledgerIdsBefore = (db.prepare('SELECT id FROM ledger_entries WHERE import_id = ?').all(importId) as Array<{ id: number }>).map((x) => x.id);

    // Re-ingest the byte-IDENTICAL file (hash matches): old behavior would skip as 'duplicate'.
    const r2 = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T02:00:00Z' });

    expect(r2.status).not.toBe('duplicate');     // re-derived, not skipped
    expect(r2.importId).toBe(importId);           // SAME row — in-place (importId / history preserved)
    const batch = db.prepare('SELECT basis, parser_version, status FROM import_batches WHERE id = ?').get(importId) as { basis: string; parser_version: number; status: string };
    expect(batch.basis).toBe('cash');             // basis re-derived from the file (was staled to 'unknown')
    expect(batch.parser_version).toBe(PARSER_VERSION); // stamped current
    expect(batch.status).toBe('committed');
    // ledger REPLACED (old rows gone, fresh rows), still exactly the 3 active rows; one import row for this hash
    const ledgerIdsAfter = (db.prepare('SELECT id FROM ledger_entries WHERE import_id = ?').all(importId) as Array<{ id: number }>).map((x) => x.id);
    expect(ledgerIdsAfter.some((id) => ledgerIdsBefore.includes(id))).toBe(false); // rows truly replaced, not appended
    expect((db.prepare('SELECT COUNT(*) c FROM ledger_entries WHERE import_id = ? AND is_active = 1').get(importId) as { c: number }).c).toBe(3);
    expect((db.prepare('SELECT COUNT(*) c FROM import_batches').get() as { c: number }).c).toBe(1);
  });

  it('keeps the fast duplicate path when parser_version is already current', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeFixture(file);
    await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });

    // re-ingest the identical file WITHOUT staling the version → fast dedup, no re-derive
    const r2 = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T02:00:00Z' });
    expect(r2.status).toBe('duplicate');
  });

  it('a stale re-derive that no longer qualifies for commit PRESERVES the prior committed version (never empties a served period)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeFixture(file);
    const r1 = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });
    expect(r1.status).toBe('committed');
    const importId = r1.importId!;

    // stale the committed row, then sabotage so the re-derive FAILS the commit gate (drop all
    // mappings ⇒ every account unmapped ⇒ commit predicate false). The re-derive must NOT empty
    // the served period — it must abort and keep the prior committed ledger active.
    db.prepare('UPDATE import_batches SET parser_version = 0 WHERE id = ?').run(importId);
    db.prepare('DELETE FROM account_mappings').run();

    const r2 = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T02:00:00Z' });
    // prior committed version is retained (NOT downgraded, NOT emptied)
    expect(r2.status).toBe('committed');
    const batch = db.prepare('SELECT status, parser_version FROM import_batches WHERE id = ?').get(importId) as { status: string; parser_version: number };
    expect(batch.status).toBe('committed');
    expect(batch.parser_version).toBe(0); // re-derive rolled back ⇒ version stays stale (consistent with retained data)
    expect((db.prepare('SELECT COUNT(*) c FROM ledger_entries WHERE import_id = ? AND is_active = 1').get(importId) as { c: number }).c).toBe(3);
    // the skip is surfaced (deduped) for attention
    const skip = db.prepare("SELECT severity FROM data_quality_issues WHERE import_id = ? AND kind = 'restale-skipped'").all(importId) as Array<{ severity: string }>;
    expect(skip).toHaveLength(1);
    expect(skip[0]!.severity).toBe('warn');
  });

  it('does NOT resurrect a superseded row — a stale superseded import stays superseded (skipped)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const fileA = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeFixture(fileA);
    const r1 = await ingestFile(db, fileA, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });
    const v1Id = r1.importId!;

    // keep a byte-identical copy of v1's content BEFORE correcting fileA
    const dirB = mkdtempSync(join(tmpdir(), 'wh-b-'));
    const fileB = join(dirB, 'P&L 2025 -- 1100 Rarig.xlsx');
    // Byte-copy v1's exact bytes (fileA pre-mutation) rather than regenerating via writeFixture:
    // ExcelJS embeds a created/modified timestamp, so two writes in different clock-seconds differ →
    // a regenerated "identical" file occasionally hashes differently → flaky 'committed' vs 'duplicate'.
    copyFileSync(fileA, fileB); // byte-identical to v1 ⇒ same content hash (deterministic)

    // corrected re-import supersedes v1
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(fileA);
    wb.worksheets[0]!.getCell('D6').value = 110000;
    await wb.xlsx.writeFile(fileA);
    await ingestFile(db, fileA, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T01:00:00Z' });
    expect((db.prepare('SELECT status FROM import_batches WHERE id = ?').get(v1Id) as { status: string }).status).toBe('superseded');

    // stale the SUPERSEDED v1, then re-present its exact bytes (fileB) — guard must NOT re-derive it
    db.prepare('UPDATE import_batches SET parser_version = 0 WHERE id = ?').run(v1Id);
    const r3 = await ingestFile(db, fileB, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T03:00:00Z' });
    expect(r3.status).toBe('duplicate'); // superseded rows are historical — never resurrected
    expect((db.prepare('SELECT status FROM import_batches WHERE id = ?').get(v1Id) as { status: string }).status).toBe('superseded');
  });

  it('a stale re-derive of an OLDER pending-review version must NOT auto-commit over a NEWER committed version (it stays pending, flagged stale-version)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const fileA = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeFixture(fileA);
    mkdirSync(join(dir, 'older'));
    const fileB = join(dir, 'older', 'P&L 2025 -- 1100 Rarig.xlsx'); // same P&L filename, other directory
    copyFileSync(fileA, fileB); // fileB keeps v1's exact bytes (fileA is edited below)
    // v1 held in review (high threshold), then a corrected export commits as v2
    const r1 = await ingestFile(db, fileA, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z', autoCommitThreshold: 0.99 });
    expect(r1.status).toBe('pending-review');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(fileA);
    wb.worksheets[0]!.getCell('D6').value = 110000;
    await wb.xlsx.writeFile(fileA);
    const r2 = await ingestFile(db, fileA, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T01:00:00Z' });
    expect(r2.status).toBe('committed');
    expect(r2.version).toBe(2);

    // parser bumps: v1 (pending) is stale and re-presented at a normal threshold, where it would qualify to commit
    db.prepare('UPDATE import_batches SET parser_version = 0 WHERE id = ?').run(r1.importId);
    const r3 = await ingestFile(db, fileB, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T03:00:00Z' });
    expect(r3.importId).toBe(r1.importId); // re-derived in place
    expect(r3.status).toBe('pending-review'); // NOT committed
    expect(db.prepare('SELECT status FROM import_batches WHERE id = ?').get(r2.importId)).toMatchObject({ status: 'committed' });
    expect(db.prepare('SELECT status FROM import_batches WHERE id = ?').get(r1.importId)).toMatchObject({ status: 'pending-review' });
    expect((db.prepare('SELECT COUNT(*) c FROM ledger_entries WHERE import_id = ? AND is_active = 1').get(r2.importId) as { c: number }).c).toBe(3);
    expect((db.prepare('SELECT COUNT(*) c FROM ledger_entries WHERE import_id = ? AND is_active = 1').get(r1.importId) as { c: number }).c).toBe(0);
    const flagged = db.prepare("SELECT severity, detail FROM data_quality_issues WHERE import_id = ? AND kind = 'stale-version' AND status = 'open'").all(r1.importId) as Array<{ severity: string; detail: string }>;
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.severity).toBe('warn');
    expect(flagged[0]!.detail).toContain('v2');
  });

  // refute wf_6ab6dbee-770: `version` is numbered per (property, period) at REGISTRATION, but a stale re-derive can rewrite
  // a row's period/property in place while keeping that number. Comparing versions then crosses two counters, so ARRIVAL
  // ORDER (id) is the ordering key, and the guard must use the same property/period key the supersede uses.
  async function periodMovedScenario(olderVersionAfterMove: number) {
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const fileA = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeFixture(fileA);
    mkdirSync(join(dir, 'older'));
    const fileOlder = join(dir, 'older', 'P&L 2025 -- 1100 Rarig.xlsx');
    copyFileSync(fileA, fileOlder); // the OLDER export's exact bytes
    const older = await ingestFile(db, fileOlder, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z', autoCommitThreshold: 0.99 });
    expect(older.status).toBe('pending-review');
    // simulate an older parser that stored a different period_end and a version numbered in THAT bucket
    db.prepare('UPDATE import_batches SET period_end = NULL, version = ?, parser_version = 0 WHERE id = ?').run(olderVersionAfterMove, older.importId);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(fileA);
    wb.worksheets[0]!.getCell('D6').value = 110000; // corrected export => the NEWER arrival
    await wb.xlsx.writeFile(fileA);
    const newer = await ingestFile(db, fileA, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T01:00:00Z' });
    expect(newer.status).toBe('committed'); // full-year bucket was empty => v1, commits
    expect(newer.version).toBe(1);
    return { db, dir, fileOlder, olderId: older.importId!, newerId: newer.importId! };
  }

  for (const [label, v] of [['TIED version (both v1)', 1], ['INVERTED version (older carries v3)', 3]] as const) {
    it(`a stale re-derive that MOVES the period (${label}) must not let older data supersede the newer committed import`, async () => {
      const { db, dir, fileOlder, olderId, newerId } = await periodMovedScenario(v);
      const r = await ingestFile(db, fileOlder, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T03:00:00Z' });
      expect(r.importId).toBe(olderId); // re-derived in place, now in the full-year bucket
      expect(r.status).toBe('pending-review'); // NOT committed
      expect(db.prepare('SELECT status FROM import_batches WHERE id = ?').get(newerId)).toMatchObject({ status: 'committed' });
      expect(db.prepare('SELECT status FROM import_batches WHERE id = ?').get(olderId)).toMatchObject({ status: 'pending-review' });
      expect((db.prepare('SELECT COUNT(*) c FROM ledger_entries WHERE import_id = ? AND is_active = 1').get(newerId) as { c: number }).c).toBe(3);
      expect((db.prepare("SELECT COUNT(*) c FROM data_quality_issues WHERE import_id = ? AND kind = 'stale-version' AND status = 'open'").get(olderId) as { c: number }).c).toBe(1);
      // the approve path must agree (same ordering key), whatever the version numbers say
      const refusal = approveImport(db, olderId);
      expect(refusal.ok).toBe(false);
      if (!refusal.ok) expect(refusal.reason).toBe('newer-version-committed');
      expect(db.prepare('SELECT status FROM import_batches WHERE id = ?').get(newerId)).toMatchObject({ status: 'committed' });
    });
  }

  it('the guard keys on the property the supersede uses (detected), not the stored property: a NULL-stored-property stale row cannot supersede', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const fileA = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeFixture(fileA);
    mkdirSync(join(dir, 'older'));
    const fileOlder = join(dir, 'older', 'P&L 2025 -- 1100 Rarig.xlsx');
    copyFileSync(fileA, fileOlder);
    const older = await ingestFile(db, fileOlder, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z', autoCommitThreshold: 0.99 });
    expect(older.status).toBe('pending-review');
    db.prepare('UPDATE import_batches SET property_id = NULL, parser_version = 0 WHERE id = ?').run(older.importId);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(fileA);
    wb.worksheets[0]!.getCell('D6').value = 110000;
    await wb.xlsx.writeFile(fileA);
    const newer = await ingestFile(db, fileA, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T01:00:00Z' });
    expect(newer.status).toBe('committed');
    const r = await ingestFile(db, fileOlder, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T03:00:00Z' });
    expect(r.importId).toBe(older.importId);
    expect(r.status).toBe('pending-review'); // detected property = Rarig => the newer committed import is in its key
    expect(db.prepare('SELECT status FROM import_batches WHERE id = ?').get(newer.importId)).toMatchObject({ status: 'committed' });
  });

  it('a stale re-derive of the NEWEST pending version still commits and supersedes the older committed one (no regression)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const fileA = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeFixture(fileA);
    const r1 = await ingestFile(db, fileA, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });
    expect(r1.status).toBe('committed');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(fileA);
    wb.worksheets[0]!.getCell('D6').value = 110000;
    await wb.xlsx.writeFile(fileA);
    mkdirSync(join(dir, 'newer'));
    const fileB = join(dir, 'newer', 'P&L 2025 -- 1100 Rarig.xlsx');
    copyFileSync(fileA, fileB);
    const r2 = await ingestFile(db, fileA, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T01:00:00Z', autoCommitThreshold: 0.99 });
    expect(r2.status).toBe('pending-review'); // v2 held; v1 still committed
    db.prepare('UPDATE import_batches SET parser_version = 0 WHERE id = ?').run(r2.importId);
    const r3 = await ingestFile(db, fileB, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T03:00:00Z' });
    expect(r3.importId).toBe(r2.importId);
    expect(r3.status).toBe('committed'); // newest version: allowed to supersede
    expect(db.prepare('SELECT status FROM import_batches WHERE id = ?').get(r1.importId)).toMatchObject({ status: 'superseded' });
  });
});

// Audit 2026-11-08 ing2-restale-autocommit-no-property-gate (ING-2 on the ingest path). A stale-parser re-derive keeps
// the batch's STORED property_id but rebuilds every ledger row under the property DETECTED from the re-dropped filename.
// A byte-identical re-drop under another property's filename (or an alias change) therefore produced ledger rows keyed
// to a different property than the batch, and ingest auto-committed them: NOI moved to the wrong property while the
// supersede keyed on the detected one. #554 closed this on approve (property-unresolved / property-mismatch); ingest
// must apply the same gate and route to review (or keep the prior committed version) instead of committing.
describe('stale re-derive property gate (ING-2, ingest path)', () => {
  const RARIG = '1100-rarig-ave-columbus-oh';
  const WESTERVILLE = '3034-westerville-rd-columbus-oh';

  async function setup(threshold?: number) {
    const dir = mkdtempSync(join(tmpdir(), 'wh-ing2-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const fileRarig = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeFixture(fileRarig);
    mkdirSync(join(dir, 'redrop'));
    const fileOther = join(dir, 'redrop', 'P&L 2025 -- 3034 Westerville.xlsx');
    copyFileSync(fileRarig, fileOther); // byte-identical => same hash => restale of the Rarig batch
    const r1 = await ingestFile(db, fileRarig, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z', autoCommitThreshold: threshold });
    db.prepare('UPDATE import_batches SET parser_version = 0 WHERE id = ?').run(r1.importId);
    return { db, dir, fileOther, importId: r1.importId!, first: r1 };
  }

  it('pending-review batch re-derived under a different detected property stays pending-review, flagged property-mismatch; approve refuses', async () => {
    const { db, dir, fileOther, importId, first } = await setup(0.99);
    expect(first.status).toBe('pending-review');
    const r = await ingestFile(db, fileOther, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T03:00:00Z' });
    expect(r.importId).toBe(importId);
    expect(r.status).toBe('pending-review'); // NOT auto-committed under the wrong property
    expect(db.prepare('SELECT status, property_id FROM import_batches WHERE id = ?').get(importId)).toMatchObject({ status: 'pending-review', property_id: RARIG });
    expect((db.prepare('SELECT COUNT(*) c FROM ledger_entries WHERE import_id = ? AND is_active = 1').get(importId) as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) c FROM ledger_entries WHERE is_active = 1 AND property_id = ?").get(WESTERVILLE) as { c: number }).c).toBe(0);
    const dq = db.prepare("SELECT severity, detail FROM data_quality_issues WHERE import_id = ? AND kind = 'property-mismatch'").all(importId) as Array<{ severity: string; detail: string }>;
    expect(dq).toHaveLength(1);
    expect(dq[0]!.detail).toContain(WESTERVILLE);
    expect(dq[0]!.detail).toContain(RARIG);
    const refusal = approveImport(db, importId);
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) expect((refusal as { reason?: string }).reason).toBe('property-mismatch');
  });

  it('committed batch re-derived under a different detected property keeps the prior committed ledger (restale-skipped names the mismatch)', async () => {
    const { db, dir, fileOther, importId, first } = await setup();
    expect(first.status).toBe('committed');
    const r = await ingestFile(db, fileOther, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T03:00:00Z' });
    expect(r).toMatchObject({ importId, status: 'committed', reason: 'restale-skipped' });
    expect(db.prepare('SELECT status, parser_version FROM import_batches WHERE id = ?').get(importId)).toMatchObject({ status: 'committed', parser_version: 0 });
    // prior ledger retained, still keyed to the batch's own property; nothing served under the detected one
    expect((db.prepare('SELECT COUNT(*) c FROM ledger_entries WHERE import_id = ? AND is_active = 1 AND property_id = ?').get(importId, RARIG) as { c: number }).c).toBe(3);
    expect((db.prepare('SELECT COUNT(*) c FROM ledger_entries WHERE property_id = ?').get(WESTERVILLE) as { c: number }).c).toBe(0);
    const skip = db.prepare("SELECT detail FROM data_quality_issues WHERE import_id = ? AND kind = 'restale-skipped'").all(importId) as Array<{ detail: string }>;
    expect(skip).toHaveLength(1);
    expect(skip[0]!.detail).toContain('property-mismatch');
  });

  it('pending-review batch whose stored property is unresolved (NULL) is not auto-committed by a re-derive that now detects one', async () => {
    const { db, dir, importId } = await setup(0.99);
    db.prepare('UPDATE import_batches SET property_id = NULL WHERE id = ?').run(importId);
    const fileRarig = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    const r = await ingestFile(db, fileRarig, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T03:00:00Z' });
    expect(r.importId).toBe(importId);
    expect(r.status).toBe('pending-review');
    expect(db.prepare('SELECT status FROM import_batches WHERE id = ?').get(importId)).toMatchObject({ status: 'pending-review' });
    expect((db.prepare("SELECT COUNT(*) c FROM data_quality_issues WHERE import_id = ? AND kind = 'property-unresolved'").get(importId) as { c: number }).c).toBe(1);
    const refusal = approveImport(db, importId);
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) expect((refusal as { reason?: string }).reason).toBe('property-unresolved');
  });

  it('same-property re-derive still commits (no regression)', async () => {
    const { db, dir, importId } = await setup();
    const r = await ingestFile(db, join(dir, 'P&L 2025 -- 1100 Rarig.xlsx'), { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T03:00:00Z' });
    expect(r).toMatchObject({ importId, status: 'committed' });
    expect(r.reason).toBeUndefined();
    expect((db.prepare("SELECT COUNT(*) c FROM data_quality_issues WHERE import_id = ? AND kind IN ('property-mismatch','property-unresolved')").get(importId) as { c: number }).c).toBe(0);
  });
});

const MIXED_SIGN_SEED = [
  { account: 'Rent', code: null, normalized_category: 'Rental Revenue', classification: 'revenue' },
  { account: 'HVAC Repair', code: null, normalized_category: 'Repairs & Maintenance', classification: 'opex' },
  { account: 'Tax Accrual', code: null, normalized_category: 'Taxes', classification: 'opex' },
  { account: 'Insurance Accrual', code: null, normalized_category: 'Insurance', classification: 'opex' },
];

describe('sign-flip uses signed magnitude, not row count (defect class: 9620-NOI-inflation via mixed-sign expense section)', () => {
  it('flips the expense side when the signed leaf SUM is negative even if positive rows outnumber negative rows by count', async () => {
    // Bug: flip[sideKey] = neg > pos (row count) — 1 negative vs 2 positive rows → no flip
    // even though the signed sum is -5000+400+300 = -4300 (negative → SHOULD flip).
    // Without flip: ledger stores HVAC=-5000, TaxAcr=+400, InsAcr=+300.
    //   opex sum = -5000+400+300 = -4300 → NOI = 100000 - (-4300) = 104300 (inflated by 4300+4300=8600).
    // With correct flip: amounts negated → HVAC=+5000, TaxAcr=-400, InsAcr=-300.
    //   opex sum = 5000-400-300 = 4300 → NOI = 100000 - 4300 = 95700 (correct).
    const dir = mkdtempSync(join(tmpdir(), 'wh-mixsign-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, MIXED_SIGN_SEED);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    const rows: Array<[string | null, string | null, string | null, number | null]> = [
      ['Profit & Loss', null, null, null],
      ['Property: 1100 Rarig Ave', null, null, null],
      ['01/01/25 - 12/31/25  (cash basis)', null, null, null],
      [null, 'INCOME', null, null],
      [null, null, '          Rent', 100000],
      [null, 'EXPENSE', null, null],
      [null, null, '          HVAC Repair', -5000],      // negative (outflow convention) — the 1 negative
      [null, null, '          Tax Accrual', 400],         // positive contra/accrual — the 2 positives
      [null, null, '          Insurance Accrual', 300],   // positive contra/accrual
      // neg=1, pos=2 → count-based flip fires false; signed sum = -5000+400+300 = -4300 < 0 → should flip
    ];
    for (const r of rows) ws.addRow(r);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await wb.xlsx.writeFile(file);

    const result = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-13T00:00:00Z' });
    expect(result.status).toBe('committed');

    const byName = new Map(
      (db.prepare('SELECT raw_account, amount FROM ledger_entries WHERE is_active=1').all() as Array<{ raw_account: string; amount: number }>)
        .map((x) => [x.raw_account, x.amount]),
    );
    // After correct flip: HVAC stored positive (5000), contra rows negated (-400, -300)
    expect(byName.get('HVAC Repair')).toBe(5000);
    expect(byName.get('Tax Accrual')).toBe(-400);
    expect(byName.get('Insurance Accrual')).toBe(-300);

    const noi = (db.prepare(`
      SELECT SUM(CASE WHEN classification IN ('revenue','recovery','other-income') THEN amount
                      WHEN classification = 'opex' THEN -amount ELSE 0 END) AS noi
      FROM ledger_entries WHERE is_active = 1
    `).get() as { noi: number }).noi;
    expect(noi).toBe(95700); // 100000 - (5000-400-300) = 100000 - 4300 = 95700
  });
});
