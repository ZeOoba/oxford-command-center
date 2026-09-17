import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWarehouse, openWarehouseReadOnly } from '../../server/warehouse/db';

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
