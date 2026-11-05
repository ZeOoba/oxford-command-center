// tests/unit/calibration.test.ts
// Phase 1 of the Score-vs-Outcome Calibration Log (the 40-year feedback loop).
// Spec: docs/superpowers/specs/2026-06-13-calibration-log-design.md §7.
// DB-backed via tmpdir sqlite, synthetic data only. Verifies the four invariants:
// deterministic inputs_version, idempotent logging, fail-open emit, Zod refusal,
// and byte-identical determinism of (scores, iv) → verdict rows.
import ExcelJS from 'exceljs';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addMappingOverride, approveImport } from '../../server/warehouse/actions';
import {
  computeInputsVersion,
  logVerdicts,
  verdictsFromAnomalies,
  verdictsFromScores,
} from '../../server/warehouse/calibration';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { ingestFile } from '../../server/warehouse/ingest';
import { detectAnomalies } from '../../server/warehouse/anomalies';
import { propertyPeriodMetrics } from '../../server/warehouse/metrics';
import { scoreProperties } from '../../server/warehouse/scores';
import { seedMappings } from '../../server/warehouse/mapping';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import { INTEL_CONFIG } from '../../server/warehouse/intel-config';
import { CalibrationVerdictSchema } from '../../src/contracts/warehouse';

const SEED = [
  { account: 'Rent', code: '5064', normalized_category: 'Rental Revenue', classification: 'revenue' },
  { account: 'HVAC Repair', code: '6285', normalized_category: 'Repairs & Maintenance', classification: 'opex' },
];

/** Write a single-property full-year P&L fixture. `rent`/`repair` vary the numbers (and bytes). */
async function writeFixture(
  path: string,
  opts: { property: string; year: number; rent: number; repair: number },
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  const yy = String(opts.year).slice(2);
  const rows: Array<[string | null, string | null, string | null, number | null]> = [
    ['Profit & Loss', null, null, null],
    [`Property: ${opts.property}`, null, null, null],
    [`01/01/${yy} - 12/31/${yy}  (cash basis)`, null, null, null],
    [null, 'INCOME', null, null],
    [null, null, '     5002 RENTAL INCOME', null],
    [null, null, '          5064 Rent', opts.rent],
    [null, 'EXPENSE', null, null],
    [null, null, '     6160 REPAIR', null],
    [null, null, '          6285 HVAC Repair', opts.repair],
  ];
  for (const r of rows) ws.addRow(r);
  await wb.xlsx.writeFile(path);
}

const dirs: string[] = [];
afterEach(() => {
  /* tmpdirs are OS-cleaned; nothing to unwind. */
});

/** Fixture property label -> the EXACT detect.ts PROPERTY_ALIASES token, so the filename resolves to a real
 *  property_master id. approveImport refuses a batch whose property did not resolve ('property-unresolved'),
 *  so the former rent-suffixed filenames (which ingested with a NULL property, ledger 'unknown') can no
 *  longer be committed through approve. */
const ALIAS_TOKEN: Record<string, string> = {
  '1100 Rarig Ave': '1100 rarig',
  '9620 E State Route 350': '9620 state 350',
  '3540 E. 5th Ave': '3540 e 5th',
};

/** A per-call subdirectory + alias filename: rent/repair vary the path's directory (and the bytes), never
 *  the filename token. */
function fixturePath(dir: string, opts: { property: string; year: number; rent: number; repair: number }): string {
  const token = ALIAS_TOKEN[opts.property];
  if (!token) throw new Error(`no alias token for fixture property ${opts.property}`);
  const sub = join(dir, `r${opts.rent}-${opts.repair}`);
  mkdirSync(sub, { recursive: true });
  return join(sub, `P&L ${opts.year} -- ${token}.xlsx`);
}

