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
import { newerCommittedImport } from './raw-store';
import { scoreProperties } from './scores';

export type ApproveResult =
  | { ok: true }
  | {
      ok: false;
      unmapped: string[];
      error?: string;
      reason?: 'property-unresolved' | 'property-mismatch' | 'sign-undecidable' | 'newer-version-committed';
    };

/** Shared tails of the property refusals' error text, so the unblock path each states works in every reachable case.
 *  ALIAS_NOTE covers the case where no filename can resolve yet: detect.ts resolves a property only through its static
 *  PROPERTY_ALIASES map (aliases entered at property onboarding are not read), and an alias for a property that is not
 *  in property_master fails ingest on the foreign key. REDROP_NOTE: registerImport re-derives a same-hash file in place
 *  only while its import is committed or pending-review and came from an older parser, so once this import is rejected
 *  a file with identical bytes is a duplicate under any name. */
const ALIAS_NOTE =
  'If the property has no PROPERTY_ALIASES entry yet, one must be added first in server/warehouse/detect.ts (a code change: ' +
  'aliases entered at property onboarding are not read by filename detection), and a property not yet in property_master ' +
  'must be onboarded first.';
const REDROP_NOTE =
  'The re-dropped file must differ byte-for-byte from this one: once this import is rejected, a file with identical bytes ' +
  'is a duplicate under any name.';

/** detect.ts's filename rule for the refusal texts: 'P&L <year> -- <token>.xlsx' (or '<year> P&L -- ...', optional
 *  ' YTD'), where the WHOLE token, lowercased with spaces around hyphens collapsed, must equal a PROPERTY_ALIASES key.
 *  A token that merely contains a key does not resolve. `key` names whose key it is. */
const aliasFilename = (key: string): string =>
  `named 'P&L <year> -- <token>.xlsx', where <token> is exactly ${key} (the whole token must equal the key, ` +
  'case-insensitively; containing it is not enough)';

/** The one ledger read that drives the empty, unresolved and mismatch gates and the re-resolution. */
const LEDGER_ROWS_SQL = 'SELECT id, raw_account, classification, property_id FROM ledger_entries WHERE import_id=? ORDER BY id';
const LEDGER_ROWS_SQL = 'SELECT id, raw_account, classification, property_id FROM ledger_entries WHERE import_id=?';
type LedgerRow = { id: number; raw_account: string; classification: string; property_id: string };

/** The rows NOT keyed to the batch's own property ('unknown', or another property), with their distinct keys sorted
 *  and quoted for the refusal text. */
function rowsOffProperty(rows: readonly LedgerRow[], propertyId: string | null): { count: number; keys: string } {
  const bad = rows.filter((r) => r.property_id === 'unknown' || r.property_id !== propertyId);
  return { count: bad.length, keys: [...new Set(bad.map((r) => r.property_id))].sort().map((k) => `'${k}'`).join(', ') };
}

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
  version: number;
}

