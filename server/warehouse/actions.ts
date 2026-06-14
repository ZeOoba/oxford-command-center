// server/warehouse/actions.ts
//
// Phase A.2 review-queue mutations over the warehouse. All mutations are transactional;
// nothing is ever deleted (reject = status flip; supersede = is_active=0). The proven
// Phase A ingest pipeline (ingest.ts) is NOT modified — the supersede SQL below mirrors
// it deliberately (kept in sync by hand to avoid touching the committed pipeline here).
import type { WarehouseDb } from './db';
import { accountKey, resolveMapping } from './mapping';
import { computeInputsVersion, logVerdicts, verdictsFromAnomalies, verdictsFromScores } from './calibration';
import { detectAnomalies } from './anomalies';
import { propertyPeriodMetrics } from './metrics';
import { scoreProperties } from './scores';

export type ApproveResult = { ok: true } | { ok: false; unmapped: string[]; error?: string };

/** Options for approveImport. `forceCalibrationError` (tests only) poisons the post-commit emit
 *  hook to prove the fail-open guarantee — the commit still returns {ok:true}. */
export interface ApproveOptions {
  forceCalibrationError?: string;
}
export type SimpleResult = { ok: true } | { ok: false; error?: string };

interface BatchRow {
  id: number;
  property_id: string | null;
  period_start: string | null;
  period_end: string | null;
  status: string;
}

/**
 * Approve a pending-review import: re-resolve every ledger row against the CURRENT mapping
 * set (so manual overrides added since ingest take effect), and only commit if nothing is
 * still unmapped. On success the rows are activated, prior committed versions of the same
 * logical period are superseded, and the batch flips to 'committed'.
 *
 * Re-resolution runs WITHOUT a section hint — the ledger does not store the source section,
 * and manual overrides are side-agnostic rulings, so this is correct. Amounts are never
 * touched (sign-normalization already applied at ingest stays intact).
 */
export function approveImport(db: WarehouseDb, importId: number, opts: ApproveOptions = {}): ApproveResult {
  const batch = db
    .prepare('SELECT id, property_id, period_start, period_end, status FROM import_batches WHERE id=?')
    .get(importId) as BatchRow | undefined;
  if (!batch) return { ok: false, unmapped: [], error: `import ${importId} not found` };
  if (batch.status !== 'pending-review') {
    return { ok: false, unmapped: [], error: `import is ${batch.status}, not pending-review` };
  }

  const rows = db
    .prepare('SELECT id, raw_account FROM ledger_entries WHERE import_id=?')
    .all(importId) as Array<{ id: number; raw_account: string }>;
  if (rows.length === 0) return { ok: false, unmapped: [], error: 'import has no ledger rows' };

  const resolved = rows.map((r) => ({
    id: r.id,
    m: resolveMapping(db, r.raw_account, batch.property_id ?? undefined),
    rawAccount: r.raw_account,
  }));
  const unmapped = resolved.filter((r) => r.m.matchKind === 'unmapped').map((r) => r.rawAccount);
  if (unmapped.length > 0) return { ok: false, unmapped };

  db.transaction(() => {
    const upd = db.prepare(
      'UPDATE ledger_entries SET normalized_category=?, classification=?, mapping_id=?, is_active=1 WHERE id=?',
    );
    for (const r of resolved) upd.run(r.m.normalizedCategory, r.m.classification, r.m.mappingId, r.id);

    // Supersede prior committed versions for the same (property, period span) — mirrors
    // the block in ingest.ts. `IS ?` is null-safe equality (period_end is null for some YTD).
    const priors = db
      .prepare(`
        SELECT id FROM import_batches
        WHERE property_id = ? AND period_start IS ? AND period_end IS ? AND id != ? AND status = 'committed'
      `)
      .all(batch.property_id, batch.period_start, batch.period_end, importId) as Array<{ id: number }>;
    const deact = db.prepare('UPDATE ledger_entries SET is_active=0 WHERE import_id=?');
    const supersede = db.prepare("UPDATE import_batches SET status='superseded', superseded_by=? WHERE id=?");
    for (const p of priors) {
      deact.run(p.id);
      supersede.run(importId, p.id);
    }
    db.prepare("UPDATE import_batches SET status='committed' WHERE id=?").run(importId);
  })();

  // ── Calibration emit hook (spec §7 item 3) — AFTER the transaction commits ─────────────────
  // A new statement just changed the ledger: the inputs_version is fresh and the verdict reflects
  // the newest data. Re-score the warehouse and log the verdicts. STRICTLY fail-open: any failure
  // here writes a data_quality_issues row (via logVerdicts) and MUST NOT change the {ok:true}
  // return above. Calibration logging is observational; it never blocks a commit.
  try {
    const iv = computeInputsVersion(db);
    const metrics = propertyPeriodMetrics(db);
    logVerdicts(
      db,
      [
        ...verdictsFromScores(scoreProperties(db, metrics), iv, `commit:${importId}`),
        ...verdictsFromAnomalies(detectAnomalies(metrics), iv, `commit:${importId}`),
      ],
      { forceError: opts.forceCalibrationError },
    );
  } catch {
    // logVerdicts is itself fail-open (it never throws), but computeInputsVersion / scoring could
    // in principle throw on a malformed db — swallow here too so the commit result is never affected.
    try {
      db.prepare(
        "INSERT INTO data_quality_issues (kind, detail, severity) VALUES ('calibration-emit-failed', 'emit hook threw before logVerdicts', 'warn')",
      ).run();
    } catch {
      /* observational machinery must never block the warehouse */
    }
  }

  return { ok: true };
}

