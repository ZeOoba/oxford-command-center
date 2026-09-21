/**
 * Restore drill. Decrypts the newest snapshot into a temp dir, runs integrity_check, compares
 * row counts against the manifest, prints elapsed time, then deletes the plaintext copy.
 *
 * Usage: npm run backup:verify
 * Env:   BACKUP_DIR, BACKUP_KEY_HEX, MAX_SNAPSHOT_AGE_HOURS (default 48)
 *
 * A backup nobody has restored is not a backup — run this weekly.
 */
import { loadEnvFile } from '../server/load-env';

loadEnvFile();

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadBackupKey,
  decryptFile,
  verifySnapshot,
  newestSnapshot,
  listTables,
  tableCounts,
  type BackupManifest,
} from '../server/warehouse/backup';

const backupDir = process.env.BACKUP_DIR ?? join(process.cwd(), 'data', 'backups');
const maxAgeHours = Number(process.env.MAX_SNAPSHOT_AGE_HOURS) || 48;

function readManifest(): BackupManifest | null {
  try {
    return JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8')) as BackupManifest;
  } catch {
    // A corrupt or missing manifest does not mean there are no backups — fall back to the
    // directory, which is the actual source of truth about what exists.
    return null;
  }
}

function main(): void {
  const started = Date.now();
  const manifest = readManifest();

  // `latest` is a basename, rejoined here. Falling back to the newest .enc on disk keeps the
  // drill useful precisely when the manifest is the thing that broke.
  const snapshotName = manifest?.latest ?? newestSnapshot(backupDir);
  if (!snapshotName) {
    console.error(`RESTORE DRILL FAILED — no snapshot found in ${backupDir}`);
    process.exitCode = 1;
    return;
  }
  if (!manifest) {
    console.warn(`manifest.json missing or unreadable — falling back to newest snapshot on disk`);
  }

  const work = mkdtempSync(join(tmpdir(), 'ora-restore-'));
  const restored = join(work, 'restored.sqlite');
  try {
    decryptFile(join(backupDir, snapshotName), restored, loadBackupKey());
    // No manifest: derive the baseline from the restored file's own tables so integrity is still
    // checked and an EMPTY snapshot still fails closed (verifySnapshot rejects an empty baseline).
    // The age check below then fails on `Infinity` for the right reason (no manifest), instead of
    // this line reporting a full snapshot as "empty".
    const expected = manifest?.counts ?? tableCounts(restored, listTables(restored));
    const result = verifySnapshot(restored, expected);
    const secs = ((Date.now() - started) / 1000).toFixed(1);

    if (!result.ok) {
      console.error(
        `RESTORE DRILL FAILED in ${secs}s — integrity=${result.integrity} mismatches=${result.mismatches.join('; ')}`,
      );
      // NOT process.exit(): that skips the finally below and leaves the DECRYPTED warehouse in
      // the temp directory indefinitely — on exactly the run where you least want it there.
      process.exitCode = 1;
      return;
    }

    // A failed backup exits without touching the manifest, so without this the drill happily
    // re-verifies a months-old snapshot forever and reports success while nothing is being
    // backed up. Staleness is the failure mode this job exists to catch.
    const ageHours = manifest ? (Date.now() - Date.parse(manifest.at)) / 3_600_000 : Infinity;
    if (ageHours > maxAgeHours) {
      console.error(
        `RESTORE DRILL FAILED — snapshot restores cleanly but is ${ageHours.toFixed(1)}h old ` +
          `(limit ${maxAgeHours}h). The backup job is not running.`,
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      `restore drill ok in ${secs}s — snapshot ${manifest?.at ?? snapshotName}, ` +
        `${Object.keys(result.counts).length} tables verified, age ${ageHours.toFixed(1)}h`,
    );
  } finally {
    // Runs on every path now, including the failure paths above.
    rmSync(work, { recursive: true, force: true });
  }
}

main();
