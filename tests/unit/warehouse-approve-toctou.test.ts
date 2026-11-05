// tests/unit/warehouse-approve-toctou.test.ts
//
// Check-then-write race (TOCTOU) in approveImport, probed with a REAL second writer.
//
// `npm run warehouse:backfill` opens the same WAL warehouse read-write as the dev server (server/warehouse/db.ts),
// so a stale-parser re-derive of an import (ingest.ts: DELETE its ledger rows, re-INSERT them under new AUTOINCREMENT
// ids, keyed to the re-drop filename's detection, held inactive) can land while approveImport is between statements.
// Before the fix, approve read the rows and ran its gates in autocommit statements and wrote in a later DEFERRED
// transaction whose UPDATE-by-id never checked its change count: a re-derive landing after the ledger read made
// approve return {ok:true}, supersede the served version and commit the import with zero active rows, so the
// property-period NOI silently disappeared (5 of 8 boundaries BAD for every re-derive kind, PR #556's sweep).
//
// The probe: connection A runs approveImport; connection B (same file, busy_timeout 0) replays a re-derive's exact
// write set before the k-th statement A prepares, for every k up to and including A's first write. The write set is
// captured from a REAL ingestFile re-derive of the same import on a copy of the same database, so B writes exactly
// what ingest.ts would. A re-derive that cannot get the write lock (SQLITE_BUSY) is serialized behind approve, which is
// what a real backfill does (it waits on busy_timeout), so approve's result is judged on the state it leaves.
//
// GOOD = approve refused and v1 still served unchanged, or approve committed v2 with its 3 rows under the batch's own
// property. Anything else is BAD: the period emptied, NOI served under another key, or ok:true with zero rows.
// Fixtures are synthetic (amounts and statement text are made up; the property ids are canonical seed ids the
// ledger's foreign key needs).
import ExcelJS from 'exceljs';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveImport } from '../../server/warehouse/actions';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { ingestFile } from '../../server/warehouse/ingest';
import { seedMappings } from '../../server/warehouse/mapping';
import { propertyPeriodMetrics } from '../../server/warehouse/metrics';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import { sha256File } from '../../server/warehouse/raw-store';

const RARIG = '1100-rarig-ave-columbus-oh';
const FIFTH = '3540-e-5th-ave-columbus-oh';
const SERVED_NOI = 95_000; // 100,000 rent - 5,000 HVAC; the distribution is excluded from NOI

const SEED = [
  { account: 'Rent', code: '5064', normalized_category: 'Rental Revenue', classification: 'revenue' },
  { account: 'HVAC Repair', code: '6285', normalized_category: 'Repairs & Maintenance', classification: 'opex' },
  { account: 'Distribution to Owner', code: '7402', normalized_category: 'Distributions', classification: 'excluded' },
];

/** Synthetic QB-style P&L. `valued=false` writes the same headers with no valued accounts (parses to 0 rows). */
async function writeFixture(path: string, propertyLine: string, valued = true): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  const rows: Array<[string | null, string | null, string | null, number | null]> = [
    ['Profit & Loss', null, null, null],
    [propertyLine, null, null, null],
    ['01/01/25 - 12/31/25  (cash basis)', null, null, null],
    [null, 'INCOME', null, null],
    [null, null, '     5002 RENTAL INCOME', null],
    ...(valued
      ? ([
          [null, null, '          5064 Rent', 100000],
          [null, 'EXPENSE', null, null],
          [null, null, '     6160 REPAIR', null],
          [null, null, '          6285 HVAC Repair', 5000],
          [null, 'NON OPERATING EXPENSE', null, null],
          [null, null, '          7402 Distribution to Owner', 25000],
        ] as Array<[string | null, string | null, string | null, number | null]>)
      : []),
  ];
  for (const r of rows) ws.addRow(r);
  await wb.xlsx.writeFile(path);
}

type Kind = 'R1 same property' | "R2 re-keyed 'unknown'" | 'R2b re-keyed to another property' | 'R3 parsed to 0 rows';
const KINDS: Array<{ kind: Kind; redropName: string; valued: boolean }> = [
  { kind: 'R1 same property', redropName: 'P&L 2025 -- 1100 Rarig.xlsx', valued: true },
  { kind: "R2 re-keyed 'unknown'", redropName: 'P&L 2025 -- Zorvane Flex Park.xlsx', valued: true },
  { kind: 'R2b re-keyed to another property', redropName: 'P&L 2025 -- 3540 E 5th.xlsx', valued: true },
  { kind: 'R3 parsed to 0 rows', redropName: 'P&L 2025 -- 1100 Rarig.xlsx', valued: false },
];

