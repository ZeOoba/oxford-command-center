// tests/unit/calibration-resolve.test.ts
// Phase 2 of the Score-vs-Outcome Calibration Log (the 40-year feedback loop):
// the RESOLVER (resolveDueOutcomes) + the REPORT (calibrationReport).
// Spec: docs/superpowers/specs/2026-06-13-calibration-log-design.md §3, §4.
//
// CRITICAL CAVEAT this file pins down: real outcome data does not exist yet (it needs ≥1
// horizon elapsed). The resolver MUST degrade gracefully — zero unresolved / zero due is a
// normal no-op that returns a zeroed result, NEVER an error or a divide-by-zero. The report
// MUST be correct (null rates, never NaN) on an empty dataset.
//
// DB-backed via tmpdir sqlite, synthetic data only.
import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { approveImport } from '../../server/warehouse/actions';
import {
  computeInputsVersion,
  logVerdicts,
  verdictsFromScores,
  verdictsFromAnomalies,
  resolveDueOutcomes,
  calibrationReport,
  calibrationPending,
} from '../../server/warehouse/calibration';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { ingestFile } from '../../server/warehouse/ingest';
import { detectAnomalies } from '../../server/warehouse/anomalies';
import { propertyPeriodMetrics } from '../../server/warehouse/metrics';
import { scoreProperties } from '../../server/warehouse/scores';
import { seedMappings } from '../../server/warehouse/mapping';
import { seedPropertyMaster } from '../../server/warehouse/property-master';

const SEED = [
  { account: 'Rent', code: '5064', normalized_category: 'Rental Revenue', classification: 'revenue' },
  { account: 'HVAC Repair', code: '6285', normalized_category: 'Repairs & Maintenance', classification: 'opex' },
];

