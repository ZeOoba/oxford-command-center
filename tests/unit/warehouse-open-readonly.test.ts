import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWarehouse, openWarehouseNoMigrate, openWarehouseReadOnly } from '../../server/warehouse/db';
import { pendingMigrations, runMigrations } from '../../server/warehouse/migrate';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ora-ro-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('openWarehouseReadOnly', () => {
  it('reads an existing warehouse', () => {
    const path = join(dir, 'finance.sqlite');
    const rw = openWarehouse(path);
    rw.prepare(
      `INSERT INTO property_master (id, name, financial_mode, ownership_pct, ownership_status)
       VALUES ('p1','Readable','pnl',1.0,'active')`,
    ).run();
    rw.close();

    const ro = openWarehouseReadOnly(path);
    try {
      expect(
        (ro.prepare('SELECT COUNT(*) AS n FROM property_master').get() as { n: number }).n,
      ).toBe(1);
    } finally {
      ro.close();
    }
  });

  it('refuses to write', () => {
    const path = join(dir, 'finance.sqlite');
    openWarehouse(path).close();
    const ro = openWarehouseReadOnly(path);
    try {
      expect(() =>
        ro
          .prepare(
            `INSERT INTO property_master (id, name, financial_mode, ownership_pct, ownership_status)
             VALUES ('p2','Nope','pnl',1.0,'active')`,
          )
          .run(),
      ).toThrow(/readonly/i);
    } finally {
      ro.close();
    }
  });

  it('does not create a database that is not there, and does not migrate one that is', () => {
    // The whole point: a reader must never bring a schema into existence. openWarehouse would
    // mkdir, create the file and apply every migration; this must throw instead.
    expect(() => openWarehouseReadOnly(join(dir, 'nope', 'missing.sqlite'))).toThrow();

    // And on a real-but-empty file it must not populate _migrations.
    const path = join(dir, 'blank.sqlite');
    const seed = openWarehouse(path);
    const applied = (
      seed.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }
    ).n;
    seed.close();

    const ro = openWarehouseReadOnly(path);
    try {
      expect((ro.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }).n).toBe(
        applied,
      );
    } finally {
      ro.close();
    }
  });
});

describe('openWarehouseNoMigrate (weekly sweep 2026-09-21)', () => {
  it('opens a current warehouse read-write', () => {
    const path = join(dir, 'finance.sqlite');
    openWarehouse(path).close();
    const db = openWarehouseNoMigrate(path);
    try {
      db.prepare(
        `INSERT INTO property_master (id, name, financial_mode, ownership_pct, ownership_status)
         VALUES ('p9','Writable','pnl',1.0,'active')`,
      ).run();
      expect((db.prepare('SELECT COUNT(*) AS n FROM property_master').get() as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
  });

  it('does not create a database that is not there', () => {
    const path = join(dir, 'nope.sqlite');
    expect(() => openWarehouseNoMigrate(path)).toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it('refuses a warehouse that is behind this code and applies NOTHING to it', () => {
    const path = join(dir, 'behind.sqlite');
    const seed = openWarehouse(path);
    // Pretend the newest migration was never applied (the live DB when a branch adds a migration).
    const newest = (
      seed.prepare('SELECT filename FROM _migrations ORDER BY id DESC LIMIT 1').get() as { filename: string }
    ).filename;
    seed.prepare('DELETE FROM _migrations WHERE filename = ?').run(newest);
    const before = (seed.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }).n;
    seed.close();

    let message = '';
    try {
      openWarehouseNoMigrate(path);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('1 migration(s) behind this code');
    expect(message).toContain(newest);

    const raw = new Database(path, { readonly: true });
    try {
      expect((raw.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }).n).toBe(before);
    } finally {
      raw.close();
    }
  });
});

describe('openWarehouseNoMigrate — a refusal touches nothing (refute round)', () => {
  it('leaves a DELETE-journal database that is behind the code in DELETE mode, with no WAL sidecars', () => {
    const path = join(dir, 'delete-mode.sqlite');
    const seed = new Database(path); // default journal_mode = delete
    runMigrations(seed);
    const newest = (
      seed.prepare('SELECT filename FROM _migrations ORDER BY id DESC LIMIT 1').get() as { filename: string }
    ).filename;
    seed.prepare('DELETE FROM _migrations WHERE filename = ?').run(newest);
    expect(seed.pragma('journal_mode', { simple: true })).toBe('delete');
    seed.close();

    expect(() => openWarehouseNoMigrate(path)).toThrow(/behind this code/);

    const probe = new Database(path, { readonly: true });
    try {
      expect(probe.pragma('journal_mode', { simple: true })).toBe('delete'); // refusal must not flip to WAL
    } finally {
      probe.close();
    }
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
  });
});

describe('pendingMigrations', () => {
  it('is a pure read: reports every migration on a blank database without creating _migrations', () => {
    const db = new Database(join(dir, 'blank.sqlite'));
    try {
      expect(pendingMigrations(db).length).toBeGreaterThan(10);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      expect(tables).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('is empty once migrated', () => {
    const db = openWarehouse(join(dir, 'ok.sqlite'));
    try {
      expect(pendingMigrations(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
