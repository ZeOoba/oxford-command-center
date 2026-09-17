// server/warehouse/backup.ts
//
// Durability for the warehouse. The proprietary datasets this file protects (listing
// observations, lease facts, decision history) cannot be reconstructed from any upstream
// source, so a laptop loss is a permanent loss without this.
//
// AES-256-GCM via node:crypto rather than an external tool: neither `age` nor 7-Zip is
// installed on this machine (verified 2026-09-17), and a backup that depends on a binary
// nobody installed is a backup that does not run.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { WarehouseDb } from './db';

const MAGIC = Buffer.from('ORAB1');
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Whole-file encryption holds the plaintext in memory; the warehouse is tens of MB today.
 *  Past this ceiling the caller must switch to a streaming implementation rather than
 *  silently exhaust memory. */
export const MAX_ENCRYPT_BYTES = 512 * 1024 * 1024;

export interface VerifyResult {
  ok: boolean;
  integrity: string;
  counts: Record<string, number>;
  mismatches: string[];
}

export function loadBackupKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const hex = env.BACKUP_KEY_HEX;
  if (!hex) {
    throw new Error(
      'BACKUP_KEY_HEX is not set — generate one with: ' +
        'node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))" ' +
        'and store it outside this repo (Windows Credential Manager or the machine env).',
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('BACKUP_KEY_HEX must be exactly 64 hex characters (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

export function encryptFile(srcPath: string, destPath: string, key: Buffer): void {
  const size = statSync(srcPath).size;
  if (size > MAX_ENCRYPT_BYTES) {
    throw new Error(
      `${srcPath} is ${size} bytes, above MAX_ENCRYPT_BYTES (${MAX_ENCRYPT_BYTES}) — use a streaming backup`,
    );
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(readFileSync(srcPath)), cipher.final()]);
  writeFileSync(destPath, Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]));
}

export function decryptFile(srcPath: string, destPath: string, key: Buffer): void {
  const raw = readFileSync(srcPath);
  if (
    raw.length < MAGIC.length + IV_BYTES + TAG_BYTES ||
    !raw.subarray(0, MAGIC.length).equals(MAGIC)
  ) {
    throw new Error(`${srcPath} is not an ORA backup file`);
  }
  const iv = raw.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = raw.subarray(MAGIC.length + IV_BYTES, MAGIC.length + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([
    decipher.update(raw.subarray(MAGIC.length + IV_BYTES + TAG_BYTES)),
    decipher.final(), // throws on tamper — GCM authentication failure
  ]);
  writeFileSync(destPath, plain);
}

/** better-sqlite3's own online backup: consistent against a live WAL database with
 *  concurrent writers, unlike a filesystem copy of the .sqlite file. */
export async function snapshotWarehouse(db: WarehouseDb, destPath: string): Promise<void> {
  await db.backup(destPath);
}

export function tableCounts(dbPath: string, tables: string[]): Record<string, number> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const counts: Record<string, number> = {};
    for (const t of tables) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) throw new Error(`unsafe table name: ${t}`);
      counts[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    }
    return counts;
  } finally {
    db.close();
  }
}

export function verifySnapshot(
  snapshotPath: string,
  expected: Record<string, number>,
): VerifyResult {
  const db = new Database(snapshotPath, { readonly: true });
  let integrity: string;
  try {
    const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    // An empty pragma result is not an "ok" — a snapshot we cannot check is a snapshot we
    // cannot trust, so it fails closed rather than reporting a passing integrity string.
    integrity = rows[0]?.integrity_check ?? 'integrity_check returned no rows';
  } finally {
    db.close();
  }
  const counts = tableCounts(snapshotPath, Object.keys(expected));
  const mismatches = Object.entries(expected)
    .filter(([t, n]) => counts[t] !== n)
    .map(([t, n]) => `${t}: expected ${n}, got ${counts[t]}`);
  return { ok: integrity === 'ok' && mismatches.length === 0, integrity, counts, mismatches };
}

const SNAPSHOT_RE = /^finance-(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})\.sqlite\.enc$/;

function snapshotDate(name: string): Date | null {
  const m = SNAPSHOT_RE.exec(name);
  if (!m) return null;
  return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!));
}

/** ISO-week key (year + week number), so "one per week" survives year boundaries. */
function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Keep every snapshot inside `keepDaily` days; outside it keep the OLDEST snapshot of each
 *  ISO week for `keepWeekly` weeks; delete the rest. Returns names to delete. */
export function selectSnapshotsToDelete(
  names: string[],
  now: Date,
  keepDaily = 14,
  keepWeekly = 8,
): string[] {
  const dailyCutoff = now.getTime() - keepDaily * 86_400_000;
  const weeklyCutoff = now.getTime() - (keepDaily + keepWeekly * 7) * 86_400_000;
  const dated = names
    .map((n) => ({ name: n, at: snapshotDate(n) }))
    .filter((x): x is { name: string; at: Date } => x.at !== null)
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  const keptWeeks = new Set<string>();
  const doomed: string[] = [];
  for (const { name, at } of dated) {
    if (at.getTime() >= dailyCutoff) continue;
    if (at.getTime() < weeklyCutoff) {
      doomed.push(name);
      continue;
    }
    const wk = isoWeekKey(at);
    if (keptWeeks.has(wk)) doomed.push(name);
    else keptWeeks.add(wk);
  }
  return doomed;
}