/** Ingest+commit one full-year P&L for one property, returning the committed importId. */
async function commitYear(
  db: WarehouseDb,
  rawDir: string,
  opts: { property: string; year: number; rent: number; repair: number; at: string },
): Promise<number> {
  const file = fixturePath(rawDir, opts);
  await writeFixture(file, opts);
  const r = await ingestFile(db, file, { rawDir: join(rawDir, 'raw'), importedAt: opts.at, autoCommitThreshold: 0.99 });
  // High threshold forces the review queue; approve to commit so rows go active.
  if (r.status === 'pending-review') {
    const ok = approveImport(db, r.importId!);
    expect(ok.ok).toBe(true);
  }
  return r.importId!;
}

/** Build a warehouse with several committed full-year imports across two years + properties. */
async function populatedDb(): Promise<{ db: WarehouseDb; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'cal-'));
  dirs.push(dir);
  const db = openWarehouse(join(dir, 'f.sqlite'));
  seedPropertyMaster(db);
  seedMappings(db, SEED);
  const props = ['1100 Rarig Ave', '9620 E State Route 350', '3540 E. 5th Ave'];
  let t = 0;
  for (const property of props) {
    await commitYear(db, dir, { property, year: 2024, rent: 100000, repair: 8000, at: `2026-06-12T00:0${t++}:00Z` });
    await commitYear(db, dir, { property, year: 2025, rent: 112000, repair: 9000, at: `2026-06-12T01:0${t++}:00Z` });
  }
  return { db, dir };
}

/** Clear the verdict + DQ tables so a logVerdicts-focused unit test starts from a clean slate.
 *  (populatedDb()'s commits fire the emit hook, which legitimately pre-populates the table; these
 *  two tests isolate logVerdicts itself, not the commit hook — that is covered end-to-end below.) */
function clearCalibration(db: WarehouseDb): void {
  db.exec('DELETE FROM calibration_verdict; DELETE FROM data_quality_issues;');
}

describe('calibration — inputs_version (§1.1)', () => {
  it('is STABLE across repeated calls on an unchanged db', async () => {
    const { db } = await populatedDb();
    const before = (db.prepare('SELECT COUNT(*) AS c FROM calibration_inputs_version').get() as { c: number }).c;
    const a = computeInputsVersion(db);
    const b = computeInputsVersion(db);
    expect(a.inputsVersion).toHaveLength(16);
    expect(b.inputsVersion).toBe(a.inputsVersion);
    expect(b.ledgerFingerprint).toBe(a.ledgerFingerprint);
    expect(b.configHash).toBe(a.configHash);
    // Upsert is INSERT OR IGNORE: two calls on an UNCHANGED db add no new rows (the version for
    // this exact state already exists from the setup commits' emit hook — re-hashing is a no-op).
    const after = (db.prepare('SELECT COUNT(*) AS c FROM calibration_inputs_version').get() as { c: number }).c;
    expect(after).toBe(before);
  });

  it('CHANGES when a ledger row is superseded (new committed version of the same period)', async () => {
    const { db, dir } = await populatedDb();
    const before = computeInputsVersion(db);
    // Supersede 1100 Rarig 2025 with a corrected (different) value → new active rowid + supersede event.
    await commitYear(db, dir, { property: '1100 Rarig Ave', year: 2025, rent: 120000, repair: 9500, at: '2026-06-12T09:00:00Z' });
    const after = computeInputsVersion(db);
    expect(after.inputsVersion).not.toBe(before.inputsVersion);
    expect(after.ledgerFingerprint).not.toBe(before.ledgerFingerprint);
  });

  it('CHANGES when INTEL_CONFIG changes (config_hash fork), ledger held constant', async () => {
    const { db } = await populatedDb();
    const base = computeInputsVersion(db);
    // Inject a perturbed config — same ledger fingerprint, different config hash ⇒ different version.
    const perturbed = computeInputsVersion(db, { revenueGrowth: 0.99 });
    expect(perturbed.ledgerFingerprint).toBe(base.ledgerFingerprint);
    expect(perturbed.configHash).not.toBe(base.configHash);
    expect(perturbed.inputsVersion).not.toBe(base.inputsVersion);
  });

  it('FREEZES the live INTEL_CONFIG verbatim in config_json (reproducible weight provenance)', async () => {
    const { db } = await populatedDb();
    const iv = computeInputsVersion(db);
    // config_json is the verbatim, stable-stringified live INTEL_CONFIG (calibration.ts): a future
    // analyst reads the literal ratified weights straight from the row. Lock that the freeze actually
    // captures the CURRENT weights/bands/knob — so the dated config_hash fork is genuinely
    // reproducible, not merely hash-sensitive.
    const frozen = JSON.parse(iv.configJson) as {
      healthWeights: Record<string, number>;
      healthBands: Record<string, number>;
      growthScoreCapPct: number;
    };
    expect(frozen.healthWeights).toEqual(INTEL_CONFIG.healthWeights);
    expect(frozen.healthBands).toEqual(INTEL_CONFIG.healthBands);
    expect(frozen.growthScoreCapPct).toBe(INTEL_CONFIG.growthScoreCapPct);
  });
});

