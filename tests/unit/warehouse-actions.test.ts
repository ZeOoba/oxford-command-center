// tests/unit/warehouse-actions.test.ts
import ExcelJS from 'exceljs';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addMappingOverride, approveImport, rejectImport, resolveIssue } from '../../server/warehouse/actions';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { PROPERTY_ALIASES } from '../../server/warehouse/detect';
import { ingestFile } from '../../server/warehouse/ingest';
import { seedMappings } from '../../server/warehouse/mapping';
import { propertyPeriodMetrics } from '../../server/warehouse/metrics';
import { onboardProperty } from '../../server/warehouse/property-onboarding';
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

// Fixture with Gas on BOTH income and expense sides: an income-section tenant billback (→ recovery,
// an NOI-income contributor) AND an expense-section utility (→ opex, an NOI-subtraction). Both leaves
// strip to raw_account_key='gas', so after commit there are TWO active Gas rows whose accountKey()
// collides — the exact dual-side shape a side-blind manual override can sign-flip. propertyLine varies
// the bytes so two property files never collide on content hash.
async function writeBothSidesGasFixture(path: string, propertyLine = 'Property: 1100 Rarig Ave'): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  const rows: Array<[string | null, string | null, string | null, number | null]> = [
    ['Profit & Loss', null, null, null],
    [propertyLine, null, null, null],
    ['01/01/25 - 12/31/25  (cash basis)', null, null, null],
    [null, 'INCOME', null, null],
    [null, null, '     5002 RENTAL INCOME', null],
    [null, null, '          5064 Rent', 100000],
    [null, null, '     5030 TENANT RECOVERIES', null],
    [null, null, '          5034 Gas', 3000],
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

  it('(i) approve honors a PROPERTY-SCOPED cross-side manual reviewer override: expense-ingested Gas re-resolves to the scoped manual income/recovery mapping', async () => {
    // A PROPERTY-SCOPED manual override is a targeted, deliberate human ruling for THAT property and
    // must WIN even on the opposite side from the row's ingest-time classification — a reviewer who
    // reclassifies a specific property's expense-ingested Gas as a tenant billback (recovery, income)
    // is exercising approve's documented purpose ("manual overrides added since ingest take effect").
    // (A GLOBAL override would instead be side-constrained — see (m); that is the harmonized policy
    // that keeps approve consistent with addMappingOverride's in-place re-derive.)
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

    // Reviewer reclassifies THIS property's Gas as an income-side tenant billback recovery — an
    // explicit, property-scoped cross-side ruling. Pending rows are is_active=0 so addMappingOverride
    // does NOT touch them; the override only takes effect through approve's re-resolution.
    const ov = addMappingOverride(db, { account: 'Gas', normalizedCategory: 'CAM Recoveries', classification: 'recovery', propertyId: '1100-rarig-ave-columbus-oh' });
    expect(ov.rederived).toBe(0); // pending row is inactive — nothing re-derived in place

    const ok = approveImport(db, r.importId!);
    expect(ok.ok).toBe(true); // must commit — the account IS mapped (manually)

    // The reviewer's intent is preserved: the row commits as the manual income/recovery mapping.
    const after = db.prepare('SELECT classification, normalized_category, mapping_id FROM ledger_entries WHERE id=?')
      .get(gasId) as { classification: string; normalized_category: string; mapping_id: number };
    expect(after.classification).toBe('recovery'); // NOT the stale 'opex'
    expect(after.normalized_category).toBe('CAM Recoveries'); // NOT 'Utilities'
    expect(after.mapping_id).toBe(ov.mappingId); // bound to the manual override, not the seed

    // NOI reflects the deliberate cross-side flip in MAGNITUDE, not just the class string: Gas's 8,000
    // moved from a −8,000 opex contribution to a +8,000 income contribution → revenue 108,000, opex 0,
    // NOI 108,000 (it would be 92,000 had the row stayed opex). Catches an amount/sign mutant.
    const noi = propertyPeriodMetrics(db).find((m) => m.propertyId === '1100-rarig-ave-columbus-oh' && m.period === '2025')!;
    expect(noi.noi).toBe(108000);
  });

  it('(m) approve SIDE-CONSTRAINS a GLOBAL cross-side manual override: an expense-ingested Gas is NOT flipped to the global income/recovery override', async () => {
    // Harmonized policy / finding-4 closure: a GLOBAL manual override (no propertyId) is a portfolio-
    // wide default and must NOT silently flip a row to the opposite NOI side on approve — it behaves
    // like a seed under the row's sideHint. Same side-constraint addMappingOverride applies in place
    // (test (j)), so the two code paths AGREE for a global override (no path-dependent NOI drift).
    const dir = mkdtempSync(join(tmpdir(), 'wha-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, DUAL_SIDE_SEED);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeDualSideFixture(file);
    const r = await ingestFile(db, file, {
      rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z', autoCommitThreshold: 0.99,
    });
    expect(r.status).toBe('pending-review');
    const gasId = (db.prepare("SELECT id FROM ledger_entries WHERE raw_account='Gas' AND import_id=?")
      .get(r.importId!) as { id: number }).id;

    // GLOBAL override (no propertyId) declaring Gas → income/recovery.
    addMappingOverride(db, { account: 'Gas', normalizedCategory: 'CAM Recoveries', classification: 'recovery' });

    const ok = approveImport(db, r.importId!);
    expect(ok.ok).toBe(true); // commits — the expense seed still maps it (side-constrained)

    // The expense Gas row stays opex/Utilities (its own side), NOT flipped to the cross-side override.
    const after = db.prepare('SELECT classification, normalized_category FROM ledger_entries WHERE id=?')
      .get(gasId) as { classification: string; normalized_category: string };
    expect(after.classification).toBe('opex'); // NOT 'recovery' — NOI sign preserved
    expect(after.normalized_category).toBe('Utilities'); // NOT 'CAM Recoveries'
  });

  it('(n) a PROPERTY-SCOPED override re-derives BOTH sides of a dual-side account for that property (targeted cross-side ruling), consistent with approve', async () => {
    // Scoped counterpart to (j): a property-scoped override is a deliberate targeted ruling, so it
    // re-derives EVERY matching active row of that property regardless of side — the SAME semantics
    // resolveMapping applies for a scoped manual on approve (a global override stays side-constrained).
    const dir = mkdtempSync(join(tmpdir(), 'wha-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, DUAL_SIDE_SEED);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeBothSidesGasFixture(file);
    expect((await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' })).status).toBe('committed');

    const ov = addMappingOverride(db, { account: 'Gas', normalizedCategory: 'Utilities', classification: 'opex', propertyId: '1100-rarig-ave-columbus-oh' });
    expect(ov.rederived).toBe(2); // BOTH sides — a scoped ruling is not side-constrained

    const sides = (db.prepare("SELECT classification FROM ledger_entries WHERE raw_account='Gas' AND is_active=1")
      .all() as Array<{ classification: string }>).map((r) => r.classification);
    expect(sides).toEqual(['opex', 'opex']);

    // NOI reflects the deliberate scoped flip in MAGNITUDE: the income-side recovery (+3,000) became
    // opex (−3,000), dropping NOI from 95,000 to 89,000 (revenue 100,000 − opex 11,000). A scoped
    // ruling MAY invert a sign — but only for its own property, and identically across both paths.
    const noi = propertyPeriodMetrics(db).find((m) => m.propertyId === '1100-rarig-ave-columbus-oh' && m.period === '2025')!;
    expect(noi.noi).toBe(89000);
  });

  it('(j) addMappingOverride preserves the NOI sign of a dual-side account: an opex override on Gas re-derives only the active expense-side row, leaving the active income-side recovery row intact', async () => {
    // Same class as the H3 approve bug, in addMappingOverride. With two ACTIVE Gas rows sharing
    // raw_account_key 'gas' — one income-side recovery (NOI-positive), one expense-side opex
    // (NOI-negative) — a side-blind manual {account:'Gas', classification:'opex'} override would
    // re-derive BOTH (rederived:2), flipping the recovery row to opex and inverting its NOI sign
    // contribution (income adds, opex subtracts). The override must bind ONLY the same-side row.
    const dir = mkdtempSync(join(tmpdir(), 'wha-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, DUAL_SIDE_SEED); // Gas as BOTH income-side recovery AND expense-side opex
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeBothSidesGasFixture(file);

    // default threshold → fully-mapped statement auto-commits, so both Gas rows are ACTIVE
    const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });
    expect(r.status).toBe('committed');
    const pid = '1100-rarig-ave-columbus-oh';

    // Precondition: ingest pinned each Gas row to its source side — income→recovery, expense→opex.
    const incomeGas = db.prepare(
      "SELECT id, classification, normalized_category FROM ledger_entries WHERE raw_account='Gas' AND is_active=1 AND classification='recovery'",
    ).get() as { id: number; classification: string; normalized_category: string } | undefined;
    const expenseGas = db.prepare(
      "SELECT id FROM ledger_entries WHERE raw_account='Gas' AND is_active=1 AND classification='opex'",
    ).get() as { id: number } | undefined;
    expect(incomeGas).toBeTruthy();
    expect(expenseGas).toBeTruthy();
    expect(incomeGas!.normalized_category).toBe('CAM Recoveries');

    // NOI before any override: revenue (Rent 100k + Gas recovery 3k) − opex (Gas utility 8k) = 95k.
    const noiBefore = propertyPeriodMetrics(db).find((m) => m.propertyId === pid && m.period === '2025')!;
    expect(noiBefore.noi).toBe(95000);

    // A reviewer maps Gas → Utilities/opex (an EXPENSE-side ruling). It must re-derive ONLY the
    // expense-side opex row, never the income-side recovery row.
    const ov = addMappingOverride(db, { account: 'Gas', normalizedCategory: 'Utilities', classification: 'opex' });
    expect(ov.rederived).toBe(1); // ONLY the expense-side row — NOT both

    // The income-side recovery row is untouched: still recovery / CAM Recoveries, still its own seed
    // mapping (not the manual override), its NOI sign still a positive contribution.
    const incomeAfter = db.prepare(
      'SELECT classification, normalized_category, mapping_id FROM ledger_entries WHERE id=?',
    ).get(incomeGas!.id) as { classification: string; normalized_category: string; mapping_id: number };
    expect(incomeAfter.classification).toBe('recovery'); // NOT 'opex' — sign NOT inverted
    expect(incomeAfter.normalized_category).toBe('CAM Recoveries');
    expect(incomeAfter.mapping_id).not.toBe(ov.mappingId);

    // The expense-side row IS bound to the manual override (legitimate same-side re-derive).
    const expenseAfter = db.prepare(
      'SELECT classification, normalized_category, mapping_id FROM ledger_entries WHERE id=?',
    ).get(expenseGas!.id) as { classification: string; normalized_category: string; mapping_id: number };
    expect(expenseAfter).toMatchObject({ classification: 'opex', normalized_category: 'Utilities', mapping_id: ov.mappingId });

    // NOI is unchanged — the recovery's +3,000 still adds; a sign flip would have dropped NOI to 89,000.
    const noiAfter = propertyPeriodMetrics(db).find((m) => m.propertyId === pid && m.period === '2025')!;
    expect(noiAfter.noi).toBe(95000);
  });

  it("(k) an 'either'-side override (excluded) carries NO side constraint: it re-derives BOTH active Gas rows", async () => {
    // Guard against over-constraining the (j) fix. 'excluded' (and any unknown class) is side-agnostic
    // — classificationSide returns 'either' — so a reviewer mapping Gas → excluded means "drop ALL Gas
    // from NOI," and the override must re-derive both the income-side recovery row and the expense-side
    // opex row (rederived:2), exactly as the unconstrained pre-fix code did for a single-side account.
    const dir = mkdtempSync(join(tmpdir(), 'wha-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, DUAL_SIDE_SEED);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeBothSidesGasFixture(file);
    expect((await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' })).status).toBe('committed');

    const ov = addMappingOverride(db, { account: 'Gas', normalizedCategory: 'Intercompany', classification: 'excluded' });
    expect(ov.rederived).toBe(2); // both sides — 'either' imposes no constraint

    const gasRows = db.prepare(
      "SELECT classification FROM ledger_entries WHERE raw_account='Gas' AND is_active=1",
    ).all() as Array<{ classification: string }>;
    expect(gasRows).toHaveLength(2);
    expect(gasRows.every((r) => r.classification === 'excluded')).toBe(true);
  });

  it('(l) rejects an invalid classification — a typo cannot silently degrade to an unconstrained (no side-guard) override', async () => {
    // The side guard derives the override side from classificationSide(input.classification); an
    // unrecognized class returns 'either' → NO constraint → the override would touch BOTH sides of a
    // dual-side account again (the exact failure (j) prevents). Validate the class up front so a typo
    // fails closed instead of silently re-opening the NOI-sign flip. No DB rows are written on reject.
    const dir = mkdtempSync(join(tmpdir(), 'wha-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, DUAL_SIDE_SEED);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeBothSidesGasFixture(file);
    expect((await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' })).status).toBe('committed');

    const mappingsBefore = (db.prepare('SELECT COUNT(*) AS c FROM account_mappings').get() as { c: number }).c;
    expect(() => addMappingOverride(db, { account: 'Gas', normalizedCategory: 'Utilities', classification: 'frobnicate' }))
      .toThrow();
    // failed closed: no mapping row leaked, both Gas rows untouched (still recovery + opex)
    expect((db.prepare('SELECT COUNT(*) AS c FROM account_mappings').get() as { c: number }).c).toBe(mappingsBefore);
    const sides = (db.prepare("SELECT classification FROM ledger_entries WHERE raw_account='Gas' AND is_active=1 ORDER BY classification")
      .all() as Array<{ classification: string }>).map((r) => r.classification);
    expect(sides).toEqual(['opex', 'recovery']);
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

  describe('older-version supersede guard', () => {
    // v1 is held in review (high auto-commit threshold), a corrected export v2 of the SAME period then commits
    // on its own. Approving v1 would supersede v2 and serve older data.
    async function v1PendingV2Committed(): Promise<{ db: WarehouseDb; v1: number; v2: number }> {
      const dir = mkdtempSync(join(tmpdir(), 'wha-sup-'));
      const db = openWarehouse(join(dir, 'f.sqlite'));
      seedPropertyMaster(db);
      seedMappings(db, SEED);
      const fileA = join(dir, 'a');
      const fileB = join(dir, 'b');
      mkdirSync(fileA);
      mkdirSync(fileB);
      const pathA = join(fileA, 'P&L 2025 -- 1100 Rarig.xlsx');
      const pathB = join(fileB, 'P&L 2025 -- 1100 Rarig.xlsx');
      await writeFixture(pathA);
      await writeFixture(pathB);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(pathB);
      wb.worksheets[0]!.getCell('D6').value = 110000; // corrected Rent => different bytes, same period
      await wb.xlsx.writeFile(pathB);
      const r1 = await ingestFile(db, pathA, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z', autoCommitThreshold: 0.99 });
      expect(r1.status).toBe('pending-review');
      const r2 = await ingestFile(db, pathB, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T01:00:00Z' });
      expect(r2.status).toBe('committed');
      expect(r2.version).toBe(2);
      return { db, v1: r1.importId!, v2: r2.importId! };
    }
    const activeFor = (db: WarehouseDb, id: number) =>
      (db.prepare('SELECT COUNT(*) AS c FROM ledger_entries WHERE import_id=? AND is_active=1').get(id) as { c: number }).c;

    it('(s) approving an OLDER pending version is refused while a newer version is committed: v2 keeps serving, v1 stays pending', async () => {
      const { db, v1, v2 } = await v1PendingV2Committed();
      const refusal = approveImport(db, v1);
      expect(refusal.ok).toBe(false);
      if (!refusal.ok) {
        expect(refusal.reason).toBe('newer-version-committed');
        expect(refusal.unmapped).toEqual([]);
        expect(refusal.error).toContain('v2');
      }
      expect(db.prepare('SELECT status FROM import_batches WHERE id=?').get(v2)).toMatchObject({ status: 'committed' });
      expect(db.prepare('SELECT status FROM import_batches WHERE id=?').get(v1)).toMatchObject({ status: 'pending-review' });
      expect(activeFor(db, v2)).toBe(3);
      expect(activeFor(db, v1)).toBe(0);
    });

    it('(t) the stale older version can still be rejected', async () => {
      const { db, v1 } = await v1PendingV2Committed();
      expect(rejectImport(db, v1).ok).toBe(true);
      expect(db.prepare('SELECT status FROM import_batches WHERE id=?').get(v1)).toMatchObject({ status: 'rejected' });
    });

    it('(v) versions of a DIFFERENT period never interfere: a committed 2024 v2 does not block approving a pending 2025 v1', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'wha-sup3-'));
      const db = openWarehouse(join(dir, 'f.sqlite'));
      seedPropertyMaster(db);
      seedMappings(db, SEED);
      const make = async (sub: string, year: string, rent?: number) => {
        mkdirSync(join(dir, sub));
        const path = join(dir, sub, `P&L ${year} -- 1100 Rarig.xlsx`);
        await writeFixture(path);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(path);
        wb.worksheets[0]!.getCell('A3').value = `01/01/${year.slice(2)} - 12/31/${year.slice(2)}  (cash basis)`;
        if (rent !== undefined) wb.worksheets[0]!.getCell('D6').value = rent;
        await wb.xlsx.writeFile(path);
        return path;
      };
      const p24a = await make('y24a', '2024');
      const p24b = await make('y24b', '2024', 90000);
      const p25 = await make('y25', '2025');
      const a = await ingestFile(db, p24a, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });
      const b = await ingestFile(db, p24b, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T01:00:00Z' });
      expect([a.status, b.status]).toEqual(['committed', 'committed']);
      expect(b.version).toBe(2); // 2024 now has a committed v2
      const c = await ingestFile(db, p25, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T02:00:00Z', autoCommitThreshold: 0.99 });
      expect(c.status).toBe('pending-review');
      expect(c.version).toBe(1); // 2025 v1, held
      expect(approveImport(db, c.importId!).ok).toBe(true); // 2024's v2 is irrelevant to 2025
    });

    it('(w) a committed import with the same start but a DIFFERENT end (half-year vs full-year) is a different period and never blocks', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'wha-sup4-'));
      const db = openWarehouse(join(dir, 'f.sqlite'));
      seedPropertyMaster(db);
      seedMappings(db, SEED);
      mkdirSync(join(dir, 'full'));
      mkdirSync(join(dir, 'half'));
      const full = join(dir, 'full', 'P&L 2025 -- 1100 Rarig.xlsx');
      const half = join(dir, 'half', 'P&L 2025 -- 1100 Rarig.xlsx');
      await writeFixture(full);
      await writeFixture(half);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(half);
      wb.worksheets[0]!.getCell('A3').value = '01/01/25 - 06/30/25  (cash basis)'; // same start, different end
      await wb.xlsx.writeFile(half);
      const f = await ingestFile(db, full, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z', autoCommitThreshold: 0.99 });
      const h = await ingestFile(db, half, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T01:00:00Z' });
      expect([f.status, h.status]).toEqual(['pending-review', 'committed']);
      expect(db.prepare('SELECT period_start, period_end FROM import_batches WHERE id=?').get(h.importId))
        .toEqual({ period_start: '2025-01-01', period_end: '2025-06-30' });
      expect(approveImport(db, f.importId!).ok).toBe(true); // the half-year import is a different period
      expect(db.prepare('SELECT status FROM import_batches WHERE id=?').get(h.importId)).toMatchObject({ status: 'committed' });
    });

    it('(u) an older pending version CAN be approved while the newer one is still pending; approving the newer then supersedes it', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'wha-sup2-'));
      const db = openWarehouse(join(dir, 'f.sqlite'));
      seedPropertyMaster(db);
      seedMappings(db, SEED);
      const pathA = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
      await writeFixture(pathA);
      const r1 = await ingestFile(db, pathA, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z', autoCommitThreshold: 0.99 });
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(pathA);
      wb.worksheets[0]!.getCell('D6').value = 110000;
      await wb.xlsx.writeFile(pathA);
      const r2 = await ingestFile(db, pathA, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T01:00:00Z', autoCommitThreshold: 0.99 });
      expect([r1.status, r2.status]).toEqual(['pending-review', 'pending-review']);
      expect(approveImport(db, r1.importId!).ok).toBe(true); // nothing newer is committed yet
      expect(approveImport(db, r2.importId!).ok).toBe(true); // newest wins
      expect(db.prepare('SELECT status, superseded_by FROM import_batches WHERE id=?').get(r1.importId)).toEqual({ status: 'superseded', superseded_by: r2.importId });
      expect(db.prepare('SELECT status FROM import_batches WHERE id=?').get(r2.importId)).toMatchObject({ status: 'committed' });
    });
  });

  describe('sign-undecidable approve gate', () => {
    // Fully-mapped statement whose EXPENSE section is closed by a stray zero Total BEFORE its negative-booked
    // leaves: the section-scoped sign decision is undecidable (ingest routes it to pending-review, no flip).
    const UNDECIDABLE_SEED = [
      { account: 'Rent', code: null, normalized_category: 'Rental Revenue', classification: 'revenue' },
      { account: 'HVAC Repair', code: null, normalized_category: 'Repairs & Maintenance', classification: 'opex' },
      { account: 'Insurance Expense', code: null, normalized_category: 'Insurance', classification: 'opex' },
    ];
    // Ingests the undecidable fixture into `into` (a fresh warehouse by default). `property` varies the bytes and the
    // property so a SECOND undecidable import can share one database with another pending import.
    async function undecidablePending(
      into?: { db: WarehouseDb; dir: string },
      property = '1100 Rarig Ave',
      fileLabel = '1100 Rarig',
    ): Promise<{ db: WarehouseDb; dir: string; importId: number }> {
      const dir = into?.dir ?? mkdtempSync(join(tmpdir(), 'wha-undec-'));
      const db = into?.db ?? openWarehouse(join(dir, 'f.sqlite'));
      if (!into) {
        seedPropertyMaster(db);
        seedMappings(db, UNDECIDABLE_SEED);
      }
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Sheet1');
      const rows: Array<[string | null, string | null, string | null, number | null]> = [
        ['Profit & Loss', null, null, null],
        [`Property: ${property}`, null, null, null],
        ['01/01/25 - 12/31/25  (cash basis)', null, null, null],
        [null, 'INCOME', null, null],
        [null, null, '          Rent', 100000],
        [null, 'EXPENSE', null, null],
        [null, null, '          Total Expense', 0],
        [null, null, '          Insurance Expense', -30000],
        [null, null, '          HVAC Repair', -10000],
      ];
      for (const r of rows) ws.addRow(r);
      const file = join(dir, `P&L 2025 -- ${fileLabel}.xlsx`);
      await wb.xlsx.writeFile(file);
      const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-10-15T00:00:00Z' });
      expect(r.status).toBe('pending-review');
      return { db, dir, importId: r.importId! };
    }
    const openUndecidable = (db: WarehouseDb, importId: number) =>
      db.prepare("SELECT id FROM data_quality_issues WHERE import_id=? AND kind='sign-undecidable' AND status='open'").all(importId) as Array<{ id: number }>;

    it('(o) approve refuses while a sign-undecidable issue is open: nothing is activated or committed', async () => {
      const { db, importId } = await undecidablePending();
      expect(openUndecidable(db, importId)).toHaveLength(1);
      const refusal = approveImport(db, importId);
      expect(refusal.ok).toBe(false);
      if (!refusal.ok) {
        expect(refusal.reason).toBe('sign-undecidable');
        expect(refusal.unmapped).toEqual([]);
        expect(refusal.error).toContain('sign');
      }
      expect(db.prepare('SELECT status FROM import_batches WHERE id=?').get(importId)).toMatchObject({ status: 'pending-review' });
      expect((db.prepare('SELECT COUNT(*) AS c FROM ledger_entries WHERE is_active=1').get() as { c: number }).c).toBe(0);
    });

    it('(p) after the reviewer resolves the sign-undecidable issue, approve commits (explicit acknowledgement path)', async () => {
      const { db, importId } = await undecidablePending();
      for (const i of openUndecidable(db, importId)) expect(resolveIssue(db, i.id).ok).toBe(true);
      const ok = approveImport(db, importId);
      expect(ok.ok).toBe(true);
      expect(db.prepare('SELECT status FROM import_batches WHERE id=?').get(importId)).toMatchObject({ status: 'committed' });
    });

    it('(q) the gate keys on THIS import (one shared database): an open sign-undecidable issue on a different import neither blocks it nor is bypassed', async () => {
      // Import A: fully mapped CLEAN-ish pending (unmapped accounts mapped below). Import B: undecidable, in the SAME db.
      const a = await pendingWarehouse();
      seedMappings(a.db, UNDECIDABLE_SEED); // Insurance Expense etc. (idempotent; A's own accounts are mapped via overrides below)
      // fileLabel is the EXACT detect.ts alias token so B resolves a property (an unresolved batch would be
      // refused 'property-unresolved' before the sign gate this case is about).
      const b = await undecidablePending({ db: a.db, dir: a.dir }, '1900 N Broadway', '1900 Broadway');
      expect(b.importId).not.toBe(a.importId);
      expect(openUndecidable(a.db, b.importId)).toHaveLength(1);
      expect(openUndecidable(a.db, a.importId)).toHaveLength(0);
      addMappingOverride(a.db, { account: 'HVAC Repair', normalizedCategory: 'Repairs & Maintenance', classification: 'opex' });
      addMappingOverride(a.db, { account: 'Distribution to Owner', normalizedCategory: 'Distributions', classification: 'excluded' });
      // A has its own warn issues (unmapped-account) still open: other kinds never block
      const aOpen = (a.db.prepare("SELECT COUNT(*) AS c FROM data_quality_issues WHERE import_id=? AND status='open'").get(a.importId) as { c: number }).c;
      expect(aOpen).toBeGreaterThan(0);
      // A commits while B's sign issue is still open ...
      expect(approveImport(a.db, a.importId).ok).toBe(true);
      // ... and B is still refused (its own issue), proving the gate is per-import, not off
      const refusal = approveImport(a.db, b.importId);
      expect(refusal.ok).toBe(false);
      if (!refusal.ok) expect(refusal.reason).toBe('sign-undecidable');
    });

    it('(r) rejecting a sign-undecidable import is never blocked (the safe path)', async () => {
      const { db, importId } = await undecidablePending();
      expect(rejectImport(db, importId).ok).toBe(true);
      expect(db.prepare('SELECT status FROM import_batches WHERE id=?').get(importId)).toMatchObject({ status: 'rejected' });
    });
  });

  describe('unresolved-property approve gate', () => {
    // A filename whose token is NOT an exact detect.ts PROPERTY_ALIASES key ingests with
    // import_batches.property_id NULL (ledger rows 'unknown') and confidence 0.4, so it always lands in
    // pending-review. Approving it would commit NOI under no property: the supersede keyed on a NULL
    // property matches nothing (silent double count) and every such batch merges into one 'unknown'
    // pseudo-property. approveImport must refuse it. Synthetic property name only.
    const UNRESOLVED_FILE = 'P&L 2025 -- Zorvane Flex Park.xlsx';
    async function unresolvedPending(seed = SEED): Promise<{ db: WarehouseDb; dir: string; importId: number }> {
      const dir = mkdtempSync(join(tmpdir(), 'wha-unres-'));
      const db = openWarehouse(join(dir, 'f.sqlite'));
      seedPropertyMaster(db);
      seedMappings(db, seed);
      const file = join(dir, UNRESOLVED_FILE);
      await writeFixture(file, 'Property: Zorvane Flex Park');
      const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-11-05T00:00:00Z' });
      expect(r.status).toBe('pending-review');
      expect(db.prepare('SELECT property_id FROM import_batches WHERE id=?').get(r.importId)).toMatchObject({ property_id: null });
      return { db, dir, importId: r.importId! };
    }
    const activeRows = (db: WarehouseDb, importId: number) =>
      (db.prepare('SELECT COUNT(*) AS c FROM ledger_entries WHERE import_id=? AND is_active=1').get(importId) as { c: number }).c;
    const committedCount = (db: WarehouseDb) =>
      (db.prepare("SELECT COUNT(*) AS c FROM import_batches WHERE status='committed'").get() as { c: number }).c;
    const verdictCount = (db: WarehouseDb) =>
      (db.prepare('SELECT COUNT(*) AS c FROM calibration_verdict').get() as { c: number }).c;

    it('(x1) refuses a fully-mapped NULL-property batch: reason property-unresolved, nothing activated or committed', async () => {
      const { db, importId } = await unresolvedPending();
      const refusal = approveImport(db, importId);
      expect(refusal.ok).toBe(false);
      if (!refusal.ok) {
        expect(refusal.reason).toBe('property-unresolved');
        expect(refusal.unmapped).toEqual([]);
        // The error names the unblock path: reject, then a fresh export under the property's alias filename (x6)...
        expect(refusal.error).toMatch(/reject it/i);
        expect(refusal.error).toMatch(/fresh export/i);
        // ...including the reachable case where no filename can resolve yet: a property with no PROPERTY_ALIASES entry
        // needs one added first (onboarding aliases are not read), and a property not in property_master must be
        // onboarded first (x9, x9b)...
        expect(refusal.error).toMatch(/no PROPERTY_ALIASES entry yet, one must be added first/);
        expect(refusal.error).toMatch(/onboarded first/i);
        // ...and claims dedup only where it holds: once the import is rejected (x6b). A still-pending import from an older
        // parser re-derives in place instead (x6c), so the text must not say a rename can never unblock it.
        expect(refusal.error).toMatch(/once this import is rejected, a file with identical bytes is a duplicate under any name/i);
        expect(refusal.error).not.toMatch(/does not unblock/i);
        // detect.ts needs the WHOLE filename token to equal an alias key; "carries" would wrongly suggest a substring match.
        expect(refusal.error).toMatch(/is exactly the property's PROPERTY_ALIASES key/);
        expect(refusal.error).not.toMatch(/carries/);
      }
      expect(db.prepare('SELECT status FROM import_batches WHERE id=?').get(importId)).toMatchObject({ status: 'pending-review' });
      expect(activeRows(db, importId)).toBe(0);
      expect(committedCount(db)).toBe(0);
    });

    it('(x2) the gate fires BEFORE the unmapped check: unmapped is [] even while accounts are unmapped', async () => {
      const { db, importId } = await unresolvedPending(SEED.slice(0, 1));
      const refusal = approveImport(db, importId);
      expect(refusal.ok).toBe(false);
      if (!refusal.ok) {
        expect(refusal.reason).toBe('property-unresolved');
        expect(refusal.unmapped).toEqual([]);
      }
      expect(activeRows(db, importId)).toBe(0);
    });

    it.each([
      ['empty string', ''],
      ['whitespace', '   '],
      ["the 'unknown' ledger sentinel", 'unknown'],
    ])('(x3) defense in depth: also refuses a batch whose stored property_id is %s', async (_label, value) => {
      // import_batches.property_id is FK-bound to property_master, so ingest can only write NULL or a real id. These
      // values are reachable only with foreign keys off (a legacy or hand-edited file); the gate still fails closed.
      const { db, importId } = await unresolvedPending();
      db.pragma('foreign_keys = OFF');
      db.prepare('UPDATE import_batches SET property_id=? WHERE id=?').run(value, importId);
      db.pragma('foreign_keys = ON');
      const refusal = approveImport(db, importId);
      expect(refusal.ok).toBe(false);
      if (!refusal.ok) expect(refusal.reason).toBe('property-unresolved');
      expect(activeRows(db, importId)).toBe(0);
      expect(committedCount(db)).toBe(0);
    });

    it('(x4) the calibration emit hook does not fire on the refusal', async () => {
      const { db, importId } = await unresolvedPending();
      const before = verdictCount(db);
      expect(approveImport(db, importId).ok).toBe(false);
      expect(verdictCount(db)).toBe(before);
      const emitFailed = (db.prepare("SELECT COUNT(*) AS c FROM data_quality_issues WHERE kind='calibration-emit-failed'").get() as { c: number }).c;
      expect(emitFailed).toBe(0);
    });

    it('(x5) a second NULL-property batch cannot be committed alongside the first (no unknown-keyed double count)', async () => {
      const { db, dir, importId } = await unresolvedPending();
      const other = join(dir, 'P&L 2025 -- Zorvane Yard.xlsx');
      await writeFixture(other, 'Property: Zorvane Yard');
      const r2 = await ingestFile(db, other, { rawDir: join(dir, 'raw'), importedAt: '2026-11-05T01:00:00Z' });
      expect(r2.status).toBe('pending-review');
      expect(approveImport(db, importId).ok).toBe(false);
      expect(approveImport(db, r2.importId!).ok).toBe(false);
      expect(committedCount(db)).toBe(0);
      expect((db.prepare("SELECT COUNT(*) AS c FROM ledger_entries WHERE property_id='unknown' AND is_active=1").get() as { c: number }).c).toBe(0);
    });

    it('(x6) unblock path: reject the refused batch, re-drop a re-exported copy whose filename carries a recognized token; it commits under the real property', async () => {
      const { db, dir, importId } = await unresolvedPending();
      expect(approveImport(db, importId).ok).toBe(false);
      expect(rejectImport(db, importId).ok).toBe(true);
      const sub = join(dir, 're-export');
      mkdirSync(sub);
      const file = join(sub, 'P&L 2025 -- 1100 Rarig.xlsx');
      await writeFixture(file, 'Property: 1100 Rarig Ave (re-export)'); // new bytes: after reject an identical file is a duplicate (x6b)
      const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-11-05T02:00:00Z' });
      expect(r.status).toBe('committed');
      expect(db.prepare('SELECT property_id FROM import_batches WHERE id=?').get(r.importId)).toMatchObject({ property_id: '1100-rarig-ave-columbus-oh' });
      expect(db.prepare('SELECT status FROM import_batches WHERE id=?').get(importId)).toMatchObject({ status: 'rejected' });
    });

    it('(x6b) once rejected, an IDENTICAL re-drop is a duplicate even under a recognized filename, so the unblock needs a fresh export', async () => {
      // registerImport re-derives a same-hash file only while its import is committed or pending-review AND from an
      // older parser; a rejected import is never re-derived, so its identical bytes are a duplicate under any name.
      const { db, dir, importId } = await unresolvedPending();
      expect(rejectImport(db, importId).ok).toBe(true);
      db.prepare('UPDATE import_batches SET parser_version = 0 WHERE id = ?').run(importId); // even from an older parser
      const sub = join(dir, 'renamed');
      mkdirSync(sub);
      const file = join(sub, 'P&L 2025 -- 1100 Rarig.xlsx');
      copyFileSync(join(dir, UNRESOLVED_FILE), file); // same bytes, recognized name
      const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-11-05T03:00:00Z' });
      expect(r).toMatchObject({ status: 'duplicate', importId });
      expect(committedCount(db)).toBe(0);
    });

    it('(x6c) while still pending from an older parser, an identical re-drop is NOT a duplicate: it re-derives the same import in place, and approve still refuses it', async () => {
      // Why the refusal text promises dedup only once the import is rejected. The re-derive re-keys the ledger rows to the
      // new filename's property but leaves the batch's property NULL (ingest.ts re-derive; ING-2). Held here with a 0.99
      // threshold. With the default threshold that re-derive can commit through ingest itself while the batch's property
      // stays NULL: the ING-2 re-derive defect, outside approveImport.
      const { db, dir, importId } = await unresolvedPending();
      db.prepare('UPDATE import_batches SET parser_version = 0 WHERE id = ?').run(importId); // simulate a parser bump
      const sub = join(dir, 'renamed-stale');
      mkdirSync(sub);
      const file = join(sub, 'P&L 2025 -- 1100 Rarig.xlsx');
      copyFileSync(join(dir, UNRESOLVED_FILE), file); // same bytes, recognized name
      const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-11-05T04:00:00Z', autoCommitThreshold: 0.99 });
      expect(r).toMatchObject({ status: 'pending-review', importId });
      expect(db.prepare('SELECT property_id FROM import_batches WHERE id=?').get(importId)).toMatchObject({ property_id: null });
      const refusal = approveImport(db, importId);
      expect(refusal.ok).toBe(false);
      if (!refusal.ok) expect(refusal.reason).toBe('property-unresolved');
      expect(committedCount(db)).toBe(0);
    });

    it('(x8) an EMPTY import is refused as empty (the documented 404 shape), even when its property is unresolved', async () => {
      // The empty-import refusal runs before the property gates, as it did before #554 (9485736f): no ledger rows,
      // nothing to key.
      const dir = mkdtempSync(join(tmpdir(), 'wha-unres-empty-'));
      const db = openWarehouse(join(dir, 'f.sqlite'));
      seedPropertyMaster(db);
      seedMappings(db, SEED);
      const file = join(dir, UNRESOLVED_FILE);
      const wb = new ExcelJS.Workbook();
      wb.addWorksheet('QuickBooks Desktop Export Tips').addRow(['QuickBooks Desktop Export Tips']);
      await wb.xlsx.writeFile(file);
      const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-11-05T00:00:00Z' });
      expect(r.status).toBe('pending-review');
      expect(db.prepare('SELECT property_id FROM import_batches WHERE id=?').get(r.importId)).toMatchObject({ property_id: null });
      const refusal = approveImport(db, r.importId!);
      expect(refusal.ok).toBe(false);
      if (!refusal.ok) {
        expect(refusal.reason).toBeUndefined();
        expect(refusal.unmapped).toEqual([]);
        expect(refusal.error).toContain('no ledger rows');
      }
    });

    it('(x9) a property with no PROPERTY_ALIASES entry: no filename resolves until the detect.ts entry exists (onboarding aliases are not read); then a fresh export commits', async () => {
      const { db, dir, importId } = await unresolvedPending();
      expect(rejectImport(db, importId).ok).toBe(true);
      const freshExport = async (sub: string, propertyLine: string) => {
        mkdirSync(join(dir, sub));
        const file = join(dir, sub, UNRESOLVED_FILE);
        await writeFixture(file, propertyLine); // a fresh export: different bytes every time
        return ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-11-05T05:00:00Z' });
      };
      // 1. A fresh export under the property's own, unaliased name: still unresolved, still refused.
      const r1 = await freshExport('fresh-1', 'Property: Zorvane Flex Park (export 2)');
      expect(r1.status).toBe('pending-review');
      const refusal = approveImport(db, r1.importId!);
      expect(refusal.ok).toBe(false);
      if (!refusal.ok) expect(refusal.reason).toBe('property-unresolved');
      expect(rejectImport(db, r1.importId!).ok).toBe(true);
      // 2. Onboarding records the property and its aliases, but filename detection does not read onboarding aliases.
      const onboarded = onboardProperty(db, {
        id: 'zorvane-flex-park', name: 'Zorvane Flex Park', aliases: ['zorvane flex park'], sfTotal: 12000,
        ownershipPct: 1, pmSystem: 'quickbooks', authoritativeSource: 'pm-exports',
      });
      expect(onboarded.ok).toBe(true);
      const r2 = await freshExport('fresh-2', 'Property: Zorvane Flex Park (export 3)');
      expect(db.prepare('SELECT property_id FROM import_batches WHERE id=?').get(r2.importId)).toMatchObject({ property_id: null });
      expect(rejectImport(db, r2.importId!).ok).toBe(true);
      // 3. The detect.ts PROPERTY_ALIASES entry (a code change, simulated here) resolves the next fresh export, which commits.
      PROPERTY_ALIASES['zorvane flex park'] = 'zorvane-flex-park';
      try {
        const r3 = await freshExport('fresh-3', 'Property: Zorvane Flex Park (export 4)');
        expect(r3.status).toBe('committed');
        expect(db.prepare('SELECT property_id FROM import_batches WHERE id=?').get(r3.importId)).toMatchObject({ property_id: 'zorvane-flex-park' });
      } finally {
        delete PROPERTY_ALIASES['zorvane flex park'];
      }
    });

    it('(x9b) a detect.ts alias for a property that is not in property_master cannot ingest: the property must be onboarded first', async () => {
      const { db, dir } = await unresolvedPending();
      PROPERTY_ALIASES['zorvane yard'] = 'zorvane-yard';
      try {
        const file = join(dir, 'P&L 2025 -- Zorvane Yard.xlsx');
        await writeFixture(file, 'Property: Zorvane Yard');
        await expect(ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-11-05T06:00:00Z' })).rejects.toThrow(/FOREIGN KEY/i);
      } finally {
        delete PROPERTY_ALIASES['zorvane yard'];
      }
    });

    it('(x7) control: a resolved-property pending batch still approves', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'wha-unres-ctl-'));
      const db = openWarehouse(join(dir, 'f.sqlite'));
      seedPropertyMaster(db);
      seedMappings(db, SEED);
      const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
      await writeFixture(file);
      const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-11-05T00:00:00Z', autoCommitThreshold: 0.99 });
      expect(r.status).toBe('pending-review');
      expect(approveImport(db, r.importId!).ok).toBe(true);
      expect(db.prepare('SELECT status FROM import_batches WHERE id=?').get(r.importId)).toMatchObject({ status: 'committed' });
    });
  });

  describe('ledger/batch property divergence approve gate', () => {
    // import_batches.property_id is written once, at first detection. A stale-parser RE-DERIVE (ingest.ts) rebuilds the
    // ledger rows from the re-drop's filename but never rewrites the batch's property, so the two can diverge (the root
    // fix is ING-2's). NOI keys on ledger_entries.property_id; approve's supersede keys on the batch's. Approving a
    // diverged batch supersedes the batch property's served version and serves the statement under the ledger's key.
    // In-memory warehouse, synthetic statements; a parser bump is simulated by zeroing parser_version.
    const RARIG = '1100-rarig-ave-columbus-oh';
    const FIFTH = '3540-e-5th-ave-columbus-oh';
    const statusOf = (db: WarehouseDb, id: number) =>
      (db.prepare('SELECT status FROM import_batches WHERE id=?').get(id) as { status: string }).status;
    const ledgerKeys = (db: WarehouseDb, id: number) =>
      (db.prepare('SELECT DISTINCT property_id AS p FROM ledger_entries WHERE import_id=? ORDER BY p').all(id) as Array<{ p: string }>).map((k) => k.p);
    const activeFor = (db: WarehouseDb, propertyId: string) =>
      (db.prepare('SELECT COUNT(*) AS c FROM ledger_entries WHERE property_id=? AND is_active=1').get(propertyId) as { c: number }).c;
    const verdictCount = (db: WarehouseDb) =>
      (db.prepare('SELECT COUNT(*) AS c FROM calibration_verdict').get() as { c: number }).c;

    /** v1 = committed 1100 Rarig 2025 (served). v2 = a later export of the same property and period (new bytes), held for
     *  review. v2 then goes stale (parser bump) and its IDENTICAL bytes are re-dropped as `redropName`: ingest re-derives
     *  v2 in place, re-keying its ledger rows to that filename's detection while v2's batch stays 1100 Rarig. */
    async function divergedPending(redropName: string): Promise<{ db: WarehouseDb; v1: number; v2: number }> {
      const dir = mkdtempSync(join(tmpdir(), 'wha-div-'));
      const db = openWarehouse(':memory:');
      seedPropertyMaster(db);
      seedMappings(db, SEED);
      for (const sub of ['v1', 'v2', 'redrop']) mkdirSync(join(dir, sub));
      const v1File = join(dir, 'v1', 'P&L 2025 -- 1100 Rarig.xlsx');
      await writeFixture(v1File);
      const v1 = await ingestFile(db, v1File, { rawDir: join(dir, 'raw'), importedAt: '2026-11-05T00:00:00Z' });
      expect(v1.status).toBe('committed');
      const v2File = join(dir, 'v2', 'P&L 2025 -- 1100 Rarig.xlsx');
      await writeFixture(v2File, 'Property: 1100 Rarig Ave (corrected export)');
      const v2 = await ingestFile(db, v2File, { rawDir: join(dir, 'raw'), importedAt: '2026-11-05T01:00:00Z', autoCommitThreshold: 0.99 });
      expect(v2.status).toBe('pending-review');
      db.prepare('UPDATE import_batches SET parser_version = 0 WHERE id = ?').run(v2.importId);
      const redrop = join(dir, 'redrop', redropName);
      copyFileSync(v2File, redrop);
      const r = await ingestFile(db, redrop, { rawDir: join(dir, 'raw'), importedAt: '2026-11-05T02:00:00Z', autoCommitThreshold: 0.99 });
      expect(r).toMatchObject({ status: 'pending-review', importId: v2.importId }); // re-derived in place, still held
      expect(db.prepare('SELECT property_id FROM import_batches WHERE id=?').get(v2.importId)).toMatchObject({ property_id: RARIG });
      return { db, v1: v1.importId!, v2: v2.importId! };
    }

    it("(y1) S2: a batch whose ledger rows were re-derived to 'unknown' is refused (property-mismatch); 1100 Rarig 2025 keeps serving v1", async () => {
      const { db, v1, v2 } = await divergedPending('P&L 2025 -- Zorvane Flex Park.xlsx');
      expect(ledgerKeys(db, v2)).toEqual(['unknown']);
      const verdictsBefore = verdictCount(db);
      const refusal = approveImport(db, v2);
      expect(refusal.ok).toBe(false);
      if (!refusal.ok) {
        expect(refusal.reason).toBe('property-mismatch');
        expect(refusal.unmapped).toEqual([]);
        expect(refusal.error).toContain("'unknown'");
        expect(refusal.error).toContain(RARIG);
        expect(refusal.error).toMatch(/fresh export/i);
        expect(refusal.error).toMatch(/no PROPERTY_ALIASES entry yet, one must be added first/);
        expect(refusal.error).toMatch(/once this import is rejected, a file with identical bytes is a duplicate under any name/i);
        expect(refusal.error).toMatch(/is exactly the PROPERTY_ALIASES key of the property it belongs to/);
        expect(refusal.error).not.toMatch(/carries/);
      }
      expect([statusOf(db, v1), statusOf(db, v2)]).toEqual(['committed', 'pending-review']);
      expect(activeFor(db, RARIG)).toBe(3); // v1 still served
      expect(activeFor(db, 'unknown')).toBe(0);
      expect(verdictCount(db)).toBe(verdictsBefore); // no calibration emit on the refusal
    });

    it('(y2) S2b: a batch whose ledger rows were re-derived to ANOTHER property is refused; 3540 E 5th never serves 1100 Rarig figures', async () => {
      const { db, v1, v2 } = await divergedPending('P&L 2025 -- 3540 E 5th.xlsx');
      expect(ledgerKeys(db, v2)).toEqual([FIFTH]);
      const refusal = approveImport(db, v2);
      expect(refusal.ok).toBe(false);
      if (!refusal.ok) {
        expect(refusal.reason).toBe('property-mismatch');
        expect(refusal.unmapped).toEqual([]);
        expect(refusal.error).toContain(FIFTH);
      }
      expect([statusOf(db, v1), statusOf(db, v2)]).toEqual(['committed', 'pending-review']);
      expect(activeFor(db, RARIG)).toBe(3);
      expect(activeFor(db, FIFTH)).toBe(0);
    });

    it('(y3) control: a stale re-derive under the SAME property filename still approves and supersedes v1', async () => {
      const { db, v1, v2 } = await divergedPending('P&L 2025 -- 1100 Rarig.xlsx');
      expect(ledgerKeys(db, v2)).toEqual([RARIG]);
      expect(approveImport(db, v2).ok).toBe(true);
      expect([statusOf(db, v1), statusOf(db, v2)]).toEqual(['superseded', 'committed']);
      expect(activeFor(db, RARIG)).toBe(3);
    });

    /** v1 = an export of 1100 Rarig 2025 held for review; v2 = a later export of the same period, committed (served).
     *  v1 then goes stale and its IDENTICAL bytes are re-dropped as `redropName`, so v1 is BOTH older than a committed
     *  version of its period and diverged (ledger re-keyed to that filename's detection, batch still 1100 Rarig). */
    async function newerCommittedAndDiverged(redropName: string): Promise<{ db: WarehouseDb; v1: number; v2: number }> {
      const dir = mkdtempSync(join(tmpdir(), 'wha-div-newer-'));
      const db = openWarehouse(':memory:');
      seedPropertyMaster(db);
      seedMappings(db, SEED);
      for (const sub of ['v1', 'v2', 'redrop']) mkdirSync(join(dir, sub));
      const v1File = join(dir, 'v1', 'P&L 2025 -- 1100 Rarig.xlsx');
      await writeFixture(v1File, 'Property: 1100 Rarig Ave (first export)');
      const v1 = await ingestFile(db, v1File, { rawDir: join(dir, 'raw'), importedAt: '2026-11-05T00:00:00Z', autoCommitThreshold: 0.99 });
      expect(v1.status).toBe('pending-review'); // held for review
      const v2File = join(dir, 'v2', 'P&L 2025 -- 1100 Rarig.xlsx');
      await writeFixture(v2File, 'Property: 1100 Rarig Ave (corrected export)');
      const v2 = await ingestFile(db, v2File, { rawDir: join(dir, 'raw'), importedAt: '2026-11-05T01:00:00Z' });
      expect(v2.status).toBe('committed'); // the newer arrival is served
      db.prepare('UPDATE import_batches SET parser_version = 0 WHERE id = ?').run(v1.importId);
      const redrop = join(dir, 'redrop', redropName);
      copyFileSync(v1File, redrop);
      const r = await ingestFile(db, redrop, { rawDir: join(dir, 'raw'), importedAt: '2026-11-05T02:00:00Z', autoCommitThreshold: 0.99 });
      expect(r).toMatchObject({ status: 'pending-review', importId: v1.importId });
      return { db, v1: v1.importId!, v2: v2.importId! };
    }

    it('(y4) precedence: when a newer version of the period is already committed, newer-version-committed is reported, not property-mismatch', async () => {
      // Before #554 (9485736f) this batch was refused 'newer-version-committed' (reject it; the newer version stays). The
      // property gates run after that guard, so their re-drop advice never replaces the simpler, documented one.
      const { db, v1, v2 } = await newerCommittedAndDiverged('P&L 2025 -- Zorvane Flex Park.xlsx');
      expect(ledgerKeys(db, v1)).toEqual(['unknown']); // diverged too: the mismatch gate would also refuse it
      const refusal = approveImport(db, v1);
      expect(refusal.ok).toBe(false);
      if (!refusal.ok) {
        expect(refusal.reason).toBe('newer-version-committed');
        expect(refusal.unmapped).toEqual([]);
        expect(refusal.error).toMatch(/the newer version stays/);
        expect(refusal.error).toContain("'unknown'"); // ...and the co-occurring mismatch is named, not hidden (y6)
      }
      expect([statusOf(db, v1), statusOf(db, v2)]).toEqual(['pending-review', 'committed']);
    });

    it('(y6) a co-occurring mismatch to ANOTHER real property is never masked: whatever the arrival order, the refusal names the ledger key and its unblock', async () => {
      // Older diverged batch, newer version committed: the reason stays newer-version-committed (round-2 precedence), and
      // the text also says the rows are keyed to 3540 E 5th with the re-drop path, so rejecting it never silently loses a
      // statement that belongs to another property.
      const older = await newerCommittedAndDiverged('P&L 2025 -- 3540 E 5th.xlsx');
      expect(ledgerKeys(older.db, older.v1)).toEqual([FIFTH]);
      const first = approveImport(older.db, older.v1);
      const again = approveImport(older.db, older.v1);
      expect(again).toEqual(first); // deterministic for a given state
      expect(first.ok).toBe(false);
      if (!first.ok) {
        expect(first.reason).toBe('newer-version-committed');
        expect(first.error).toMatch(/the newer version stays/);
        expect(first.error).toContain(`'${FIFTH}'`);
        expect(first.error).toMatch(/re-drop a fresh export/);
        expect(first.error).toMatch(/no PROPERTY_ALIASES entry yet, one must be added first/);
      }
      expect(activeFor(older.db, FIFTH)).toBe(0);
      // Newer diverged batch, older version committed (the y2 shape): no newer version, so property-mismatch itself.
      const newer = await divergedPending('P&L 2025 -- 3540 E 5th.xlsx');
      const refusal = approveImport(newer.db, newer.v2);
      expect(refusal.ok).toBe(false);
      if (!refusal.ok) {
        expect(refusal.reason).toBe('property-mismatch');
        expect(refusal.error).toContain(`'${FIFTH}'`);
      }
    });

    it('(z1) one ledger read drives the empty, unresolved and mismatch gates: approve reads ledger_entries exactly once before its first write', async () => {
      // Refute wf_2e74b57b-da3: each statement between approve's ledger read and its write transaction widens the
      // check-then-write window (TOCTOU, Window B) that a concurrent re-derive can land in. A single process cannot show
      // the race, so this pins the statement shape instead: one read of the import's ledger rows, then the transaction.
      const { db, v2 } = await divergedPending('P&L 2025 -- 1100 Rarig.xlsx'); // approvable (the y3 shape)
      const beforeFirstWrite: string[] = [];
      const prepare = db.prepare.bind(db);
      let wrote = false;
      (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
        if (/^\s*(UPDATE|INSERT|DELETE)\b/i.test(sql)) wrote = true;
        if (!wrote) beforeFirstWrite.push(sql);
        return prepare(sql);
      };
      try {
        expect(approveImport(db, v2).ok).toBe(true);
      } finally {
        (db as unknown as { prepare: unknown }).prepare = prepare;
      }
      expect(beforeFirstWrite.filter((sql) => /\bFROM ledger_entries\b/i.test(sql))).toHaveLength(1);
    });

    it('(y5) unblock path: reject the mismatched batch, then a fresh export under the alias filename of the property it belongs to commits and supersedes v1', async () => {
      const { db, v1, v2 } = await divergedPending('P&L 2025 -- Zorvane Flex Park.xlsx');
      expect(approveImport(db, v2).ok).toBe(false);
      expect(rejectImport(db, v2).ok).toBe(true);
      const dir = mkdtempSync(join(tmpdir(), 'wha-div-unblock-'));
      const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
      await writeFixture(file, 'Property: 1100 Rarig Ave (fresh export)');
      const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-11-05T03:00:00Z' });
      expect(r.status).toBe('committed');
      expect([statusOf(db, v1), statusOf(db, v2), statusOf(db, r.importId!)]).toEqual(['superseded', 'rejected', 'committed']);
      expect(ledgerKeys(db, r.importId!)).toEqual([RARIG]);
      expect(activeFor(db, RARIG)).toBe(3);
      expect(activeFor(db, 'unknown')).toBe(0);
    });
  });
});
