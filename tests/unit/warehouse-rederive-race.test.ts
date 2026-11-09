// tests/unit/warehouse-rederive-race.test.ts
//
// Check-then-write race in ingestFile's stale-parser RE-DERIVE, probed with a REAL second writer (the reverse order of
// warehouse-approve-toctou.test.ts, which actions.ts's Concurrency note leaves to ingest.ts).
//
// `npm run warehouse:backfill` and the dev server open the same WAL warehouse read-write (server/warehouse/db.ts). A
// re-derive decides whether to roll itself back (RestaleAbort) from the batch's status BEFORE the re-derive: a
// 'committed' (serving) batch that no longer qualifies must keep its prior ledger. When that status was read outside the
// re-derive's write transaction, a user approve landing between the read and the transaction committed the batch
// (superseding the served version), the stale 'pending-review' read let the re-derive through, and the re-derive then
// deactivated the just-committed rows and flipped the batch back to pending-review: no active version, so the
// property-period's NOI silently disappeared. A reject landing in the same window was undone the same way (a rejected
// batch flipped back into the review queue).
//
// The probe: connection A runs ingestFile on the batch's own file (hash-identical, stale parser => re-derive in place,
// held for review by a 0.99 threshold so it does NOT qualify to commit). Connection B (same file, busy_timeout 0) runs
// the user action before the k-th statement A prepares, for every k of the run. An action that cannot get the write
// lock (SQLITE_BUSY) is serialized behind the re-derive, which is what a real request does (busy_timeout, or api.ts's
// retryable 503), so it is run again once the re-derive returns. Every run is then judged on the state it leaves.
// Fixtures are synthetic (amounts and statement text are made up; the property id is a canonical seed id the ledger's
// foreign key needs).
import ExcelJS from 'exceljs';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveImport, rejectImport } from '../../server/warehouse/actions';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { ingestFile } from '../../server/warehouse/ingest';
import type { IngestResult } from '../../server/warehouse/ingest';
import { seedMappings } from '../../server/warehouse/mapping';
import { propertyPeriodMetrics } from '../../server/warehouse/metrics';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import { sha256File } from '../../server/warehouse/raw-store';

const RARIG = '1100-rarig-ave-columbus-oh';
const SERVED_NOI = 95_000; // 100,000 rent - 5,000 HVAC; the distribution is excluded from NOI

const SEED = [
  { account: 'Rent', code: '5064', normalized_category: 'Rental Revenue', classification: 'revenue' },
  { account: 'HVAC Repair', code: '6285', normalized_category: 'Repairs & Maintenance', classification: 'opex' },
  { account: 'Distribution to Owner', code: '7402', normalized_category: 'Distributions', classification: 'excluded' },
];

async function writeFixture(path: string, propertyLine: string): Promise<void> {
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

let root: string;
let basePath: string;
let newBasePath: string;
let v2File: string;
let v3File: string;
let v1: number;
let v2: number;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'wh-rederive-race-'));
  basePath = join(root, 'base.sqlite');
  const db = openWarehouse(basePath);
  seedPropertyMaster(db);
  seedMappings(db, SEED);
  for (const sub of ['v1', 'v2']) mkdirSync(join(root, sub));
  // v1: committed (served) 2025 statement.
  const v1File = join(root, 'v1', 'P&L 2025 -- 1100 Rarig.xlsx');
  await writeFixture(v1File, 'Property: Synthetic Flex Park');
  const r1 = await ingestFile(db, v1File, { rawDir: join(root, 'raw'), importedAt: '2026-11-08T00:00:00Z' });
  expect(r1.status).toBe('committed');
  // Base for the NEW-import scenarios: only v1 (served). v3 is a fresh export of the same period that ingest registers.
  db.pragma('wal_checkpoint(TRUNCATE)');
  newBasePath = join(root, 'new-base.sqlite');
  copyFileSync(basePath, newBasePath);
  mkdirSync(join(root, 'v3'));
  v3File = join(root, 'v3', 'P&L 2025 -- 1100 Rarig.xlsx');
  await writeFixture(v3File, 'Property: Synthetic Flex Park (re-export)');
  // v2: a later export of the same property and period, held for review, from an older parser (re-derivable).
  v2File = join(root, 'v2', 'P&L 2025 -- 1100 Rarig.xlsx');
  await writeFixture(v2File, 'Property: Synthetic Flex Park (corrected export)');
  const r2 = await ingestFile(db, v2File, { rawDir: join(root, 'raw'), importedAt: '2026-11-08T01:00:00Z', autoCommitThreshold: 0.99 });
  expect(r2.status).toBe('pending-review');
  v1 = r1.importId!;
  v2 = r2.importId!;
  db.prepare('UPDATE import_batches SET parser_version = 0 WHERE id = ?').run(v2);
  db.close();
});

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows can hold a just-closed WAL file briefly; the OS temp dir is cleaned eventually */
  }
});

