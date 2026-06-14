// tests/unit/warehouse-actions.test.ts
import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addMappingOverride, approveImport, rejectImport, resolveIssue } from '../../server/warehouse/actions';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { ingestFile } from '../../server/warehouse/ingest';
import { seedMappings } from '../../server/warehouse/mapping';
import { seedPropertyMaster } from '../../server/warehouse/property-master';

// Local copy of the ingest-test fixture writer (tests never import across test files).
// propertyLine varies the bytes so two property files never collide on content hash.
async function writeFixture(path: string, propertyLine = 'Property: 1100 Rarig Ave'): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  const rows: Array<[string | null, string | null, string | null, number | null]> = [
    ['Profit & Loss', null, null, null],
    [propertyLine, null, null, null],
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
  for (const r of rows) ws.addRow(r);
  await wb.xlsx.writeFile(path);
}

const SEED = [
  { account: 'Rent', code: '5064', normalized_category: 'Rental Revenue', classification: 'revenue' },
  { account: 'HVAC Repair', code: '6285', normalized_category: 'Repairs & Maintenance', classification: 'opex' },
  { account: 'Distribution to Owner', code: '7402', normalized_category: 'Distributions', classification: 'excluded' },
];

// Dual-side utility seed: the real PFI seed carries "Gas" on BOTH the income side
// (tenant billback → CAM Recoveries/recovery) and the expense side (utility → Utilities/opex).
// Both survive seeding (deduped per account-key+side). accountKey() strips the GL prefix, so
// both seed under raw_account_key='gas'.
const DUAL_SIDE_SEED = [
  { account: 'Rent', code: '5064', normalized_category: 'Rental Revenue', classification: 'revenue' },
  // income-side Gas (tenant billback recovery) — an NOI-income contributor
  { account: 'Gas', code: '5034', normalized_category: 'CAM Recoveries', classification: 'recovery' },
  // expense-side Gas (utility opex) — an NOI-opex (subtracted) contributor
  { account: 'Gas', code: '6675', normalized_category: 'Utilities', classification: 'opex' },
];

// Fixture with an EXPENSE-section Gas row (utility opex). The income-side Gas mapping also
// exists in the seed, so on approve (no section hint) the expense row could re-resolve to the
// income/recovery mapping — flipping its NOI sign contribution. propertyLine varies the bytes.
async function writeDualSideFixture(path: string, propertyLine = 'Property: 1100 Rarig Ave'): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  const rows: Array<[string | null, string | null, string | null, number | null]> = [
    ['Profit & Loss', null, null, null],
    [propertyLine, null, null, null],
    ['01/01/25 - 12/31/25  (cash basis)', null, null, null],
    [null, 'INCOME', null, null],
    [null, null, '     5002 RENTAL INCOME', null],
    [null, null, '          5064 Rent', 100000],
    [null, 'EXPENSE', null, null],
    [null, null, '     6600 UTILITIES', null],
    [null, null, '          6675 Gas', 8000],
  ];
  for (const r of rows) ws.addRow(r);
  await wb.xlsx.writeFile(path);
}

/** Seed only 'Rent' → HVAC Repair + Distribution to Owner come back unmapped → pending-review, rows inactive. */
async function pendingWarehouse(): Promise<{ db: WarehouseDb; dir: string; importId: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'wha-'));
  const db = openWarehouse(join(dir, 'f.sqlite'));
  seedPropertyMaster(db);
  seedMappings(db, SEED.slice(0, 1));
  const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
  await writeFixture(file);
  const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });
  expect(r.status).toBe('pending-review');
  return { db, dir, importId: r.importId! };
}

