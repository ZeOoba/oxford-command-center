import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/warehouse/migrate';
import { openWarehouseReadOnly } from '../../server/warehouse/db';
import {
  loadBackupKey,
  encryptFile,
  decryptFile,
  snapshotWarehouse,
  tableCounts,
  verifySnapshot,
  selectSnapshotsToDelete,
} from '../../server/warehouse/backup';

const KEY_HEX = 'a'.repeat(64);
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ora-backup-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadBackupKey', () => {
  it('returns 32 bytes from a 64-hex-char env var', () => {
    expect(loadBackupKey({ BACKUP_KEY_HEX: KEY_HEX } as NodeJS.ProcessEnv)).toHaveLength(32);
  });

  it('throws a generation hint when unset', () => {
    expect(() => loadBackupKey({} as NodeJS.ProcessEnv)).toThrow(/BACKUP_KEY_HEX is not set/);
  });

  it('rejects a key that is not exactly 64 hex characters', () => {
    expect(() => loadBackupKey({ BACKUP_KEY_HEX: 'abc' } as NodeJS.ProcessEnv)).toThrow(/64 hex/);
  });
});

describe('encryptFile / decryptFile', () => {
  it('round-trips a file byte-for-byte', () => {
    const key = loadBackupKey({ BACKUP_KEY_HEX: KEY_HEX } as NodeJS.ProcessEnv);
    const src = join(dir, 'plain.bin');
    const payload = Buffer.from('oxford realty advisors warehouse payload');
    writeFileSync(src, payload);
    encryptFile(src, join(dir, 'c.enc'), key);
    decryptFile(join(dir, 'c.enc'), join(dir, 'out.bin'), key);
    expect(readFileSync(join(dir, 'out.bin')).equals(payload)).toBe(true);
  });

  it('does not leave plaintext in the ciphertext', () => {
    const key = loadBackupKey({ BACKUP_KEY_HEX: KEY_HEX } as NodeJS.ProcessEnv);
    const src = join(dir, 'plain.bin');
    writeFileSync(src, Buffer.from('TENANT_SECRET_MARKER'));
    encryptFile(src, join(dir, 'c.enc'), key);
    expect(readFileSync(join(dir, 'c.enc')).includes('TENANT_SECRET_MARKER')).toBe(false);
  });

  it('refuses to decrypt a tampered file', () => {
    const key = loadBackupKey({ BACKUP_KEY_HEX: KEY_HEX } as NodeJS.ProcessEnv);
    const src = join(dir, 'plain.bin');
    writeFileSync(src, Buffer.from('payload'));
    encryptFile(src, join(dir, 'c.enc'), key);
    const bytes = readFileSync(join(dir, 'c.enc'));
    const last = bytes.length - 1;
    bytes.writeUInt8(bytes.readUInt8(last) ^ 0xff, last);
    writeFileSync(join(dir, 'c.enc'), bytes);
    expect(() => decryptFile(join(dir, 'c.enc'), join(dir, 'out.bin'), key)).toThrow();
  });

  it('refuses a file whose magic header is wrong', () => {
    const key = loadBackupKey({ BACKUP_KEY_HEX: KEY_HEX } as NodeJS.ProcessEnv);
    writeFileSync(join(dir, 'bogus.enc'), Buffer.from('NOTORAB1 and some bytes'));
    expect(() => decryptFile(join(dir, 'bogus.enc'), join(dir, 'out.bin'), key)).toThrow(
      /not an ORA backup/,
    );
  });
});

describe('snapshotWarehouse + verifySnapshot', () => {
  it('produces a snapshot whose row counts match the source', async () => {
    const live = join(dir, 'finance.sqlite');
    const db = new Database(live);
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      `INSERT INTO property_master (id, name, financial_mode, ownership_pct, ownership_status)
       VALUES ('p1', 'Test Property', 'pnl', 1.0, 'active')`,
    ).run();

    const snap = join(dir, 'snap.sqlite');
    await snapshotWarehouse(db, snap);
    const expected = tableCounts(live, ['property_master']);
    const result = verifySnapshot(snap, expected);

    expect(expected).toEqual({ property_master: 1 });
    expect(result.integrity).toBe('ok');
    expect(result.mismatches).toEqual([]);
    expect(result.ok).toBe(true);
    db.close();
  });

  it('reports a mismatch when the expected counts disagree', async () => {
    const live = join(dir, 'finance.sqlite');
    const db = new Database(live);
    runMigrations(db);
    const snap = join(dir, 'snap.sqlite');
    await snapshotWarehouse(db, snap);
    const result = verifySnapshot(snap, { property_master: 99 });
    expect(result.ok).toBe(false);
    expect(result.mismatches[0]).toMatch(/property_master.*expected 99.*got 0/);
    db.close();
  });
});

