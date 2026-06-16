// tests/unit/warehouse-ingest.test.ts
import ExcelJS from 'exceljs';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
    // leaves (Rarig 2024: stated -125,539.93 vs EXPENSE leaves +125,539.93 exact)
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