/** Reject a pending-review import. Rows are left inactive (never deleted); the batch is auditable. */
export function rejectImport(db: WarehouseDb, importId: number): SimpleResult {
  const batch = db.prepare('SELECT status FROM import_batches WHERE id=?').get(importId) as
    | { status: string }
    | undefined;
  if (!batch) return { ok: false, error: `import ${importId} not found` };
  if (batch.status !== 'pending-review') return { ok: false, error: `import is ${batch.status}, not pending-review` };
  db.prepare("UPDATE import_batches SET status='rejected' WHERE id=?").run(importId);
  return { ok: true };
}

/** Mark an open data-quality issue resolved. */
export function resolveIssue(db: WarehouseDb, issueId: number): SimpleResult {
  const issue = db.prepare('SELECT status FROM data_quality_issues WHERE id=?').get(issueId) as
    | { status: string }
    | undefined;
  if (!issue) return { ok: false, error: `issue ${issueId} not found` };
  if (issue.status !== 'open') return { ok: false, error: `issue is ${issue.status}, not open` };
  db.prepare("UPDATE data_quality_issues SET status='resolved', resolved_at=datetime('now') WHERE id=?").run(issueId);
  return { ok: true };
}

export interface AddMappingInput {
  account: string;
  normalizedCategory: string;
  classification: string;
  propertyId?: string;
}

export interface AddMappingResult {
  mappingId: number;
  rederived: number;
}

/**
 * Append a manual mapping override (match_kind='manual' — beats seed per resolveMapping
 * precedence) and re-derive ACTIVE ledger rows whose normalized account key matches, scoped
 * to a property when given. accountKey() can't run in SQL, so candidates are filtered in JS.
 */
export function addMappingOverride(db: WarehouseDb, input: AddMappingInput): AddMappingResult {
  const key = accountKey(input.account);
  return db.transaction(() => {
    const ins = db
      .prepare(`
        INSERT INTO account_mappings (raw_account_key, normalized_category, classification, match_kind, property_id)
        VALUES (?, ?, ?, 'manual', ?)
      `)
      .run(key, input.normalizedCategory, input.classification, input.propertyId ?? null);
    const mappingId = Number(ins.lastInsertRowid);

    const candidates = (
      input.propertyId
        ? db.prepare('SELECT id, raw_account FROM ledger_entries WHERE is_active=1 AND property_id=?').all(input.propertyId)
        : db.prepare('SELECT id, raw_account FROM ledger_entries WHERE is_active=1').all()
    ) as Array<{ id: number; raw_account: string }>;

    const upd = db.prepare('UPDATE ledger_entries SET normalized_category=?, classification=?, mapping_id=? WHERE id=?');
    let rederived = 0;
    for (const c of candidates) {
      if (accountKey(c.raw_account) === key) {
        upd.run(input.normalizedCategory, input.classification, mappingId, c.id);
        rederived += 1;
      }
    }
    return { mappingId, rederived };
  })();
}
