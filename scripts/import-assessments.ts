// scripts/import-assessments.ts
//
// CSV importer for property tax assessments (Phase 6 tax module). Reads the
// docs/templates/property-tax-assessments.template.csv format and upserts rows into
// property_tax_assessments (migration 020). INSERT OR REPLACE on the table's
// UNIQUE(property_id, tax_year) makes a re-run of the same file a no-op change-wise (idempotent).
//
// Usage: npx tsx scripts/import-assessments.ts <csv-path> [--db <path>]
//
// Row handling:
//   - '#'-prefixed comment lines are skipped (the template ships with a comment header).
//   - Blank-value rows (every optional numeric field empty — the un-filled template state as
//     shipped) are skipped, not imported as zeros.
//   - A property_id not found in property_master is skipped and recorded as a
//     data_quality_issues row (never inserted — that would violate the FK and silently
//     misattribute a tax bill).
//   - Any other validation failure (bad tax_year, negative number, out-of-range ratio) is
//     skipped and reported in the printed summary; nothing partial is written for that row.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openWarehouse } from '../server/warehouse/db';
import type { WarehouseDb } from '../server/warehouse/db';

// CSV column order (header row) — property_id,property_name,market,tax_year,jurisdiction,
// assessed_value,assessment_ratio,millage_rate,annual_tax_billed,source,as_of
const COL_PROPERTY_ID = 0;
const COL_TAX_YEAR = 3;
const COL_JURISDICTION = 4;
const COL_ASSESSED_VALUE = 5;
const COL_ASSESSMENT_RATIO = 6;
const COL_MILLAGE_RATE = 7;
const COL_ANNUAL_TAX_BILLED = 8;
const COL_SOURCE = 9;
const COL_AS_OF = 10;

/**
 * Tolerant single-CSV-line splitter (RFC4180-ish: quoted fields, doubled-quote escape).
 * A local copy — server/sources/quickbooks.ts has an equivalent private helper, but this lane
 * touches only the files in its brief; this is a ~15-line generic utility (not business logic),
 * so a second small copy is the pragmatic call rather than reaching into an off-limits file.
 */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export interface ParsedAssessmentRow {
  propertyId: string;
  taxYear: number;
  jurisdiction: string | null;
  assessedValue: number | null;
  assessmentRatio: number | null;
  millageRate: number | null;
  annualTaxBilled: number | null;
  source: string;
  asOf: string | null;
}

export interface InvalidRow {
  line: number;
  propertyId: string;
  reason: string;
}

export interface ParseCsvOutcome {
  rows: ParsedAssessmentRow[];
  skippedComment: number;
  skippedBlank: number;
  invalidRows: InvalidRow[];
}

// tax_year bounds — MUST match migration 020's CHECK(tax_year BETWEEN 1990 AND 2100) exactly.
// Refute finding 1a: a mismatch here is not cosmetic — a row that passes parse but fails the DB
// CHECK used to abort the whole import transaction (see importAssessmentRows' per-row isolation
// below for the belt-and-suspenders defense, but the real fix is not letting bad rows through here).
const MIN_TAX_YEAR = 1990;
const MAX_TAX_YEAR = 2100;