type LedgerWrite = [string, string, string, string | null, number, string, string, number | null, number];
type IssueWrite = [string | null, string, string, string];
interface WriteSet {
  ledger: LedgerWrite[];
  issues: IssueWrite[];
  batch: Record<string, unknown>;
}

const BATCH_COLS = ['basis', 'source_system', 'period_start', 'period_end', 'period_grain', 'confidence', 'detect_notes', 'parser_version', 'status'];

let root: string;
let basePath: string;
let v1: number;
let v2: number;
const writeSets = new Map<Kind, WriteSet>();

/** Copy the (closed, checkpointed) base warehouse to a fresh file for one run. */
function freshCopy(tag: string): string {
  const dir = join(root, tag);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'w.sqlite');
  copyFileSync(basePath, p);
  return p;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'wha-toctou-'));
  basePath = join(root, 'base.sqlite');
  const db = openWarehouse(basePath);
  seedPropertyMaster(db);
  seedMappings(db, SEED);
  for (const sub of ['v1', 'v2']) mkdirSync(join(root, sub));
  // v1: committed (served) 2025 statement.
  const v1File = join(root, 'v1', 'P&L 2025 -- 1100 Rarig.xlsx');
  await writeFixture(v1File, 'Property: Synthetic Flex Park');
  const r1 = await ingestFile(db, v1File, { rawDir: join(root, 'raw'), importedAt: '2026-11-05T00:00:00Z' });
  expect(r1.status).toBe('committed');
  // v2: a later export of the same property and period, held for review, from an older parser (re-derivable).
  const v2File = join(root, 'v2', 'P&L 2025 -- 1100 Rarig.xlsx');
  await writeFixture(v2File, 'Property: Synthetic Flex Park (corrected export)');
  const r2 = await ingestFile(db, v2File, { rawDir: join(root, 'raw'), importedAt: '2026-11-05T01:00:00Z', autoCommitThreshold: 0.99 });
  expect(r2.status).toBe('pending-review');
  v1 = r1.importId!;
  v2 = r2.importId!;
  db.prepare('UPDATE import_batches SET parser_version = 0 WHERE id = ?').run(v2);
  db.close();

  // Capture each kind's write set from a REAL ingest re-derive of v2 on a copy. registerImport matches on file hash,
  // so the copy's v2 is pointed at the re-drop's hash (identical bytes for R1/R2/R2b; for R3, bytes that parse to 0
  // rows, which is what a parser change yields on the same file).
  for (const { kind, redropName, valued } of KINDS) {
    const dir = join(root, `capture-${KINDS.findIndex((k) => k.kind === kind)}`);
    mkdirSync(join(dir, 'redrop'), { recursive: true });
    const redrop = join(dir, 'redrop', redropName);
    if (valued) copyFileSync(v2File, redrop);
    else await writeFixture(redrop, 'Property: Synthetic Flex Park (corrected export)', false);
    const p = join(dir, 'w.sqlite');
    copyFileSync(basePath, p);
    const cdb = openWarehouse(p);
    cdb.prepare('UPDATE import_batches SET file_hash = ? WHERE id = ?').run(sha256File(redrop), v2);
    const r = await ingestFile(cdb, redrop, { rawDir: join(dir, 'raw'), importedAt: '2026-11-05T02:00:00Z', autoCommitThreshold: 0.99 });
    expect(r).toMatchObject({ status: 'pending-review', importId: v2 }); // re-derived in place, still held
    writeSets.set(kind, {
      ledger: cdb
        .prepare(`SELECT property_id, period, raw_account, gl_code, amount, normalized_category, classification, mapping_id, is_active
                  FROM ledger_entries WHERE import_id = ? ORDER BY id`)
        .raw()
        .all(v2) as LedgerWrite[],
      issues: cdb
        .prepare('SELECT property_id, kind, detail, severity FROM data_quality_issues WHERE import_id = ? ORDER BY id')
        .raw()
        .all(v2) as IssueWrite[],
      batch: cdb.prepare(`SELECT ${BATCH_COLS.join(', ')} FROM import_batches WHERE id = ?`).get(v2) as Record<string, unknown>,
    });
    cdb.close();
  }
});

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows can hold a just-closed WAL file briefly; the OS temp dir is cleaned eventually */
  }
});