describe('calibration — logVerdicts idempotency + fail-open (§7)', () => {
  it('is IDEMPOTENT: same verdict set twice → N written then 0 (dedup_key UNIQUE)', async () => {
    const { db } = await populatedDb();
    clearCalibration(db); // isolate logVerdicts from the commit-hook's pre-population
    const iv = computeInputsVersion(db);
    const metrics = propertyPeriodMetrics(db);
    const verdicts = [
      ...verdictsFromScores(scoreProperties(db, metrics), iv, 'commit:test'),
      ...verdictsFromAnomalies(detectAnomalies(metrics), iv, 'commit:test'),
    ];
    expect(verdicts.length).toBeGreaterThan(0);

    const first = logVerdicts(db, verdicts);
    expect(first.error).toBeUndefined();
    expect(first.written).toBe(verdicts.length);
    expect(first.skipped).toBe(0);

    const second = logVerdicts(db, verdicts);
    expect(second.written).toBe(0);
    expect(second.skipped).toBe(verdicts.length);

    const rows = db.prepare('SELECT COUNT(*) AS c FROM calibration_verdict').get() as { c: number };
    expect(rows.c).toBe(verdicts.length);
  });

  it('FAIL-OPEN: a forced throw in the emit path NEVER propagates and writes a data_quality_issues row', async () => {
    const { db } = await populatedDb();
    clearCalibration(db); // isolate logVerdicts from the commit-hook's pre-population
    const dqBefore = (db.prepare('SELECT COUNT(*) AS c FROM data_quality_issues').get() as { c: number }).c;

    // A poisoned db whose prepare() throws simulates an internal failure inside logVerdicts.
    // logVerdicts must catch it, return {written:0,skipped:0,error}, and record a DQ row on the REAL db.
    const iv = computeInputsVersion(db);
    const verdicts = verdictsFromScores(scoreProperties(db, propertyPeriodMetrics(db)), iv, 'commit:test');
    expect(verdicts.length).toBeGreaterThan(0);

    const res = logVerdicts(db, verdicts, { forceError: 'boom (synthetic)' });
    expect(res.written).toBe(0);
    expect(res.skipped).toBe(0);
    expect(res.error).toBeTruthy();

    const dqAfter = db.prepare(
      "SELECT COUNT(*) AS c FROM data_quality_issues WHERE kind='calibration-emit-failed'",
    ).get() as { c: number };
    expect(dqAfter.c).toBe(1);
    // No verdict rows were written on the failed path.
    expect((db.prepare('SELECT COUNT(*) AS c FROM calibration_verdict').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM data_quality_issues').get() as { c: number }).c)
      .toBeGreaterThan(dqBefore);
  });

  it('FAIL-OPEN end-to-end: approveImport returns {ok:true} even when the emit hook is poisoned', async () => {
    // Build a pending import, then commit it. The emit hook runs AFTER the transaction; a failure
    // there must not flip the {ok:true} result. We prove the hook fired (DQ row) without breaking commit.
    const dir = mkdtempSync(join(tmpdir(), 'cal-'));
    dirs.push(dir);
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    // Prime one prior year so the second commit produces real scores to log.
    await commitYear(db, dir, { property: '1100 Rarig Ave', year: 2024, rent: 100000, repair: 8000, at: '2026-06-12T00:00:00Z' });

    // Ingest 2025 to pending-review, then approve with the emit hook forced to fail.
    const fx = { property: '1100 Rarig Ave', year: 2025, rent: 112000, repair: 9000 };
    const file = fixturePath(dir, fx);
    await writeFixture(file, fx);
    const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T01:00:00Z', autoCommitThreshold: 0.99 });
    expect(r.status).toBe('pending-review');

    const ok = approveImport(db, r.importId!, { forceCalibrationError: 'boom (synthetic)' });
    expect(ok.ok).toBe(true); // commit succeeds despite the poisoned emit hook
    expect(db.prepare('SELECT status FROM import_batches WHERE id=?').get(r.importId)).toMatchObject({ status: 'committed' });
    const dq = db.prepare("SELECT COUNT(*) AS c FROM data_quality_issues WHERE kind='calibration-emit-failed'").get() as { c: number };
    expect(dq.c).toBe(1);
  });

  it('HEALTHY end-to-end: approveImport emits verdict rows on a clean commit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cal-'));
    dirs.push(dir);
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    await commitYear(db, dir, { property: '1100 Rarig Ave', year: 2024, rent: 100000, repair: 8000, at: '2026-06-12T00:00:00Z' });
    await commitYear(db, dir, { property: '1100 Rarig Ave', year: 2025, rent: 112000, repair: 9000, at: '2026-06-12T01:00:00Z' });
    const n = (db.prepare('SELECT COUNT(*) AS c FROM calibration_verdict').get() as { c: number }).c;
    expect(n).toBeGreaterThan(0); // health-band/attention/capital-action rows for the scored property
    const kinds = db.prepare('SELECT DISTINCT verdict_kind FROM calibration_verdict ORDER BY verdict_kind')
      .all() as Array<{ verdict_kind: string }>;
    expect(kinds.map((k) => k.verdict_kind)).toEqual(expect.arrayContaining(['attention', 'capital-action', 'health-band']));
    // emitted_by carries the commit provenance.
    const eb = db.prepare('SELECT DISTINCT emitted_by FROM calibration_verdict').all() as Array<{ emitted_by: string }>;
    expect(eb.every((e) => e.emitted_by.startsWith('commit:'))).toBe(true);
  });
});