/**
 * Approve a pending-review import: re-resolve every ledger row against the CURRENT mapping
 * set (so manual overrides added since ingest take effect), and only commit if nothing is
 * still unmapped. On success the rows are activated, prior committed versions of the same
 * logical period are superseded, and the batch flips to 'committed'.
 *
 * Refusals, in the order they are checked (all leave the batch pending-review and every ledger row untouched):
 *  - not found / not pending-review;
 *  - reason 'newer-version-committed': a NEWER ARRIVAL (higher import id) for the same property and period is
 *    already committed, so approving this older one would supersede it and serve older data (reject it instead).
 *    If the batch's ledger rows are also keyed off its property, the text names those keys and their re-drop path,
 *    so rejecting it never silently loses a statement that belongs to another property;
 *  - no ledger rows: an empty import (the API answers 404, whatever the batch's property);
 *  - reason 'property-unresolved': the batch's property never resolved (property_id NULL, blank or the ledger's
 *    'unknown' sentinel). Committing it would key NOI to no property: the supersede below matches nothing on a NULL
 *    id (silent double count) and every such batch merges into one 'unknown' pseudo-property;
 *  - reason 'property-mismatch': the batch's property resolved, but some of its ledger rows are keyed to a different
 *    property or to 'unknown'. NOI keys on ledger_entries.property_id while the supersede keys on the batch's, so
 *    committing would supersede the batch property's served version and serve the rows under the ledger's key. A
 *    stale-parser re-derive produces this (ingest.ts rebuilds the ledger from a re-drop's filename but never rewrites
 *    the batch's property; ING-2). Together the two property gates guarantee that approve never commits a ledger row
 *    that is not keyed to the batch's own resolved property. They run after the newer-version and empty checks, which
 *    keep the answers they gave before #554 (9485736f: reject the stale import; 404), and before the unmapped and sign
 *    checks, so the reviewer is never asked to map accounts or verify a sign for a batch that cannot commit. The empty,
 *    unresolved and mismatch checks all read ONE ledger read, which the re-resolution reuses;
 *  - unmapped accounts remain (`unmapped` lists them);
 *  - reason 'sign-undecidable': ingest held the batch with no sign flip applied and the reviewer has not yet
 *    marked the sign-undecidable issue verified.
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
 *
 * Concurrency. Every read, gate and write runs in ONE `BEGIN IMMEDIATE` transaction (checkAndCommit), so the state
 * the gates judge is the state the writes act on. `npm run warehouse:backfill` writes the same WAL file (db.ts), and its
 * stale-parser re-derive (ingest.ts) deletes an import's ledger rows and re-inserts them under new ids. When the gates
 * ran as autocommit statements ahead of a later DEFERRED write transaction, a re-derive landing between them made
 * approve return {ok:true}, supersede the served version and commit the import with zero active ledger rows, so the
 * property-period's NOI disappeared (TOCTOU; 5 of 8 statement boundaries, tests/unit/warehouse-approve-toctou.test.ts).
 * IMMEDIATE takes the write lock before the first read, so a concurrent writer waits (busy_timeout) until approve
 * commits or refuses; a DEFERRED read-then-write would also fail its lock upgrade with SQLITE_BUSY_SNAPSHOT, which skips
 * the busy handler (see debt-snapshot.ts). As defense in depth the activating UPDATE is keyed on (id, import_id) and its
 * total change count must equal the rows read, and the batch's status flip must hit exactly one pending-review row;
 * otherwise approve throws and the transaction rolls back, leaving the served version and the batch untouched.
 * Not covered here: the reverse order (a re-derive that read its prior status before this approve committed, then runs
 * after it) is ingest.ts's own check-then-write (it reads priorStatus outside its transaction); its fix belongs there.
 */
