// server/warehouse/ingest.ts
import { basename } from 'node:path';
import { detectFromFilename } from './detect';
import type { WarehouseDb } from './db';
import { resolveMapping } from './mapping';
import { parseQbExcel } from './parse/qb-excel';
import { registerImport } from './raw-store';

export interface IngestOptions {
  rawDir: string;
  importedAt: string;
  importedBy?: string;
  autoCommitThreshold?: number; // ratified default 0.85
}

export interface IngestResult {
  file: string;
  status: 'committed' | 'pending-review' | 'duplicate' | 'skipped' | 'needs-adapter';
  importId?: number;
  version?: number;
  reason?: string;
  unmapped?: string[];
}

export async function ingestFile(db: WarehouseDb, filePath: string, opts: IngestOptions): Promise<IngestResult> {
  const fileName = basename(filePath);
  const det = detectFromFilename(fileName);
  if (!det) return { file: fileName, status: 'skipped', reason: 'not a P&L filename' };
  if (det.format === 'pdf' || det.format === 'csv') {
    return { file: fileName, status: 'needs-adapter', reason: `${det.format} adapter not in Phase A` };
  }

  const stmt = await parseQbExcel(filePath);
  const periodStart = stmt.periodStart ?? `${det.year}-01-01`;
  const periodEnd = stmt.periodEnd ?? (det.grain === 'year' ? `${det.year}-12-31` : null);
  const period = String(det.year);

  const reg = registerImport(db, {
    sourcePath: filePath, rawDir: opts.rawDir,
    propertyId: det.propertyId, periodStart, periodEnd,
    grain: det.grain, basis: stmt.basis, sourceSystem: stmt.sourceSystem,
    confidence: det.confidence, importedAt: opts.importedAt, importedBy: opts.importedBy,
    detectNotes: `token=${det.propertyToken}; propertyRaw=${stmt.propertyRaw}`,
  });
  if (reg.kind === 'duplicate') {
    return { file: fileName, status: 'duplicate', importId: reg.existingImportId };
  }

  const unmapped: string[] = [];
  const insLedger = db.prepare(`
    INSERT INTO ledger_entries (import_id, property_id, period, raw_account, gl_code, amount,
      normalized_category, classification, mapping_id, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  const insIssue = db.prepare(`
    INSERT INTO data_quality_issues (import_id, property_id, kind, detail, severity) VALUES (?, ?, ?, ?, ?)
  `);

  const threshold = opts.autoCommitThreshold ?? 0.85;
  const tx = db.transaction(() => {
    for (const a of stmt.accounts) {
      if (a.total === null) continue;
      const m = resolveMapping(db, a.name, det.propertyId ?? undefined, a.section);
      if (m.matchKind === 'unmapped') {
        unmapped.push(a.name);
        insIssue.run(reg.importId, det.propertyId, 'unmapped-account', `${a.name} (section ${a.section}) defaulted to Unmapped/opex`, 'warn');
      }
      insLedger.run(reg.importId, det.propertyId ?? 'unknown', period, a.name, a.code ?? null, a.total, m.normalizedCategory, m.classification, m.mappingId);
    }
    const commit = det.propertyId !== null && det.confidence >= threshold && unmapped.length === 0;
    if (commit) {
      // supersede prior committed versions for the same logical period
      const priors = db.prepare(`
        SELECT id FROM import_batches
        WHERE property_id = ? AND period_start IS ? AND period_end IS ? AND id != ? AND status = 'committed'
      `).all(det.propertyId, periodStart, periodEnd, reg.importId) as Array<{ id: number }>;
      for (const p of priors) {
        db.prepare("UPDATE ledger_entries SET is_active = 0 WHERE import_id = ?").run(p.id);
        db.prepare("UPDATE import_batches SET status = 'superseded', superseded_by = ? WHERE id = ?").run(reg.importId, p.id);
      }
      db.prepare("UPDATE import_batches SET status = 'committed' WHERE id = ?").run(reg.importId);
    } else {
      // pending-review rows are not active until approved
      db.prepare("UPDATE ledger_entries SET is_active = 0 WHERE import_id = ?").run(reg.importId);
    }
    return commit;
  });
  const committed = tx();

  return {
    file: fileName,
    status: committed ? 'committed' : 'pending-review',
    importId: reg.importId,
    version: reg.version,
    unmapped: unmapped.length ? unmapped : undefined,
  };
}
