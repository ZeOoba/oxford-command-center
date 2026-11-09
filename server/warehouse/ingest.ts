// server/warehouse/ingest.ts
import { basename } from 'node:path';
import { detectFromFilename } from './detect';
import type { WarehouseDb } from './db';
import { resolveMapping, sectionSide } from './mapping';
import { PARSER_VERSION, parseQbExcel } from './parse/qb-excel';
import { newerCommittedImport, registerImport } from './raw-store';

/** Thrown inside the ingest transaction to ROLL BACK a re-derive of a committed row that no longer
 *  qualifies for commit — preserving the prior committed data instead of emptying a served period. */
class RestaleAbort extends Error {
  constructor(readonly propertyGate: string | null) {
    super('restale re-derive no longer qualifies for commit');
  }
}

/** Thrown inside the ingest transaction when, under the write lock, the batch this ingest registered (new) or is
 *  re-deriving (restale) is no longer in the state registration saw: a concurrent reject/supersede, or another re-derive
 *  already stamped the current parser. The ingest writes nothing; the other writer's decision stands. */
class IngestTargetGone extends Error {}

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
  const period = /^\d{4}/.test(periodStart) ? periodStart.slice(0, 4) : String(det.year);

  const detectNotes = `token=${det.propertyToken}; propertyRaw=${stmt.propertyRaw}`;
  const reg = registerImport(db, {
    sourcePath: filePath, rawDir: opts.rawDir,
    propertyId: det.propertyId, periodStart, periodEnd,
    grain: det.grain, basis: stmt.basis, sourceSystem: stmt.sourceSystem,
    confidence: det.confidence, parserVersion: PARSER_VERSION,
    importedAt: opts.importedAt, importedBy: opts.importedBy, detectNotes,
  });
  // A 'duplicate' whose batch is an ORPHANED REGISTRATION is resumed instead. registerImport INSERTs the batch in its own
  // autocommit statement before the ingest transaction below, so if that transaction never ran (SQLITE_BUSY past
  // busy_timeout, a crash, any throw) the batch is left 'pending-review' at the current parser with no ledger and no DQ
  // rows — every ingest that reaches its transaction writes at least one of them (an empty parse writes 'empty-parse').
  // Answering 'duplicate' there would strand the statement for good: approve refuses a batch with no ledger rows and the
  // same bytes never register again (refute wf_9cac3677-b1c). Resumed only under the SAME detection (property, period)
  // the batch was registered with, so nothing needs refreshing; the raw copy registerImport stored under the hash is
  // reused as is. Re-checked under the write lock below, so two resumers (or a resumer and the original) never both write.
  let resumedVersion: number | undefined;
  if (reg.kind === 'duplicate') {
    const orphan = db.prepare(`
      SELECT b.version FROM import_batches b
      WHERE b.id = ? AND b.status = 'pending-review' AND b.parser_version = ?
        AND b.property_id IS ? AND b.period_start IS ? AND b.period_end IS ?
        AND NOT EXISTS (SELECT 1 FROM ledger_entries l WHERE l.import_id = b.id)
        AND NOT EXISTS (SELECT 1 FROM data_quality_issues d WHERE d.import_id = b.id)
    `).get(reg.existingImportId, PARSER_VERSION, det.propertyId, periodStart, periodEnd) as { version: number } | undefined;
    if (!orphan) return { file: fileName, status: 'duplicate', importId: reg.existingImportId };
    resumedVersion = orphan.version;
  }
  // 'new' (or a resumed orphan, handled exactly like 'new') → fresh row; 'restale' → an existing ACTIVE row produced by
  // an older parser, re-derived IN PLACE (same importId, preserving history/refs). The derivation body below is
  // identical for both; restale first clears the prior ledger/issues and refreshes the row's derived columns.
  const importId = reg.kind === 'new' ? reg.importId : reg.existingImportId;
  const isReDerive = reg.kind === 'restale';
  // The batch's status BEFORE the re-derive is read INSIDE the IMMEDIATE transaction below (never here): a re-derive of
  // a SERVING ('committed') row that turns out not to qualify for commit must NOT silently empty the period; it is
  // rolled back to preserve the prior committed data (RestaleAbort). Read outside the write lock, a user approve landing
  // between that read and the transaction (actions.ts commits the batch and supersedes the served version) left a stale
  // 'pending-review' that let the re-derive deactivate the just-committed rows and flip the batch back to review — the
  // property-period's NOI disappeared (tests/unit/warehouse-rederive-race.test.ts). pending-review rows aren't serving,
  // so they re-derive freely.

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
  //
  // Decided from the SIGNED LEAF sums of stmt.sections, NOT a raw sum over stmt.accounts
  // (fixed 2026-09-28, OI-355 / cc-audit-army + refute-financial-change wf_e7c0dd32-4ae): a raw
  // account-level sum includes trailing rows under a lingering CLOSED section (Yardi
  // financing/refinance rows that follow "TOTAL OPERATING EXPENSES" but stay tagged with that
  // section — see the per-section foot comment below, "29000 Info Lane 2025"). One large trailing
  // outflow can push that sum negative even though every real opex leaf is positive-convention,
  // flipping real opex to the WRONG sign. Parse-side accumulation closes each section at its own
  // Total row, so section leafSum excludes those trailing rows.
  // Two things are deliberately EXCLUDED from this decision:
  //  - sec.statedTotal: it carries the report's DISPLAY sign (QB/Rent-Manager print expense totals
  //    negative over positive leaves — the foot check below compares abs() for that reason), which
  //    is independent of how the LEAVES are booked, and the leaves are what get flipped.
  //  - synthetic "<SIDE> (file total)" sections: they restate the real sections already summed
  //    here, so counting them double-counts magnitude and re-imports the display sign.
  // A residue within rounding of zero is "no flip": an IEEE artefact must not invert a whole side.
  const SIGN_EPSILON = 0.005;
  const undecidableSides: string[] = [];
  const flip: Record<'income' | 'expense', boolean> = { income: false, expense: false };
  for (const sideKey of ['income', 'expense'] as const) {
    let sum = 0;
    for (const sec of stmt.sections) {
      if (sec.name.endsWith('(file total)') || sectionSide(sec.name) !== sideKey) continue;
      sum += sec.leafSum;
    }
    flip[sideKey] = sum < -SIGN_EPSILON;
    // Fail loud when the section-scoped decision is undecidable (in-scope leaves net to ~0, e.g. a
    // section closed early by a stray Total row) while the side's tagged accounts are materially
    // negative: the old account-sum rule would have flipped, this one cannot tell. Never silent.
    if (!flip[sideKey] && Math.abs(sum) <= FOOT_TOLERANCE) {
      let raw = 0;
      for (const a of stmt.accounts) {
        if (a.total !== null && sectionSide(a.section) === sideKey) raw += a.total;
      }
      if (raw < -FOOT_TOLERANCE) {
        undecidableSides.push(`${sideKey}: section-scoped leaf sum ${sum.toFixed(2)} vs tagged-account sum ${raw.toFixed(2)}`);
      }
    }
  }
  const tx = db.transaction(() => {
    // Re-check, under the write lock, that the batch is still in the state registration saw. registerImport ran in its
    // own autocommit statements BEFORE this transaction — for a NEW import its INSERT made the batch visible as
    // 'pending-review' — so a user reject (or, for a re-derive, a reject/supersede/another re-derive) can land in
    // between. A rejected or superseded batch must never be committed, served, or pulled back into the review queue
    // (without this check a new import rejected in that window was committed over the reject, superseding the served
    // version: refute wf_53324d02-ce7). Expected: NEW (or resumed orphan) → 'pending-review' with no ledger or DQ rows
    // yet (otherwise another ingest of the same registration already wrote it — never write it twice); RESTALE →
    // registerImport's re-derivable predicate (committed or pending-review, parser older than current). The status read
    // here is also the RestaleAbort decision's prior status and the guard on the final status flips below.
    const cur = db.prepare(`
      SELECT b.status, b.parser_version,
        EXISTS (SELECT 1 FROM ledger_entries l WHERE l.import_id = b.id)
          OR EXISTS (SELECT 1 FROM data_quality_issues d WHERE d.import_id = b.id) AS written
      FROM import_batches b WHERE b.id = ?`).get(importId) as
      | { status: string; parser_version: number; written: number }
      | undefined;
    const stillIngestable = cur !== undefined && (isReDerive
      ? (cur.status === 'committed' || cur.status === 'pending-review') && cur.parser_version < PARSER_VERSION
      : cur.status === 'pending-review' && cur.written === 0);
    if (!stillIngestable) {
      throw new IngestTargetGone(cur
        ? `import #${importId} is now ${cur.status} (parser v${cur.parser_version}${!isReDerive && cur.written ? ', already ingested by another writer' : ''})`
        : `import #${importId} no longer exists`);
    }
    const priorStatus = cur.status;
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
    for (const detail of undecidableSides) {
      insIssue.run(importId, det.propertyId, 'sign-undecidable',
        `sign convention undecidable — ${detail}; no flip applied, verify the ledger sign for this side`, 'warn');
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
    //    (Rarig 2024: stated -REDACTED-AMT vs EXPENSE-section leaves +REDACTED-AMT exact);
    //  - Yardi "Total Operating Expenses" excludes the financing/capital rows that follow
    //    in the same lingering section (29000 Info Lane 2025 carries the refinance flows:
    //    section sum -5.79M vs stated REDACTED-AMT) — the seed classifies those rows out of
    //    NOI correctly, so the ledger is right even though a naive section foot is not;
    //  - 1851 Solar's stated total covers Ordinary Expense only (delta = Other Expense).
    // The expense side therefore foots per SECTION below: parse-side accumulation
    // closes each section at its top-level Total row, so each stated total is compared
    // at exactly the scope it covers.
    // Compared on ABSOLUTE values: `incomeSum` accumulates the ledger amount AFTER the outflow-convention
    // sign flip above, while `stmt.totalIncome` is the report's raw stated figure (parse space). A
    // negative-convention book would otherwise foot 2x off and raise a false mismatch on every import.
    if (stmt.totalIncome !== null && Math.abs(Math.abs(stmt.totalIncome) - Math.abs(incomeSum)) > FOOT_TOLERANCE) {
      insIssue.run(importId, det.propertyId, 'foot-mismatch',
        `income foot mismatch: report-stated total ${stmt.totalIncome} vs parsed income-side sum ${incomeSum} (|stated| ${Math.abs(stmt.totalIncome).toFixed(2)} vs |parsed| ${Math.abs(incomeSum).toFixed(2)})`, 'warn');
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
    // An undecidable sign side fails closed: the 'sign-undecidable' DQ row says no flip was applied,
    // so committing would serve a possibly negative-booked side as-is. Route to review instead.
    // An OLDER arrival must not commit over a NEWER committed one: the supersede below would replace newer data
    // with older data (reachable when a stale pending-review import is re-derived). Keyed on the SAME property and
    // period the supersede uses (the freshly detected ones), ordered by arrival. Hold it and say why.
    const newerCommitted = newerCommittedImport(db, importId, { propertyId: det.propertyId, periodStart, periodEnd });
    if (newerCommitted !== null) {
      insIssue.run(importId, det.propertyId, 'stale-version',
        `a newer version (v${newerCommitted.version}, import #${newerCommitted.id}) of this period is already committed; this older import cannot supersede it — reject it`, 'warn');
    }
    // Property gate on a re-derive (ING-2 on the ingest path; audit 2026-11-08). The re-derive keeps the batch's STORED
    // property_id (the UPDATE above never rewrites it) but keys every ledger row to the property DETECTED from this
    // filename, and the supersede below keys on the detected one too. A byte-identical re-drop under another property's
    // filename, or an alias change, therefore rebuilds the ledger under a different property than the batch; committing
    // it would serve this statement's NOI under the detected property while the batch stays filed under its own. Same
    // two gates approveImport applies (#554, actions.ts): the stored property must be resolved, and every ledger row
    // must be keyed to it. Either failure blocks auto-commit: a pending-review batch stays in review (approve refuses it
    // with the same reason), a committed one is rolled back by RestaleAbort below, keeping its prior ledger.
    // A fresh ('new') import registers the detected property as the batch's, so it cannot disagree.
    let propertyGate: 'property-unresolved' | 'property-mismatch' | null = null;
    if (isReDerive) {
      const stored = (db.prepare('SELECT property_id FROM import_batches WHERE id = ?').get(importId) as { property_id: string | null }).property_id;
      const ledgerKey = det.propertyId ?? 'unknown';
      if (stored === null || stored.trim() === '' || stored === 'unknown') {
        propertyGate = 'property-unresolved';
        insIssue.run(importId, det.propertyId, 'property-unresolved',
          `re-derive of import #${importId}: the batch has no resolved property (stored ${stored === null ? 'NULL' : `'${stored}'`}) but its ledger was rebuilt under '${ledgerKey}' from ${fileName} — not auto-committed; reject it and re-drop the statement under its property's PROPERTY_ALIASES filename`, 'error');
      } else if (ledgerKey !== stored) {
        propertyGate = 'property-mismatch';
        insIssue.run(importId, det.propertyId, 'property-mismatch',
          `re-derive of import #${importId}: the batch is filed under '${stored}' but ${fileName} keyed its ledger rows to '${ledgerKey}' — not auto-committed (committing would serve this statement under the wrong property); reject it and re-drop the statement under the PROPERTY_ALIASES filename of the property it belongs to`, 'error');
      }
    }
    const commit = insertedRows > 0 && det.propertyId !== null && det.confidence >= threshold && unmapped.length === 0
      && undecidableSides.length === 0 && newerCommitted === null && propertyGate === null;
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
      // Guarded on the status read under the lock and change-counted (same defense in depth as actions.ts): a flip that
      // does not hit exactly this one row in that status throws and rolls the whole ingest back, supersedes included.
      const flipped = db.prepare("UPDATE import_batches SET status = 'committed' WHERE id = ? AND status = ?").run(importId, priorStatus).changes;
      if (flipped !== 1) throw new Error(`ingestFile: import #${importId} was no longer ${priorStatus} at the commit flip; rolled back.`);
    } else {
      // A re-derive of a SERVING ('committed') row that no longer qualifies would empty the period
      // (deactivated ledger + no active prior) — that silently drops a property from served NOI.
      // Abort the tx instead: rollback restores the prior committed ledger/status/parser_version intact.
      if (isReDerive && priorStatus === 'committed') throw new RestaleAbort(propertyGate);
      // pending-review rows are not active until approved
      db.prepare("UPDATE ledger_entries SET is_active = 0 WHERE import_id = ?").run(importId);
      // A NEW batch is already 'pending-review' (checked under the lock above); only a re-derive flips it back.
      if (isReDerive) {
        const flipped = db.prepare("UPDATE import_batches SET status = 'pending-review' WHERE id = ? AND status = ?").run(importId, priorStatus).changes;
        if (flipped !== 1) throw new Error(`ingestFile: import #${importId} was no longer ${priorStatus} at the review flip; rolled back.`);
      }
    }
    return { commit, propertyGate };
  });

  let committed: boolean;
  // Set inside the tx; on a RestaleAbort the tx's DQ rows roll back, so the skip message carries the reason instead.
  let skippedPropertyGate: string | null = null;
  try {
    // IMMEDIATE: take the write lock before the first read, so the prior status the RestaleAbort decision uses is the
    // state the writes act on (a concurrent approve/reject waits on busy_timeout, or api.ts answers a retryable 503).
    // A DEFERRED read-then-write would instead fail its lock upgrade with SQLITE_BUSY_SNAPSHOT, which skips the busy
    // handler. SQLITE_BUSY after busy_timeout is rethrown below, never swallowed. The transaction wrote nothing; for a
    // NEW import the registration row (registerImport's own autocommit INSERT) does remain, 'pending-review' with no
    // ledger, and a retry resumes it (the orphaned-registration check above) rather than answering 'duplicate'.
    committed = tx.immediate().commit;
  } catch (e) {
    if (e instanceof IngestTargetGone) {
      // The transaction wrote nothing. A re-derive answers what registerImport would answer now ('duplicate': the batch
      // is no longer re-derivable); a new (or resumed) import answers 'skipped' — its batch was rejected before its
      // ledger was written, and the reject stands, or another writer already ingested it.
      return isReDerive
        ? { file: fileName, status: 'duplicate', importId, reason: `re-derive skipped: ${e.message}` }
        : { file: fileName, status: 'skipped', importId, reason: `ingest skipped: ${e.message} before this ingest wrote its ledger` };
    }
    if (!(e instanceof RestaleAbort)) throw e;
    skippedPropertyGate = e.propertyGate;
    // Prior committed version preserved (tx rolled back; parser_version stays stale so a later,
    // fixed parser re-attempts). Surface the skip once (deduped in ONE statement) so it's visible to DQ queries.
    db.prepare(`INSERT INTO data_quality_issues (import_id, property_id, kind, detail, severity)
      SELECT ?, ?, 'restale-skipped', ?, 'warn'
      WHERE NOT EXISTS (SELECT 1 FROM data_quality_issues WHERE import_id = ? AND kind = 'restale-skipped')`)
      .run(importId, det.propertyId,
        `parser-version re-derive (v${PARSER_VERSION}) no longer qualifies for commit (unmapped/low-confidence/empty/sign-undecidable/property-unresolved/property-mismatch) — prior committed version retained` +
        (skippedPropertyGate ? `; ${skippedPropertyGate}: the re-dropped file ${fileName} detects property ${det.propertyId === null ? 'none' : `'${det.propertyId}'`}, not the batch's own — the retained ledger stays under the batch's property` : '') +
        (undecidableSides.length ? `; sign-undecidable: ${undecidableSides.join(' | ')} — retained ledger may carry an unflipped side, verify its sign` : ''),
        importId);
    return { file: fileName, status: 'committed', importId, reason: 'restale-skipped' };
  }

  return {
    file: fileName,
    status: committed ? 'committed' : 'pending-review',
    importId,
    version: reg.kind === 'new' ? reg.version : resumedVersion,
    reason: insertedRows === 0 ? 'empty-parse' : undefined,
    unmapped: unmapped.length ? unmapped : undefined,
  };
}