function freshCopy(tag: string, from = basePath): string {
  const dir = join(root, tag);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'w.sqlite');
  copyFileSync(from, p);
  return p;
}

/** What A ingests: the stale-parser RE-DERIVE of v2 (held for review), or a NEW import of v3 (`threshold` decides
 *  whether it auto-commits). B's action targets the batch registered for that file, looked up by hash. */
interface Scenario {
  name: string;
  base: () => string;
  file: () => string;
  threshold: number;
}
const REDERIVE: Scenario = { name: 'rederive', base: () => basePath, file: () => v2File, threshold: 0.99 };
const NEW_COMMITTING: Scenario = { name: 'new-commit', base: () => newBasePath, file: () => v3File, threshold: 0.85 };
const NEW_HELD: Scenario = { name: 'new-held', base: () => newBasePath, file: () => v3File, threshold: 0.99 };

const TXN_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

/** Wrap A.prepare: call `before(k)` ahead of the k-th statement ingestFile prepares. */
function hookPrepares(a: WarehouseDb, before: (k: number) => void): { restore: () => void; count: () => number } {
  const prepare = a.prepare.bind(a);
  let k = 0;
  (a as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    if (!TXN_CONTROL.test(sql)) {
      k += 1;
      before(k);
    }
    return prepare(sql);
  };
  return {
    restore: () => {
      delete (a as unknown as { prepare?: unknown }).prepare;
    },
    count: () => k,
  };
}

const status = (db: WarehouseDb, id: number) =>
  (db.prepare('SELECT status FROM import_batches WHERE id=?').get(id) as { status: string }).status;

interface Run {
  k: number;
  injected: 'landed' | 'blocked' | 'none';
  actOk: boolean;
  ingest: IngestResult;
  v1: string;
  /** status of the scenario's batch (v2 re-derived, or the new v3) */
  v2: string;
  target: number;
  active: Array<{ importId: number }>;
  noi: number | undefined;
}

/** B's action on the scenario's batch. */
type Act = (b: WarehouseDb, id: number) => boolean;

/** One run: B performs `act` on the scenario's batch before A's k-th prepared statement of the ingest (k = 0: never,
 *  counts them). An action that is blocked, or whose batch is not registered yet at that boundary (no user could act on
 *  it), runs once the ingest returns — serialized behind it, as a real request is. */
async function runAt(k: number, act: Act, sc: Scenario = REDERIVE): Promise<{ run: Run; boundaries: number }> {
  const p = freshCopy(`${sc.name}-k${k}-${Math.random().toString(36).slice(2, 8)}`, sc.base());
  const hash = sha256File(sc.file());
  const targetOf = (db: WarehouseDb) =>
    (db.prepare('SELECT id FROM import_batches WHERE file_hash = ?').get(hash) as { id: number } | undefined)?.id;
  const act1 = (db: WarehouseDb): boolean | null => {
    const id = targetOf(db);
    return id === undefined ? null : act(db, id);
  };
  const a = openWarehouse(p);
  const b = openWarehouse(p);
  b.pragma('busy_timeout = 0'); // a single thread cannot wait out A's lock: BUSY means "serialized behind the re-derive"
  // A holder, not `let`s: the hook assigns from a closure, which TypeScript's narrowing does not see.
  const st: { injected: Run['injected']; actOk: boolean } = { injected: 'none', actOk: false };
  const hook = hookPrepares(a, (i) => {
    if (i !== k) return;
    try {
      const r = act1(b);
      if (r === null) return; // batch not registered yet
      st.actOk = r;
      st.injected = 'landed';
    } catch (e) {
      if (!/SQLITE_BUSY|database is locked/i.test(String((e as { code?: string }).code ?? e))) throw e;
      st.injected = 'blocked';
    }
  });
  let ingest: IngestResult;
  try {
    ingest = await ingestFile(a, sc.file(), {
      rawDir: join(root, `raw-${sc.name}`),
      importedAt: '2026-11-08T02:00:00Z',
      autoCommitThreshold: sc.threshold,
    });
  } finally {
    hook.restore();
  }
  if (k > 0 && st.injected !== 'landed') st.actOk = act1(b) ?? false; // serialized behind the ingest
  const target = targetOf(a)!;
  const run: Run = {
    k,
    injected: st.injected,
    actOk: st.actOk,
    ingest,
    v1: status(a, v1),
    v2: status(a, target),
    target,
    active: a.prepare('SELECT import_id AS importId FROM ledger_entries WHERE is_active = 1').all() as Array<{ importId: number }>,
    noi: propertyPeriodMetrics(a).find((m) => m.propertyId === RARIG && m.period === '2025')?.noi,
  };
  const boundaries = hook.count();
  a.close();
  b.close();
  return { run, boundaries };
}