describe('calibration — Zod boundary (§2) + determinism (§7)', () => {
  it('REJECTS a verdict with neither band nor value', () => {
    const bad = {
      subjectKind: 'property', subjectId: 'x', verdictKind: 'health-band', verdictEngine: 'scores',
      predictedBand: null, predictedValue: null, predictedUnit: null, confidence: 0.7,
      direction: 'n/a', reasons: [], asOfPeriod: '2025', horizonPeriods: 1,
      inputsVersion: '0123456789abcdef', emittedBy: 'commit:test',
    };
    const res = CalibrationVerdictSchema.safeParse(bad);
    expect(res.success).toBe(false);

    // A band-only verdict (value null) is accepted.
    const ok = CalibrationVerdictSchema.safeParse({ ...bad, predictedBand: 'green', predictedUnit: 'band' });
    expect(ok.success).toBe(true);
  });

  it('DETERMINISM: same (scores, iv) → identical verdict rows', async () => {
    const { db } = await populatedDb();
    const iv = computeInputsVersion(db);
    const scores = scoreProperties(db, propertyPeriodMetrics(db));
    const a = verdictsFromScores(scores, iv, 'commit:test');
    const b = verdictsFromScores(scores, iv, 'commit:test');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // Every produced verdict passes its own schema (the rows we would persist are valid).
    for (const v of a) expect(CalibrationVerdictSchema.safeParse(v).success).toBe(true);
    // dedup keys within a single emission are unique (no self-collision among rows).
    const keys = a.map((v) => `${v.subjectKind}|${v.subjectId}|${v.verdictKind}|${v.asOfPeriod}|${v.inputsVersion}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// ── Adversarial-review defect repros (D1–D4) ────────────────────────────────────────────────
// Each test reproduces a defect an adversarial reviewer found in the Phase-1 scaffold. Written
// first (TDD), watched to fail against the pre-fix code, then made green by the fix.
//
// These repros use filename tokens that RESOLVE to real property_master ids (detect.ts
// PROPERTY_ALIASES) so the ledger carries a concrete property_id (with rentableSf, cash basis)
// — not the 'unknown' aggregate. That gives real per-property quartiles + a real same-basis
// cohort, which D1/D2/D4 need. (The tests above formerly used rent-suffixed tokens -> a single
// 'unknown' subject. That path is retired: approveImport refuses a NULL-property batch with
// 'property-unresolved', so an 'unknown' subject can no longer be committed via approve. They now
// resolve to real properties through ALIAS_TOKEN.)

/** Commit one full-year P&L whose filename token is an EXACT detect.ts alias (→ resolves to a
 *  real property_master id). `repair` grows faster than `rent` across years so reclassifying the
 *  repair account opex→capex genuinely moves NOI growth → moves the health verdict. */
async function commitAlias(
  db: WarehouseDb,
  rawDir: string,
  opts: { token: string; property: string; year: number; rent: number; repair: number; at: string },
): Promise<number> {
  const file = join(rawDir, `P&L ${opts.year} -- ${opts.token}.xlsx`);
  await writeFixture(file, opts);
  const r = await ingestFile(db, file, { rawDir: join(rawDir, 'raw'), importedAt: opts.at, autoCommitThreshold: 0.99 });
  if (r.status === 'pending-review') {
    const ok = approveImport(db, r.importId!);
    expect(ok.ok).toBe(true);
  }
  return r.importId!;
}

/** A warehouse with ONE resolved property whose repair (opex) grew far faster than rent, so a
 *  later opex→capex reclassification flips NOI from a decline to a gain → moves the verdict. */
async function reclassMovesVerdictDb(): Promise<{ db: WarehouseDb; dir: string; subject: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'cal-'));
  dirs.push(dir);
  const db = openWarehouse(join(dir, 'f.sqlite'));
  seedPropertyMaster(db);
  seedMappings(db, SEED);
  let t = 0;
  await commitAlias(db, dir, { token: '1100 rarig', property: 'A', year: 2024, rent: 100000, repair: 8000, at: `2026-06-12T0${t++}:00:00Z` });
  await commitAlias(db, dir, { token: '1100 rarig', property: 'A', year: 2025, rent: 112000, repair: 30000, at: `2026-06-12T0${t++}:00:00Z` });
  return { db, dir, subject: '1100-rarig-ave-columbus-oh' };
}

describe('calibration — D1: inputs_version folds mapping/classification state (§1.1)', () => {
  it('CHANGES inputs_version when a reclassification moves the verdict, ledger rows unchanged', async () => {
    const { db, subject } = await reclassMovesVerdictDb();

    const ivBefore = computeInputsVersion(db);
    const healthBefore = verdictsFromScores(scoreProperties(db, propertyPeriodMetrics(db)), ivBefore, 'commit:b')
      .find((v) => v.subjectId === subject && v.verdictKind === 'health-band')!;

    // Reclassify HVAC Repair opex → capex. addMappingOverride UPDATEs active ledger rows'
    // classification/normalized_category WITHOUT changing row count or ids — opex drops out of NOI,
    // NOI growth flips from a decline to a gain, the health score moves. The fingerprint must move too.
    const res = addMappingOverride(db, { account: 'HVAC Repair', normalizedCategory: 'CapEx', classification: 'capex' });
    expect(res.rederived).toBeGreaterThan(0);

    const ivAfter = computeInputsVersion(db);
    const healthAfter = verdictsFromScores(scoreProperties(db, propertyPeriodMetrics(db)), ivAfter, 'commit:a')
      .find((v) => v.subjectId === subject && v.verdictKind === 'health-band')!;

    // The verdict actually changed (score moved) — otherwise the test proves nothing.
    expect(healthAfter.predictedValue).not.toBe(healthBefore.predictedValue);
    // …and therefore the inputs_version MUST change too (the defect: it did not — same fingerprint).
    expect(ivAfter.inputsVersion).not.toBe(ivBefore.inputsVersion);
  });
});

describe('calibration — D2: mapping override does not poison the log via dedup (§1.2)', () => {
  it('WRITES the corrected verdict after a reclassification, not silently skips it', async () => {
    const { db, subject } = await reclassMovesVerdictDb();
    clearCalibration(db);

    // Log the BEFORE (stale) verdicts.
    const ivBefore = computeInputsVersion(db);
    const before = verdictsFromScores(scoreProperties(db, propertyPeriodMetrics(db)), ivBefore, 'commit:before');
    const firstLog = logVerdicts(db, before);
    expect(firstLog.error).toBeUndefined();
    expect(firstLog.written).toBe(before.length);
    const beforeHealth = before.find((v) => v.subjectId === subject && v.verdictKind === 'health-band')!.predictedValue;

    // Reclassify so the score moves, then log the CORRECTED verdicts.
    addMappingOverride(db, { account: 'HVAC Repair', normalizedCategory: 'CapEx', classification: 'capex' });
    const ivAfter = computeInputsVersion(db);
    const after = verdictsFromScores(scoreProperties(db, propertyPeriodMetrics(db)), ivAfter, 'commit:after');
    const afterHealth = after.find((v) => v.subjectId === subject && v.verdictKind === 'health-band')!.predictedValue;
    expect(afterHealth).not.toBe(beforeHealth); // the correction is a genuinely different verdict

    const secondLog = logVerdicts(db, after);
    // The corrected verdict row for the subject's health-band MUST be present (written), not dropped
    // by a dedup_key collision with the stale verdict.
    const values = (db
      .prepare("SELECT predicted_value AS pv FROM calibration_verdict WHERE subject_id=? AND verdict_kind='health-band' ORDER BY id")
      .all(subject) as Array<{ pv: number }>).map((r) => r.pv);
    expect(values).toContain(afterHealth);
    expect(secondLog.written).toBeGreaterThan(0);
  });
});

describe('calibration — D3: anomaly verdicts do not collide on dedup_key (§1.2, §2.1)', () => {
  it('WRITES three distinct anomalies for one property/period (subkind discriminates)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cal-'));
    dirs.push(dir);
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    clearCalibration(db);

    const property = '1100-rarig-ave-columbus-oh';
    const period = '2025';
    const iv = computeInputsVersion(db);
    // Three distinct anomaly KINDS for ONE (property, period). They all carry verdictKind='anomaly'
    // and (with the pre-fix dedup tuple subject|kind|as_of|inputs_version) collapse to ONE dedup_key.
    const flags = [
      { propertyId: property, period, kind: 'noi-decline' as const, subkey: '', severity: 'high' as const, detail: 'NOI declined 20%', metricValue: -0.2 },
      { propertyId: property, period, kind: 'expense-growth' as const, subkey: '', severity: 'moderate' as const, detail: 'Opex grew 18%', metricValue: 0.18 },
      { propertyId: property, period, kind: 'category-spike' as const, subkey: 'Taxes', severity: 'high' as const, detail: 'Taxes spiked 40%', metricValue: 0.4 },
    ];
    const verdicts = verdictsFromAnomalies(flags, iv, 'commit:test');
    expect(verdicts).toHaveLength(3);

    const res = logVerdicts(db, verdicts);
    expect(res.error).toBeUndefined();
    expect(res.written).toBe(3); // pre-fix: 1 written, 2 skipped
    expect(res.skipped).toBe(0);
    const n = (db.prepare(
      "SELECT COUNT(*) AS c FROM calibration_verdict WHERE subject_id=? AND verdict_kind='anomaly'",
    ).get(property) as { c: number }).c;
    expect(n).toBe(3);
  });

  it('WRITES distinct verdicts for two SAME-kind anomalies (subkey discriminates) — refute F1', async () => {
    // The same-kind multiplicity the engine actually emits: two category-spikes for one
    // property/period. With verdictSubkind = kind alone they collapsed to ONE dedup_key (the same
    // D3 collision F1 fixed in the alert pipeline). The subkey must keep them distinct here too.
    const dir = mkdtempSync(join(tmpdir(), 'cal-'));
    dirs.push(dir);
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    clearCalibration(db);

    const property = '1100-rarig-ave-columbus-oh';
    const period = '2025';
    const iv = computeInputsVersion(db);
    const flags = [
      { propertyId: property, period, kind: 'category-spike' as const, subkey: 'Taxes', severity: 'high' as const, detail: 'Taxes spiked 40%', metricValue: 0.4 },
      { propertyId: property, period, kind: 'category-spike' as const, subkey: 'Utilities', severity: 'high' as const, detail: 'Utilities spiked 35%', metricValue: 0.35 },
    ];
    const res = logVerdicts(db, verdictsFromAnomalies(flags, iv, 'commit:test'));
    expect(res.error).toBeUndefined();
    expect(res.written).toBe(2); // pre-fix: 1 written, 1 skipped (collision)
    expect(res.skipped).toBe(0);
  });
});

/** Two distinct, resolved, same-(cash)-basis properties with DIFFERENT NOI/SF → the same-basis
 *  NOI/SF cohort is exactly n=2 and each property gets a real (non-null) quartile. */
async function twoPropertyDb(): Promise<{ db: WarehouseDb; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'cal-'));
  dirs.push(dir);
  const db = openWarehouse(join(dir, 'f.sqlite'));
  seedPropertyMaster(db);
  seedMappings(db, SEED);
  let t = 0;
  await commitAlias(db, dir, { token: '1100 rarig', property: 'A', year: 2024, rent: 100000, repair: 8000, at: `2026-06-12T0${t++}:00:00Z` });
  await commitAlias(db, dir, { token: '1100 rarig', property: 'A', year: 2025, rent: 112000, repair: 9000, at: `2026-06-12T0${t++}:00:00Z` });
  await commitAlias(db, dir, { token: '9620 state 350', property: 'B', year: 2024, rent: 200000, repair: 8000, at: `2026-06-12T0${t++}:00:00Z` });
  await commitAlias(db, dir, { token: '9620 state 350', property: 'B', year: 2025, rent: 224000, repair: 9000, at: `2026-06-12T0${t++}:00:00Z` });
  return { db, dir };
}

describe('calibration — D4: small-cohort confidence cap at n<3 (§2.3)', () => {
  it('CAPS recorded confidence at 0.6 for an n=2 same-basis cohort', async () => {
    const { db } = await twoPropertyDb();
    const scores = scoreProperties(db, propertyPeriodMetrics(db));
    // Two properties, same (cash) basis → NOI/SF cohort n=2. Each gets a real (non-null) quartile,
    // so the pre-fix `noiPerSfQuartile === null` cap does NOT fire — but spec §2.3 mandates the cap
    // at cohort n<3. n=2 cohorts are common at a 14-property firm partitioned by basis.
    const scored = scores.filter((s) => s.noiPerSfQuartile !== null);
    expect(scored.length).toBeGreaterThan(0); // the n=2 cohort DID produce ranked quartiles

    const iv = computeInputsVersion(db);
    const verdicts = verdictsFromScores(scores, iv, 'commit:test');
    // Restrict to the two ranked subjects (the cohort under test).
    const ranked = new Set(scored.map((s) => s.propertyId));
    const cohortVerdicts = verdicts.filter((v) => ranked.has(v.subjectId));
    expect(cohortVerdicts.length).toBeGreaterThan(0);
    for (const v of cohortVerdicts) {
      expect(v.confidence).not.toBeNull();
      expect(v.confidence!).toBeLessThanOrEqual(0.6); // n=2 < 3 → capped
    }
  });
});