/** Nonneg number cell; '' → null; non-numeric/negative → undefined (caller treats as invalid). */
function parseNonNegNullable(raw: string): number | null | undefined {
  if (raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

/**
 * Ratio cell; '' → null; anything else must be STRICTLY greater than 0 and at most 1 — matches
 * migration 020's CHECK(assessment_ratio > 0 AND assessment_ratio <= 1) exactly. Refute finding
 * 1a: the prior version accepted 0 (n >= 0), which the DB CHECK rejects.
 */
function parseRatioNullable(raw: string): number | null | undefined {
  if (raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) return undefined;
  return n;
}

/**
 * Parse the assessments CSV text into validated rows. Pure — no DB, no I/O. Exported for tests.
 * The first non-comment, non-blank line is treated as the header and skipped without validation
 * (this importer is positional, matching the fixed template column order, not header-driven).
 */
export function parseAssessmentsCsv(text: string): ParseCsvOutcome {
  const lines = text.split(/\r?\n/);
  const rows: ParsedAssessmentRow[] = [];
  let skippedComment = 0;
  let skippedBlank = 0;
  const invalidRows: InvalidRow[] = [];

  let headerSeen = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    if (trimmed.startsWith('#')) { skippedComment += 1; continue; }
    if (!headerSeen) { headerSeen = true; continue; }

    const cells = parseCsvLine(raw);
    const propertyId = cells[COL_PROPERTY_ID] ?? '';
    const taxYearRaw = cells[COL_TAX_YEAR] ?? '';
    const jurisdictionRaw = cells[COL_JURISDICTION] ?? '';
    const assessedValueRaw = cells[COL_ASSESSED_VALUE] ?? '';
    const assessmentRatioRaw = cells[COL_ASSESSMENT_RATIO] ?? '';
    const millageRateRaw = cells[COL_MILLAGE_RATE] ?? '';
    const annualTaxBilledRaw = cells[COL_ANNUAL_TAX_BILLED] ?? '';
    const sourceRaw = cells[COL_SOURCE] ?? '';
    const asOfRaw = cells[COL_AS_OF] ?? '';

    if (propertyId === '') {
      invalidRows.push({ line: i + 1, propertyId: '(blank)', reason: 'missing property_id' });
      continue;
    }

    // Blank-value row (the un-filled template state): every optional numeric field empty means
    // nothing to import — skip quietly rather than writing an all-null assessment row.
    if (assessedValueRaw === '' && assessmentRatioRaw === '' && millageRateRaw === '' && annualTaxBilledRaw === '') {
      skippedBlank += 1;
      continue;
    }

    // Refute finding 1a: a BLANK tax_year with other fields filled falls through to Number('')===0,
    // which passes isFinite+isInteger — a "valid" 0 that then violates the DB's tax_year CHECK.
    // Reject blank explicitly (clearer message) in addition to the range check below (which would
    // also catch it, since 0 is outside [MIN_TAX_YEAR, MAX_TAX_YEAR]).
    if (taxYearRaw.trim() === '') {
      invalidRows.push({ line: i + 1, propertyId, reason: 'missing tax_year' });
      continue;
    }
    const taxYear = Number(taxYearRaw);
    if (!Number.isFinite(taxYear) || !Number.isInteger(taxYear) || taxYear < MIN_TAX_YEAR || taxYear > MAX_TAX_YEAR) {
      invalidRows.push({
        line: i + 1, propertyId,
        reason: `tax_year must be an integer between ${MIN_TAX_YEAR} and ${MAX_TAX_YEAR}, got '${taxYearRaw}'`,
      });
      continue;
    }

    const assessedValue = parseNonNegNullable(assessedValueRaw);
    if (assessedValue === undefined) {
      invalidRows.push({ line: i + 1, propertyId, reason: `assessed_value must be a nonnegative number, got '${assessedValueRaw}'` });
      continue;
    }
    const millageRate = parseNonNegNullable(millageRateRaw);
    if (millageRate === undefined) {
      invalidRows.push({ line: i + 1, propertyId, reason: `millage_rate must be a nonnegative number, got '${millageRateRaw}'` });
      continue;
    }
    const annualTaxBilled = parseNonNegNullable(annualTaxBilledRaw);
    if (annualTaxBilled === undefined) {
      invalidRows.push({ line: i + 1, propertyId, reason: `annual_tax_billed must be a nonnegative number, got '${annualTaxBilledRaw}'` });
      continue;
    }
    const assessmentRatio = parseRatioNullable(assessmentRatioRaw);
    if (assessmentRatio === undefined) {
      invalidRows.push({ line: i + 1, propertyId, reason: `assessment_ratio must be greater than 0 and at most 1, got '${assessmentRatioRaw}'` });
      continue;
    }

    rows.push({
      propertyId,
      taxYear,
      jurisdiction: jurisdictionRaw === '' ? null : jurisdictionRaw,
      assessedValue,
      assessmentRatio,
      millageRate,
      annualTaxBilled,
      source: sourceRaw === '' ? 'county-portal' : sourceRaw,
      asOf: asOfRaw === '' ? null : asOfRaw,
    });
  }

  return { rows, skippedComment, skippedBlank, invalidRows };
}

export interface ImportRowsResult {
  imported: number;
  skippedUnknownProperty: number;
  /** Refute finding 3: a row for a (property_id, tax_year) that already has a winner WITHIN this
   *  batch — flagged and rejected rather than silently letting file order pick the survivor. */
  skippedDuplicate: number;
  /** Refute finding 1b: a row that parsed cleanly but still violated a DB CHECK constraint
   *  (defense in depth — parseAssessmentsCsv's validation is kept in lockstep with migration 020's
   *  CHECKs, but this catches any surviving mismatch, or a direct caller bypassing the parser). */
  skippedInvalid: number;
}

/**
 * Upsert parsed+validated rows into property_tax_assessments. A property_id not present in
 * property_master is never inserted (would violate the FK and silently misattribute a tax bill);
 * it is recorded as a data_quality_issues row instead. INSERT OR REPLACE on the table's
 * UNIQUE(property_id, tax_year) makes a re-run of the same file idempotent (mirrors insurance.ts).
 *
 * Refute findings 1 + 3 + A + B: rows are grouped by (property_id, tax_year); each group is
 * resolved to AT MOST ONE landed row —
 *   PRECEDENCE (finding B): within a group of >1 row, candidates are tried in order of MOST
 *     RECENT `as_of` first (a real CSV field, not a guess — a missing as_of sorts before any real
 *     date, so a row that has one always beats a row that doesn't). Ties (including "neither has
 *     an as_of") fall back to first-occurrence order (stable sort). This means an analyst
 *     APPENDING a corrected assessment row after the original in the same file gets the
 *     correction, not the stale original — the natural "latest data wins" expectation.
 *   ATTEMPT-UNTIL-LANDED (finding A): candidates are tried in that precedence order; an earlier
 *     candidate's OWN failure (unknown property, or a CHECK violation caught locally — see below)
 *     is recorded under its own reason and does NOT block a later, valid candidate for the SAME
 *     key from landing. The key is "claimed" only once a row for it has actually been inserted —
 *     never pre-claimed on first sight (that was finding A's regression: a failing first
 *     occurrence permanently blocked a valid later one, silently losing the property's only
 *     assessment row). Once a candidate lands, every remaining candidate in the group is a genuine
 *     duplicate (skippedDuplicate, DQ-recorded) and is never attempted.
 *   PER-ROW ISOLATION (finding 1b): each attempted INSERT is wrapped in its own try/catch INSIDE
 *     the enclosing transaction. SQLite's default CHECK-violation conflict resolution (ABORT) only
 *     undoes the ONE failing statement, not the whole transaction — so catching the exception here
 *     (instead of letting it propagate to db.transaction()'s wrapper, which WOULD roll back
 *     everything already inserted) means one bad row can never wipe out every good row in the same
 *     run. The failure is recorded as a data_quality_issues row and does not count as `imported`.
 */
export function importAssessmentRows(db: WarehouseDb, rows: ParsedAssessmentRow[]): ImportRowsResult {
  const knownProperties = new Set(
    (db.prepare('SELECT id FROM property_master').all() as { id: string }[]).map((r) => r.id),
  );

  const insert = db.prepare(`
    INSERT OR REPLACE INTO property_tax_assessments
      (property_id, tax_year, jurisdiction, assessed_value, assessment_ratio, millage_rate, annual_tax_billed, source, as_of)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertDqUnknown = db.prepare(`
    INSERT INTO data_quality_issues (property_id, kind, detail, severity)
    VALUES (?, 'tax-assessment-unknown-property', ?, 'warn')
  `);
  const insertDqDuplicate = db.prepare(`
    INSERT INTO data_quality_issues (property_id, kind, detail, severity)
    VALUES (?, 'tax-assessment-duplicate-in-batch', ?, 'warn')
  `);
  const insertDqInvalid = db.prepare(`
    INSERT INTO data_quality_issues (property_id, kind, detail, severity)
    VALUES (?, 'tax-assessment-check-violation', ?, 'warn')
  `);

  let imported = 0;
  let skippedUnknownProperty = 0;
  let skippedDuplicate = 0;
  let skippedInvalid = 0;

  // Group by (property_id, tax_year). A JS Map iterates entries in INSERTION order, so grouping
  // this way (instead of a separate key-order array) naturally preserves each key's
  // first-appearance order — a CSV with no duplicates at all still processes top-to-bottom,
  // unchanged from before.
  const groups = new Map<string, ParsedAssessmentRow[]>();
  for (const r of rows) {
    const key = `${r.propertyId}|${r.taxYear}`;
    const g = groups.get(key);
    if (g) { g.push(r); } else { groups.set(key, [r]); }
  }

  const tx = db.transaction(() => {
    for (const group of groups.values()) {
      // Finding B precedence: sort by as_of DESCENDING ('' for a missing as_of always sorts before
      // any real 'YYYY-MM-DD' string). Array.prototype.sort is stable in Node/V8, so a tie
      // (including "neither has an as_of") preserves original relative order — first-occurrence
      // wins as the documented fallback. Skip the sort entirely for the (overwhelmingly common)
      // single-row group.
      const ranked = group.length === 1
        ? group
        : [...group].sort((a, b) => (b.asOf ?? '').localeCompare(a.asOf ?? ''));

      let landed = false;
      for (const r of ranked) {
        if (landed) {
          // A higher-(or equal-)precedence candidate for this key already landed — every
          // remaining candidate is a genuine duplicate; never attempted, never silently applied.
          skippedDuplicate += 1;
          insertDqDuplicate.run(
            r.propertyId,
            `import-assessments: duplicate row for property_id '${r.propertyId}' (tax_year ${r.taxYear}) within the same import batch — a higher-precedence row (by as_of, else first-occurrence) was kept, this row was skipped`,
          );
          continue;
        }

        if (!knownProperties.has(r.propertyId)) {
          skippedUnknownProperty += 1;
          insertDqUnknown.run(
            r.propertyId,
            `import-assessments: property_id '${r.propertyId}' (tax_year ${r.taxYear}) not found in property_master — assessment row skipped`,
          );
          continue; // finding A: this candidate's OWN failure must not block the next-ranked one
        }

        // Finding 1b: per-row isolation. A CHECK-constraint violation here throws and is caught
        // LOCALLY — it never reaches db.transaction()'s wrapper, so earlier successful rows (for
        // OTHER keys) in this same call are NOT rolled back, and — finding A — it does not stop
        // the NEXT-ranked candidate for THIS SAME key from being tried.
        try {
          insert.run(
            r.propertyId, r.taxYear, r.jurisdiction, r.assessedValue, r.assessmentRatio,
            r.millageRate, r.annualTaxBilled, r.source, r.asOf,
          );
          imported += 1;
          landed = true; // claim the key only now that a row for it has actually committed
        } catch (e) {
          skippedInvalid += 1;
          const detail = e instanceof Error ? e.message : String(e);
          insertDqInvalid.run(
            r.propertyId,
            `import-assessments: row for property_id '${r.propertyId}' (tax_year ${r.taxYear}) violated a database constraint and was skipped: ${detail}`,
          );
        }
      }
    }
  });
  tx();
  return { imported, skippedUnknownProperty, skippedDuplicate, skippedInvalid };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): { csvPath: string; db?: string } {
  const positional: string[] = [];
  let db: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--db') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error('missing value for --db');
      db = next;
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  const csvPath = positional[0];
  if (csvPath === undefined) {
    throw new Error('Usage: npx tsx scripts/import-assessments.ts <csv-path> [--db <path>]');
  }
  return { csvPath, db };
}

function defaultDbPath(): string {
  return process.env.WAREHOUSE_DB ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite');
}

function main(argv: string[]): number {
  let args: { csvPath: string; db?: string };
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }

  let text: string;
  try {
    text = readFileSync(args.csvPath, 'utf8');
  } catch (e) {
    console.error(`cannot read ${args.csvPath}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  const { rows, skippedComment, skippedBlank, invalidRows } = parseAssessmentsCsv(text);

  const dbPath = args.db ?? defaultDbPath();
  let db: WarehouseDb;
  try {
    db = openWarehouse(dbPath);
  } catch (e) {
    console.error(`cannot open warehouse at ${dbPath}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  // Refute finding 1c: importAssessmentRows already isolates per-row failures (see its own doc
  // comment), but a wholly unexpected DB error (e.g. a locked file, a disk error) must still exit
  // nonzero with a clear message instead of an unhandled crash — and db.close() must run either way.
  let result: ImportRowsResult;
  try {
    result = importAssessmentRows(db, rows);
  } catch (e) {
    console.error(`import-assessments: database error during import: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    db.close();
  }

  const { imported, skippedUnknownProperty, skippedDuplicate, skippedInvalid } = result;
  console.log(`import-assessments: ${imported} row(s) imported/updated from ${args.csvPath}`);
  console.log(
    `  skipped: ${skippedComment} comment line(s), ${skippedBlank} blank-value row(s), `
    + `${skippedUnknownProperty} unknown-property row(s), ${skippedDuplicate} in-batch duplicate row(s), `
    + `${skippedInvalid} constraint-violating row(s), ${invalidRows.length} invalid row(s)`,
  );
  for (const r of invalidRows) console.warn(`  line ${r.line} (${r.propertyId}): ${r.reason}`);

  return 0;
}

// Run the CLI only when invoked directly — importing for tests must never open a db or write.
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/import-assessments.ts')) {
  process.exit(main(process.argv.slice(2)));
}
