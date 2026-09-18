# Record Spine Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ORA's warehouse survivable (encrypted off-machine snapshots with a proven restore) and joinable (one canonical id per property/unit/tenant/lease, plus a cited-fact, decision and audit substrate).

**Architecture:** Six additive pieces on the existing SQLite warehouse. `server/warehouse/backup.ts` snapshots through better-sqlite3's own backup API and encrypts with AES-256-GCM from `node:crypto` (no external binary — `age` and 7-Zip are not installed on this machine). Migration `030_record_spine.sql` adds seven tables and makes `audit_log` append-only with triggers. `entity-xref.ts` maps every external identity to a canonical id, reusing the lease-market branch's `lm_property.identity_key` convention as the join key. All tasks are additive; nothing existing is altered.

**Tech Stack:** TypeScript (ESM, Node ≥20), better-sqlite3, vitest, tsx scripts, node:crypto.

## Global Constraints

- Migrations are the single source of truth for schema; never `CREATE TABLE IF NOT EXISTS` inline in TypeScript (`server/warehouse/db.ts:9-15`).
- **Migration number is 030.** 029 belongs to `feat/lease-market-intel` and is final.
- Additive only: no `ALTER`/`DROP` of an existing table or column.
- Every new table name must appear in `architecture/system-of-record.md` (Task 4 enforces this with a test).
- Tests run against `new Database(':memory:')` + `runMigrations(db)` — never against the live warehouse file.
- Foreign keys are ON in every connection (`db.pragma('foreign_keys = ON')`).
- Work in an isolated worktree: `npm run worktree`.
- Test command is `npx vitest run <path>` for a single file; the full gate is `npm run gate`.
- **Typecheck against the root tsconfig, not just `tsconfig.node.json`.** `tests/` is covered only
  by the root project, so `npx tsc --noEmit -p tsconfig.node.json` passes on test files that the
  gate then rejects under `noUncheckedIndexedAccess`.
- `data/backups/` must be gitignored before the first live drill. Encrypted or not, firm data
  never enters git.
- **A migration is immutable once any database has applied it.** `runMigrations` tracks migrations
  by filename with no checksum, so editing an applied file in place never reaches a database that
  already ran it — that database is left permanently missing the edit, silently. Once 030 has been
  applied anywhere, correct it with 031, never by editing 030. (Surfaced by the lease-market
  session's reviewers against their own 029; it is a repo-wide property, not a branch quirk.)

---

## Execution record (2026-09-17)

**Track 1 is COMPLETE** — all seven tasks on branch `feat/record-spine`, rebased onto main after
`feat/lease-market-intel` merged (PR #330). Full gate green: **4670 tests, 311 files**.

Live drill against the real warehouse and the off-machine OneDrive destination: **38 tables
verified in 0.0s**, snapshot encrypted (magic `ORAB1`), no plaintext or WAL sidecars left behind,
and the live warehouse byte-identical before and after — confirming the backup does not migrate
the database it protects.

`architecture/system-of-record.md` was **ratified by Gabriel on 2026-09-17** and is now binding.

**Task 6 was redesigned during execution.** The plan assumed `lm_property.ora_property_key` holds a
`property_master.id`; it does not — it holds the raw rent-roll label (`Lease.propertyKey`). Property
identity spans three id spaces that do not agree, and `property_master` carries no rent-roll key, so
every cross-space link grounds out in a normalized address comparison. Gabriel ratified that
`config/lease-market.json`'s `oraProperties` is the **authority** on which listing is an ORA
building; the seeder mirrors that decision and only *proposes* everything else. It never auto-links
from an address match alone. Note there is nothing to seed yet: `oraProperties` is empty and live
`lm_*` ingest is held pending the CoStar retention answer.

Five defects in this plan were found by executing it, and are corrected in the task text above:

1. The backup CLI opened its source through `openWarehouse()`, which runs pending migrations —
   it would have written this branch's unmerged migration 030 into the live shared warehouse.
2. Verifying the snapshot leaves `-shm`/`-wal` sidecars a read-only connection cannot checkpoint
   away, so deleting only the `.sqlite` left unencrypted database artifacts in the backup dir.
3. The system-of-record test read the wrong table column (index 2, not 3) and so asserted
   against an empty set — it passed while checking nothing.
4. `verifySnapshot` indexed `pragma('integrity_check')[0]` directly, which fails the repo's
   `noUncheckedIndexedAccess`; it now fails closed on an empty result instead.
5. Task 1's expected count was 8; the suite as written is 9 tests.

---

### Task 1: Encrypted snapshot module

**Files:**
- Create: `server/warehouse/backup.ts`
- Test: `tests/unit/warehouse-backup.test.ts`

**Interfaces:**
- Consumes: `WarehouseDb` from `server/warehouse/db.ts`.
- Produces: `loadBackupKey(env?): Buffer` · `encryptFile(srcPath: string, destPath: string, key: Buffer): void` · `decryptFile(srcPath: string, destPath: string, key: Buffer): void` · `snapshotWarehouse(db: WarehouseDb, destPath: string): Promise<void>` · `tableCounts(dbPath: string, tables: string[]): Record<string, number>` · `verifySnapshot(snapshotPath: string, expected: Record<string, number>): VerifyResult` where `VerifyResult = { ok: boolean; integrity: string; counts: Record<string, number>; mismatches: string[] }` · `MAX_ENCRYPT_BYTES: number`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/warehouse-backup.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/warehouse/migrate';
import {
  loadBackupKey, encryptFile, decryptFile, snapshotWarehouse, tableCounts, verifySnapshot,
} from '../../server/warehouse/backup';

const KEY_HEX = 'a'.repeat(64);
let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ora-backup-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

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
    bytes[bytes.length - 1] ^= 0xff;
    writeFileSync(join(dir, 'c.enc'), bytes);
    expect(() => decryptFile(join(dir, 'c.enc'), join(dir, 'out.bin'), key)).toThrow();
  });

  it('refuses a file whose magic header is wrong', () => {
    const key = loadBackupKey({ BACKUP_KEY_HEX: KEY_HEX } as NodeJS.ProcessEnv);
    writeFileSync(join(dir, 'bogus.enc'), Buffer.from('NOTORAB1 and some bytes'));
    expect(() => decryptFile(join(dir, 'bogus.enc'), join(dir, 'out.bin'), key)).toThrow(/not an ORA backup/);
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/warehouse-backup.test.ts`
Expected: FAIL — `Failed to resolve import "../../server/warehouse/backup"`.

- [ ] **Step 3: Write the implementation**

Create `server/warehouse/backup.ts`:

```ts
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
    throw new Error(`${srcPath} is ${size} bytes, above MAX_ENCRYPT_BYTES (${MAX_ENCRYPT_BYTES}) — use a streaming backup`);
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(readFileSync(srcPath)), cipher.final()]);
  writeFileSync(destPath, Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]));
}

