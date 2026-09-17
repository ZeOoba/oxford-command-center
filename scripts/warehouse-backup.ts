/**
 * Nightly warehouse backup. Snapshot → verify → encrypt → prune → manifest.
 *
 * Usage: npm run backup
 * Env:   WAREHOUSE_DB   (default data/warehouse/finance.sqlite)
 *        BACKUP_DIR     (default data/backups — put a OneDrive path here for off-machine copies)
 *        BACKUP_KEY_HEX (required, 64 hex chars)
 *
 * Exit 0 only when the snapshot passed integrity_check AND row counts matched the source.
 */
import { loadEnvFile } from '../server/load-env';

loadEnvFile();

import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  loadBackupKey,
  snapshotWarehouse,
  tableCounts,
  verifySnapshot,
  encryptFile,
  selectSnapshotsToDelete,
  writeManifest,
} from '../server/warehouse/backup';

const dbPath =
  process.env.WAREHOUSE_DB ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite');
const backupDir = process.env.BACKUP_DIR ?? join(process.cwd(), 'data', 'backups');

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

const BUSY_TIMEOUT_MS = Number(process.env.WAREHOUSE_BUSY_TIMEOUT_MS) || 15_000;

function allTables(path: string): string[] {
  const db = new Database(path, { readonly: true });
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  try {
    return (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
    )
      .map((r) => r.name)
      .sort();
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const key = loadBackupKey();
  mkdirSync(backupDir, { recursive: true });
  const now = new Date();
  const plainPath = join(backupDir, `finance-${stamp(now)}.sqlite`);
  const encPath = `${plainPath}.enc`;

  // Deliberately NOT openWarehouse(): that helper runs pending migrations, and a backup job
  // must never mutate the schema of the database it is protecting. Run from a feature branch
  // it would silently apply that branch's unmerged migration to the live warehouse. This is a
  // plain handle — the backup only reads, and WAL lets it run alongside the dev server.
  const db = new Database(dbPath);
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  try {
    await snapshotWarehouse(db, plainPath);
  } finally {
    db.close();
  }

  /** Deletes the plaintext snapshot AND its WAL sidecars. Opening the snapshot to verify it
   *  creates `-shm`/`-wal`, and a read-only connection cannot checkpoint them away on close, so
   *  deleting only the .sqlite leaves unencrypted database artifacts sitting in the backup
   *  directory — exactly what encrypting the snapshot was meant to prevent. */
  const removePlaintext = (): void => {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${plainPath}${suffix}`, { force: true });
  };

  // Everything from here to a successful encrypt runs under `finally`. Any throw in between —
  // a table name the identifier allowlist rejects, SQLITE_BUSY on a count, a disk error during
  // encrypt — previously propagated straight to process.exit(1) with the UNENCRYPTED warehouse
  // still on disk. BACKUP_DIR is a OneDrive path, so that plaintext then syncs to the cloud.
  let result: ReturnType<typeof verifySnapshot>;
  let tables: string[];
  try {
    tables = allTables(dbPath);
    result = verifySnapshot(plainPath, tableCounts(dbPath, tables));
    if (!result.ok) {
      console.error(
        `BACKUP FAILED — integrity=${result.integrity} mismatches=${result.mismatches.join('; ')}`,
      );
      process.exitCode = 1;
      return;
    }
    encryptFile(plainPath, encPath, key);
  } finally {
    removePlaintext(); // never leave an unencrypted copy behind, on ANY path
  }

  for (const doomed of selectSnapshotsToDelete(readdirSync(backupDir), now)) {
    rmSync(join(backupDir, doomed), { force: true });
  }

  writeManifest(backupDir, {
    latest: `finance-${stamp(now)}.sqlite.enc`,
    at: now.toISOString(),
    bytes: statSync(encPath).size,
    tables: tables.length,
    counts: result.counts,
  });

  console.log(`backup ok → ${encPath} (${tables.length} tables, integrity ${result.integrity})`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
