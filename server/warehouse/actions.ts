// server/warehouse/actions.ts
//
// Phase A.2 review-queue mutations over the warehouse. All mutations are transactional;
// nothing is ever deleted (reject = status flip; supersede = is_active=0). The proven
// Phase A ingest pipeline (ingest.ts) is NOT modified — the supersede SQL below mirrors
// it deliberately (kept in sync by hand to avoid touching the committed pipeline here).
import { Classification } from '../../src/contracts/warehouse';
import type { WarehouseDb } from './db';
import { accountKey, classificationSide, resolveMapping } from './mapping';
import { computeInputsVersion, logVerdicts, verdictsFromAnomalies, verdictsFromScores } from './calibration';
import { detectAnomalies } from './anomalies';
import { propertyPeriodMetrics } from './metrics';
import { scoreProperties } from './scores';

export type ApproveResult =
  | { ok: true }
  | { ok: false; unmapped: string[]; error?: string; reason?: 'sign-undecidable' };

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
 * Re-resolution of SEED/learned mappings is CONSTRAINED to each row's EXISTING classification side
 * (derived via classificationSide). The ledger does not store the source section, but it DOES store
 * the row's classification — and that pins which side of the statement the row belongs to. A
 * dual-side account (the real PFI seed carries "Gas"/"Electric"/"Water" as BOTH a tenant-billback
 * recovery on the income side AND a utility opex on the expense side) would otherwise re-resolve
 * via an UNDEFINED tiebreak (rows[0] of two tied global seed rows) and could flip an expense row
 * to the income/recovery mapping — silently inverting its NOI sign contribution (income adds, opex
 * subtracts). Passing the existing side guards against that for single- and dual-side SEED rows.
 *
 * A PROPERTY-SCOPED manual override is exempt from the side guard: it is a targeted, deliberate human
 * ruling for that property, and approve's contract is to apply it — INCLUDING a deliberate cross-side
 * reclassification (e.g. a reviewer who declares a specific property's expense-ingested Gas a tenant
 * billback → income/recovery). A GLOBAL manual override (no property_id) is a portfolio-wide default
 * and is side-constrained like a seed — it can never silently flip a row to the opposite NOI side
 * across the portfolio (finding 4; this keeps approve consistent with addMappingOverride's in-place
 * re-derive). resolveMapping encodes exactly this: scoped-manual wins regardless of sideHint, global-
 * manual and seed/learned rows bind to the side. A genuine cross-side reclassification must therefore
 * be scoped to its property; a global override only re-resolves rows already on its own side.
 * Amounts are never touched (sign-normalization already applied at ingest stays intact).
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
    .prepare('SELECT id, raw_account, classification FROM ledger_entries WHERE import_id=?')
    .all(importId) as Array<{ id: number; raw_account: string; classification: string }>;
  if (rows.length === 0) return { ok: false, unmapped: [], error: 'import has no ledger rows' };

  // Derive the year period for this import so period-scoped mapping rows (e.g. the H4 FVC 2025
  // easement exclusion) fire correctly during re-resolution. period_start is '2025-01-01' for an
  // annual import; substr gives '2025'. Undefined when period_start is null (e.g. YTD without
  // a detected year) — resolveMapping treats undefined as "no period constraint" (safe fallback).
  const period: string | undefined = batch.period_start ? batch.period_start.substring(0, 4) : undefined;

  const resolved = rows.map((r) => ({
    id: r.id,
    // Constrain re-resolution of SEED and GLOBAL-manual rows to the row's existing classification
    // side so a dual-side account can only re-resolve within its original side (no NOI sign flip). A
    // PROPERTY-SCOPED manual override still wins regardless of side (resolveMapping exempts a scoped
    // manual from the sideHint guard) — a reviewer's targeted cross-side reclassification is honored.
    // 'either'-side classes (e.g. 'excluded'/unknown) pass no constraint — resolution unchanged.
    m: resolveMapping(
      db,
      r.raw_account,
      batch.property_id ?? undefined,
      undefined,
      classificationSide(r.classification),
      period,
    ),
    rawAccount: r.raw_account,
  }));
  const unmapped = resolved.filter((r) => r.m.matchKind === 'unmapped').map((r) => r.rawAccount);
  if (unmapped.length > 0) return { ok: false, unmapped };

  // Sign gate. Ingest held this batch because a statement side's sign convention was undecidable and NO flip
  // was applied, so its rows carry the signs as booked. Approving would commit them as-is, and nothing here
  // can flip them. Require the reviewer to acknowledge first: verify each flagged side against the source
  // statement, then resolve the 'sign-undecidable' issue(s). Reject is always available and is the right
  // call when the sign is wrong. Keyed on THIS import's open issues only.
  const openSignIssues = db
    .prepare("SELECT COUNT(*) AS c FROM data_quality_issues WHERE import_id = ? AND kind = 'sign-undecidable' AND status = 'open'")
    .get(importId) as { c: number };
  if (openSignIssues.c > 0) {
    return {
      ok: false,
      unmapped: [],
      reason: 'sign-undecidable',
      error:
        `sign convention undecidable for ${openSignIssues.c} statement side(s): no sign flip was applied, so approving would commit the ` +
        `amounts as booked. Verify each flagged side against the source statement, mark the sign-undecidable issue(s) verified, then ` +
        `approve — or reject the import if the sign is wrong.`,
    };
  }

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
 *
 * A GLOBAL override's re-derive is CONSTRAINED to the override's income/expense side (classificationSide)
 * — the same dual-side guard approveImport applies on re-resolution (H3 + finding 4). A dual-side account
 * (the real PFI seed carries "Gas"/"Electric"/"Water" as BOTH a tenant-billback recovery on the income
 * side AND a utility opex on the expense side) can have two ACTIVE rows under one account key — one income,
 * one expense. A side-blind UPDATE would push the override's classification onto BOTH, flipping the
 * income-side recovery row to opex and INVERTING its NOI sign contribution (income adds, opex subtracts).
 * So a GLOBAL override re-derives a row only when its side is compatible with the row's EXISTING side: an
 * 'either'-side override (e.g. 'excluded'/unknown) and an 'either'-side row carry NO constraint (mirrors
 * classificationSide returning 'either' → no side filter in resolveMapping); otherwise the two sides must
 * match. A PROPERTY-SCOPED override (propertyId given) is a targeted, deliberate ruling and re-derives
 * EVERY matching row of that property regardless of side — exactly how resolveMapping resolves a scoped
 * manual on approve, so the in-place and approve paths stay consistent.
 */