/** Exactly one committed version serving its 3 rows with the expected NOI; returns the serving import or a failure. */
function served(r: Run): { serving: number | null; bad: string | null } {
  const v1Serving = r.v1 === 'committed' && r.active.length === 3 && r.active.every((x) => x.importId === v1);
  const v2Serving =
    r.v2 === 'committed' && r.v1 === 'superseded' && r.active.length === 3 && r.active.every((x) => x.importId === r.target);
  if (r.noi === undefined) return { serving: null, bad: 'served NOI for the property-period disappeared' };
  if (r.noi !== SERVED_NOI) return { serving: null, bad: `served NOI changed to ${r.noi}` };
  if (!v1Serving && !v2Serving) return { serving: null, bad: `inconsistent end state (v1 ${r.v1}, v2 ${r.v2}, active ${r.active.length})` };
  return { serving: v1Serving ? v1 : r.target, bad: null };
}

const approve: Act = (b, id) => approveImport(b, id).ok;
const reject: Act = (b, id) => rejectImport(b, id).ok;

describe('stale-parser re-derive vs a concurrent approve/reject (prior-status check-then-write)', () => {
  it('control: with no concurrent writer the re-derive holds v2 for review and v1 keeps serving', async () => {
    const { run, boundaries } = await runAt(0, approve);
    expect(run.ingest).toMatchObject({ status: 'pending-review', importId: v2 });
    expect(served(run)).toEqual({ serving: v1, bad: null });
    expect(run.v2).toBe('pending-review');
    expect(boundaries).toBeGreaterThan(4);
  });

  it('approve at ANY statement boundary of the re-derive: the approved version stays committed and serving', async () => {
    const { boundaries } = await runAt(0, approve);
    const failures: string[] = [];
    for (let k = 1; k <= boundaries; k++) {
      const { run } = await runAt(k, approve);
      const s = served(run);
      if (s.bad) failures.push(`k=${k} (${run.injected}): ${s.bad}`);
      else if (run.actOk && s.serving !== v2) failures.push(`k=${k} (${run.injected}): approve ok:true but v2 is ${run.v2}`);
      else if (!run.actOk) failures.push(`k=${k} (${run.injected}): approve refused`);
      // an approve that landed BEFORE the re-derive wrote: the re-derive must not claim it held a committed batch for review
      else if (run.injected === 'landed' && run.ingest.status === 'pending-review') failures.push(`k=${k} (${run.injected}): ingest reported pending-review for a committed batch`);
    }
    expect(failures).toEqual([]);
  });

  it('reject at ANY statement boundary of the re-derive: the rejected batch stays rejected and v1 keeps serving', async () => {
    const { boundaries } = await runAt(0, reject);
    const failures: string[] = [];
    for (let k = 1; k <= boundaries; k++) {
      const { run } = await runAt(k, reject);
      const s = served(run);
      if (s.bad) failures.push(`k=${k} (${run.injected}): ${s.bad}`);
      else if (!run.actOk) failures.push(`k=${k} (${run.injected}): reject refused`);
      else if (run.v2 !== 'rejected') failures.push(`k=${k} (${run.injected}): reject ok:true but v2 is ${run.v2}`);
      else if (s.serving !== v1) failures.push(`k=${k} (${run.injected}): v1 not serving`);
      // a reject that landed before the re-derive's write lock: the re-derive finds nothing re-derivable and writes nothing
      else if (run.injected === 'landed' && run.ingest.status !== 'duplicate') failures.push(`k=${k}: ingest reported ${run.ingest.status}`);
    }
    expect(failures).toEqual([]);
  });

  it('a re-derive that cannot get the write lock surfaces SQLITE_BUSY (never swallowed) and writes nothing', async () => {
    const p = freshCopy(`busy-${Math.random().toString(36).slice(2, 8)}`);
    const a = openWarehouse(p);
    a.pragma('busy_timeout = 0');
    const b = openWarehouse(p);
    b.exec('BEGIN IMMEDIATE'); // a peer writer (e.g. an approve) holds the write lock
    try {
      await expect(
        ingestFile(a, v2File, { rawDir: join(root, 'raw'), importedAt: '2026-11-08T03:00:00Z', autoCommitThreshold: 0.99 }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^SQLITE_BUSY/) });
    } finally {
      b.exec('ROLLBACK');
    }
    const row = a.prepare('SELECT status, parser_version FROM import_batches WHERE id = ?').get(v2) as { status: string; parser_version: number };
    expect(row).toEqual({ status: 'pending-review', parser_version: 0 }); // untouched: still re-derivable on retry
    a.close();
    b.close();
  });
});

