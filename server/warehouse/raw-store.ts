// server/warehouse/raw-store.ts
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { WarehouseDb } from './db';

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export interface RegisterInput {
  sourcePath: string;
  rawDir: string;
  propertyId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  grain: string;
  basis: string;
  sourceSystem: string;
  confidence: number;
  /** Current parse/derivation version (qb-excel PARSER_VERSION). Stamped on new rows; an existing
   *  hash-match whose stored version is BELOW this is re-derivable rather than a plain duplicate. */
  parserVersion: number;
  importedAt: string;
  importedBy?: string;
  detectNotes?: string;
}

export type RegisterResult =
  | { kind: 'new'; importId: number; version: number; rawPath: string; hash: string }
  | { kind: 'duplicate'; existingImportId: number; hash: string }
  // hash-identical to an existing ACTIVE import produced by an older parser ⇒ caller re-derives it
  // in place (refresh derived columns + ledger) rather than skipping. Superseded rows are NEVER
  // restale (historical — re-deriving would resurrect a replaced version).
  | { kind: 'restale'; existingImportId: number; hash: string };

export function registerImport(db: WarehouseDb, input: RegisterInput): RegisterResult {
  const hash = sha256File(input.sourcePath);
  const existing = db.prepare('SELECT id, status, parser_version FROM import_batches WHERE file_hash = ?')
    .get(hash) as { id: number; status: string; parser_version: number } | undefined;
  if (existing) {
    const reDerivable = existing.status === 'committed' || existing.status === 'pending-review';
    if (reDerivable && existing.parser_version < input.parserVersion) {
      return { kind: 'restale', existingImportId: existing.id, hash };
    }
    return { kind: 'duplicate', existingImportId: existing.id, hash };
  }

  mkdirSync(input.rawDir, { recursive: true });
  const fileName = basename(input.sourcePath);
  const rawPath = join(input.rawDir, `${hash.slice(0, 16)}__${fileName}`);
  copyFileSync(input.sourcePath, rawPath); // immutable copy; never overwritten (hash-named)

  const prior = db.prepare(`
    SELECT COALESCE(MAX(version), 0) AS v FROM import_batches
    WHERE property_id IS ? AND period_start IS ? AND period_end IS ?
  `).get(input.propertyId, input.periodStart, input.periodEnd) as { v: number };
  const version = prior.v + 1;

  const res = db.prepare(`
    INSERT INTO import_batches (file_name, file_hash, raw_path, imported_at, imported_by, property_id,
      period_start, period_end, period_grain, basis, source_system, version, status, confidence, detect_notes,
      parser_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending-review', ?, ?, ?)
  `).run(
    fileName, hash, rawPath, input.importedAt, input.importedBy ?? null, input.propertyId,
    input.periodStart, input.periodEnd, input.grain, input.basis, input.sourceSystem,
    version, input.confidence, input.detectNotes ?? null, input.parserVersion,
  );
  return { kind: 'new', importId: Number(res.lastInsertRowid), version, rawPath, hash };
}