export function approveImport(db: WarehouseDb, importId: number, opts: ApproveOptions = {}): ApproveResult {
  const result = db.transaction(() => checkAndCommit(db, importId)).immediate();
  if (!result.ok) return result;

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

/** approveImport's reads, gates and writes. Runs only inside approveImport's IMMEDIATE transaction: a refusal returns
 *  having written nothing; a thrown error rolls every write back. */
function checkAndCommit(db: WarehouseDb, importId: number): ApproveResult {
  const batch = db
    .prepare('SELECT id, property_id, period_start, period_end, status, version FROM import_batches WHERE id=?')
    .get(importId) as BatchRow | undefined;
  if (!batch) return { ok: false, unmapped: [], error: `import ${importId} not found` };
  if (batch.status !== 'pending-review') {
    return { ok: false, unmapped: [], error: `import is ${batch.status}, not pending-review` };
  }

  // Supersede guard. Approving commits this batch and supersedes EVERY committed version of the same period. If a
  // NEWER arrival is already committed, that would replace newer data with older data, so refuse before asking the
  // reviewer to map accounts or verify signs for a batch that can never be approved. Reject it instead; the newer
  // import stays served. (An older batch can still be approved while the newer one is only pending.) Same key the
  // supersede below uses: this batch's stored property/period.
  const newerCommitted = newerCommittedImport(db, importId, {
    propertyId: batch.property_id,
    periodStart: batch.period_start,
    periodEnd: batch.period_end,
  });
  if (newerCommitted !== null) {
    // Refusal path only: also name a co-occurring property mismatch, so rejecting this import never silently loses a
    // statement that belongs to another property (refute wf_2e74b57b-da3). Read only after this guard fired, so the
    // statements on the commit path are unchanged.
    const off = rowsOffProperty(db.prepare(LEDGER_ROWS_SQL).all(importId) as LedgerRow[], batch.property_id);
    return {
      ok: false,
      unmapped: [],
      reason: 'newer-version-committed',
      error:
        `a newer version (v${newerCommitted.version}, import #${newerCommitted.id}) of this period is already committed; approving this older ` +
        `import (v${batch.version}, #${importId}) would supersede it and serve older data. Reject this import — the newer version stays.` +
        (off.count > 0
          ? ` Its ledger rows are also keyed to ${off.keys} rather than '${batch.property_id}' (a re-derive rebuilt them from a ` +
            `differently named re-drop of the same file), so the statement may belong to another property: if it does, after ` +
            `rejecting this import re-drop a fresh export of the statement ${aliasFilename("that property's PROPERTY_ALIASES key")}. ` +
            `${ALIAS_NOTE} ${REDROP_NOTE}`
          : ''),
    };
  }

  // ONE ledger read drives the empty, unresolved and mismatch gates, the re-resolution and the activation count below.
  // It runs under approveImport's write lock, so no re-derive can replace these rows before they are activated.
  // ONE ledger read drives the empty, unresolved and mismatch gates and the re-resolution below. A separate gate query
  // here would add a statement between this read and the write transaction, the window a concurrent re-derive can land
  // in (TOCTOU Window B, refute wf_2e74b57b-da3). The root fix (re-check inside an IMMEDIATE transaction) is deferred.
  const rows = db.prepare(LEDGER_ROWS_SQL).all(importId) as LedgerRow[];
  if (rows.length === 0) return { ok: false, unmapped: [], error: 'import has no ledger rows' };

  // Property gates (fail closed). They run after the newer-version guard and the empty-import check, which keep the
  // answers they gave before #554 (9485736f), and before any mapping re-resolution, so the reviewer is never asked to map
  // accounts or verify a sign for a batch that cannot commit. Reject stays available, and each error text carries an
  // unblock path that works in every reachable case (aliasFilename, ALIAS_NOTE, REDROP_NOTE).
  //
  // 1. Unresolved property ('unknown' is the ledger's stand-in for NULL): it can never be committed safely, and the
  //    supersede below would match nothing on a NULL key.
  if (batch.property_id === null || batch.property_id.trim() === '' || batch.property_id === 'unknown') {
    return {
      ok: false,
      unmapped: [],
      reason: 'property-unresolved',
      error:
        `import #${importId} has no resolved property: its filename token does not equal any PROPERTY_ALIASES key, so ` +
        `approving it would commit NOI under no property. Reject it, then re-drop a fresh export of the statement ` +
        `${aliasFilename("the property's PROPERTY_ALIASES key")}. ${ALIAS_NOTE} ${REDROP_NOTE}`,
    };
  }

  // 2. Ledger rows not keyed to the batch's property. NOI keys on ledger_entries.property_id; the supersede below keys
  //    on the batch's. A stale-parser re-derive (ingest.ts) rebuilds the ledger rows from a re-drop's filename but never
  //    rewrites the batch's property, so the two can disagree, and approving would supersede the batch property's
  //    served version and serve this statement under the ledger's key ('unknown' or another property).
  const off = rowsOffProperty(rows, batch.property_id);
  if (off.count > 0) {
    return {
      ok: false,
      unmapped: [],
      reason: 'property-mismatch',
      error:
        `import #${importId} is filed under '${batch.property_id}', but ${off.count} of its ledger rows are keyed to ` +
        `${off.keys} (a re-derive rebuilt them from a differently named re-drop of the same file). Approving it would ` +
        `supersede any committed version of this period filed under '${batch.property_id}' and serve this statement under ` +
        `the wrong property. Reject it, then re-drop a fresh export of the statement ` +
        `${aliasFilename('the PROPERTY_ALIASES key of the property it belongs to')}. ${ALIAS_NOTE} ${REDROP_NOTE}`,
    };
  }

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

  // Writes. Still inside the IMMEDIATE transaction approveImport opened, so a throw below rolls every write back.
  const upd = db.prepare(
    'UPDATE ledger_entries SET normalized_category=?, classification=?, mapping_id=?, is_active=1 WHERE id=? AND import_id=?',
  );
  let activated = 0;
  for (const r of resolved) activated += upd.run(r.m.normalizedCategory, r.m.classification, r.m.mappingId, r.id, importId).changes;
  if (activated !== rows.length) {
    throw new Error(
      `approveImport: activated ${activated} of ${rows.length} ledger rows of import #${importId}; the ledger changed under ` +
        'the approve, so it was rolled back and nothing was committed. Retry the approve.',
    );
  }

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
  const flipped = db.prepare("UPDATE import_batches SET status='committed' WHERE id=? AND status='pending-review'").run(importId).changes;
  if (flipped !== 1) {
    throw new Error(`approveImport: import #${importId} was no longer pending-review at commit; rolled back, nothing was committed.`);
  }
  return { ok: true };
}

/** Reject a pending-review import. Rows are left inactive (never deleted); the batch is auditable.
 *  The status read and the flip run in one IMMEDIATE transaction, and the flip is guarded on 'pending-review' and must
 *  change exactly one row: a concurrent backfill re-derive that commits this import between the two must never leave a
 *  'rejected' batch serving its ledger rows (refute wf_f8901854-484; tests/unit/warehouse-approve-toctou.test.ts). */
export function rejectImport(db: WarehouseDb, importId: number): SimpleResult {
  return db
    .transaction((): SimpleResult => {
      const batch = db.prepare('SELECT status FROM import_batches WHERE id=?').get(importId) as
        | { status: string }
        | undefined;
      if (!batch) return { ok: false, error: `import ${importId} not found` };
      if (batch.status !== 'pending-review') return { ok: false, error: `import is ${batch.status}, not pending-review` };
      const changed = db.prepare("UPDATE import_batches SET status='rejected' WHERE id=? AND status='pending-review'").run(importId).changes;
      if (changed !== 1) throw new Error(`rejectImport: import #${importId} was no longer pending-review at the flip; rolled back.`);
      return { ok: true };
    })
    .immediate();
}

/** Mark an open data-quality issue resolved. Read and flip run in one IMMEDIATE transaction, guarded on 'open' with
 *  a one-row change count, so a re-derive that deletes and re-creates the issue never yields ok:true for nothing. */
export function resolveIssue(db: WarehouseDb, issueId: number): SimpleResult {
  return db
    .transaction((): SimpleResult => {
      const issue = db.prepare('SELECT status FROM data_quality_issues WHERE id=?').get(issueId) as
        | { status: string }
        | undefined;
      if (!issue) return { ok: false, error: `issue ${issueId} not found` };
      if (issue.status !== 'open') return { ok: false, error: `issue is ${issue.status}, not open` };
      const changed = db
        .prepare("UPDATE data_quality_issues SET status='resolved', resolved_at=datetime('now') WHERE id=? AND status='open'")
        .run(issueId).changes;
      if (changed !== 1) throw new Error(`resolveIssue: issue #${issueId} was no longer open at the flip; rolled back.`);
      return { ok: true };
    })
    .immediate();
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
