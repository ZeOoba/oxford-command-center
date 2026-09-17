// tests/unit/bake-warehouse-missing-db.test.ts
//
// M4: `new Database(dbPath)` with no options SILENTLY CREATES an empty file when WAREHOUSE_DB points
// at a path that doesn't exist yet. The bake then fails downstream (buildWarehouseEnvelope's
// required-route checks reject an empty DB with no data), but that 0-byte file is left on disk — and
// the NEXT time anything opens it through openWarehouse() (a normal server start, a retried bake),
// runMigrations sees a valid, empty SQLite file and migrates it into a valid, EMPTY warehouse. Every
// later bake against that path then silently "succeeds" with a real (but empty) mirror and no error at
// all — the missing-database failure disappears into a permanently-empty warehouse instead of ever
// surfacing loudly.
//
// Fixed by opening with `{ fileMustExist: true }` (as scripts/bake-mirror.ts's own governor read
// already does) and turning better-sqlite3's SQLITE_CANTOPEN throw into one clear bake failure.
//
// Deliberately does NOT chdir to an isolated cwd, matching tests/unit/lease-market-api-bake.test.ts's
// own orchestrator tests: runs from the repo root, with only WAREHOUSE_DB pointed at a nonexistent
// path under a temp dir and BRAIN_BAKE_SOURCE_URL pointed at a reserved/typically-closed port to
// deterministically force the checkpoint-read branch (the one the bug lived in) instead of racing
// brainServerUp's 1500ms abort timeout.
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bakeWarehouseJson } from '../../scripts/bake-warehouse';

describe('bakeWarehouseJson — checkpoint-read path refuses to create a missing warehouse DB (M4)', () => {
  const ORIGINAL_WAREHOUSE_DB = process.env.WAREHOUSE_DB;
  const ORIGINAL_BAKE_SOURCE_URL = process.env.BRAIN_BAKE_SOURCE_URL;
  const dirs: string[] = [];

  afterEach(() => {
    if (ORIGINAL_WAREHOUSE_DB === undefined) delete process.env.WAREHOUSE_DB;
    else process.env.WAREHOUSE_DB = ORIGINAL_WAREHOUSE_DB;
    if (ORIGINAL_BAKE_SOURCE_URL === undefined) delete process.env.BRAIN_BAKE_SOURCE_URL;
    else process.env.BRAIN_BAKE_SOURCE_URL = ORIGINAL_BAKE_SOURCE_URL;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('throws a clear, actionable error and creates NO file at all when WAREHOUSE_DB points at a nonexistent path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bake-missing-db-'));
    dirs.push(dir);
    const dbPath = join(dir, 'does-not-exist.sqlite');
    expect(existsSync(dbPath)).toBe(false);

    process.env.WAREHOUSE_DB = dbPath;
    process.env.BRAIN_BAKE_SOURCE_URL = 'http://127.0.0.1:1';

    await expect(bakeWarehouseJson({ now: Date.parse('2026-03-02T00:00:00.000Z') })).rejects.toThrow(
      /warehouse bake failed: no database at .*does-not-exist\.sqlite.*refusing to create an empty warehouse/,
    );
    // The whole point of the fix: nothing was created at dbPath — no 0-byte file, and so no later
    // openWarehouse() call against this path can ever silently migrate it into an empty warehouse.
    expect(existsSync(dbPath)).toBe(false);
  });

  it('still throws (not create-and-succeed) when the CONTAINING DIRECTORY itself does not exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bake-missing-db-dir-'));
    dirs.push(dir);
    const dbPath = join(dir, 'nested', 'does-not-exist.sqlite');
    expect(existsSync(dbPath)).toBe(false);

    process.env.WAREHOUSE_DB = dbPath;
    process.env.BRAIN_BAKE_SOURCE_URL = 'http://127.0.0.1:1';

    await expect(bakeWarehouseJson({ now: Date.parse('2026-03-02T00:00:00.000Z') })).rejects.toThrow(/warehouse bake failed: no database at/);
    expect(existsSync(dbPath)).toBe(false);
  });
});