describe('warehouse actions', () => {
  it('(a) approve refuses while unmapped rows remain: batch stays pending, rows stay inactive', async () => {
    const { db, importId } = await pendingWarehouse();
    const refusal = approveImport(db, importId);
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) expect(refusal.unmapped).toEqual(expect.arrayContaining(['HVAC Repair', 'Distribution to Owner']));
    expect(db.prepare('SELECT status FROM import_batches WHERE id=?').get(importId)).toMatchObject({ status: 'pending-review' });
    expect((db.prepare('SELECT COUNT(*) AS c FROM ledger_entries WHERE is_active=1').get() as { c: number }).c).toBe(0);
  });

  it('(b) overrides resolve the gap and approve re-resolves, activates rows, commits the batch', async () => {
    const { db, importId } = await pendingWarehouse();
    addMappingOverride(db, { account: 'HVAC Repair', normalizedCategory: 'Repairs & Maintenance', classification: 'opex' });
    addMappingOverride(db, { account: 'Distribution to Owner', normalizedCategory: 'Distributions', classification: 'excluded' });
    const ok = approveImport(db, importId);
    expect(ok.ok).toBe(true);

    // rows re-resolved, activated, batch committed
    const active = db.prepare(
      'SELECT raw_account, normalized_category, classification FROM ledger_entries WHERE is_active=1 ORDER BY raw_account',
    ).all() as Array<{ raw_account: string; normalized_category: string; classification: string }>;
    expect(active).toHaveLength(3);
    expect(active).toEqual([
      { raw_account: 'Distribution to Owner', normalized_category: 'Distributions', classification: 'excluded' },
      { raw_account: 'HVAC Repair', normalized_category: 'Repairs & Maintenance', classification: 'opex' },
      { raw_account: 'Rent', normalized_category: 'Rental Revenue', classification: 'revenue' },
    ]);
    expect(db.prepare('SELECT status FROM import_batches WHERE id=?').get(importId)).toMatchObject({ status: 'committed' });
  });

  it('(c) approving supersedes a prior committed version for the same period: v1 superseded + inactive, v2 active', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wha-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeFixture(file);
    const v1 = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });
    expect(v1.status).toBe('committed');

    // corrected file (different bytes); high threshold forces it through the review queue
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    wb.worksheets[0]!.getCell('D6').value = 110000; // Rent corrected
    await wb.xlsx.writeFile(file);
    const v2 = await ingestFile(db, file, {
      rawDir: join(dir, 'raw'), importedAt: '2026-06-12T01:00:00Z', autoCommitThreshold: 0.99,
    });
    expect(v2.status).toBe('pending-review');
    expect(v2.version).toBe(2);

    const ok = approveImport(db, v2.importId!);
    expect(ok.ok).toBe(true);
    expect(db.prepare('SELECT status, superseded_by FROM import_batches WHERE id=?').get(v1.importId))
      .toEqual({ status: 'superseded', superseded_by: v2.importId });
    expect(db.prepare('SELECT status FROM import_batches WHERE id=?').get(v2.importId)).toMatchObject({ status: 'committed' });
    const active = db.prepare('SELECT import_id, amount FROM ledger_entries WHERE is_active=1 ORDER BY raw_account')
      .all() as Array<{ import_id: number; amount: number }>;
    expect(active).toHaveLength(3);
    expect(active.every((r) => r.import_id === v2.importId)).toBe(true);
    expect(active.map((r) => r.amount)).toContain(110000);
    // v1 rows preserved, deactivated — never deleted
    expect((db.prepare('SELECT COUNT(*) AS c FROM ledger_entries WHERE is_active=0 AND import_id=?').get(v1.importId) as { c: number }).c).toBe(3);
  });

  it('(d) rejectImport: status rejected, rows stay inactive; approving a rejected import fails', async () => {
    const { db, importId } = await pendingWarehouse();
    const rej = rejectImport(db, importId);
    expect(rej.ok).toBe(true);
    expect(db.prepare('SELECT status FROM import_batches WHERE id=?').get(importId)).toMatchObject({ status: 'rejected' });
    expect((db.prepare('SELECT COUNT(*) AS c FROM ledger_entries WHERE import_id=?').get(importId) as { c: number }).c).toBe(3);
    expect((db.prepare('SELECT COUNT(*) AS c FROM ledger_entries WHERE import_id=? AND is_active=1').get(importId) as { c: number }).c).toBe(0);

    const refusal = approveImport(db, importId);
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) {
      expect(refusal.unmapped).toEqual([]);
      expect(refusal.error).toContain('rejected');
    }
    // rejecting twice also fails (no longer pending-review)
    const rej2 = rejectImport(db, importId);
    expect(rej2.ok).toBe(false);
  });

  it('(e) resolveIssue: open → resolved with resolved_at set; second resolve and unknown id fail', async () => {
    const { db, importId } = await pendingWarehouse();
    const issue = db.prepare(
      "SELECT id FROM data_quality_issues WHERE import_id=? AND kind='unmapped-account' ORDER BY id LIMIT 1",
    ).get(importId) as { id: number };

    const ok = resolveIssue(db, issue.id);
    expect(ok.ok).toBe(true);
    const row = db.prepare('SELECT status, resolved_at FROM data_quality_issues WHERE id=?').get(issue.id) as
      { status: string; resolved_at: string | null };
    expect(row.status).toBe('resolved');
    expect(row.resolved_at).not.toBeNull();

    expect(resolveIssue(db, issue.id).ok).toBe(false); // already resolved
    expect(resolveIssue(db, 999999).ok).toBe(false); // unknown id
  });

  it('(f) property-scoped override re-derives only matching ACTIVE rows of that property; others untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wha-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const rarig = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeFixture(rarig);
    const raytown = join(dir, 'P&L 2025 -- 9620 State 350.xlsx');
    await writeFixture(raytown, 'Property: 9620 E State Route 350');
    expect((await ingestFile(db, rarig, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' })).status).toBe('committed');
    expect((await ingestFile(db, raytown, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:01:00Z' })).status).toBe('committed');

    // '6285 hvac repair' exercises accountKey normalization (GL-code strip + lowercase)
    const res = addMappingOverride(db, {
      account: '6285 hvac repair',
      normalizedCategory: 'HVAC Capital',
      classification: 'capex',
      propertyId: '1100-rarig-ave-columbus-oh',
    });
    expect(res.rederived).toBe(1);
    expect(db.prepare('SELECT property_id, match_kind FROM account_mappings WHERE id=?').get(res.mappingId))
      .toEqual({ property_id: '1100-rarig-ave-columbus-oh', match_kind: 'manual' });

    const scoped = db.prepare(
      "SELECT normalized_category, classification, mapping_id FROM ledger_entries WHERE is_active=1 AND property_id='1100-rarig-ave-columbus-oh' AND raw_account='HVAC Repair'",
    ).get() as { normalized_category: string; classification: string; mapping_id: number };
    expect(scoped).toEqual({ normalized_category: 'HVAC Capital', classification: 'capex', mapping_id: res.mappingId });

    // the unrelated property's identical account is untouched
    const other = db.prepare(
      "SELECT normalized_category, classification FROM ledger_entries WHERE is_active=1 AND property_id='9620-e-state-route-350-raytown-mo' AND raw_account='HVAC Repair'",
    ).get() as { normalized_category: string; classification: string };
    expect(other).toEqual({ normalized_category: 'Repairs & Maintenance', classification: 'opex' });

    // non-matching accounts on the scoped property are untouched too
    const rent = db.prepare(
      "SELECT classification FROM ledger_entries WHERE is_active=1 AND property_id='1100-rarig-ave-columbus-oh' AND raw_account='Rent'",
    ).get() as { classification: string };
    expect(rent.classification).toBe('revenue');
  });

  it('(h) approve preserves the NOI sign of a dual-side account: expense Gas stays opex, never flips to income/recovery', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wha-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, DUAL_SIDE_SEED); // both income-side (recovery) and expense-side (opex) Gas
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeDualSideFixture(file);

    // high threshold forces the (fully-mapped) import into the review queue so approve runs
    const r = await ingestFile(db, file, {
      rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z', autoCommitThreshold: 0.99,
    });
    expect(r.status).toBe('pending-review');

    // ingest resolved the expense Gas via its source section → expense-side opex
    const beforeId = db.prepare("SELECT id FROM ledger_entries WHERE raw_account='Gas' AND import_id=?")
      .get(r.importId!) as { id: number };
    const before = db.prepare('SELECT classification, normalized_category, amount FROM ledger_entries WHERE id=?')
      .get(beforeId.id) as { classification: string; normalized_category: string; amount: number };
    expect(before).toMatchObject({ classification: 'opex', normalized_category: 'Utilities', amount: 8000 });

    const ok = approveImport(db, r.importId!);
    expect(ok.ok).toBe(true);

    // After approve the expense Gas row MUST still be opex — its NOI contribution is still a
    // subtraction, not an addition. A re-resolve to the income/recovery mapping would flip the
    // sign (recovery is an NOI income class) and silently overstate NOI.
    const after = db.prepare("SELECT classification, normalized_category FROM ledger_entries WHERE id=?")
      .get(beforeId.id) as { classification: string; normalized_category: string };
    expect(after.classification).toBe('opex'); // NOT 'recovery'
    expect(after.normalized_category).toBe('Utilities'); // NOT 'CAM Recoveries'
  });

  it('(i) approve honors a CROSS-SIDE manual reviewer override: expense-ingested Gas re-resolves to the manual income/recovery mapping', async () => {
    // Regression guard for the H3-fix side-effect: the sideHint constraint must bind only the
    // dual-side SEED tiebreak, never a deliberate human ruling. A reviewer who reclassifies an
    // expense-ingested Gas as a tenant billback (recovery, income side) via addMappingOverride
    // is exercising approve's documented purpose ("manual overrides added since ingest take
    // effect"). The override must WIN even though it sits on the opposite side from the row's
    // ingest-time classification — dropping it silently committed the stale opex classification.
    const dir = mkdtempSync(join(tmpdir(), 'wha-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, DUAL_SIDE_SEED); // both income-side (recovery) and expense-side (opex) Gas
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeDualSideFixture(file);

    const r = await ingestFile(db, file, {
      rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z', autoCommitThreshold: 0.99,
    });
    expect(r.status).toBe('pending-review');

    const gasId = (db.prepare("SELECT id FROM ledger_entries WHERE raw_account='Gas' AND import_id=?")
      .get(r.importId!) as { id: number }).id;
    // ingest pinned it expense-side (opex/Utilities) via the source EXPENSE section
    expect(db.prepare('SELECT classification, normalized_category FROM ledger_entries WHERE id=?').get(gasId))
      .toMatchObject({ classification: 'opex', normalized_category: 'Utilities' });

    // Reviewer reclassifies this Gas as an income-side tenant billback recovery — an explicit
    // cross-side ruling. Pending rows are is_active=0 so addMappingOverride does NOT touch them;
    // the override only takes effect through approve's re-resolution.
    const ov = addMappingOverride(db, { account: 'Gas', normalizedCategory: 'CAM Recoveries', classification: 'recovery' });
    expect(ov.rederived).toBe(0); // pending row is inactive — nothing re-derived in place

    const ok = approveImport(db, r.importId!);
    expect(ok.ok).toBe(true); // must commit — the account IS mapped (manually)

    // The reviewer's intent is preserved: the row commits as the manual income/recovery mapping.
    const after = db.prepare('SELECT classification, normalized_category, mapping_id FROM ledger_entries WHERE id=?')
      .get(gasId) as { classification: string; normalized_category: string; mapping_id: number };
    expect(after.classification).toBe('recovery'); // NOT the stale 'opex'
    expect(after.normalized_category).toBe('CAM Recoveries'); // NOT 'Utilities'
    expect(after.mapping_id).toBe(ov.mappingId); // bound to the manual override, not the seed
  });

  it('(g) approve refuses an empty (zero-row) import — never commits a period with no ledger rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wha-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('QuickBooks Desktop Export Tips');
    ws.addRow(['QuickBooks Desktop Export Tips']);
    await wb.xlsx.writeFile(file);
    const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });
    expect(r.status).toBe('pending-review');

    const refusal = approveImport(db, r.importId!);
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) expect(refusal.error).toContain('no ledger rows');
    expect(db.prepare('SELECT status FROM import_batches WHERE id=?').get(r.importId)).toMatchObject({ status: 'pending-review' });
  });
});
