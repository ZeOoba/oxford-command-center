// server/warehouse/ingest.ts
import { basename } from 'node:path';
import { detectFromFilename } from './detect';
import type { WarehouseDb } from './db';
import { resolveMapping, sectionSide } from './mapping';
import { PARSER_VERSION, parseQbExcel } from './parse/qb-excel';
import { registerImport } from './raw-store';

/** Thrown inside the ingest transaction to ROLL BACK a re-derive of a committed row that no longer
 *  qualifies for commit — preserving the prior committed data instead of emptying a served period. */
class RestaleAbort extends Error {}

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

  const detectNotes = `token=${det.propertyToken}; propertyRaw=${stmt.propertyRaw}`;
  const reg = registerImport(db, {
    sourcePath: filePath, rawDir: opts.rawDir,
    propertyId: det.propertyId, periodStart, periodEnd,
    grain: det.grain, basis: stmt.basis, sourceSystem: stmt.sourceSystem,
    confidence: det.confidence, parserVersion: PARSER_VERSION,
    importedAt: opts.importedAt, importedBy: opts.importedBy, detectNotes,
  });
  if (reg.kind === 'duplicate') {
    return { file: fileName, status: 'duplicate', importId: reg.existingImportId };
  }
  // 'new' → fresh row; 'restale' → an existing ACTIVE row produced by an older parser, re-derived
  // IN PLACE (same importId, preserving history/refs). The derivation body below is identical for
  // both; restale first clears the prior ledger/issues and refreshes the row's derived columns.
  const importId = reg.kind === 'new' ? reg.importId : reg.existingImportId;
  const isReDerive = reg.kind === 'restale';
  // status BEFORE the re-derive — a re-derive of a SERVING ('committed') row that turns out not to
  // qualify for commit must NOT silently empty the period; it is rolled back to preserve the prior
  // committed data (see RestaleAbort below). pending-review rows aren't serving, so they re-derive freely.
  const priorStatus = isReDerive
    ? (db.prepare('SELECT status FROM import_batches WHERE id = ?').get(importId) as { status: string }).status
    : null;

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
  // its signed non-zero leaf SUM is negative — contra rows (tax refunds)
  // correctly invert with the side. Never silent: a 'sign-normalized' DQ info row is
  // written whenever a flip is applied.
  const flip: Record<'income' | 'expense', boolean> = { income: false, expense: false };
  for (const sideKey of ['income', 'expense'] as const) {
    let sum = 0;
    for (const a of stmt.accounts) {
      if (a.total === null || a.total === 0 || sectionSide(a.section) !== sideKey) continue;
      sum += a.total;
    }
    flip[sideKey] = sum < 0;
  }
  const tx = db.transaction(() => {
    if (isReDerive) {
      // In-place re-derive of a stale (older-parser) import: drop its prior ledger + DQ rows and
      // refresh its derived columns from the fresh parse. The commit/supersede block below then
      // re-decides its status as if freshly ingested. parser_version is stamped to current.
      db.prepare('DELETE FROM ledger_entries WHERE import_id = ?').run(importId);
      db.prepare('DELETE FROM data_quality_issues WHERE import_id = ?').run(importId);
      db.prepare(`UPDATE import_batches SET basis = ?, source_system = ?, period_start = ?, period_end = ?,
        period_grain = ?, confidence = ?, detect_notes = ?, parser_version = ? WHERE id = ?`)
        .run(stmt.basis, stmt.sourceSystem, periodStart, periodEnd, det.grain, det.confidence, detectNotes, PARSER_VERSION, importId);
    }
    for (const sideKey of ['income', 'expense'] as const) {
      if (flip[sideKey]) {
        insIssue.run(importId, det.propertyId, 'sign-normalized',
          `${sideKey}-side signed leaf sum is negative (outflow convention) — amounts flipped to positive-cost magnitudes on ingest`, 'info');
      }
    }
    for (const a of stmt.accounts) {
      if (a.total === null) continue;
      const m = resolveMapping(db, a.name, det.propertyId ?? undefined, a.section, undefined, period);
      if (m.matchKind === 'unmapped') {
        unmapped.push(a.name);
        insIssue.run(importId, det.propertyId, 'unmapped-account', `${a.name} (section ${a.section}) defaulted to Unmapped/opex`, 'warn');
      }
      const side = sectionSide(a.section);
      const amount = side && flip[side] ? -a.total : a.total;
      insLedger.run(importId, det.propertyId ?? 'unknown', period, a.name, a.code ?? null, amount, m.normalizedCategory, m.classification, m.mappingId);
      insertedRows += 1;
      // side via the SOURCE section (not classification): report-stated totals include
      // every row under the section — even ones the NOI engine later excludes.
      if (side === 'income') incomeSum += amount;
    }
    // Foot the report's own stated INCOME total against what we inserted: a section drop
    // or wrong value column commits silently without this choke point. Reports only —
    // never blocks or downgrades the commit/pending decision.
    //
    // The income SIDE foot stays as measured 2026-06-12 (income foots exactly 32/32
    // across all staged files). The EXPENSE side cannot foot per side: every PM
    // format's stated expense total covers a narrower scope than the lingering section
    // state attributes —
    //  - QB/Rent-Manager charts display it NEGATIVE and exclude NON OPERATING EXPENSE
    //    (Rarig 2024: stated -125,539.93 vs EXPENSE-section leaves +125,539.93 exact);
    //  - Yardi "Total Operating Expenses" excludes the financing/capital rows that follow
    //    in the same lingering section (29000 Info Lane 2025 carries the refinance flows:
    //    section sum -5.79M vs stated 200,321.42) — the seed classifies those rows out of
    //    NOI correctly, so the ledger is right even though a naive section foot is not;
    //  - 1851 Solar's stated total covers Ordinary Expense only (delta = Other Expense).
    // The expense side therefore foots per SECTION below: parse-side accumulation
    // closes each section at its top-level Total row, so each stated total is compared
    // at exactly the scope it covers.
    if (stmt.totalIncome !== null && Math.abs(stmt.totalIncome - incomeSum) > FOOT_TOLERANCE) {
      insIssue.run(importId, det.propertyId, 'foot-mismatch',
        `income foot mismatch: report-stated total ${stmt.totalIncome} vs parsed income-side sum ${incomeSum} (delta ${(stmt.totalIncome - incomeSum).toFixed(2)})`, 'warn');
    }
    // Per-SECTION foot (both sides — the expense-side choke point): every section that
    // carries a report-stated total must tie to ITS OWN leaf sum. Compared in PARSE
    // space (RawStatement values, before the sign-normalization applied to ledger rows)
    // with absolute values on BOTH sides: QB/Rent-Manager display expense totals
    // negative against positive leaves (Rarig), 9620 books expense leaves negative
    // against a negative stated total — abs neutralizes both display conventions.
    // Sections that never state a total (no top-level Total row) are not footable.
    for (const sec of stmt.sections) {
      if (sec.statedTotal === null) continue;
      if (Math.abs(Math.abs(sec.statedTotal) - Math.abs(sec.leafSum)) > FOOT_TOLERANCE) {
        insIssue.run(importId, det.propertyId, 'foot-mismatch',
          `section foot mismatch [${sec.name}]: report-stated total ${sec.statedTotal} vs section-scoped leaf sum ${sec.leafSum} (|stated| ${Math.abs(sec.statedTotal).toFixed(2)} vs |leaves| ${Math.abs(sec.leafSum).toFixed(2)})`, 'warn');
      }
    }
    if (insertedRows === 0) {
      // empty parse = adapter/layout failure, never a valid statement — committing it
      // would silently record the period as ingested with zero ledger rows (data loss).
      insIssue.run(importId, det.propertyId, 'empty-parse', `parsed 0 valued accounts from ${fileName} (sourceSystem ${stmt.sourceSystem})`, 'error');
    }
    const commit = insertedRows > 0 && det.propertyId !== null && det.confidence >= threshold && unmapped.length === 0;
    if (commit) {
      // supersede prior committed versions for the same logical period
      const priors = db.prepare(`
        SELECT id FROM import_batches
        WHERE property_id = ? AND period_start IS ? AND period_end IS ? AND id != ? AND status = 'committed'
      `).all(det.propertyId, periodStart, periodEnd, importId) as Array<{ id: number }>;
      for (const p of priors) {
        db.prepare("UPDATE ledger_entries SET is_active = 0 WHERE import_id = ?").run(p.id);
        db.prepare("UPDATE import_batches SET status = 'superseded', superseded_by = ? WHERE id = ?").run(importId, p.id);
      }
      db.prepare("UPDATE import_batches SET status = 'committed' WHERE id = ?").run(importId);
    } else {
      // A re-derive of a SERVING ('committed') row that no longer qualifies would empty the period
      // (deactivated ledger + no active prior) — that silently drops a property from served NOI.
      // Abort the tx instead: rollback restores the prior committed ledger/status/parser_version intact.
      if (isReDerive && priorStatus === 'committed') throw new RestaleAbort();
      // pending-review rows are not active until approved
      db.prepare("UPDATE ledger_entries SET is_active = 0 WHERE import_id = ?").run(importId);
      if (isReDerive) db.prepare("UPDATE import_batches SET status = 'pending-review' WHERE id = ?").run(importId);
    }
    return commit;
  });

  let committed: boolean;
  try {
    committed = tx();
  } catch (e) {
    if (!(e instanceof RestaleAbort)) throw e;
    // Prior committed version preserved (tx rolled back; parser_version stays stale so a later,
    // fixed parser re-attempts). Surface the skip once (deduped) so it's visible to DQ queries.
    const flagged = db.prepare("SELECT 1 FROM data_quality_issues WHERE import_id = ? AND kind = 'restale-skipped'").get(importId);
    if (!flagged) {
      db.prepare("INSERT INTO data_quality_issues (import_id, property_id, kind, detail, severity) VALUES (?, ?, ?, ?, ?)")
        .run(importId, det.propertyId, 'restale-skipped',
          `parser-version re-derive (v${PARSER_VERSION}) no longer qualifies for commit (unmapped/low-confidence/empty) — prior committed version retained`, 'warn');
    }
    return { file: fileName, status: 'committed', importId, reason: 'restale-skipped' };
  }

  return {
    file: fileName,
    status: committed ? 'committed' : 'pending-review',
    importId,
    version: reg.kind === 'new' ? reg.version : undefined,
    reason: insertedRows === 0 ? 'empty-parse' : undefined,
    unmapped: unmapped.length ? unmapped : undefined,
  };
}