describe('empty-baseline fail-closed (weekly sweep 2026-09-21, HIGH)', () => {
  it('verifySnapshot refuses to certify a snapshot when the baseline has zero tables', async () => {
    // A missing source file used to become an EMPTY database on open, so expected = {} and the
    // comparison was vacuously true: "backup ok (0 tables)", exit 0, and the restore drill passed.
    const live = join(dir, 'empty.sqlite');
    new Database(live).close();
    const snap = join(dir, 'empty-snap.sqlite');
    const db = openWarehouseReadOnly(live);
    await snapshotWarehouse(db, snap);
    db.close();
    const result = verifySnapshot(snap, {});
    expect(result.integrity).toBe('ok');
    expect(result.ok).toBe(false);
    expect(result.mismatches.join(' ')).toMatch(/no tables/);
  });

  it('snapshotWarehouse works from a read-only handle (the handle the backup job now uses)', async () => {
    const live = join(dir, 'finance.sqlite');
    const rw = new Database(live);
    runMigrations(rw);
    rw.prepare(
      `INSERT INTO property_master (id, name, financial_mode, ownership_pct, ownership_status)
       VALUES ('p1', 'Test Property', 'pnl', 1.0, 'active')`,
    ).run();
    rw.close();

    const ro = openWarehouseReadOnly(live);
    const snap = join(dir, 'snap.sqlite');
    await snapshotWarehouse(ro, snap);
    ro.close();
    expect(verifySnapshot(snap, tableCounts(live, ['property_master'])).ok).toBe(true);
  });

  it('the backup script exits non-zero and creates NOTHING when WAREHOUSE_DB does not exist', () => {
    const missing = join(dir, 'nested-dir-exists');
    // Directory present, file absent: the exact reproduction from the sweep. (A bare
    // `new Database(path)` creates a 0-byte file here.)
    rmSync(missing, { recursive: true, force: true });
    const backupDir = join(dir, 'backups');
    const dbPath = join(dir, 'finance.sqlite'); // dir exists, file does not
    expect(existsSync(dbPath)).toBe(false);

    const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/warehouse-backup.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, WAREHOUSE_DB: dbPath, BACKUP_DIR: backupDir, BACKUP_KEY_HEX: KEY_HEX },
      encoding: 'utf8',
      timeout: 60_000,
    });

    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/BACKUP FAILED/);
    expect(r.stdout).not.toMatch(/backup ok/);
    expect(existsSync(dbPath)).toBe(false); // no empty database was conjured
    expect(existsSync(join(backupDir, 'manifest.json'))).toBe(false);
    expect(existsSync(backupDir)).toBe(false); // a failed open creates nothing at all, not even the directory
  }, 90_000);
});

describe('restore drill without a manifest (refute round)', () => {
  const run = (script: string, env: Record<string, string>) =>
    spawnSync(process.execPath, ['--import', 'tsx', script], {
      cwd: process.cwd(),
      env: { ...process.env, ...env, BACKUP_KEY_HEX: KEY_HEX },
      encoding: 'utf8',
      timeout: 60_000,
    });

  it('names the missing manifest, not an "empty snapshot", when the backup itself is full', () => {
    const dbPath = join(dir, 'finance.sqlite');
    const seed = new Database(dbPath);
    runMigrations(seed);
    seed.close();
    const backupDir = join(dir, 'backups');

    const b = run('scripts/warehouse-backup.ts', { WAREHOUSE_DB: dbPath, BACKUP_DIR: backupDir });
    expect(b.status).toBe(0);
    rmSync(join(backupDir, 'manifest.json'));

    const r = run('scripts/warehouse-restore-verify.ts', { BACKUP_DIR: backupDir });
    expect(r.status).toBe(1); // no manifest -> age unknowable -> still fails, as before this branch
    const out = r.stderr + r.stdout;
    expect(out).not.toMatch(/empty snapshot cannot be certified/);
    expect(out).toMatch(/manifest.*missing|old|Infinity|not running/i);
  }, 120_000);
});

describe('selectSnapshotsToDelete', () => {
  const name = (iso: string) => `finance-${iso}.sqlite.enc`;
  const now = new Date('2026-09-17T03:00:00Z');

  it('keeps every snapshot inside the daily window', () => {
    const names = [name('2026-09-17T0300'), name('2026-09-16T0300'), name('2026-09-10T0300')];
    expect(selectSnapshotsToDelete(names, now, 14, 8)).toEqual([]);
  });

  it('keeps one per ISO week outside the daily window', () => {
    const names = [
      name('2026-08-03T0300'), // Mon, week 32
      name('2026-08-05T0300'), // Wed, week 32 — same week, older kept, this one dropped
      name('2026-08-10T0300'), // Mon, week 33
    ];
    expect(selectSnapshotsToDelete(names, now, 14, 8)).toEqual([name('2026-08-05T0300')]);
  });

  it('drops weekly snapshots beyond the weekly window', () => {
    // Three snapshots, not two: with only two the MIN_SNAPSHOTS_KEPT floor would spare the old
    // one, and this test is about the weekly window, not the floor (which has its own tests).
    const names = [name('2026-01-05T0300'), name('2026-09-14T0300'), name('2026-09-16T0300')];
    expect(selectSnapshotsToDelete(names, now, 14, 8)).toEqual([name('2026-01-05T0300')]);
  });

  it('ignores files that do not match the snapshot naming convention', () => {
    expect(selectSnapshotsToDelete(['notes.txt', 'finance.sqlite'], now, 14, 8)).toEqual([]);
  });
});

describe('selectSnapshotsToDelete — retention floor', () => {
  const name = (iso: string) => `finance-${iso}.sqlite.enc`;
  const now = new Date('2026-09-17T03:00:00Z');

  it('never deletes the only snapshot, however old', () => {
    expect(selectSnapshotsToDelete([name('2020-01-05T0300')], now, 14, 8)).toEqual([]);
  });

  it('keeps the floor when every snapshot is beyond every window', () => {
    const names = [name('2020-01-05T0300'), name('2020-02-05T0300'), name('2020-03-05T0300')];
    const doomed = selectSnapshotsToDelete(names, now, 14, 8);
    expect(names.length - doomed.length).toBe(2);
    // the survivors are the NEWEST two
    expect(doomed).toEqual([name('2020-01-05T0300')]);
  });
});
