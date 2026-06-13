// server/warehouse/ingest.ts
import { basename } from 'node:path';
import { detectFromFilename } from './detect';
import type { WarehouseDb } from './db';
import { resolveMapping, sectionSide } from './mapping';
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
  const FOOT_TOLERANCE = 1; // dollars
  let insertedRows = 0;
  let incomeSum = 0;
  // Sign-convention normalization: some charts (9620 State 350 / Peak REP QB export)
  // book expense-side rows as NEGATIVE outflows; the ledger stores costs as positive
  // magnitudes (NOI = income − opex), so subtracting negative opex would ADD costs back
  // (the defect that produced 9620 2025 NOI 342,516 instead of 27,614). Flip a side when
  // a strict majority of its non-zero leaves are negative — contra rows (tax refunds)
  // correctly invert with the side. Never silent: a 'sign-normalized' DQ info row is
  // written whenever a flip is applied.
  const flip: Record<'income' | 'expense', boolean> = { income: false, expense: false };
  for (const sideKey of ['income', 'expense'] as const) {
    let neg = 0;
    let pos = 0;
    for (const a of stmt.accounts) {
      if (a.total === null || a.total === 0 || sectionSide(a.section) !== sideKey) continue;
      if (a.total < 0) neg += 1;
      else pos += 1;
    }
    flip[sideKey] = neg > pos;
  }
  const tx = db.transaction(() => {
    for (const sideKey of ['income', 'expense'] as const) {
      if (flip[sideKey]) {
        insIssue.run(reg.importId, det.propertyId, 'sign-normalized',
          `${sideKey}-side leaves are majority-negative (outflow convention) — amounts flipped to positive-cost magnitudes on ingest`, 'info');
      }
    }
    for (const a of stmt.accounts) {
      if (a.total === null) continue;
      const m = resolveMapping(db, a.name, det.propertyId ?? undefined, a.section);
      if (m.matchKind === 'unmapped') {
        unmapped.push(a.name);
        insIssue.run(reg.importId, det.propertyId, 'unmapped-account', `${a.name} (section ${a.section}) defaulted to Unmapped/opex`, 'warn');
      }
      const side = sectionSide(a.section);
      const amount = side && flip[side] ? -a.total : a.total;
      insLedger.run(reg.importId, det.propertyId ?? 'unknown', period, a.name, a.code ?? null, amount, m.normalizedCategory, m.classification, m.mappingId);
      insertedRows += 1;
      // side via the SOURCE section (not classification): report-stated totals include
      // every row under the section — even ones the NOI engine later excludes.
      if (side === 'income') incomeSum += amount;
    }
    // Foot the report's own stated INCOME total against what we inserted: a section drop
    // or wrong value column commits silently without this choke point. Reports only —
    // never blocks or downgrades the commit/pending decision.
    //
    // INCOME ONLY (measured 2026-06-12 across all 32 staged files: income foots exactly
    // 32/32). The EXPENSE side deliberately does NOT foot here: every PM format's stated
    // expense total covers a narrower scope than the section state machine attributes —
    //  - QB/Rent-Manager charts display it NEGATIVE and exclude NON OPERATING EXPENSE
    //    (Rarig 2024: stated -125,539.93 vs EXPENSE-section leaves +125,539.93 exact);
    //  - Yardi "Total Operating Expenses" excludes the financing/capital rows that follow
    //    in the same lingering section (29000 Info Lane 2025 carries the refinance flows:
    //    section sum -5.79M vs stated 200,321.42) — the seed classifies those rows out of
    //    NOI correctly, so the ledger is right even though a naive section foot is not;
    //  - 1851 Solar's stated total covers Ordinary Expense only (delta = Other Expense).
    // A meaningful expense foot needs section-boundary reform (reset section state at
    // each top-level "Total X" row) — Phase B work, tracked in the architecture spec.
    if (stmt.totalIncome !== null && Math.abs(stmt.totalIncome - incomeSum) > FOOT_TOLERANCE) {
      insIssue.run(reg.importId, det.propertyId, 'foot-mismatch',
        `income foot mismatch: report-stated total ${stmt.totalIncome} vs parsed income-side sum ${incomeSum} (delta ${(stmt.totalIncome - incomeSum).toFixed(2)})`, 'warn');
    }
    if (insertedRows === 0) {
      // empty parse = adapter/layout failure, never a valid statement — committing it
      // would silently record the period as ingested with zero ledger rows (data loss).
      insIssue.run(reg.importId, det.propertyId, 'empty-parse', `parsed 0 valued accounts from ${fileName} (sourceSystem ${stmt.sourceSystem})`, 'error');
    }
    const commit = insertedRows > 0 && det.propertyId !== null && det.confidence >= threshold && unmapped.length === 0;
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
    reason: insertedRows === 0 ? 'empty-parse' : undefined,
    unmapped: unmapped.length ? unmapped : undefined,
  };
}