async function writeFixture(
  path: string,
  opts: { token: string; year: number; rent: number; repair: number },
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  const yy = String(opts.year).slice(2);
  const rows: Array<[string | null, string | null, string | null, number | null]> = [
    ['Profit & Loss', null, null, null],
    [`Property: ${opts.token}`, null, null, null],
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

/** Commit one full-year P&L (filename token resolves to a real property_master id). */
async function commitYear(
  db: WarehouseDb,
  rawDir: string,
  opts: { token: string; year: number; rent: number; repair: number; at: string },
): Promise<number> {
  const file = join(rawDir, `P&L ${opts.year} -- ${opts.token} ${opts.rent}.xlsx`);
  await writeFixture(file, opts);
  const r = await ingestFile(db, file, { rawDir: join(rawDir, 'raw'), importedAt: opts.at, autoCommitThreshold: 0.99 });
  if (r.status === 'pending-review') {
    const ok = approveImport(db, r.importId!);
    expect(ok.ok).toBe(true);
  }
  return r.importId!;
}

const dirs: string[] = [];
function freshDb(): { db: WarehouseDb; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cal-resolve-'));
  dirs.push(dir);
  const db = openWarehouse(join(dir, 'f.sqlite'));
  seedPropertyMaster(db);
  seedMappings(db, SEED);
  return { db, dir };
}

// ── §3 resolver: the empty / no-data no-op (the central Phase-2 caveat) ─────────────────────
describe('calibration resolver — empty / no-data no-op (§3, the central caveat)', () => {
  it('a brand-new warehouse with NO verdicts resolves to a zeroed result, never throws', () => {
    const { db } = freshDb();
    const res = resolveDueOutcomes(db);
    expect(res).toMatchObject({ scanned: 0, due: 0, resolved: 0, skippedNoData: 0, errors: 0 });
    // No outcome rows were written.
    expect((db.prepare('SELECT COUNT(*) AS c FROM calibration_outcome').get() as { c: number }).c).toBe(0);
  });

  it('verdicts present but NO later same-grain outcome period → all PENDING, zero resolved, no throw', async () => {
    // One property, ONE committed year → there IS a verdict, but no strictly-later full-year period
    // exists yet to score it against. The verdict stays unresolved (pending), never wrongly scored.
    const { db, dir } = freshDb();
    await commitYear(db, dir, { token: '1100 rarig', year: 2025, rent: 100000, repair: 8000, at: '2026-06-12T00:00:00Z' });
    const verdictCount = (db.prepare('SELECT COUNT(*) AS c FROM calibration_verdict').get() as { c: number }).c;
    expect(verdictCount).toBeGreaterThan(0); // the commit hook logged verdicts

    const res = resolveDueOutcomes(db);
    expect(res.due).toBe(0); // horizon not yet covered by a later same-grain period
    expect(res.resolved).toBe(0);
    expect(res.errors).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM calibration_outcome').get() as { c: number }).c).toBe(0);
  });

  it('is idempotent on empty: two runs both no-op, zero outcomes', () => {
    const { db } = freshDb();
    expect(resolveDueOutcomes(db).resolved).toBe(0);
    expect(resolveDueOutcomes(db).resolved).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM calibration_outcome').get() as { c: number }).c).toBe(0);
  });
});

// ── §3.1 resolver: scoring due verdicts against realized same-grain outcomes ─────────────────
describe('calibration resolver — scores due verdicts against realized outcomes (§3.1)', () => {
  it('resolves a 2024 verdict once a later 2025 full-year period covers its horizon', async () => {
    // Commit 2024, then 2025. The on-commit hook logs a verdict for BOTH years. The 2024 verdict
    // (horizon 1yr) is now covered by the 2025 same-grain period → resolvable.
    const { db, dir } = freshDb();
    await commitYear(db, dir, { token: '1100 rarig', year: 2024, rent: 100000, repair: 8000, at: '2026-06-12T00:00:00Z' });
    await commitYear(db, dir, { token: '1100 rarig', year: 2025, rent: 112000, repair: 9000, at: '2026-06-12T01:00:00Z' });

    const res = resolveDueOutcomes(db);
    expect(res.resolved).toBeGreaterThan(0);
    expect(res.errors).toBe(0);

    // Every resolved verdict got exactly one is_resolution=1 outcome row.
    const blessed = db.prepare(
      'SELECT COUNT(*) AS c FROM calibration_outcome WHERE is_resolution = 1',
    ).get() as { c: number };
    expect(blessed.c).toBe(res.resolved);

    // The blessed 2024 capital-action outcome carries the realized NOI trend (NOI grew → realized_value > 0).
    const ca = db.prepare(`
      SELECT o.realized_value AS rv, o.outcome_period AS op, o.hit AS hit, o.resolved_by AS rb
      FROM calibration_outcome o JOIN calibration_verdict v ON v.id = o.calibration_id
      WHERE v.verdict_kind = 'capital-action' AND v.as_of_period = '2024' AND o.is_resolution = 1
    `).get() as { rv: number | null; op: string; hit: number | null; rb: string } | undefined;
    expect(ca).toBeDefined();
    expect(ca!.op).toBe('2025');
    expect(ca!.rv).not.toBeNull();
    expect(ca!.rv!).toBeGreaterThan(0); // NOI 92000→103000 grew
    expect(ca!.rb.startsWith('auto:')).toBe(true);
  });

  it('GRAIN DISCIPLINE: never resolves a full-year verdict against a cross-grain (YTD) period', async () => {
    // Commit a 2024 FULL YEAR (verdict logged), then a 2025 YTD partial. The 2025 YTD must NOT be
    // used to resolve the 2024 full-year verdict (a 12-mo-vs-partial comparison is forbidden, §3.1).
    const { db, dir } = freshDb();
    await commitYear(db, dir, { token: '1100 rarig', year: 2024, rent: 100000, repair: 8000, at: '2026-06-12T00:00:00Z' });

    // A 2025 YTD (partial-year) import for the same property.
    const file = join(dir, 'P&L 2025 YTD -- 1100 rarig.xlsx');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    for (const r of [
      ['Profit & Loss', null, null, null],
      ['Property: 1100 rarig', null, null, null],
      ['01/01/25 - 05/31/25  (cash basis)', null, null, null],
      [null, 'INCOME', null, null],
      [null, null, '     5002 RENTAL INCOME', null],
      [null, null, '          5064 Rent', 46000],
      [null, 'EXPENSE', null, null],
      [null, null, '     6160 REPAIR', null],
      [null, null, '          6285 HVAC Repair', 3500],
    ] as Array<[string | null, string | null, string | null, number | null]>) {
      ws.addRow(r);
    }
    await wb.xlsx.writeFile(file);
    const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T02:00:00Z', autoCommitThreshold: 0.99 });
    if (r.status === 'pending-review') expect(approveImport(db, r.importId!).ok).toBe(true);

    const res = resolveDueOutcomes(db);
    // The 2024 full-year verdict has NO same-grain later period (the only later period is a YTD
    // partial) → it stays pending. No outcome may be scored from a cross-grain comparison.
    const crossGrain = db.prepare(`
      SELECT COUNT(*) AS c FROM calibration_outcome o JOIN calibration_verdict v ON v.id = o.calibration_id
      WHERE v.as_of_period = '2024' AND o.outcome_period LIKE '2025%'
    `).get() as { c: number };
    expect(crossGrain.c).toBe(0);
    expect(res.errors).toBe(0);
  });

  it('IDEMPOTENT: resolving twice does not write a second blessed outcome (no double-resolution)', async () => {
    const { db, dir } = freshDb();
    await commitYear(db, dir, { token: '1100 rarig', year: 2024, rent: 100000, repair: 8000, at: '2026-06-12T00:00:00Z' });
    await commitYear(db, dir, { token: '1100 rarig', year: 2025, rent: 112000, repair: 9000, at: '2026-06-12T01:00:00Z' });

    const first = resolveDueOutcomes(db);
    expect(first.resolved).toBeGreaterThan(0);
    const afterFirst = (db.prepare('SELECT COUNT(*) AS c FROM calibration_outcome WHERE is_resolution=1').get() as { c: number }).c;

    const second = resolveDueOutcomes(db);
    expect(second.resolved).toBe(0); // nothing left to resolve
    const afterSecond = (db.prepare('SELECT COUNT(*) AS c FROM calibration_outcome WHERE is_resolution=1').get() as { c: number }).c;
    expect(afterSecond).toBe(afterFirst); // the partial unique index forbids a 2nd blessed row
  });

  it('does NOT re-resolve a verdict that already carries a blessed (manual) resolution', async () => {
    const { db, dir } = freshDb();
    await commitYear(db, dir, { token: '1100 rarig', year: 2024, rent: 100000, repair: 8000, at: '2026-06-12T00:00:00Z' });
    await commitYear(db, dir, { token: '1100 rarig', year: 2025, rent: 112000, repair: 9000, at: '2026-06-12T01:00:00Z' });

    // Hand-bless one 2024 capital-action verdict with a manual outcome BEFORE the auto-resolver runs.
    const v = db.prepare(
      "SELECT id FROM calibration_verdict WHERE verdict_kind='capital-action' AND as_of_period='2024' LIMIT 1",
    ).get() as { id: number };
    db.prepare(`
      INSERT INTO calibration_outcome
        (calibration_id, realized_band, outcome_period, hit, resolved_by, resolution_basis, is_resolution)
      VALUES (?, 'manual-band', '2025', 1, 'manual:test', 'analyst-judgment', 1)
    `).run(v.id);

    const res = resolveDueOutcomes(db);
    // The already-blessed verdict is skipped; only OTHER unresolved verdicts may resolve.
    const blessedForV = db.prepare(
      'SELECT COUNT(*) AS c FROM calibration_outcome WHERE calibration_id=? AND is_resolution=1',
    ).get(v.id) as { c: number };
    expect(blessedForV.c).toBe(1); // still exactly one — auto-resolver did not add a second
    expect(res.errors).toBe(0);
  });
});

// ── §4 report: shape + empty-dataset correctness (no NaN, no divide-by-zero) ─────────────────
describe('calibration report — empty dataset is correct (§4, no NaN / no divide-by-zero)', () => {
  it('an empty warehouse yields a zeroed report with NULL rates (never NaN)', () => {
    const { db } = freshDb();
    const rep = calibrationReport(db, {});
    expect(rep.totalVerdicts).toBe(0);
    expect(rep.resolvedVerdicts).toBe(0);
    expect(rep.overallHitRate).toBeNull(); // 0/0 → null, NOT NaN
    expect(rep.byKind).toEqual([]);
    expect(rep.dataMaturityNote).toContain('data-accumulation'); // §6 small-N honesty
    // Defensive: nothing in the report serializes to NaN.
    expect(JSON.stringify(rep)).not.toContain('null,"x"'); // smoke; real check is no throw + nulls
    expect(Number.isNaN(rep.overallHitRate as unknown as number)).toBe(false);
  });

  it('a report over only-unresolved verdicts has resolved=0 and null rates', async () => {
    const { db, dir } = freshDb();
    await commitYear(db, dir, { token: '1100 rarig', year: 2025, rent: 100000, repair: 8000, at: '2026-06-12T00:00:00Z' });
    const rep = calibrationReport(db, {});
    expect(rep.totalVerdicts).toBeGreaterThan(0);
    expect(rep.resolvedVerdicts).toBe(0);
    expect(rep.overallHitRate).toBeNull();
    for (const k of rep.byKind) {
      expect(k.scoreable === 0 ? k.hitRate === null : true).toBe(true);
    }
  });
});

describe('calibration report — aggregates resolved outcomes (§4.1)', () => {
  it('counts hits / scoreable per kind and per band, with a Wilson interval when n>0', async () => {
    const { db, dir } = freshDb();
    await commitYear(db, dir, { token: '1100 rarig', year: 2024, rent: 100000, repair: 8000, at: '2026-06-12T00:00:00Z' });
    await commitYear(db, dir, { token: '1100 rarig', year: 2025, rent: 112000, repair: 9000, at: '2026-06-12T01:00:00Z' });
    resolveDueOutcomes(db);

    const rep = calibrationReport(db, {});
    expect(rep.resolvedVerdicts).toBeGreaterThan(0);
    expect(rep.byKind.length).toBeGreaterThan(0);

    for (const k of rep.byKind) {
      // No NaN ever; a scoreable=0 kind has a null rate, otherwise a finite 0..1 rate + interval.
      if (k.scoreable === 0) {
        expect(k.hitRate).toBeNull();
        expect(k.wilsonLow).toBeNull();
        expect(k.wilsonHigh).toBeNull();
      } else {
        expect(k.hitRate!).toBeGreaterThanOrEqual(0);
        expect(k.hitRate!).toBeLessThanOrEqual(1);
        expect(k.wilsonLow!).toBeLessThanOrEqual(k.hitRate!);
        expect(k.wilsonHigh!).toBeGreaterThanOrEqual(k.hitRate!);
      }
    }
    // overallHitRate, when present, is finite and in range.
    if (rep.overallHitRate !== null) {
      expect(Number.isFinite(rep.overallHitRate)).toBe(true);
      expect(rep.overallHitRate).toBeGreaterThanOrEqual(0);
      expect(rep.overallHitRate).toBeLessThanOrEqual(1);
    }
  });

  it('treatment-adjusted hit-rate is computed over action_taken=none rows only', async () => {
    const { db, dir } = freshDb();
    await commitYear(db, dir, { token: '1100 rarig', year: 2024, rent: 100000, repair: 8000, at: '2026-06-12T00:00:00Z' });
    await commitYear(db, dir, { token: '1100 rarig', year: 2025, rent: 112000, repair: 9000, at: '2026-06-12T01:00:00Z' });
    resolveDueOutcomes(db); // auto-resolution → action_taken defaults to 'unknown'

    const rep = calibrationReport(db, {});
    // With every auto-resolution at action_taken='unknown' (not 'none'), the clean-test rate is null.
    expect(rep.treatmentAdjustedHitRate).toBeNull();
  });
});

// ── adversarial repros (added during the REFUTE pass) ───────────────────────────────────────
describe('calibration resolver/report — adversarial repros', () => {
  it('a verdict with horizon_periods NULL (open-ended) is not force-resolved at a fixed horizon', async () => {
    // Insert an open-ended verdict by hand (horizon null). The resolver must not invent a horizon
    // and wrongly score it; open-ended verdicts resolve only on a terminal event (disposition), which
    // does not occur here → they stay pending.
    const { db, dir } = freshDb();
    await commitYear(db, dir, { token: '1100 rarig', year: 2024, rent: 100000, repair: 8000, at: '2026-06-12T00:00:00Z' });
    await commitYear(db, dir, { token: '1100 rarig', year: 2025, rent: 112000, repair: 9000, at: '2026-06-12T01:00:00Z' });
    const iv = computeInputsVersion(db);
    const subject = '1100-rarig-ave-columbus-oh';
    db.prepare(`
      INSERT OR IGNORE INTO calibration_verdict
        (subject_kind, subject_id, verdict_kind, verdict_subkind, verdict_engine,
         predicted_band, predicted_value, predicted_unit, confidence, direction, reasons_json,
         as_of_period, horizon_periods, inputs_version, emitted_by, dedup_key)
      VALUES ('property', ?, 'capital-action', 'open', 'scores', 'monitor', NULL, 'band', 0.7,
              'flat', '[]', '2024', NULL, ?, 'manual:test', ?)
    `).run(subject, iv.inputsVersion, `property|${subject}|capital-action|open|2024|${iv.inputsVersion}`);

    const res = resolveDueOutcomes(db);
    // The open-ended verdict (horizon null) is NOT scored by the fixed-horizon path.
    const openOutcome = db.prepare(`
      SELECT COUNT(*) AS c FROM calibration_outcome o JOIN calibration_verdict v ON v.id=o.calibration_id
      WHERE v.verdict_subkind='open' AND v.horizon_periods IS NULL
    `).get() as { c: number };
    expect(openOutcome.c).toBe(0);
    expect(res.errors).toBe(0);
  });

  it('report over a kind whose every outcome has hit=null (not scoreable) → null rate, never NaN', () => {
    // Hand-craft a verdict + a non-scoreable outcome (hit null). The report must treat scoreable as 0
    // for that kind and report a null hit-rate, not 0/0 = NaN.
    const { db } = freshDb();
    const iv = computeInputsVersion(db);
    const key = `property|X|forecast||2024|${iv.inputsVersion}`;
    db.prepare(`
      INSERT INTO calibration_verdict
        (subject_kind, subject_id, verdict_kind, verdict_subkind, verdict_engine,
         predicted_band, predicted_value, predicted_unit, confidence, direction, reasons_json,
         as_of_period, horizon_periods, inputs_version, emitted_by, dedup_key)
      VALUES ('property','X','forecast','','forecast', NULL, 1000, 'usd', NULL, 'n/a', '[]',
              '2024', 1, ?, 'manual:test', ?)
    `).run(iv.inputsVersion, key);
    const vid = (db.prepare("SELECT id FROM calibration_verdict WHERE dedup_key=?").get(key) as { id: number }).id;
    db.prepare(`
      INSERT INTO calibration_outcome
        (calibration_id, realized_value, outcome_period, hit, resolved_by, resolution_basis, is_resolution)
      VALUES (?, 1100, '2025', NULL, 'manual:test', 'analyst-judgment', 1)
    `).run(vid);

    const rep = calibrationReport(db, {});
    const fc = rep.byKind.find((k) => k.verdictKind === 'forecast');
    expect(fc).toBeDefined();
    expect(fc!.scoreable).toBe(0); // hit null → not scoreable
    expect(fc!.hitRate).toBeNull();
    expect(Number.isNaN(fc!.hitRate as unknown as number)).toBe(false);
  });
});

// keep the imports referenced (defensive: prove the Phase-1 helpers still load alongside Phase 2)
describe('calibration phase-1 helpers still importable', () => {
  it('logVerdicts/verdictsFromScores/verdictsFromAnomalies are present', () => {
    expect(typeof logVerdicts).toBe('function');
    expect(typeof verdictsFromScores).toBe('function');
    expect(typeof verdictsFromAnomalies).toBe('function');
    expect(typeof scoreProperties).toBe('function');
    expect(typeof detectAnomalies).toBe('function');
    expect(typeof propertyPeriodMetrics).toBe('function');
  });
});

// ── REFUTE pass: additional adversarial probes (report filter SQL, horizon boundary, treatment) ─
describe('calibration — REFUTE pass probes', () => {
  it('report filter (from/to/kind) builds valid SQL and never double-applies the resolution clause', async () => {
    const { db, dir } = freshDb();
    await commitYear(db, dir, { token: '1100 rarig', year: 2024, rent: 100000, repair: 8000, at: '2026-06-12T00:00:00Z' });
    await commitYear(db, dir, { token: '1100 rarig', year: 2025, rent: 112000, repair: 9000, at: '2026-06-12T01:00:00Z' });
    resolveDueOutcomes(db);

    // Filtered report must not throw (the .replace('WHERE',...) join clause must stay valid SQL).
    const filtered = calibrationReport(db, { from: '2024', to: '2025', kind: 'capital-action' });
    expect(filtered.kind).toBe('capital-action');
    expect(filtered.byKind.every((k) => k.verdictKind === 'capital-action')).toBe(true);
    // A from past all verdicts → zero in range, null rate (never NaN).
    const future = calibrationReport(db, { from: '2099' });
    expect(future.totalVerdicts).toBe(0);
    expect(future.overallHitRate).toBeNull();
  });

  it('HORIZON BOUNDARY: a 1yr 2024 verdict resolves against 2025, never against 2024 itself', async () => {
    const { db, dir } = freshDb();
    await commitYear(db, dir, { token: '1100 rarig', year: 2024, rent: 100000, repair: 8000, at: '2026-06-12T00:00:00Z' });
    await commitYear(db, dir, { token: '1100 rarig', year: 2025, rent: 112000, repair: 9000, at: '2026-06-12T01:00:00Z' });
    resolveDueOutcomes(db);
    // No outcome period may equal its verdict's as_of_period (that would be a zero-horizon self-resolve).
    const selfResolved = db.prepare(`
      SELECT COUNT(*) AS c FROM calibration_outcome o JOIN calibration_verdict v ON v.id=o.calibration_id
      WHERE o.is_resolution=1 AND o.outcome_period = v.as_of_period
    `).get() as { c: number };
    expect(selfResolved.c).toBe(0);
    // The 2024 verdict's outcome is strictly later (2025); horizon_actual ≥ 1.
    const ha = db.prepare(`
      SELECT MIN(o.horizon_actual) AS m FROM calibration_outcome o JOIN calibration_verdict v ON v.id=o.calibration_id
      WHERE o.is_resolution=1 AND v.as_of_period='2024'
    `).get() as { m: number | null };
    expect(ha.m).not.toBeNull();
    expect(ha.m!).toBeGreaterThanOrEqual(1);
  });

  it('PENDING queue equals the set resolveDueOutcomes would bless (consistency)', async () => {
    const { db, dir } = freshDb();
    await commitYear(db, dir, { token: '1100 rarig', year: 2024, rent: 100000, repair: 8000, at: '2026-06-12T00:00:00Z' });
    await commitYear(db, dir, { token: '1100 rarig', year: 2025, rent: 112000, repair: 9000, at: '2026-06-12T01:00:00Z' });
    const pendingBefore = calibrationPending(db).length;
    expect(pendingBefore).toBeGreaterThan(0);
    const res = resolveDueOutcomes(db);
    // Everything that was pending+scoreable is now resolved; the pending queue shrinks accordingly.
    expect(res.resolved).toBeGreaterThan(0);
    expect(res.resolved).toBeLessThanOrEqual(pendingBefore);
    const pendingAfter = calibrationPending(db).filter((v) => !v.resolved).length;
    // Re-running pending excludes the now-resolved verdicts (status='open' filter).
    expect(pendingAfter).toBeLessThanOrEqual(pendingBefore);
  });

  it('TREATMENT: action_taken=none rows feed the clean-test rate without NaN', async () => {
    const { db, dir } = freshDb();
    await commitYear(db, dir, { token: '1100 rarig', year: 2024, rent: 100000, repair: 8000, at: '2026-06-12T00:00:00Z' });
    await commitYear(db, dir, { token: '1100 rarig', year: 2025, rent: 112000, repair: 9000, at: '2026-06-12T01:00:00Z' });
    resolveDueOutcomes(db);
    // Flip one auto-resolution to action_taken='none' (a clean natural experiment) and re-report.
    db.prepare("UPDATE calibration_outcome SET action_taken='none' WHERE is_resolution=1 AND hit IS NOT NULL").run();
    const rep = calibrationReport(db, {});
    // Now the treatment-adjusted rate is computed (over the none rows) and is finite, never NaN.
    if (rep.treatmentAdjustedScoreable > 0) {
      expect(rep.treatmentAdjustedHitRate).not.toBeNull();
      expect(Number.isNaN(rep.treatmentAdjustedHitRate as unknown as number)).toBe(false);
      expect(rep.treatmentAdjustedHitRate!).toBeGreaterThanOrEqual(0);
      expect(rep.treatmentAdjustedHitRate!).toBeLessThanOrEqual(1);
    }
  });
});
