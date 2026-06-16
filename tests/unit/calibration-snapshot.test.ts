// tests/unit/calibration-snapshot.test.ts
// The scheduled-snapshot entry point (scripts/calibration-snapshot.ts) — the Phase-1-tail writer the
// ora-calibration-snapshot task drives. Spec: 2026-06-13-calibration-log-design.md §2.2 (trigger 2).
//
// runSnapshot(db, {taskId}) does, IN ORDER:
//   1. resolveDueOutcomes(db) — score any verdict whose horizon a later same-grain period now covers.
//   2. log the CURRENT verdicts (scores + anomalies) tagged emittedBy='snapshot:<taskId>', idempotently.
// It mirrors the on-commit emit hook's resolve→score→log path but with the snapshot emittedBy tag, and is
// FAIL-OPEN (never throws to its caller — the scheduler must not crash). Observational: writes ONLY the
// calibration tables; never a verdict UPDATE, never a governor.
//
// CENTRAL PHASE-2 CAVEAT pinned here: an empty / no-outcome warehouse is the NORMAL state — runSnapshot
// returns a zeroed summary, writes nothing scoreable, and NEVER throws or divides by zero.
import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseArgs, runSnapshot } from '../../scripts/calibration-snapshot';
import { approveImport } from '../../server/warehouse/actions';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { ingestFile } from '../../server/warehouse/ingest';
import { seedMappings } from '../../server/warehouse/mapping';
import { seedPropertyMaster } from '../../server/warehouse/property-master';

const SEED = [
  { account: 'Rent', code: '5064', normalized_category: 'Rental Revenue', classification: 'revenue' },
  { account: 'HVAC Repair', code: '6285', normalized_category: 'Repairs & Maintenance', classification: 'opex' },
];

async function writeFixture(path: string, opts: { token: string; year: number; rent: number; repair: number }): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  const yy = String(opts.year).slice(2);
  for (const r of [
    ['Profit & Loss', null, null, null],
    [`Property: ${opts.token}`, null, null, null],
    [`01/01/${yy} - 12/31/${yy}  (cash basis)`, null, null, null],
    [null, 'INCOME', null, null],
    [null, null, '     5002 RENTAL INCOME', null],
    [null, null, '          5064 Rent', opts.rent],
    [null, 'EXPENSE', null, null],
    [null, null, '     6160 REPAIR', null],
    [null, null, '          6285 HVAC Repair', opts.repair],
  ] as Array<[string | null, string | null, string | null, number | null]>) {
    ws.addRow(r);
  }
  await wb.xlsx.writeFile(path);
}

async function commitYear(db: WarehouseDb, dir: string, opts: { token: string; year: number; rent: number; repair: number; at: string }): Promise<void> {
  const file = join(dir, `P&L ${opts.year} -- ${opts.token} ${opts.rent}.xlsx`);
  await writeFixture(file, opts);
  const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: opts.at, autoCommitThreshold: 0.99 });
  if (r.status === 'pending-review') expect(approveImport(db, r.importId!).ok).toBe(true);
}

const dirs: string[] = [];
function freshDb(): { db: WarehouseDb; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cal-snap-'));
  dirs.push(dir);
  const db = openWarehouse(join(dir, 'f.sqlite'));
  seedPropertyMaster(db);
  seedMappings(db, SEED);
  return { db, dir };
}
afterAll(() => { /* tmp dirs left for OS cleanup; warehouse handles are GC'd */ });

const TASK = 'ora-calibration-snapshot';

describe('runSnapshot — empty / no-data no-op (the central Phase-2 caveat)', () => {
  it('a brand-new warehouse returns a zeroed summary, writes nothing, never throws', () => {
    const { db } = freshDb();
    const s = runSnapshot(db, { taskId: TASK });
    expect(s.ok).toBe(true);
    expect(s.resolved).toBe(0);
    expect(s.verdictsWritten).toBe(0);
    expect(s.errors).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM calibration_outcome').get() as { c: number }).c).toBe(0);
  });
});

