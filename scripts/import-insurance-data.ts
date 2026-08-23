// scripts/import-insurance-data.ts
//
// THE real-data swap for the P4c insurance placeholder buildout. Until this script has been run,
// server/warehouse/placeholder-data.ts's resolveLossEvents() and resolveDecPages() serve synthetic
// fixture rows from server/warehouse/placeholders/*.placeholder.json. Once real broker loss-run /
// dec-page data lands in insurance_loss_events / property_insurance_policies via this importer,
// those resolvers automatically stop reading the fixtures and start reading the warehouse — no
// other code change is required. This is the ONLY way that cutover happens.
//
// Three modes, one script (unlike scripts/import-assessments.ts's single CSV mode):
//
//   1. Default (loss events): npx tsx scripts/import-insurance-data.ts <events.json> [--db <path>]
//      Input JSON shape: { events: [{ id, propertyId, policyRef, lossDate, cause, grossIncurred,
//      paid, reserve, source }, ...] } — the same shape as loss-runs.placeholder.json's "events"
//      array. `source` is optional per row; if absent, a top-level `source` on the payload is used
//      if present, else the CLI's file-path argument is used as the default source.
//      INSERT OR IGNORE into insurance_loss_events makes a re-run of the same file idempotent via
//      the table's PRIMARY KEY(id) and its UNIQUE(property_id, loss_date, cause, gross_incurred)
//      (migration 022) — a second run reports the same rows as `ignored`, not duplicated.
//
//   2. Dec pages: npx tsx scripts/import-insurance-data.ts --dec-pages <policies.json> [--db <path>]
//      Input JSON shape: [{ policyId, deductible, coverageLimit }, ...] — policyId is the
//      property_insurance_policies row's integer id (migration 008: INTEGER PRIMARY KEY
//      AUTOINCREMENT; resolveDecPages in placeholder-data.ts stringifies it via String(row.id), so
//      this importer accepts policyId as either a JSON number or a numeric string).
//      UPDATE ... SET deductible = ?, coverage_limit = ? WHERE id = ? for each row that resolves to
//      an existing policy id; a missing id is counted (`missing`), never thrown.
//
//   3. Policies (premium history): npx tsx scripts/import-insurance-data.ts --policies <policies.json> [--db <path>]
//      Input JSON shape: { policies: [{ propertyId, insurer, policyNumber, effectiveDate,
//      expirationDate, premiumAnnual, coverageTiv, policyType, source, sourceDate }, ...],
//      newLines?: string[], ingestedBy?: string }. Upserts by (property_id, policy_number,
//      effective_date) — UPDATE by the existing row's own `id` on a match, never INSERT OR REPLACE
//      (that would mint a new autoincrement id and silently wipe any deductible/coverage_limit a
//      separate --dec-pages run already applied). property_id has no FK; a propertyId is only
//      accepted if a row for it already exists or it's listed in `newLines` for this run — anything
//      else is logged to data_quality_issues (kind='insurance-policy-unrecognized-line') and skipped.
//      CAUTION for any future history backfill through this mode: server/warehouse/insurance-
//      analysis.ts's collapseToCurrentTerm ranks a policy line's "current" term by source_date DESC
//      first, effective_date only as a tiebreak. A history row whose sourceDate is NEWER than the
//      live capture's, for an OLDER effective_date, would make that older term win and surface as
//      "current" downstream (renewalCalendar, premiumAnnualTotal, policiesN, insurance-expiry-soon).
//      Keep a backfilled row's sourceDate no newer than the most recent live capture for that
//      property/line — never the backfill's own compile date if that's more recent.
//
// Row handling (mirrors import-assessments.ts):
//   - A row that fails FORMAT validation is rejected and reported in the printed summary — nothing
//     is written for that row, and it is never persisted as a data_quality_issues row (matches
//     import-assessments.ts: parse-time rejects are reported, not persisted). FORMAT rejects
//     include: missing required field; non-numeric/negative grossIncurred; malformed policyId; a
//     loss_date that is not strict ISO YYYY-MM-DD (P4c refute finding 1 — a US MM/DD/YYYY or an
//     Excel-serial date silently corrupts EAL downstream, so it is caught at the boundary, never
//     auto-reformatted); and a dec-pages row with deductible > coverageLimit (P4c refute finding 3
//     — a transposition that would break the engine's retained/transferred/overLimit partition).
//   - A loss-event row with a MISSING or BLANK propertyId is a valid portfolio/umbrella-level loss
//     (per docs/templates/insurance-loss-runs.template.csv), NOT an error: it is accepted and
//     stored with property_id = NULL (FK-exempt; resolveLossEvents coerces it back to '' for the
//     engine's blank-check). P4c refute finding 2.
//   - A loss-event row whose propertyId is PRESENT and non-blank but not found in property_master is
//     never inserted (would violate the FK and silently misattribute a loss) — it is recorded as a
//     data_quality_issues row instead, mirroring import-assessments.ts's unknown-property handling.
//   - Each attempted write is isolated: INSERT OR IGNORE cannot throw on a conflict (SQLite's
//     IGNORE resolution silently skips the one violating row), and every UPDATE/INSERT is still
//     wrapped in its own try/catch inside the enclosing db.transaction() as defense in depth, so an
//     unexpected per-row DB error can never roll back the rest of the batch.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openWarehouse } from '../server/warehouse/db';
import type { WarehouseDb } from '../server/warehouse/db';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// ── Loss events ──────────────────────────────────────────────────────────────────────────────