export function addMappingOverride(db: WarehouseDb, input: AddMappingInput): AddMappingResult {
  // Validate the class BEFORE deriving its side: an unrecognized classification would map to
  // 'either' (classificationSide's default), silently disabling the side guard below and re-opening
  // the dual-side NOI-sign flip. Fail closed on a typo — never write an out-of-enum classification.
  Classification.parse(input.classification);
  const key = accountKey(input.account);
  const overrideSide = classificationSide(input.classification);
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
        ? db.prepare('SELECT id, raw_account, classification FROM ledger_entries WHERE is_active=1 AND property_id=?').all(input.propertyId)
        : db.prepare('SELECT id, raw_account, classification FROM ledger_entries WHERE is_active=1').all()
    ) as Array<{ id: number; raw_account: string; classification: string }>;

    const upd = db.prepare('UPDATE ledger_entries SET normalized_category=?, classification=?, mapping_id=? WHERE id=?');
    let rederived = 0;
    for (const c of candidates) {
      if (accountKey(c.raw_account) !== key) continue;
      // Side guard for GLOBAL overrides ONLY: a portfolio-wide default must never re-derive a row on
      // the OPPOSITE income-statement side (that would invert its NOI sign). 'either' on either side
      // imposes no constraint; otherwise the sides must match. A PROPERTY-SCOPED override (input.propertyId
      // set) is a targeted, deliberate human ruling and re-derives EVERY matching row of that property
      // regardless of side — identical to how resolveMapping resolves the two override kinds on approve,
      // so the in-place and approve paths stay consistent (no path-dependent NOI drift).
      if (!input.propertyId) {
        const rowSide = classificationSide(c.classification);
        if (overrideSide !== 'either' && rowSide !== 'either' && overrideSide !== rowSide) continue;
      }
      upd.run(input.normalizedCategory, input.classification, mappingId, c.id);
      rederived += 1;
    }
    return { mappingId, rederived };
  })();
}