/** B replays a re-derive's write set exactly as ingest.ts's transaction does: DELETE the import's ledger and issue
 *  rows, refresh its derived columns, re-INSERT (new AUTOINCREMENT ids). Throws SQLITE_BUSY if A holds the write lock. */
function replayReDerive(b: WarehouseDb, ws: WriteSet): void {
  b.transaction(() => {
    b.prepare('DELETE FROM ledger_entries WHERE import_id = ?').run(v2);
    b.prepare('DELETE FROM data_quality_issues WHERE import_id = ?').run(v2);
    b.prepare(`UPDATE import_batches SET ${BATCH_COLS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(
      ...BATCH_COLS.map((c) => ws.batch[c]),
      v2,
    );
    const ins = b.prepare(`INSERT INTO ledger_entries (import_id, property_id, period, raw_account, gl_code, amount,
      normalized_category, classification, mapping_id, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of ws.ledger) ins.run(v2, ...row);
    const iss = b.prepare('INSERT INTO data_quality_issues (import_id, property_id, kind, detail, severity) VALUES (?, ?, ?, ?, ?)');
    for (const row of ws.issues) iss.run(v2, ...row);
  })();
}

/** Transaction-control statements better-sqlite3 prepares for db.transaction(): not approve's own statements. */
const TXN_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
const WRITE = /^\s*(UPDATE|INSERT|DELETE)\b/i;

/** Wrap A.prepare: call `before(k, sql)` ahead of the k-th approve statement prepared, up to and including the first write. */
function hookPrepares(a: WarehouseDb, before: (k: number, sql: string) => void): { restore: () => void; boundaries: () => number } {
  const prepare = a.prepare.bind(a);
  let k = 0;
  let firstWrite = 0;
  (a as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    if (!TXN_CONTROL.test(sql) && firstWrite === 0) {
      k += 1;
      before(k, sql);
      if (WRITE.test(sql)) firstWrite = k;
    }
    return prepare(sql);
  };
  return {
    restore: () => {
      delete (a as unknown as { prepare?: unknown }).prepare;
    },
    boundaries: () => firstWrite,
  };
}

interface Outcome {
  k: number;
  injected: 'landed' | 'blocked';
  ok: boolean | 'threw';
  bad: string | null;
}

function judge(a: WarehouseDb, ok: boolean | 'threw'): string | null {
  const status = (id: number) => (a.prepare('SELECT status FROM import_batches WHERE id=?').get(id) as { status: string }).status;
  const active = a
    .prepare('SELECT import_id AS importId, property_id AS propertyId FROM ledger_entries WHERE is_active = 1')
    .all() as Array<{ importId: number; propertyId: string }>;
  const v2Active = active.filter((r) => r.importId === v2).length;
  const offKey = active.filter((r) => r.propertyId !== RARIG);
  const noi = propertyPeriodMetrics(a).find((m) => m.propertyId === RARIG && m.period === '2025')?.noi;
  if (ok === true && v2Active === 0) return 'approve returned ok:true but committed zero active rows';
  if (offKey.length > 0) return `NOI served under another key: ${[...new Set(offKey.map((r) => r.propertyId))].join(', ')}`;
  if (noi === undefined) return 'served NOI for the property-period disappeared';
  if (noi !== SERVED_NOI) return `served NOI changed to ${noi}`;
  const refusedGood = ok !== true && status(v1) === 'committed' && active.length === 3 && active.every((r) => r.importId === v1);
  const committedGood =
    ok === true && status(v2) === 'committed' && status(v1) === 'superseded' && active.length === 3 && v2Active === 3;
  return refusedGood || committedGood ? null : `inconsistent end state (v1 ${status(v1)}, v2 ${status(v2)}, active ${active.length})`;
}

/** One run: inject the re-derive before approve's k-th statement (k = 0: no injection, to count the boundaries). */
function runAt(kind: Kind, k: number): { outcome: Outcome; boundaries: number } {
  const p = freshCopy(`${kind.slice(0, 3).trim()}-${k}`);
  const a = openWarehouse(p);
  const b = openWarehouse(p);
  b.pragma('busy_timeout = 0'); // a single thread cannot wait out A's lock: BUSY means "serialized behind approve"
  let injected: Outcome['injected'] = 'blocked';
  const hook = hookPrepares(a, (i) => {
    if (i !== k) return;
    try {
      replayReDerive(b, writeSets.get(kind)!);
      injected = 'landed';
    } catch (e) {
      if (!/SQLITE_BUSY|database is locked/i.test(String((e as { code?: string }).code ?? e))) throw e;
      injected = 'blocked';
    }
  });
  let ok: boolean | 'threw';
  try {
    ok = approveImport(a, v2).ok;
  } catch {
    ok = 'threw';
  } finally {
    hook.restore();
  }
  const outcome: Outcome = { k, injected, ok, bad: judge(a, ok) };
  const boundaries = hook.boundaries();
  a.close();
  b.close();
  return { outcome, boundaries };
}

describe('approveImport check-then-write race (TOCTOU) against a real concurrent re-derive', () => {
  it('the captured write sets are the real re-derive shapes', () => {
    const keys = (kind: Kind) => [...new Set(writeSets.get(kind)!.ledger.map((r) => r[0]))];
    expect(keys('R1 same property')).toEqual([RARIG]);
    expect(keys("R2 re-keyed 'unknown'")).toEqual(['unknown']);
    expect(keys('R2b re-keyed to another property')).toEqual([FIFTH]);
    expect(writeSets.get('R3 parsed to 0 rows')!.ledger).toEqual([]);
    expect(writeSets.get('R3 parsed to 0 rows')!.issues.map((i) => i[1])).toContain('empty-parse');
    for (const { kind } of KINDS) {
      expect(writeSets.get(kind)!.ledger.every((r) => r[8] === 0)).toBe(true); // held inactive
      expect(writeSets.get(kind)!.batch.status).toBe('pending-review');
    }
  });

  it('control: with no concurrent writer, approve commits v2 and the property-period keeps serving the same NOI', () => {
    const { outcome, boundaries } = runAt('R1 same property', 0);
    expect(outcome).toMatchObject({ ok: true, bad: null });
    expect(boundaries).toBe(8); // batch, newer-version, ledger read, 3 x resolveMapping, sign gate, then the first write
  });

  for (const { kind } of KINDS) {
    it(`${kind}: 0 of 8 statement boundaries lose served NOI or return ok while committing zero rows`, () => {
      const { boundaries } = runAt(kind, 0);
      const outcomes: Outcome[] = [];
      for (let k = 1; k <= boundaries; k++) outcomes.push(runAt(kind, k).outcome);
      expect(outcomes).toHaveLength(8);
      expect(outcomes.filter((o) => o.bad !== null)).toEqual([]);
    });
  }

  it('approve holds the write lock for its whole check-and-write: a re-derive at ANY boundary is serialized behind it', () => {
    for (const { kind } of KINDS) {
      for (let k = 1; k <= 8; k++) expect(runAt(kind, k).outcome).toMatchObject({ k, injected: 'blocked', ok: true, bad: null });
    }
  });

  it("the activating UPDATE's change count is asserted: a row it cannot update rolls the whole approve back", () => {
    const p = freshCopy('changes-guard');
    const a = openWarehouse(p);
    // A TEMP trigger makes the UPDATE silently skip one row (changes 0), standing in for a row id that vanished.
    a.exec(`CREATE TEMP TRIGGER skip_rent BEFORE UPDATE OF is_active ON ledger_entries
            WHEN OLD.import_id = ${v2} AND OLD.raw_account = 'Rent' BEGIN SELECT RAISE(IGNORE); END`);
    expect(() => approveImport(a, v2)).toThrow(/activated 2 of 3 ledger rows/);
    expect((a.prepare('SELECT status FROM import_batches WHERE id=?').get(v1) as { status: string }).status).toBe('committed');
    expect((a.prepare('SELECT status FROM import_batches WHERE id=?').get(v2) as { status: string }).status).toBe('pending-review');
    expect(judge(a, 'threw')).toBeNull(); // v1 still served, nothing of v2 active
    a.close();
  });
});