export interface ParsedLossEventRow {
  id: string;
  propertyId: string;
  policyRef: string | null;
  lossDate: string;
  cause: string | null;
  grossIncurred: number;
  paid: number | null;
  reserve: number | null;
  source: string;
}

export interface RejectedRow {
  index: number;
  id: string | null;
  reason: string;
}

export interface ParseLossEventsOutcome {
  rows: ParsedLossEventRow[];
  rejected: RejectedRow[];
}

/**
 * Parse + validate the loss-events JSON payload. Pure — no DB, no I/O. Exported for tests.
 * `defaultSource` is the fallback used when a row omits `source` AND the payload has no top-level
 * `source` of its own (the CLI passes its file-path argument as this fallback).
 */
export function parseLossEventsPayload(payload: unknown, defaultSource: string): ParseLossEventsOutcome {
  const rows: ParsedLossEventRow[] = [];
  const rejected: RejectedRow[] = [];

  if (!isRecord(payload) || !Array.isArray(payload.events)) {
    rejected.push({ index: -1, id: null, reason: 'payload must be an object with an "events" array' });
    return { rows, rejected };
  }

  const topLevelSource = typeof payload.source === 'string' && payload.source !== '' ? payload.source : undefined;
  const fallbackSource = topLevelSource ?? defaultSource;

  payload.events.forEach((raw: unknown, index: number) => {
    if (!isRecord(raw)) {
      rejected.push({ index, id: null, reason: 'row is not an object' });
      return;
    }
    const { id, propertyId, policyRef, lossDate, cause, grossIncurred, paid, reserve, source } = raw;

    if (typeof id !== 'string' || id === '') {
      rejected.push({ index, id: null, reason: 'missing or invalid "id"' });
      return;
    }
    // P4c refute finding 2: a MISSING or BLANK propertyId is a valid portfolio/umbrella-level loss
    // (per docs/templates/insurance-loss-runs.template.csv: "leave blank for a portfolio-level or
    // umbrella-policy loss that isn't attributable to a single property"). Map it to '' — the
    // engine's blank-check (insurance-loss-analysis.ts: `if (e.propertyId === '') continue;`) and
    // resolveLossEvents' null→'' coercion (placeholder-data.ts) both already expect exactly this.
    // Only a PRESENT propertyId of the wrong TYPE is malformed and rejected; a present, non-blank
    // string flows through to importLossEventRows' unknown-property (property_master) check.
    if (propertyId !== undefined && propertyId !== null && typeof propertyId !== 'string') {
      rejected.push({ index, id, reason: `propertyId must be a string when present, got '${String(propertyId)}'` });
      return;
    }
    const normalizedPropertyId = typeof propertyId === 'string' ? propertyId : '';
    if (typeof lossDate !== 'string' || lossDate === '') {
      rejected.push({ index, id, reason: 'missing or invalid "lossDate"' });
      return;
    }
    // P4c refute finding 1: loss_date MUST be strict ISO YYYY-MM-DD — matching migration 022's TEXT
    // column and every fixture/test row. calendarYear() in insurance-loss-analysis.ts extracts the
    // year via /^\s*(\d{4})/ and silently returns null for any non-ISO string (a US MM/DD/YYYY
    // broker loss-run export, the common case), which zeroes observationYears and nulls EVERY EAL
    // while the same events' dollar totals still populate — a silent EAL corruption with no error.
    // WORSE: an Excel serial like "45413" (a date miscoerced to text) matches \d{4} and fabricates a
    // bogus "year", inflating observationYears past MIN_LOSS_YEARS and understating EAL. Reject the
    // row here (like negative grossIncurred below) rather than auto-detect alternate formats — a
    // human fixes the source file, exactly as import-assessments.ts rejects malformed rows.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(lossDate)) {
      rejected.push({ index, id, reason: `lossDate must be ISO YYYY-MM-DD, got '${lossDate}'` });
      return;
    }
    // Matches placeholder-data.ts's parseLossEventFixtureRow precedent (Task 2): negative gross is
    // nonsensical loss data, rejected rather than let it flow into downstream loss-engine sums.
    if (typeof grossIncurred !== 'number' || !Number.isFinite(grossIncurred) || grossIncurred < 0) {
      rejected.push({ index, id, reason: `grossIncurred must be a nonnegative number, got '${String(grossIncurred)}'` });
      return;
    }

    rows.push({
      id,
      propertyId: normalizedPropertyId,
      policyRef: typeof policyRef === 'string' ? policyRef : null,
      lossDate,
      cause: typeof cause === 'string' ? cause : null,
      grossIncurred,
      paid: typeof paid === 'number' ? paid : null,
      reserve: typeof reserve === 'number' ? reserve : null,
      source: typeof source === 'string' && source !== '' ? source : fallbackSource,
    });
  });

  return { rows, rejected };
}