describe('a NEW import interrupted between registration and its transaction is resumable', () => {
  /** Run ingest of v3 on A, calling `between(b)` right after registerImport's INSERT (before the ingest transaction). */
  async function ingestWithGap(a: WarehouseDb, b: WarehouseDb, between: (b: WarehouseDb) => void): Promise<IngestResult> {
    let armed = false;
    let fired = false;
    const hook = hookPrepares(a, () => {
      if (armed && !fired) {
        fired = true;
        between(b);
      }
    });
    const prepare = (a as unknown as { prepare: (sql: string) => unknown }).prepare;
    (a as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      const st = prepare(sql);
      if (/^\s*INSERT INTO import_batches\b/i.test(sql)) armed = true; // the NEXT prepare is after the INSERT ran
      return st;
    };
    try {
      return await ingestFile(a, v3File, { rawDir: join(root, 'raw-gap'), importedAt: '2026-11-09T00:00:00Z' });
    } finally {
      hook.restore();
      expect(fired).toBe(true);
    }
  }

  it('SQLITE_BUSY at the ingest transaction, then a retry: the corrected statement lands and is served', async () => {
    const p = freshCopy(`resume-${Math.random().toString(36).slice(2, 8)}`, newBasePath);
    const a = openWarehouse(p);
    a.pragma('busy_timeout = 0');
    const b = openWarehouse(p);
    await expect(ingestWithGap(a, b, (bb) => bb.exec('BEGIN IMMEDIATE'))).rejects.toMatchObject({
      code: expect.stringMatching(/^SQLITE_BUSY/),
    });
    b.exec('ROLLBACK');
    const v3 = (a.prepare('SELECT id FROM import_batches WHERE file_hash = ?').get(sha256File(v3File)) as { id: number }).id;
    expect(status(a, v3)).toBe('pending-review'); // the registration row survived the failed transaction
    const retry = await ingestFile(a, v3File, { rawDir: join(root, 'raw-gap'), importedAt: '2026-11-09T00:01:00Z' });
    expect(retry).toMatchObject({ status: 'committed', importId: v3 });
    expect(status(a, v3)).toBe('committed');
    expect(status(a, v1)).toBe('superseded');
    const active = a.prepare('SELECT import_id AS importId FROM ledger_entries WHERE is_active = 1').all() as Array<{ importId: number }>;
    expect(active.length).toBe(3);
    expect(active.every((r) => r.importId === v3)).toBe(true);
    expect(propertyPeriodMetrics(a).find((m) => m.propertyId === RARIG && m.period === '2025')?.noi).toBe(SERVED_NOI);
    expect((a.prepare('SELECT COUNT(*) c FROM import_batches').get() as { c: number }).c).toBe(2); // resumed, not re-registered
    a.close();
    b.close();
  });

  it('a registration another writer finished in the gap is not ingested twice', async () => {
    const p = freshCopy(`twice-${Math.random().toString(36).slice(2, 8)}`, newBasePath);
    const a = openWarehouse(p);
    const b = openWarehouse(p);
    const hash = sha256File(v3File);
    // Stand-in for a concurrent ingest that resumed this registration and finished it (held for review, one DQ row).
    const r = await ingestWithGap(a, b, (bb) => {
      const id = (bb.prepare('SELECT id FROM import_batches WHERE file_hash = ?').get(hash) as { id: number }).id;
      bb.prepare("INSERT INTO data_quality_issues (import_id, property_id, kind, detail, severity) VALUES (?, ?, 'foot-mismatch', 'synthetic', 'warn')").run(id, RARIG);
    });
    expect(r.status).toBe('skipped');
    expect((a.prepare('SELECT COUNT(*) c FROM ledger_entries WHERE import_id = ?').get(r.importId) as { c: number }).c).toBe(0);
    expect(status(a, v1)).toBe('committed');
    a.close();
    b.close();
  });

  it('a fully ingested held-for-review import is still a duplicate on re-drop (not resumed)', async () => {
    const p = freshCopy(`emptydup-${Math.random().toString(36).slice(2, 8)}`, newBasePath);
    const a = openWarehouse(p);
    const first = await ingestFile(a, v3File, { rawDir: join(root, 'raw-gap'), importedAt: '2026-11-09T00:00:00Z', autoCommitThreshold: 0.99 });
    expect(first.status).toBe('pending-review');
    expect((await ingestFile(a, v3File, { rawDir: join(root, 'raw-gap'), importedAt: '2026-11-09T00:01:00Z' })).status).toBe('duplicate');
    a.close();
  });
});

