import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/warehouse/migrate';
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