export interface ImportLossEventsResult {
  inserted: number;
  ignored: number;
  rejected: number;
}

/**
 * Insert parsed+validated loss-event rows into insurance_loss_events. A PRESENT, non-blank
 * propertyId not present in property_master is never inserted — recorded as a data_quality_issues
 * row instead (mirrors import-assessments.ts's unknown-property handling). A BLANK propertyId ('')
 * is a portfolio/umbrella loss and is stored with property_id = NULL (FK-exempt) — P4c refute
 * finding 2. INSERT OR IGNORE on the table's PRIMARY
 * KEY(id) and UNIQUE(property_id, loss_date, cause, gross_incurred) (migration 022) makes a re-run
 * of the same rows idempotent: `changes === 0` means the row was already present (`ignored`), not
 * an error. Each row's insert is wrapped in its own try/catch INSIDE the enclosing transaction —
 * one row hitting an unexpected constraint can never roll back rows already committed for others.
 */
export function importLossEventRows(db: WarehouseDb, rows: ParsedLossEventRow[]): ImportLossEventsResult {
  const knownProperties = new Set(
    (db.prepare('SELECT id FROM property_master').all() as { id: string }[]).map((r) => r.id),
  );

  const insert = db.prepare(`
    INSERT OR IGNORE INTO insurance_loss_events
      (id, property_id, policy_ref, loss_date, cause, gross_incurred, paid, reserve, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertDqUnknown = db.prepare(`
    INSERT INTO data_quality_issues (property_id, kind, detail, severity)
    VALUES (?, 'insurance-loss-event-unknown-property', ?, 'warn')
  `);
  const insertDqInvalid = db.prepare(`
    INSERT INTO data_quality_issues (property_id, kind, detail, severity)
    VALUES (?, 'insurance-loss-event-check-violation', ?, 'warn')
  `);

  let inserted = 0;
  let ignored = 0;
  let rejected = 0;

  const tx = db.transaction(() => {
    for (const r of rows) {
      // P4c refute finding 2: a blank propertyId ('') is a portfolio/umbrella loss, NOT an unknown
      // property. Store it as NULL (property_id is a nullable FK REFERENCES property_master(id), and
      // foreign_keys is ON — inserting '' would violate the FK, whereas NULL is FK-exempt).
      // resolveLossEvents reads the NULL back as '' for the engine's blank-check. Only a PRESENT,
      // non-blank propertyId missing from property_master is a genuine unknown-property DQ.
      const isPortfolioLoss = r.propertyId === '';
      if (!isPortfolioLoss && !knownProperties.has(r.propertyId)) {
        rejected += 1;
        insertDqUnknown.run(
          r.propertyId,
          `import-insurance-data: property_id '${r.propertyId}' (loss event '${r.id}') not found in property_master — row skipped`,
        );
        continue; // this candidate's own failure must never block any other row in the batch
      }

      try {
        const result = insert.run(
          r.id, isPortfolioLoss ? null : r.propertyId, r.policyRef, r.lossDate, r.cause, r.grossIncurred, r.paid, r.reserve, r.source,
        );
        if (result.changes > 0) inserted += 1;
        else ignored += 1; // idempotent re-run: PRIMARY KEY or UNIQUE conflict, silently skipped by IGNORE
      } catch (e) {
        rejected += 1;
        const detail = e instanceof Error ? e.message : String(e);
        insertDqInvalid.run(
          r.propertyId,
          `import-insurance-data: loss event '${r.id}' (property_id '${r.propertyId}') violated a database constraint and was skipped: ${detail}`,
        );
      }
    }
  });
  tx();

  return { inserted, ignored, rejected };
}

/** Combined parse+import entry point used by the CLI (and the cleanest single call for tests). */
export function importLossRuns(db: WarehouseDb, payload: unknown, defaultSource: string): ImportLossEventsResult {
  const { rows, rejected } = parseLossEventsPayload(payload, defaultSource);
  const dbResult = importLossEventRows(db, rows);
  return {
    inserted: dbResult.inserted,
    ignored: dbResult.ignored,
    rejected: rejected.length + dbResult.rejected,
  };
}

// ── Dec pages ────────────────────────────────────────────────────────────────────────────────

export interface ParsedDecPageRow {
  policyId: number;
  deductible: number;
  coverageLimit: number;
}

export interface ParseDecPagesOutcome {
  rows: ParsedDecPageRow[];
  rejected: RejectedRow[];
}

/** Parse + validate the dec-pages JSON payload (a bare array, not a CSV). Pure — no DB, no I/O. */
export function parseDecPagesPayload(payload: unknown): ParseDecPagesOutcome {
  const rows: ParsedDecPageRow[] = [];
  const rejected: RejectedRow[] = [];

  if (!Array.isArray(payload)) {
    rejected.push({ index: -1, id: null, reason: 'dec-pages payload must be a JSON array' });
    return { rows, rejected };
  }

  payload.forEach((raw: unknown, index: number) => {
    if (!isRecord(raw)) {
      rejected.push({ index, id: null, reason: 'row is not an object' });
      return;
    }
    const { policyId, deductible, coverageLimit } = raw;
    // resolveDecPages (placeholder-data.ts) keys its map with String(row.id) off an INTEGER PRIMARY
    // KEY column (migration 008) — accept either a JSON number or a numeric string for policyId.
    const policyIdNum = typeof policyId === 'number' ? policyId
      : typeof policyId === 'string' ? Number(policyId)
      : NaN;
    if (!Number.isFinite(policyIdNum) || !Number.isInteger(policyIdNum) || policyIdNum <= 0) {
      rejected.push({ index, id: policyId == null ? null : String(policyId), reason: `policyId must be a positive integer, got '${String(policyId)}'` });
      return;
    }
    if (typeof deductible !== 'number' || !Number.isFinite(deductible) || deductible < 0) {
      rejected.push({ index, id: String(policyIdNum), reason: `deductible must be a nonnegative number, got '${String(deductible)}'` });
      return;
    }
    if (typeof coverageLimit !== 'number' || !Number.isFinite(coverageLimit) || coverageLimit < 0) {
      rejected.push({ index, id: String(policyIdNum), reason: `coverageLimit must be a nonnegative number, got '${String(coverageLimit)}'` });
      return;
    }
    // P4c refute finding 3: the loss engine's per-event split (insurance-loss-analysis.ts) is
    // retained=Σmin(gross,d); transferred=Σmax(0,min(gross,limit)−d); overLimit=Σmax(0,gross−limit).
    // That only partitions gross when d ≤ limit. A transposed dec-pages row with deductible >
    // coverageLimit double-counts the (limit, deductible) band into BOTH retained and overLimit, so
    // retained+transferred+overLimit no longer sums to gross — silently inflating self-insure
    // exposure. Reject the row at the source (both values are guaranteed numbers by the checks
    // above); do NOT band-fix the engine, which would mask bad input at the wrong layer.
    if (deductible > coverageLimit) {
      rejected.push({ index, id: String(policyIdNum), reason: `deductible (${deductible}) must not exceed coverageLimit (${coverageLimit})` });
      return;
    }

    rows.push({ policyId: policyIdNum, deductible, coverageLimit });
  });

  return { rows, rejected };
}

export interface ImportDecPagesResult {
  updated: number;
  missing: number;
  rejected: number;
}

/**
 * Apply parsed+validated dec-page rows to property_insurance_policies. A policyId that does not
 * resolve to an existing row is counted (`missing`), never thrown — `changes === 0` after the
 * UPDATE tells us the WHERE clause matched nothing. Each UPDATE is wrapped in its own try/catch
 * inside the enclosing transaction, same isolation contract as importLossEventRows.
 */
export function importDecPageRows(db: WarehouseDb, rows: ParsedDecPageRow[]): ImportDecPagesResult {
  const update = db.prepare('UPDATE property_insurance_policies SET deductible = ?, coverage_limit = ? WHERE id = ?');
  const insertDqMissing = db.prepare(`
    INSERT INTO data_quality_issues (property_id, kind, detail, severity)
    VALUES (NULL, 'insurance-dec-page-unknown-policy', ?, 'warn')
  `);

  let updated = 0;
  let missing = 0;
  let rejected = 0;

  const tx = db.transaction(() => {
    for (const r of rows) {
      try {
        const result = update.run(r.deductible, r.coverageLimit, r.policyId);
        if (result.changes > 0) {
          updated += 1;
        } else {
          missing += 1;
          insertDqMissing.run(
            `import-insurance-data: policy id '${r.policyId}' not found in property_insurance_policies — dec-page update skipped`,
          );
        }
      } catch (e) {
        rejected += 1;
        const detail = e instanceof Error ? e.message : String(e);
        console.warn(`import-insurance-data: dec-page update for policy '${r.policyId}' failed: ${detail}`);
      }
    }
  });
  tx();

  return { updated, missing, rejected };
}

/** Combined parse+import entry point used by the CLI. */
export function importDecPages(db: WarehouseDb, payload: unknown): ImportDecPagesResult {
  const { rows, rejected } = parseDecPagesPayload(payload);
  const dbResult = importDecPageRows(db, rows);
  return {
    updated: dbResult.updated,
    missing: dbResult.missing,
    rejected: rejected.length + dbResult.rejected,
  };
}

// ── Policies (premium history) ──────────────────────────────────────────────────────────────

export interface ParsedPolicyRow {
  propertyId: string;
  insurer: string;
  policyNumber: string;
  effectiveDate: string;
  expirationDate: string | null;
  premiumAnnual: number;
  coverageTiv: number | null;
  policyType: string;
  source: string;
  sourceDate: string;
}

export interface ParsePoliciesOutcome {
  rows: ParsedPolicyRow[];
  rejected: RejectedRow[];
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse + validate the policies JSON payload. Pure — no DB, no I/O. Exported for tests.
 * Mirrors parseLossEventsPayload's per-row source fallback: a row's own `source` wins, else the
 * payload's top-level `source`, else the CLI's file-path argument (passed in as `defaultSource`).
 */
export function parsePoliciesPayload(payload: unknown, defaultSource: string): ParsePoliciesOutcome {
  const rows: ParsedPolicyRow[] = [];
  const rejected: RejectedRow[] = [];

  if (!isRecord(payload) || !Array.isArray(payload.policies)) {
    rejected.push({ index: -1, id: null, reason: 'payload must be an object with a "policies" array' });
    return { rows, rejected };
  }

  const topLevelSource = typeof payload.source === 'string' && payload.source !== '' ? payload.source : undefined;
  const fallbackSource = topLevelSource ?? defaultSource;

  payload.policies.forEach((raw: unknown, index: number) => {
    if (!isRecord(raw)) {
      rejected.push({ index, id: null, reason: 'row is not an object' });
      return;
    }
    const {
      propertyId, insurer, policyNumber, effectiveDate, expirationDate,
      premiumAnnual, coverageTiv, policyType, source, sourceDate,
    } = raw;

    if (typeof propertyId !== 'string' || propertyId.trim() === '') {
      rejected.push({ index, id: null, reason: 'missing or invalid "propertyId"' });
      return;
    }
    if (typeof insurer !== 'string' || insurer.trim() === '') {
      rejected.push({ index, id: propertyId, reason: 'missing or invalid "insurer"' });
      return;
    }
    if (typeof policyNumber !== 'string' || policyNumber.trim() === '') {
      rejected.push({ index, id: propertyId, reason: 'missing or invalid "policyNumber"' });
      return;
    }
    if (typeof effectiveDate !== 'string' || !ISO_DATE_RE.test(effectiveDate)) {
      rejected.push({ index, id: propertyId, reason: `effectiveDate must be ISO YYYY-MM-DD, got '${String(effectiveDate)}'` });
      return;
    }
    if (expirationDate !== undefined && expirationDate !== null
      && (typeof expirationDate !== 'string' || !ISO_DATE_RE.test(expirationDate))) {
      rejected.push({ index, id: propertyId, reason: `expirationDate must be ISO YYYY-MM-DD when present, got '${String(expirationDate)}'` });
      return;
    }
    if (typeof premiumAnnual !== 'number' || !Number.isFinite(premiumAnnual) || premiumAnnual < 0) {
      rejected.push({ index, id: propertyId, reason: `premiumAnnual must be a nonnegative number, got '${String(premiumAnnual)}'` });
      return;
    }
    if (coverageTiv !== undefined && coverageTiv !== null
      && (typeof coverageTiv !== 'number' || !Number.isFinite(coverageTiv) || coverageTiv < 0)) {
      rejected.push({ index, id: propertyId, reason: `coverageTiv must be a nonnegative number when present, got '${String(coverageTiv)}'` });
      return;
    }
    if (typeof policyType !== 'string' || policyType.trim() === '') {
      rejected.push({ index, id: propertyId, reason: 'missing or invalid "policyType"' });
      return;
    }
    // Validated as strictly as effectiveDate/expirationDate: sourceDate feeds source_date, which
    // insurance-analysis.ts's isMoreCurrent compares as a STRING (DESC) to rank a policy line's
    // current term. A non-ISO value (or a missing check, as this line originally had) would sort
    // unpredictably against real ISO dates and silently corrupt that ranking.
    if (typeof sourceDate !== 'string' || !ISO_DATE_RE.test(sourceDate)) {
      rejected.push({ index, id: propertyId, reason: `sourceDate must be ISO YYYY-MM-DD, got '${String(sourceDate)}'` });
      return;
    }

    rows.push({
      propertyId,
      insurer,
      policyNumber,
      effectiveDate,
      expirationDate: typeof expirationDate === 'string' ? expirationDate : null,
      premiumAnnual,
      coverageTiv: typeof coverageTiv === 'number' ? coverageTiv : null,
      policyType,
      source: typeof source === 'string' && source !== '' ? source : fallbackSource,
      sourceDate,
    });
  });

  return { rows, rejected };
}

export interface ImportPolicyRowsResult {
  inserted: number;
  updated: number;
  unrecognized: number;
  rejected: number;
}

/**
 * Upsert parsed+validated policy rows into property_insurance_policies. property_id has NO FK
 * (unlike property_tax_assessments/insurance_loss_events), so "recognized" means "an existing row
 * with this property_id already exists" OR "explicitly allowlisted via newLines for this run" —
 * the only two ways this importer will ever mint a property_id, matching the design's identity
 * rule (spec §4.1: reuse an existing line's id, mint a new one only for a genuinely new line).
 *
 * On a (property_id, policy_number, effective_date) match, UPDATE by that row's own `id` rather
 * than INSERT OR REPLACE — REPLACE deletes-and-reinserts under an AUTOINCREMENT PK, which would
 * mint a fresh id and silently null out any deductible/coverage_limit --dec-pages already applied
 * (spec §5). deductible/coverage_limit are never touched by this importer either way.
 */
export function importPolicyRows(
  db: WarehouseDb,
  rows: ParsedPolicyRow[],
  ingestedBy: string,
  newLines: string[] = [],
): ImportPolicyRowsResult {
  const knownPropertyIds = new Set(
    (db.prepare('SELECT DISTINCT property_id FROM property_insurance_policies').all() as { property_id: string }[])
      .map((r) => r.property_id),
  );
  const allowedNewLines = new Set(newLines);

  const findExisting = db.prepare(`
    SELECT id FROM property_insurance_policies WHERE property_id = ? AND policy_number = ? AND effective_date = ?
  `);
  const update = db.prepare(`
    UPDATE property_insurance_policies
    SET insurer = ?, expiration_date = ?, premium_annual = ?, coverage_tiv = ?, policy_type = ?,
        source = ?, source_date = ?, ingested_by = ?, ingested_at = datetime('now')
    WHERE id = ?
  `);
  const insert = db.prepare(`
    INSERT INTO property_insurance_policies
      (property_id, insurer, policy_number, effective_date, expiration_date, premium_annual,
       coverage_tiv, policy_type, source, source_date, ingested_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertDqUnrecognized = db.prepare(`
    INSERT INTO data_quality_issues (property_id, kind, detail, severity)
    VALUES (?, 'insurance-policy-unrecognized-line', ?, 'warn')
  `);
  const insertDqInvalid = db.prepare(`
    INSERT INTO data_quality_issues (property_id, kind, detail, severity)
    VALUES (?, 'insurance-policy-check-violation', ?, 'warn')
  `);

  let inserted = 0;
  let updated = 0;
  let unrecognized = 0;
  let rejected = 0;

  const tx = db.transaction(() => {
    for (const r of rows) {
      if (!knownPropertyIds.has(r.propertyId) && !allowedNewLines.has(r.propertyId)) {
        unrecognized += 1;
        insertDqUnrecognized.run(
          r.propertyId,
          `import-insurance-data --policies: property_id '${r.propertyId}' has no existing policy line and is not in this run's newLines allowlist — row skipped`,
        );
        continue; // this row's own failure must never block any other row in the batch
      }
      try {
        const existing = findExisting.get(r.propertyId, r.policyNumber, r.effectiveDate) as { id: number } | undefined;
        if (existing) {
          update.run(
            r.insurer, r.expirationDate, r.premiumAnnual, r.coverageTiv, r.policyType,
            r.source, r.sourceDate, ingestedBy, existing.id,
          );
          updated += 1;
        } else {
          insert.run(
            r.propertyId, r.insurer, r.policyNumber, r.effectiveDate, r.expirationDate,
            r.premiumAnnual, r.coverageTiv, r.policyType, r.source, r.sourceDate, ingestedBy,
          );
          inserted += 1;
          knownPropertyIds.add(r.propertyId); // a newLines row counts as known for a later row in this same batch
        }
      } catch (e) {
        rejected += 1;
        const detail = e instanceof Error ? e.message : String(e);
        console.warn(`import-insurance-data --policies: row for '${r.propertyId}' (${r.policyNumber}, ${r.effectiveDate}) failed: ${detail}`);
        // Mirrors importLossEventRows' insertDqInvalid: this script runs against a live warehouse,
        // so an unexpected DB failure needs a persisted, auditable trail — not just a line in a
        // console a later reader will never see. The row's own failure must never block the rest
        // of the batch (already true here: caught locally, loop continues).
        insertDqInvalid.run(
          r.propertyId,
          `import-insurance-data --policies: row for property_id '${r.propertyId}' (policy_number '${r.policyNumber}', effective_date '${r.effectiveDate}') violated a database constraint and was skipped: ${detail}`,
        );
      }
    }
  });
  tx();

  return { inserted, updated, unrecognized, rejected };
}

/** Combined parse+import entry point used by the CLI. */
export function importPolicies(db: WarehouseDb, payload: unknown, defaultSource: string): ImportPolicyRowsResult {
  const { rows, rejected } = parsePoliciesPayload(payload, defaultSource);
  const newLines = isRecord(payload) && Array.isArray(payload.newLines)
    ? payload.newLines.filter((x): x is string => typeof x === 'string')
    : [];
  const ingestedBy = isRecord(payload) && typeof payload.ingestedBy === 'string' && payload.ingestedBy !== ''
    ? payload.ingestedBy
    : 'import-insurance-data.ts --policies';
  const dbResult = importPolicyRows(db, rows, ingestedBy, newLines);
  return {
    inserted: dbResult.inserted,
    updated: dbResult.updated,
    unrecognized: dbResult.unrecognized,
    rejected: rejected.length + dbResult.rejected,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────

export interface CliArgs {
  mode: 'loss-events' | 'dec-pages' | 'policies';
  filePath: string;
  db?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let db: string | undefined;
  let decPagesPath: string | undefined;
  let policiesPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--db') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error('missing value for --db');
      db = next;
      i += 1;
    } else if (arg === '--dec-pages') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error('missing value for --dec-pages');
      decPagesPath = next;
      i += 1;
    } else if (arg === '--policies') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error('missing value for --policies');
      policiesPath = next;
      i += 1;
    } else {
      positional.push(arg);
    }
  }

  if (decPagesPath !== undefined && policiesPath !== undefined) {
    // Foot-gun guard: these two modes have completely different write semantics against a live
    // financial warehouse. Silently preferring one over the other on a mistyped combined invocation
    // (the prior behavior) is exactly the class of mistake this file's validation otherwise guards
    // against elsewhere — reject instead of guessing.
    throw new Error('--dec-pages and --policies are mutually exclusive');
  }
  if (decPagesPath !== undefined) {
    return { mode: 'dec-pages', filePath: decPagesPath, db };
  }
  if (policiesPath !== undefined) {
    return { mode: 'policies', filePath: policiesPath, db };
  }

  const filePath = positional[0];
  if (filePath === undefined) {
    throw new Error(
      'Usage: npx tsx scripts/import-insurance-data.ts <events.json> [--db <path>]\n'
      + '   or: npx tsx scripts/import-insurance-data.ts --dec-pages <policies.json> [--db <path>]\n'
      + '   or: npx tsx scripts/import-insurance-data.ts --policies <policies.json> [--db <path>]',
    );
  }
  return { mode: 'loss-events', filePath, db };
}