describe('ingest status flips are guarded and change-counted', () => {
  it('a commit flip that does not hit exactly one row rolls the whole ingest back (supersede included)', async () => {
    const p = freshCopy(`flip-${Math.random().toString(36).slice(2, 8)}`, newBasePath);
    const a = openWarehouse(p);
    // A TEMP trigger makes the flip silently skip its row (changes 0), standing in for a status changed under it.
    a.exec(`CREATE TEMP TRIGGER skip_commit BEFORE UPDATE OF status ON import_batches
            WHEN OLD.file_hash = '${sha256File(v3File)}' AND NEW.status = 'committed' BEGIN SELECT RAISE(IGNORE); END`);
    await expect(
      ingestFile(a, v3File, { rawDir: join(root, 'raw-flip'), importedAt: '2026-11-08T04:00:00Z' }),
    ).rejects.toThrow(/no longer pending-review at the commit flip/);
    expect(status(a, v1)).toBe('committed'); // the supersede rolled back with it
    expect((a.prepare('SELECT COUNT(*) c FROM ledger_entries WHERE is_active = 1 AND import_id = ?').get(v1) as { c: number }).c).toBe(3);
    a.close();
  });
});

describe('NEW import vs a concurrent reject/approve (registration INSERT runs before the ingest transaction)', () => {
  for (const sc of [NEW_COMMITTING, NEW_HELD]) {
    it(`${sc.name}: a reject at ANY boundary stays rejected, and a rejected batch never commits or serves`, async () => {
      const { run: control, boundaries } = await runAt(0, reject, sc);
      expect(control.ingest.status).toBe(sc === NEW_COMMITTING ? 'committed' : 'pending-review');
      const failures: string[] = [];
      let landed = 0;
      for (let k = 1; k <= boundaries; k++) {
        const { run } = await runAt(k, reject, sc);
        if (run.injected === 'landed') landed += 1;
        const s = served(run);
        if (s.bad) failures.push(`k=${k} (${run.injected}): ${s.bad}`);
        else if (run.actOk && run.v2 !== 'rejected') failures.push(`k=${k} (${run.injected}): reject ok:true but the batch is ${run.v2}`);
        else if (run.actOk && s.serving !== v1) failures.push(`k=${k} (${run.injected}): reject ok:true but v1 not serving`);
        else if (run.injected === 'landed' && run.ingest.status !== 'skipped') failures.push(`k=${k}: ingest reported ${run.ingest.status} for a batch rejected under it`);
      }
      expect(failures).toEqual([]);
      expect(landed).toBeGreaterThan(0); // the window between registration and the transaction was actually probed
    });

    it(`${sc.name}: an approve at ANY boundary never loses served NOI and never answers ok:true for a batch it did not commit`, async () => {
      const { boundaries } = await runAt(0, approve, sc);
      const failures: string[] = [];
      for (let k = 1; k <= boundaries; k++) {
        const { run } = await runAt(k, approve, sc);
        const s = served(run);
        if (s.bad) failures.push(`k=${k} (${run.injected}): ${s.bad}`);
        else if (run.actOk && s.serving !== run.target) failures.push(`k=${k} (${run.injected}): approve ok:true but the batch is ${run.v2}`);
      }
      expect(failures).toEqual([]);
    });
  }
});