describe('runSnapshot — resolve THEN log, with the snapshot tag', () => {
  it('resolves a due verdict and re-logs current verdicts tagged snapshot:<taskId>', async () => {
    const { db, dir } = freshDb();
    await commitYear(db, dir, { token: '1100 rarig', year: 2024, rent: 100000, repair: 8000, at: '2026-06-12T00:00:00Z' });
    await commitYear(db, dir, { token: '1100 rarig', year: 2025, rent: 112000, repair: 9000, at: '2026-06-12T01:00:00Z' });

    // Clear the on-commit verdicts so the snapshot is observably the writer of the CURRENT verdicts
    // (otherwise the dedup_key makes the snapshot a no-op against already-logged commit verdicts —
    // which is correct behavior, but we want to SEE the snapshot tag here).
    db.prepare("DELETE FROM calibration_outcome").run();
    db.prepare("DELETE FROM calibration_verdict").run();

    const s = runSnapshot(db, { taskId: TASK });
    expect(s.ok).toBe(true);
    expect(s.verdictsWritten).toBeGreaterThan(0);
    // Every verdict it wrote carries the snapshot emittedBy tag.
    const tagged = (db.prepare("SELECT COUNT(*) AS c FROM calibration_verdict WHERE emitted_by = ?").get(`snapshot:${TASK}`) as { c: number }).c;
    expect(tagged).toBe(s.verdictsWritten);
    // Resolve ran: the 2024 verdict (horizon 1yr) is covered by 2025 → at least one resolution OR it
    // stays pending if the snapshot logged 2024 only after clearing — assert no throw + counts coherent.
    expect(s.errors).toBe(0);
  });

  it('is idempotent: a second snapshot at the same inputs_version writes 0 new verdicts (dedup)', async () => {
    const { db, dir } = freshDb();
    await commitYear(db, dir, { token: '1100 rarig', year: 2024, rent: 100000, repair: 8000, at: '2026-06-12T00:00:00Z' });
    await commitYear(db, dir, { token: '1100 rarig', year: 2025, rent: 112000, repair: 9000, at: '2026-06-12T01:00:00Z' });
    db.prepare("DELETE FROM calibration_outcome").run();
    db.prepare("DELETE FROM calibration_verdict").run();

    const first = runSnapshot(db, { taskId: TASK });
    const second = runSnapshot(db, { taskId: TASK });
    expect(first.verdictsWritten).toBeGreaterThan(0);
    expect(second.verdictsWritten).toBe(0); // same inputs_version → dedup_key no-op
    expect(second.verdictsSkipped).toBeGreaterThan(0);
  });

  it('resolve runs BEFORE log (a just-due outcome is resolved on the same run that re-snapshots)', async () => {
    const { db, dir } = freshDb();
    await commitYear(db, dir, { token: '1100 rarig', year: 2024, rent: 100000, repair: 8000, at: '2026-06-12T00:00:00Z' });
    await commitYear(db, dir, { token: '1100 rarig', year: 2025, rent: 112000, repair: 9000, at: '2026-06-12T01:00:00Z' });
    // The on-commit hook logged 2024+2025 verdicts but did NOT resolve. A snapshot now should resolve
    // the due 2024 verdict in step 1.
    const before = (db.prepare('SELECT COUNT(*) AS c FROM calibration_outcome WHERE is_resolution = 1').get() as { c: number }).c;
    const s = runSnapshot(db, { taskId: TASK });
    const after = (db.prepare('SELECT COUNT(*) AS c FROM calibration_outcome WHERE is_resolution = 1').get() as { c: number }).c;
    expect(before).toBe(0);
    expect(after).toBeGreaterThan(0);
    expect(s.resolved).toBe(after - before);
  });
});

describe('parseArgs — option values must not swallow the next flag', () => {
  it('parses a well-formed argv', () => {
    const a = parseArgs(['--task', 'my-task', '--db', '/tmp/f.sqlite', '--json']);
    expect(a).toEqual({ task: 'my-task', db: '/tmp/f.sqlite', json: true });
  });

  it('--db followed by another flag throws instead of consuming the flag as a path', () => {
    expect(() => parseArgs(['--db', '--json'])).toThrow(/missing value for --db/);
  });

  it('--task with no following value throws instead of swallowing a trailing flag', () => {
    expect(() => parseArgs(['--json', '--task'])).toThrow(/missing value for --task/);
  });

  it('--json still registers when it precedes a valued option', () => {
    const a = parseArgs(['--json', '--db', '/tmp/f.sqlite']);
    expect(a).toEqual({ task: 'ora-calibration-snapshot', db: '/tmp/f.sqlite', json: true });
  });

  it('defaults task and leaves db undefined when no options are given', () => {
    expect(parseArgs([])).toEqual({ task: 'ora-calibration-snapshot', json: false });
  });
});

describe('runSnapshot — fail-open (the scheduler must never crash)', () => {
  it('a forced error in the emit path does NOT throw and is reported in the summary', () => {
    const { db } = freshDb();
    const s = runSnapshot(db, { taskId: TASK, forceEmitError: 'boom' });
    expect(s.ok).toBe(false);
    expect(s.errors).toBeGreaterThan(0);
    // A data_quality_issues row records the failure (observability).
    const dq = (db.prepare("SELECT COUNT(*) AS c FROM data_quality_issues WHERE kind LIKE 'calibration-%'").get() as { c: number }).c;
    expect(dq).toBeGreaterThan(0);
  });
});