function defaultDbPath(): string {
  return process.env.WAREHOUSE_DB ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite');
}

function main(argv: string[]): number {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }

  let text: string;
  try {
    text = readFileSync(args.filePath, 'utf8');
  } catch (e) {
    console.error(`cannot read ${args.filePath}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (e) {
    console.error(`cannot parse ${args.filePath} as JSON: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  const dbPath = args.db ?? defaultDbPath();
  let db: WarehouseDb;
  try {
    db = openWarehouse(dbPath);
  } catch (e) {
    console.error(`cannot open warehouse at ${dbPath}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  try {
    if (args.mode === 'dec-pages') {
      const result = importDecPages(db, payload);
      console.log(`import-insurance-data (dec-pages): ${result.updated} polic${result.updated === 1 ? 'y' : 'ies'} updated from ${args.filePath}`);
      console.log(`  ${result.missing} missing policy id(s), ${result.rejected} rejected row(s)`);
    } else if (args.mode === 'policies') {
      const result = importPolicies(db, payload, args.filePath);
      console.log(`import-insurance-data (policies): ${result.inserted} inserted, ${result.updated} updated from ${args.filePath}`);
      console.log(`  ${result.unrecognized} unrecognized property_id row(s), ${result.rejected} rejected row(s)`);
    } else {
      const result = importLossRuns(db, payload, args.filePath);
      console.log(`import-insurance-data (loss-events): ${result.inserted} row(s) inserted from ${args.filePath}`);
      console.log(`  ${result.ignored} already-present (ignored) row(s), ${result.rejected} rejected row(s)`);
      if (result.inserted > 0) {
        console.log('  insurance_loss_events is no longer empty — placeholder-data.ts resolvers now read the warehouse, not the fixture.');
      }
    }
  } catch (e) {
    console.error(`import-insurance-data: database error during import: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    db.close();
  }

  return 0;
}

// Run the CLI only when invoked directly — importing for tests must never open a db or write.
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/import-insurance-data.ts')) {
  process.exit(main(process.argv.slice(2)));
}
