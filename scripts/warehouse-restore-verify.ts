/**
 * Restore drill. Decrypts the newest snapshot into a temp dir, runs integrity_check, compares
 * row counts against the manifest, prints elapsed time, then deletes the plaintext copy.
 *
 * Usage: npm run backup:verify
 * A backup nobody has restored is not a backup — run this weekly.
 */
import { loadEnvFile } from '../server/load-env';

loadEnvFile();

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBackupKey, decryptFile, verifySnapshot } from '../server/warehouse/backup';

const backupDir = process.env.BACKUP_DIR ?? join(process.cwd(), 'data', 'backups');

function main(): void {
  const started = Date.now();
  const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8')) as {
    latest: string;
    at: string;
    counts: Record<string, number>;
  };
  const work = mkdtempSync(join(tmpdir(), 'ora-restore-'));
  const restored = join(work, 'restored.sqlite');
  try {
    decryptFile(manifest.latest, restored, loadBackupKey());
    const result = verifySnapshot(restored, manifest.counts);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (!result.ok) {
      console.error(
        `RESTORE DRILL FAILED in ${secs}s — integrity=${result.integrity} mismatches=${result.mismatches.join('; ')}`,
      );
      process.exit(1);
    }
    console.log(
      `restore drill ok in ${secs}s — snapshot ${manifest.at}, ${Object.keys(result.counts).length} tables verified`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main();