export function decryptFile(srcPath: string, destPath: string, key: Buffer): void {
  const raw = readFileSync(srcPath);
  if (raw.length < MAGIC.length + IV_BYTES + TAG_BYTES || !raw.subarray(0, MAGIC.length).equals(MAGIC)) {
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

export function verifySnapshot(snapshotPath: string, expected: Record<string, number>): VerifyResult {
  const db = new Database(snapshotPath, { readonly: true });
  let integrity: string;
  try {
    const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    // An empty pragma result is not an "ok" — a snapshot we cannot check is a snapshot we
    // cannot trust, so it fails closed. (Indexing [0] directly also fails `noUncheckedIndexedAccess`.)
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/warehouse-backup.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add server/warehouse/backup.ts tests/unit/warehouse-backup.test.ts
git commit -m "feat(warehouse): encrypted snapshot + verification module"
```

---

### Task 2: Backup CLI, retention, and the restore drill

**Files:**
- Create: `scripts/warehouse-backup.ts`, `scripts/warehouse-restore-verify.ts`
- Modify: `server/warehouse/backup.ts` (add `selectSnapshotsToDelete`), `tests/unit/warehouse-backup.test.ts` (add retention tests), `package.json:44` (scripts block)

**Interfaces:**
- Consumes: everything from Task 1.
- Produces: `selectSnapshotsToDelete(names: string[], now: Date, keepDaily?: number, keepWeekly?: number): string[]` · npm scripts `backup` and `backup:verify` · snapshot filename format `finance-YYYY-MM-DDTHHmm.sqlite.enc` · a manifest at `<BACKUP_DIR>/manifest.json`.

- [ ] **Step 1: Write the failing retention test**

Append to `tests/unit/warehouse-backup.test.ts`:

```ts
import { selectSnapshotsToDelete } from '../../server/warehouse/backup';

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
    const names = [name('2026-01-05T0300'), name('2026-09-14T0300')];
    expect(selectSnapshotsToDelete(names, now, 14, 8)).toEqual([name('2026-01-05T0300')]);
  });

  it('ignores files that do not match the snapshot naming convention', () => {
    expect(selectSnapshotsToDelete(['notes.txt', 'finance.sqlite'], now, 14, 8)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/warehouse-backup.test.ts -t selectSnapshotsToDelete`
Expected: FAIL — `selectSnapshotsToDelete is not a function`.

- [ ] **Step 3: Implement retention selection**

Append to `server/warehouse/backup.ts`:

```ts
const SNAPSHOT_RE = /^finance-(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})\.sqlite\.enc$/;

function snapshotDate(name: string): Date | null {
  const m = SNAPSHOT_RE.exec(name);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
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
  names: string[], now: Date, keepDaily = 14, keepWeekly = 8,
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
    if (at.getTime() < weeklyCutoff) { doomed.push(name); continue; }
    const wk = isoWeekKey(at);
    if (keptWeeks.has(wk)) doomed.push(name);
    else keptWeeks.add(wk);
  }
  return doomed;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/warehouse-backup.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Write the backup CLI**

Create `scripts/warehouse-backup.ts`:

```ts
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
import { mkdirSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  loadBackupKey, snapshotWarehouse, tableCounts, verifySnapshot, encryptFile, selectSnapshotsToDelete,
} from '../server/warehouse/backup';

const dbPath = process.env.WAREHOUSE_DB ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite');
const backupDir = process.env.BACKUP_DIR ?? join(process.cwd(), 'data', 'backups');

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

function allTables(path: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>)
      .map((r) => r.name).sort();
  } finally { db.close(); }
}

async function main(): Promise<void> {
  const key = loadBackupKey();
  mkdirSync(backupDir, { recursive: true });
  const now = new Date();
  const plainPath = join(backupDir, `finance-${stamp(now)}.sqlite`);
  const encPath = `${plainPath}.enc`;

  // Deliberately NOT openWarehouse(): that helper runs pending migrations, and a backup job
  // must never mutate the schema of the database it is protecting. Run from a feature branch
  // it would silently apply that branch's unmerged migration to the live warehouse.
  const db = new Database(dbPath);
  db.pragma(`busy_timeout = ${Number(process.env.WAREHOUSE_BUSY_TIMEOUT_MS) || 15_000}`);
  try {
    await snapshotWarehouse(db, plainPath);
  } finally { db.close(); }

  /** Deletes the plaintext snapshot AND its WAL sidecars. Opening the snapshot to verify it
   *  creates `-shm`/`-wal`, and a read-only connection cannot checkpoint them away on close, so
   *  deleting only the .sqlite leaves unencrypted database artifacts in the backup directory. */
  const removePlaintext = (): void => {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${plainPath}${suffix}`, { force: true });
  };

  const tables = allTables(dbPath);
  const result = verifySnapshot(plainPath, tableCounts(dbPath, tables));
  if (!result.ok) {
    removePlaintext();
    console.error(`BACKUP FAILED — integrity=${result.integrity} mismatches=${result.mismatches.join('; ')}`);
    process.exit(1);
  }

  encryptFile(plainPath, encPath, key);
  removePlaintext(); // never leave an unencrypted copy behind

  for (const doomed of selectSnapshotsToDelete(readdirSync(backupDir), now)) {
    rmSync(join(backupDir, doomed), { force: true });
  }

  writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify({
    latest: encPath, at: now.toISOString(), bytes: statSync(encPath).size,
    tables: tables.length, counts: result.counts,
  }, null, 2));
  console.log(`backup ok → ${encPath} (${tables.length} tables, integrity ${result.integrity})`);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 6: Write the restore-drill CLI**

Create `scripts/warehouse-restore-verify.ts`:

```ts
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
    latest: string; at: string; counts: Record<string, number>;
  };
  const work = mkdtempSync(join(tmpdir(), 'ora-restore-'));
  const restored = join(work, 'restored.sqlite');
  try {
    decryptFile(manifest.latest, restored, loadBackupKey());
    const result = verifySnapshot(restored, manifest.counts);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (!result.ok) {
      console.error(`RESTORE DRILL FAILED in ${secs}s — integrity=${result.integrity} mismatches=${result.mismatches.join('; ')}`);
      process.exit(1);
    }
    console.log(`restore drill ok in ${secs}s — snapshot ${manifest.at}, ${Object.keys(result.counts).length} tables verified`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main();
```

- [ ] **Step 7: Register the npm scripts**

In `package.json`, add to `"scripts"` immediately after `"warehouse:import-loss-runs"`:

```json
    "backup": "tsx scripts/warehouse-backup.ts",
    "backup:verify": "tsx scripts/warehouse-restore-verify.ts",
```

- [ ] **Step 8: Run the drill end to end against the live warehouse**

```bash
BACKUP_KEY_HEX=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))") npm run backup
```
Expected: `backup ok → data/backups/finance-<stamp>.sqlite.enc (N tables, integrity ok)`.
Then, with the same key exported: `npm run backup:verify`
Expected: `restore drill ok in <n>s — snapshot <iso>, N tables verified`.

> Record the elapsed time in the commit message — it is the number that answers "how long until we are back up?"

- [ ] **Step 9: Commit**

```bash
git add scripts/warehouse-backup.ts scripts/warehouse-restore-verify.ts server/warehouse/backup.ts tests/unit/warehouse-backup.test.ts package.json
git commit -m "feat(warehouse): backup CLI, retention policy, restore drill"
```

> **Hand-off to Gabriel after this task:** store `BACKUP_KEY_HEX` outside the repo (Windows Credential Manager or machine env) and set `BACKUP_DIR` to a OneDrive path so snapshots leave the laptop. A key committed to the repo makes the encryption worthless.

---

### Task 3: Migration 030 — Record Spine tables

**Files:**
- Create: `server/warehouse/migrations/030_record_spine.sql`, `tests/unit/migration-030-record-spine.test.ts`

**Interfaces:**
- Produces: tables `entity_xref`, `documents`, `lease_facts`, `obligations`, `deal_decisions`, `agent_runs`, `audit_log`; `audit_log` is append-only (UPDATE/DELETE raise).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/migration-030-record-spine.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/warehouse/migrate';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

const SPINE_TABLES = [
  'agent_runs', 'audit_log', 'deal_decisions', 'documents', 'entity_xref', 'lease_facts', 'obligations',
];

describe('migration 030 — record spine', () => {
  it('creates all seven tables', () => {
    const db = makeDb();
    const names = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${SPINE_TABLES.map(() => '?').join(',')})`,
    ).all(...SPINE_TABLES) as Array<{ name: string }>).map((r) => r.name).sort();
    expect(names).toEqual(SPINE_TABLES);
  });

  it('enforces one row per (system, entity_type, external_id) in entity_xref', () => {
    const db = makeDb();
    const ins = () => db.prepare(
      `INSERT INTO entity_xref (entity_type, canonical_id, system, external_id, match_method)
       VALUES ('property', 'prop-1', 'ora_pm', 'x-1', 'exact_address')`,
    ).run();
    expect(ins).not.toThrow();
    expect(ins).toThrow();
  });

  it('rejects an unknown entity_type', () => {
    const db = makeDb();
    expect(() => db.prepare(
      `INSERT INTO entity_xref (entity_type, canonical_id, system, external_id, match_method)
       VALUES ('spaceship', 'c1', 'notion', 'n1', 'manual')`,
    ).run()).toThrow(/CHECK/);
  });

  it('rejects a lease_facts row whose document_id does not exist', () => {
    const db = makeDb();
    expect(() => db.prepare(
      `INSERT INTO lease_facts (fact_id, lease_canonical_id, field, value_json, document_id, page, quote,
                                quote_on_page, confidence, extractor_version, run_id, status)
       VALUES ('f1','l1','expiration','"2027-01-31"','missing-doc',4,'quoted text',1,0.91,'v1','r1','extracted')`,
    ).run()).toThrow(/FOREIGN KEY/);
  });

  it('rejects an unknown lease_facts status', () => {
    const db = makeDb();
    db.prepare(`INSERT INTO documents (document_id, sha256, path, doc_type, landed_at)
                VALUES ('d1','abc','C:/x.pdf','lease','2026-09-17T00:00:00Z')`).run();
    expect(() => db.prepare(
      `INSERT INTO lease_facts (fact_id, lease_canonical_id, field, value_json, document_id, page, quote,
                                quote_on_page, confidence, extractor_version, run_id, status)
       VALUES ('f1','l1','expiration','"2027-01-31"','d1',4,'q',1,0.9,'v1','r1','probably-fine')`,
    ).run()).toThrow(/CHECK/);
  });

  it('makes audit_log append-only', () => {
    const db = makeDb();
    db.prepare(`INSERT INTO audit_log (at, actor, action, entity, entity_id)
                VALUES ('2026-09-17T00:00:00Z','gabriel','verify','lease_facts','f1')`).run();
    expect(() => db.prepare(`UPDATE audit_log SET actor='someone-else' WHERE seq=1`).run())
      .toThrow(/append-only/);
    expect(() => db.prepare(`DELETE FROM audit_log WHERE seq=1`).run()).toThrow(/append-only/);
  });

  it('defaults an obligation to open and rejects an unknown responsible_party', () => {
    const db = makeDb();
    db.prepare(`INSERT INTO obligations (obligation_id, lease_canonical_id, kind, responsible_party, source_fact_ids)
                VALUES ('o1','l1','renewal_notice','tenant','["f1"]')`).run();
    expect((db.prepare(`SELECT status FROM obligations WHERE obligation_id='o1'`).get() as { status: string }).status).toBe('open');
    expect(() => db.prepare(`INSERT INTO obligations (obligation_id, lease_canonical_id, kind, responsible_party, source_fact_ids)
                             VALUES ('o2','l1','renewal_notice','the-broker','["f1"]')`).run()).toThrow(/CHECK/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/migration-030-record-spine.test.ts`
Expected: FAIL — `no such table: main.entity_xref`.

- [ ] **Step 3: Write the migration**

Create `server/warehouse/migrations/030_record_spine.sql`:

```sql
-- 030_record_spine.sql
--
-- The Record Spine: canonical identity, source documents, cited facts, decisions, and an
-- append-only audit trail. Additive only — no existing table is altered.
--
-- Why: lease and tenant records live in at least five stores (live workbook, warehouse
-- lease_terms, ora-pm Postgres, Notion Tenant DB, TENANTS.json pipeline). Nothing today maps
-- one store's id to another's, so a join is a manual reconciliation every time, and the Notion
-- Tenant DB already required a large remediation after phantom/duplicate rows silently corrupted
-- every analytic built on it. entity_xref makes identity explicit and auditable rather than
-- re-derived per query.
--
-- lease_facts carries page + verbatim quote + a deterministic quote_on_page flag because an
-- extracted lease term with no source citation cannot be checked by a human, and OCR abstraction
-- has already missed a hand-altered term and an unexecuted lease in this portfolio.

CREATE TABLE IF NOT EXISTS entity_xref (
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('property','unit','tenant','lease')),
  canonical_id  TEXT NOT NULL,
  system        TEXT NOT NULL CHECK (system IN
                  ('warehouse','ora_pm','notion','workbook','lease_market','yardi','appfolio','rentmanager','quickbooks','hubspot')),
  external_id   TEXT NOT NULL,
  match_method  TEXT NOT NULL CHECK (match_method IN
                  ('exact_id','exact_address','identity_key','manual','ambiguous')),
  confidence    REAL NOT NULL DEFAULT 1.0,
  verified_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (system, entity_type, external_id)
);
CREATE INDEX IF NOT EXISTS idx_entity_xref_canonical ON entity_xref (entity_type, canonical_id);

CREATE TABLE IF NOT EXISTS documents (
  document_id        TEXT PRIMARY KEY,
  sha256             TEXT NOT NULL UNIQUE,
  path               TEXT NOT NULL,
  doc_type           TEXT NOT NULL CHECK (doc_type IN
                       ('lease','amendment','addendum','guaranty','snda','estoppel','coi','om','other')),
  lease_canonical_id TEXT,
  chain_seq          INTEGER,
  executed           TEXT NOT NULL DEFAULT 'unknown' CHECK (executed IN ('yes','no','unknown')),
  contains_pii       INTEGER NOT NULL DEFAULT 0 CHECK (contains_pii IN (0,1)),
  page_count         INTEGER,
  landed_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_lease ON documents (lease_canonical_id, chain_seq);

CREATE TABLE IF NOT EXISTS lease_facts (
  fact_id            TEXT PRIMARY KEY,
  lease_canonical_id TEXT NOT NULL,
  field              TEXT NOT NULL,
  value_json         TEXT NOT NULL,
  document_id        TEXT NOT NULL REFERENCES documents(document_id),
  page               INTEGER NOT NULL,
  quote              TEXT NOT NULL,
  quote_on_page      INTEGER NOT NULL CHECK (quote_on_page IN (0,1)),
  confidence         REAL NOT NULL,
  extractor_version  TEXT NOT NULL,
  run_id             TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('extracted','disputed','verified','superseded')),
  superseded_by      TEXT,
  verified_by        TEXT,
  verified_at        TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lease_facts_lease_field ON lease_facts (lease_canonical_id, field, status);

CREATE TABLE IF NOT EXISTS obligations (
  obligation_id      TEXT PRIMARY KEY,
  lease_canonical_id TEXT NOT NULL,
  kind               TEXT NOT NULL,
  responsible_party  TEXT NOT NULL CHECK (responsible_party IN ('landlord','tenant','shared','unknown')),
  trigger_date       TEXT,
  due_date           TEXT,
  recurrence         TEXT,
  source_fact_ids    TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','satisfied','waived','expired')),
  owner              TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_obligations_due ON obligations (due_date, status);

CREATE TABLE IF NOT EXISTS deal_decisions (
  decision_id       TEXT PRIMARY KEY,
  candidate_id      TEXT NOT NULL,
  stage             TEXT NOT NULL,
  decision          TEXT NOT NULL CHECK (decision IN ('pass','watch','investigate','underwrite','contact_broker','loi','acquired','lost')),
  reason_codes      TEXT NOT NULL,
  note              TEXT,
  price_at_decision REAL,
  ruleset_version   TEXT NOT NULL,
  decided_by        TEXT NOT NULL,
  decided_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deal_decisions_candidate ON deal_decisions (candidate_id, decided_at);

CREATE TABLE IF NOT EXISTS agent_runs (
  run_id         TEXT PRIMARY KEY,
  pipeline       TEXT NOT NULL,
  model          TEXT,
  prompt_version TEXT,
  input_sha256   TEXT,
  tokens_in      INTEGER,
  tokens_out     INTEGER,
  cost_usd       REAL,
  status         TEXT NOT NULL CHECK (status IN ('running','ok','error')),
  error          TEXT,
  started_at     TEXT NOT NULL,
  ended_at       TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log (entity, entity_id, seq);

-- Append-only enforcement. An audit trail a process can rewrite is not an audit trail; these
-- triggers make tampering a hard error at the database rather than a code-review convention.
CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/migration-030-record-spine.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add server/warehouse/migrations/030_record_spine.sql tests/unit/migration-030-record-spine.test.ts
git commit -m "feat(warehouse): migration 030 — record spine tables"
```

---

### Task 4: System-of-record matrix (with a test that keeps it honest)

**Files:**
- Create: `architecture/system-of-record.md`, `tests/unit/system-of-record-doc.test.ts`

**Interfaces:**
- Produces: a ratifiable matrix whose "Warehouse table" column is machine-checked against the migrated schema, so the doc cannot silently drift from reality.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/system-of-record-doc.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/warehouse/migrate';

/** Pulls every `backtick-quoted` token from the "Warehouse table" column of the matrix. */
function tablesNamedInDoc(md: string): string[] {
  const section = md.split('<!-- TABLE-CHECK:START -->')[1]?.split('<!-- TABLE-CHECK:END -->')[0] ?? '';
  const names = new Set<string>();
  for (const row of section.split('\n')) {
    // A markdown row starts with '|', so split() yields an empty cell at index 0 and the
    // "Warehouse table" column lands at index 3, NOT 2. Reading index 2 parses the neighbouring
    // "System of record" column, which holds no backticked names — every assertion below then
    // passes against an empty set. Verify the test bites by planting a bogus table name.
    const cells = row.split('|');
    if (cells.length < 4) continue;
    for (const m of cells[3]!.matchAll(/`([a-z_][a-z0-9_]*)`/g)) names.add(m[1]!);
  }
  return [...names].sort();
}

describe('system-of-record matrix', () => {
  const md = readFileSync(join(process.cwd(), 'architecture', 'system-of-record.md'), 'utf8');

  it('names at least the seven spine tables', () => {
    const named = tablesNamedInDoc(md);
    for (const t of ['entity_xref', 'documents', 'lease_facts', 'obligations', 'deal_decisions', 'agent_runs', 'audit_log']) {
      expect(named).toContain(t);
    }
  });

  it('names only tables that actually exist in the migrated schema', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const real = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as Array<{ name: string }>).map((r) => r.name));
    const missing = tablesNamedInDoc(md).filter((t) => !real.has(t));
    expect(missing).toEqual([]);
  });

  it('records a ratification line for Gabriel', () => {
    expect(md).toMatch(/\*\*Ratified by Gabriel:\*\*/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/system-of-record-doc.test.ts`
Expected: FAIL — `ENOENT: no such file or directory ... architecture/system-of-record.md`.

- [ ] **Step 3: Write the matrix**

Create `architecture/system-of-record.md`:

```markdown
# System of Record Matrix

**Status:** PROPOSED — awaiting ratification.
**Ratified by Gabriel:** ( pending — date and initials go here )

One system of record per entity. Every other store holding the same entity is a **mirror**: it
may be read, but a disagreement is resolved in favour of the system of record, and a mirror is
never the source for an analytic. Adding a new store for an entity that already has one requires
retiring an old one in the same change.

<!-- TABLE-CHECK:START -->
| Entity | System of record | Warehouse table | Mirrors (read-only) |
|---|---|---|---|
| Property / unit | Warehouse | `property_master`, `entity_xref` | ora-pm `properties`/`units`, Notion, live workbook, `lm_property` |
| Lease economic terms | Warehouse (verified facts) | `lease_facts`, `lease_terms` | ora-pm `leases`, Notion Tenant DB, TENANTS.json |
| Lease obligations & dates | Warehouse | `obligations` | M365 To-Do tasks |
| Source documents | Warehouse registry (files stay in OneDrive) | `documents` | doc-index.sqlite |
| Listings & observations | Warehouse | *pending migration 029 — see note below* | Access-gated mirror (row-level stripped) |
| Billed rent / AR | PM system export | `ledger_entries` | — |
| GL / P&L | QuickBooks Desktop CSV | `ledger_entries`, `import_batches` | live workbook |
| Deal candidates & scores | Warehouse | `acq_candidates`, `acq_scores` | Notion Sourcing Log, HubSpot |
| Deal decisions | Warehouse | `deal_decisions` | `deal-decision-ledger.md` (frozen, read-only) |
| Pipeline provenance | Warehouse | `agent_runs`, `audit_log` | — |
<!-- TABLE-CHECK:END -->

## Open decisions (Gabriel)

1. **Is ora-pm headed to production** (tenant portal, Stripe ACH) or staying pre-production? If
   production, lease economic terms move there at the Postgres migration trigger, and this matrix
   changes with it.
2. **CoStar retention and derivation rights** — until confirmed in writing, `lm_observation` rows
   are treated as license-bound; the purge path is a join on `lm_landing.source`.

## Rules

- A mirror that disagrees with its system of record is a **defect**, not a data point.
- No analytic reads a mirror. If an analytic needs a field only a mirror has, the field is missing
  from the system of record and that is the bug to fix.
- Every cross-store link is recorded in `entity_xref` with its `match_method`, never inferred at
  query time.
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/system-of-record-doc.test.ts`
Expected: PASS, 3 tests. (If the third fails, the `**Ratified by Gabriel:**` line is missing — it must stay in the file, pending or not.)

- [ ] **Step 5: Commit**

```bash
git add architecture/system-of-record.md tests/unit/system-of-record-doc.test.ts
git commit -m "docs(architecture): system-of-record matrix + drift test"
```

---

### Task 5: Entity crosswalk core

**Files:**
- Create: `server/warehouse/entity-xref.ts`, `tests/unit/entity-xref.test.ts`

**Interfaces:**
- Consumes: `entity_xref` from Task 3.
- Produces: `linkEntity(db, link: EntityLink): void` · `canonicalIdFor(db, system: string, entityType: EntityType, externalId: string): string | null` · `unmatchedReport(db, entityType: EntityType): UnmatchedRow[]` where `EntityLink = { entityType: EntityType; canonicalId: string; system: string; externalId: string; matchMethod: MatchMethod; confidence?: number }`.

> **This module deliberately contains NO address normalizer.** Address normalization belongs to the lease-market module (`src/analytics/lease-market/normalize.ts`, `splitAddress`), and Task 6 imports it. A second implementation that agrees with it today is precisely the drift this crosswalk exists to prevent — and that normalizer is actively changing (a building-designator collapse, where "Bldg 1" and "Bldg 2" reduce to one address, is being fixed on the lease-market branch). `server/` importing from `src/` is the established pattern here (77 files already do).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/entity-xref.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/warehouse/migrate';
import { linkEntity, canonicalIdFor, unmatchedReport } from '../../server/warehouse/entity-xref';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('linkEntity / canonicalIdFor', () => {
  it('stores a link and reads it back', () => {
    const db = makeDb();
    linkEntity(db, { entityType: 'property', canonicalId: 'prop-1', system: 'ora_pm', externalId: 'pm-42', matchMethod: 'exact_address' });
    expect(canonicalIdFor(db, 'ora_pm', 'property', 'pm-42')).toBe('prop-1');
    expect(canonicalIdFor(db, 'ora_pm', 'property', 'nope')).toBeNull();
  });

  it('is idempotent — re-linking the same pair does not throw or duplicate', () => {
    const db = makeDb();
    const link = { entityType: 'property' as const, canonicalId: 'prop-1', system: 'notion', externalId: 'n-1', matchMethod: 'manual' as const };
    linkEntity(db, link);
    linkEntity(db, link);
    expect((db.prepare('SELECT COUNT(*) AS n FROM entity_xref').get() as { n: number }).n).toBe(1);
  });

  it('refuses to silently repoint an external id at a different canonical id', () => {
    const db = makeDb();
    linkEntity(db, { entityType: 'property', canonicalId: 'prop-1', system: 'notion', externalId: 'n-1', matchMethod: 'manual' });
    expect(() => linkEntity(db, { entityType: 'property', canonicalId: 'prop-2', system: 'notion', externalId: 'n-1', matchMethod: 'manual' }))
      .toThrow(/already linked to prop-1/);
  });
});

describe('unmatchedReport', () => {
  it('lists warehouse properties that have no link in any other system', () => {
    const db = makeDb();
    db.prepare(`INSERT INTO property_master (id, name, financial_mode, ownership_pct, ownership_status)
                VALUES ('prop-1','Linked','pnl',1.0,'active')`).run();
    db.prepare(`INSERT INTO property_master (id, name, financial_mode, ownership_pct, ownership_status)
                VALUES ('prop-2','Orphan','pnl',1.0,'active')`).run();
    linkEntity(db, { entityType: 'property', canonicalId: 'prop-1', system: 'ora_pm', externalId: 'pm-1', matchMethod: 'exact_id' });
    expect(unmatchedReport(db, 'property')).toEqual([{ canonicalId: 'prop-2', name: 'Orphan' }]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/entity-xref.test.ts`
Expected: FAIL — cannot resolve `../../server/warehouse/entity-xref`.

- [ ] **Step 3: Write the implementation**

Create `server/warehouse/entity-xref.ts`:

```ts
// server/warehouse/entity-xref.ts
//
// Canonical identity across stores. This module stores and reads links; it does NOT normalize
// addresses — that is the lease-market module's normalizer (see Task 6), imported rather than
// reimplemented. A wrong auto-link is worse than an unmatched row, because every later join
// inherits it silently, so anything short of an unambiguous match is reported to a human.
import type { WarehouseDb } from './db';

export type EntityType = 'property' | 'unit' | 'tenant' | 'lease';
export type MatchMethod = 'exact_id' | 'exact_address' | 'identity_key' | 'manual' | 'ambiguous';

export interface EntityLink {
  entityType: EntityType;
  canonicalId: string;
  system: string;
  externalId: string;
  matchMethod: MatchMethod;
  confidence?: number;
}

export interface UnmatchedRow { canonicalId: string; name: string }

export function linkEntity(db: WarehouseDb, link: EntityLink): void {
  const existing = db
    .prepare('SELECT canonical_id FROM entity_xref WHERE system = ? AND entity_type = ? AND external_id = ?')
    .get(link.system, link.entityType, link.externalId) as { canonical_id: string } | undefined;

  if (existing) {
    if (existing.canonical_id !== link.canonicalId) {
      throw new Error(
        `${link.system}:${link.entityType}:${link.externalId} is already linked to ${existing.canonical_id} — ` +
          `refusing to repoint it at ${link.canonicalId}; resolve by hand and record the change in audit_log`,
      );
    }
    return;
  }

  db.prepare(
    `INSERT INTO entity_xref (entity_type, canonical_id, system, external_id, match_method, confidence)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(link.entityType, link.canonicalId, link.system, link.externalId, link.matchMethod, link.confidence ?? 1.0);
}

export function canonicalIdFor(
  db: WarehouseDb, system: string, entityType: EntityType, externalId: string,
): string | null {
  const row = db
    .prepare('SELECT canonical_id FROM entity_xref WHERE system = ? AND entity_type = ? AND external_id = ?')
    .get(system, entityType, externalId) as { canonical_id: string } | undefined;
  return row?.canonical_id ?? null;
}

export function unmatchedReport(db: WarehouseDb, entityType: EntityType): UnmatchedRow[] {
  if (entityType !== 'property') return [];
  return (
    db.prepare(
      `SELECT pm.id AS canonicalId, pm.name AS name
         FROM property_master pm
        WHERE NOT EXISTS (
              SELECT 1 FROM entity_xref x
               WHERE x.entity_type = 'property' AND x.canonical_id = pm.id)
        ORDER BY pm.id`,
    ).all() as UnmatchedRow[]
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/entity-xref.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add server/warehouse/entity-xref.ts tests/unit/entity-xref.test.ts
git commit -m "feat(warehouse): entity crosswalk link storage"
```

---

### Task 6: Crosswalk seeder CLI (feature-detects the lease-market tables)

**Files:**
- Create: `scripts/seed-entity-xref.ts`
- Modify: `server/warehouse/entity-xref.ts` (add `seedFromLeaseMarket`), `tests/unit/entity-xref.test.ts` (add its tests), `package.json` (script `xref:seed`)

**Interfaces:**
- Produces: `seedFromLeaseMarket(db): { linked: number; skipped: string[] }` — links `lm_property` rows to warehouse property ids by normalized address; returns `{ linked: 0, skipped: ['lm_property table absent'] }` when the lease-market migration has not landed yet.

> **Dependency:** seeding real data requires `feat/lease-market-intel` to be merged. The function is written and tested against a synthetic `lm_property` table so it can be built before the merge.

> **STATUS 2026-09-17: NOT BUILT — held deliberately.** The owning session asked that this wait,
> because the normalizer is still moving. Two changes confirmed by that session after this plan
> was written:
>
> - **`normalizeSuite` now preserves the building designator.** CoStar "1100 Rarig Ave Bldg 1"
>   suite "A" normalizes to suite `B1-A`; "Bldg 2"/"A" to `B2-A`. **`addressNorm` is unchanged**
>   (`1100 RARIG AVE`) in every case, so the property-level matching this task performs is
>   unaffected. Any *suite-level* join added later must expect the `B<n>-` prefix.
> - **Unit↔suite matching is becoming a three-step cascade** (exact, building-stripped,
>   single-space fallback). If this crosswalk ever matches at suite level, import that cascade —
>   writing a fourth matcher is the same drift constraint 9 exists to prevent.
>
> Build this only after the merge, and pin its tests against the merged normalizer.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/entity-xref.test.ts`:

```ts
import { seedFromLeaseMarket } from '../../server/warehouse/entity-xref';

/** Minimal stand-in for migration 029's lm_property, so this suite does not depend on the
 *  lease-market branch having landed. Only the columns the seeder reads. */
function createStubLmProperty(db: Database.Database): void {
  db.exec(`CREATE TABLE lm_property (
    lm_property_id INTEGER PRIMARY KEY,
    identity_key   TEXT NOT NULL UNIQUE,
    address_norm   TEXT NOT NULL,
    city_norm      TEXT NOT NULL DEFAULT ''
  )`);
}

function addProperty(db: Database.Database, id: string, address: string | null, market = 'Columbus'): void {
  db.prepare(`INSERT INTO property_master (id, name, financial_mode, ownership_pct, ownership_status, address, market)
              VALUES (?, ?, 'pnl', 1.0, 'active', ?, ?)`).run(id, `Property ${id}`, address, market);
}

function addLmProperty(db: Database.Database, lmId: number, market: string, city: string, addressNorm: string): void {
  db.prepare(`INSERT INTO lm_property (lm_property_id, identity_key, address_norm, city_norm)
              VALUES (?, ?, ?, ?)`).run(lmId, `addr:${market}|${city}|${addressNorm}`, addressNorm, city);
}

describe('seedFromLeaseMarket', () => {
  it('skips cleanly when the lease-market tables have not landed', () => {
    const db = makeDb();
    expect(seedFromLeaseMarket(db)).toEqual({ linked: 0, skipped: ['lm_property table absent'] });
  });

  it('links an ORA-owned building to its lm_property row', () => {
    const db = makeDb();
    createStubLmProperty(db);
    addProperty(db, 'prop-1', '1100 Rarig Ave.');
    addLmProperty(db, 7, 'columbus', 'columbus', '1100 rarig ave');

    expect(seedFromLeaseMarket(db)).toEqual({ linked: 1, skipped: [] });
    expect(canonicalIdFor(db, 'lease_market', 'property', '7')).toBe('prop-1');
  });

  it('does not link across markets when the street address happens to coincide', () => {
    const db = makeDb();
    createStubLmProperty(db);
    addProperty(db, 'prop-md', '500 Main St', 'Baltimore');
    addLmProperty(db, 8, 'columbus', 'columbus', '500 main st');

    expect(seedFromLeaseMarket(db)).toEqual({ linked: 0, skipped: [] });
  });

  it('reports rather than links when two warehouse properties share one address in a market', () => {
    const db = makeDb();
    createStubLmProperty(db);
    addProperty(db, 'prop-1', '500 Main Street');
    addProperty(db, 'prop-2', '500 Main St');
    addLmProperty(db, 9, 'columbus', 'columbus', '500 main st');

    const result = seedFromLeaseMarket(db);
    expect(result.linked).toBe(0);
    expect(result.skipped[0]).toMatch(/ambiguous.*500 main st.*prop-1.*prop-2/);
  });

  it('reports rather than links when two lm rows compete for one warehouse property', () => {
    // Real case per the lease-market session: address_norm is NOT unique within a market —
    // two different cities can share a street address, and a blank-city row may not yet be
    // bridged to its city-bearing twin.
    const db = makeDb();
    createStubLmProperty(db);
    addProperty(db, 'prop-1', '4300 Industrial Blvd');
    addLmProperty(db, 21, 'columbus', 'columbus', '4300 industrial blvd');
    addLmProperty(db, 22, 'columbus', 'worthington', '4300 industrial blvd');

    const result = seedFromLeaseMarket(db);
    expect(result.linked).toBe(0);
    expect(result.skipped[0]).toMatch(/ambiguous.*prop-1.*lm rows 21, 22/);
    expect(canonicalIdFor(db, 'lease_market', 'property', '21')).toBeNull();
  });

  it('leaves a warehouse property with no address untouched instead of guessing', () => {
    const db = makeDb();
    createStubLmProperty(db);
    addProperty(db, 'prop-3', null);
    addLmProperty(db, 11, 'columbus', 'columbus', '900 nowhere rd');
    expect(seedFromLeaseMarket(db)).toEqual({ linked: 0, skipped: [] });
  });
});
```

> **Schema fact (verified against `001_initial.sql:7-24` + `024`):** `property_master` has `id, name, market, address, property_manager, pm_contact, pm_platform, financial_mode, rentable_sf, acquisition_date, ownership_pct, ownership_status, asset_class, notes, content_hash, created_at, updated_at`. **There is no `city` column**, so the full `addr:<market>|<city>|<address>` key cannot be reconstructed warehouse-side. The seeder therefore matches on market + normalized address, parsing the market out of `identity_key`, and refuses any match that is not one-to-one in both directions.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/entity-xref.test.ts -t seedFromLeaseMarket`
Expected: FAIL — `seedFromLeaseMarket is not a function`.

- [ ] **Step 3: Implement the seeder**

Append to `server/warehouse/entity-xref.ts`:

```ts
// The lease-market module owns address normalization. Import it — never reimplement it. Its
// behaviour is changing (building-designator collapse fix), and inheriting that change is the
// point: two implementations that agree today are a silent divergence tomorrow.
import { splitAddress } from '../../src/analytics/lease-market/normalize';

export interface SeedResult { linked: number; skipped: string[] }

function tableExists(db: WarehouseDb, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

/** identity_key is `addr:<market>|<city>|<address>` or `costar:<id>`. Only the addr: form
 *  carries a market, and only that form can be matched warehouse-side. */
function marketFromIdentityKey(identityKey: string): string | null {
  if (!identityKey.startsWith('addr:')) return null;
  return identityKey.slice('addr:'.length).split('|')[0] ?? null;
}

const marketKey = (market: string | null, addressNorm: string): string =>
  `${(market ?? '').trim().toLowerCase()}|${addressNorm}`;

/** Links ORA-owned buildings to their lease-market rows.
 *
 *  Matches on market + normalized address. `address_norm` is NOT unique within a market: two
 *  cities can share a street address, and a blank-city row may not yet be bridged to its
 *  city-bearing twin. So a link is written ONLY when the match is one-to-one in BOTH directions —
 *  one warehouse property for the address, and one lm row for that property. Everything else is
 *  reported for a human. A wrong link corrupts every later join silently, which is strictly worse
 *  than an unlinked row somebody has to look at. */
export function seedFromLeaseMarket(db: WarehouseDb): SeedResult {
  if (!tableExists(db, 'lm_property')) return { linked: 0, skipped: ['lm_property table absent'] };

  const owned = db.prepare(
    `SELECT id, address, market FROM property_master WHERE address IS NOT NULL AND address <> ''`,
  ).all() as Array<{ id: string; address: string; market: string | null }>;

  const propertiesByKey = new Map<string, string[]>();
  for (const p of owned) {
    const { addressNorm } = splitAddress(p.address, null);
    const key = marketKey(p.market, addressNorm);
    propertiesByKey.set(key, [...(propertiesByKey.get(key) ?? []), p.id]);
  }

  const lmRows = db.prepare('SELECT lm_property_id, identity_key, address_norm FROM lm_property').all() as
    Array<{ lm_property_id: number; identity_key: string; address_norm: string }>;

  // Group lm rows by the key they would match, so two lm rows competing for one warehouse
  // property are caught before either is linked.
  const lmByKey = new Map<string, Array<{ id: number }>>();
  for (const lm of lmRows) {
    const market = marketFromIdentityKey(lm.identity_key);
    if (market === null) continue; // costar:<id> form carries no market — not matchable here
    // Re-run the source address through the same normalizer, so both sides are one function.
    const { addressNorm } = splitAddress(lm.address_norm, null);
    const key = marketKey(market, addressNorm);
    lmByKey.set(key, [...(lmByKey.get(key) ?? []), { id: lm.lm_property_id }]);
  }

  const skipped: string[] = [];
  let linked = 0;

  for (const [key, lmGroup] of lmByKey) {
    const properties = propertiesByKey.get(key);
    if (!properties) continue;
    const address = key.split('|').slice(1).join('|');

    if (properties.length > 1) {
      skipped.push(`ambiguous: ${address} matches ${properties.join(', ')} — resolve by hand`);
      continue;
    }
    if (lmGroup.length > 1) {
      skipped.push(
        `ambiguous: ${properties[0]} at ${address} matches lm rows ${lmGroup.map((l) => l.id).join(', ')} ` +
          '— different cities or an unbridged blank-city row; resolve by hand',
      );
      continue;
    }

    linkEntity(db, {
      entityType: 'property', canonicalId: properties[0], system: 'lease_market',
      externalId: String(lmGroup[0].id), matchMethod: 'exact_address',
    });
    linked += 1;
  }
  return { linked, skipped };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/entity-xref.test.ts`
Expected: PASS, 10 tests.

> **Before pinning behaviour here:** pull the latest `feat/lease-market-intel` first. `splitAddress` is being changed on that branch (building designators such as "Bldg 1" / "Bldg 2" currently collapse to one address). Running these tests against the pre-fix normalizer may pass for the wrong reason.

- [ ] **Step 5: Write the CLI**

Create `scripts/seed-entity-xref.ts`:

```ts
/**
 * Seeds entity_xref and prints what could not be matched.
 * Usage: npm run xref:seed
 * Read-only against every store except entity_xref.
 */
import { loadEnvFile } from '../server/load-env';
loadEnvFile();
import { join } from 'node:path';
import { openWarehouse } from '../server/warehouse/db';
import { seedFromLeaseMarket, unmatchedReport } from '../server/warehouse/entity-xref';

const dbPath = process.env.WAREHOUSE_DB ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite');
const db = openWarehouse(dbPath);
try {
  const result = seedFromLeaseMarket(db);
  console.log(`lease-market links: ${result.linked}`);
  for (const s of result.skipped) console.warn(`  SKIPPED ${s}`);

  const unmatched = unmatchedReport(db, 'property');
  console.log(`\nproperties with no cross-system link: ${unmatched.length}`);
  for (const row of unmatched) console.log(`  ${row.canonicalId}  ${row.name}`);
  if (unmatched.length > 0) {
    console.log('\nEach unmatched property is a join that will silently fail later. Resolve by hand ' +
                'and record the link with match_method = manual.');
  }
} finally {
  db.close();
}
```

- [ ] **Step 6: Register the npm script**

In `package.json`, after `"backup:verify"`:

```json
    "xref:seed": "tsx scripts/seed-entity-xref.ts",
```

- [ ] **Step 7: Commit**

```bash
git add scripts/seed-entity-xref.ts server/warehouse/entity-xref.ts tests/unit/entity-xref.test.ts package.json
git commit -m "feat(warehouse): crosswalk seeder with ambiguity reporting"
```

---

### Task 7: Audit and agent-run helpers

**Files:**
- Create: `server/warehouse/audit.ts`, `server/warehouse/agent-runs.ts`, `tests/unit/audit-log.test.ts`

**Interfaces:**
- Produces: `appendAudit(db, entry: AuditEntry): number` (returns `seq`) · `auditTrail(db, entity: string, entityId: string): AuditEntry[] ` · `withAgentRun<T>(db, meta: RunMeta, fn: (runId: string) => Promise<T>): Promise<T>` · `recordUsage(db, runId: string, usage: { tokensIn: number; tokensOut: number; costUsd?: number }): void`. `AuditEntry = { at: string; actor: string; action: string; entity: string; entityId: string; before?: unknown; after?: unknown }`. `RunMeta = { pipeline: string; model?: string; promptVersion?: string; inputSha256?: string }`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/audit-log.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/warehouse/migrate';
import { appendAudit, auditTrail } from '../../server/warehouse/audit';
import { withAgentRun, recordUsage } from '../../server/warehouse/agent-runs';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('appendAudit / auditTrail', () => {
  it('records an entry and returns its sequence number', () => {
    const db = makeDb();
    const seq = appendAudit(db, {
      at: '2026-09-17T12:00:00Z', actor: 'gabriel', action: 'verify',
      entity: 'lease_facts', entityId: 'f1', before: { status: 'extracted' }, after: { status: 'verified' },
    });
    expect(seq).toBe(1);
    const trail = auditTrail(db, 'lease_facts', 'f1');
    expect(trail).toHaveLength(1);
    expect(trail[0].after).toEqual({ status: 'verified' });
  });

  it('keeps entries in insertion order for one entity', () => {
    const db = makeDb();
    for (const action of ['extract', 'dispute', 'verify']) {
      appendAudit(db, { at: '2026-09-17T12:00:00Z', actor: 'pipeline', action, entity: 'lease_facts', entityId: 'f1' });
    }
    expect(auditTrail(db, 'lease_facts', 'f1').map((e) => e.action)).toEqual(['extract', 'dispute', 'verify']);
  });
});

describe('withAgentRun', () => {
  it('marks a successful run ok and records usage', async () => {
    const db = makeDb();
    const out = await withAgentRun(db, { pipeline: 'lease-extract', model: 'claude-sonnet-5' }, async (runId) => {
      recordUsage(db, runId, { tokensIn: 1000, tokensOut: 200, costUsd: 0.004 });
      return 'done';
    });
    expect(out).toBe('done');
    const row = db.prepare('SELECT status, tokens_in, cost_usd, ended_at FROM agent_runs').get() as
      { status: string; tokens_in: number; cost_usd: number; ended_at: string };
    expect(row.status).toBe('ok');
    expect(row.tokens_in).toBe(1000);
    expect(row.ended_at).toBeTruthy();
  });

  it('marks a failed run error, stores the message, and rethrows', async () => {
    const db = makeDb();
    await expect(withAgentRun(db, { pipeline: 'lease-extract' }, async () => {
      throw new Error('model refused');
    })).rejects.toThrow('model refused');
    const row = db.prepare('SELECT status, error FROM agent_runs').get() as { status: string; error: string };
    expect(row.status).toBe('error');
    expect(row.error).toMatch(/model refused/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/audit-log.test.ts`
Expected: FAIL — cannot resolve `../../server/warehouse/audit`.

- [ ] **Step 3: Write both modules**

Create `server/warehouse/audit.ts`:

```ts
// server/warehouse/audit.ts — every human verification, correction and override lands here.
// The table is append-only at the database level (migration 030 triggers); this module is the
// only sanctioned writer.
import type { WarehouseDb } from './db';

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  entity: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

export function appendAudit(db: WarehouseDb, entry: AuditEntry): number {
  const info = db.prepare(
    `INSERT INTO audit_log (at, actor, action, entity, entity_id, before_json, after_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.at, entry.actor, entry.action, entry.entity, entry.entityId,
    entry.before === undefined ? null : JSON.stringify(entry.before),
    entry.after === undefined ? null : JSON.stringify(entry.after),
  );
  return Number(info.lastInsertRowid);
}

export function auditTrail(db: WarehouseDb, entity: string, entityId: string): AuditEntry[] {
  const rows = db.prepare(
    `SELECT at, actor, action, entity, entity_id AS entityId, before_json, after_json
       FROM audit_log WHERE entity = ? AND entity_id = ? ORDER BY seq`,
  ).all(entity, entityId) as Array<AuditEntry & { before_json: string | null; after_json: string | null }>;

  return rows.map((r) => ({
    at: r.at, actor: r.actor, action: r.action, entity: r.entity, entityId: r.entityId,
    before: r.before_json ? JSON.parse(r.before_json) : undefined,
    after: r.after_json ? JSON.parse(r.after_json) : undefined,
  }));
}
```

Create `server/warehouse/agent-runs.ts`:

```ts
// server/warehouse/agent-runs.ts — provenance for every LLM-backed pipeline run.
// Without this, "which model version produced this fact, from which input, at what cost" is
// unanswerable, and a silent extraction regression is invisible until someone reads a lease.
import { randomUUID } from 'node:crypto';
import type { WarehouseDb } from './db';

export interface RunMeta {
  pipeline: string;
  model?: string;
  promptVersion?: string;
  inputSha256?: string;
}

export function recordUsage(
  db: WarehouseDb, runId: string, usage: { tokensIn: number; tokensOut: number; costUsd?: number },
): void {
  db.prepare('UPDATE agent_runs SET tokens_in = ?, tokens_out = ?, cost_usd = ? WHERE run_id = ?')
    .run(usage.tokensIn, usage.tokensOut, usage.costUsd ?? null, runId);
}

export async function withAgentRun<T>(
  db: WarehouseDb, meta: RunMeta, fn: (runId: string) => Promise<T>,
): Promise<T> {
  const runId = randomUUID();
  db.prepare(
    `INSERT INTO agent_runs (run_id, pipeline, model, prompt_version, input_sha256, status, started_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?)`,
  ).run(runId, meta.pipeline, meta.model ?? null, meta.promptVersion ?? null, meta.inputSha256 ?? null, new Date().toISOString());

  try {
    const result = await fn(runId);
    db.prepare("UPDATE agent_runs SET status = 'ok', ended_at = ? WHERE run_id = ?")
      .run(new Date().toISOString(), runId);
    return result;
  } catch (err) {
    db.prepare("UPDATE agent_runs SET status = 'error', error = ?, ended_at = ? WHERE run_id = ?")
      .run(err instanceof Error ? err.message : String(err), new Date().toISOString(), runId);
    throw err;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/audit-log.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the full gate**

Run: `npm run gate`
Expected: all stages green. If `check:schema-drift` flags the new tables, it is because a write route now binds them — that is Track 3; no route exists yet at this point.

- [ ] **Step 6: Commit**

```bash
git add server/warehouse/audit.ts server/warehouse/agent-runs.ts tests/unit/audit-log.test.ts
git commit -m "feat(warehouse): append-only audit trail and agent-run provenance"
```

---

## Track 1 completion criteria

1. `npm run backup` then `npm run backup:verify` both exit 0; the restore time is recorded.
2. `BACKUP_KEY_HEX` lives outside the repo and `BACKUP_DIR` points off-machine.
3. Migration 030 applied; `npm run gate` green.
4. `npm run xref:seed` run after the lease-market merge; unmatched list is empty or every entry explained.
5. `architecture/system-of-record.md` ratified by Gabriel (the pending line filled in).
