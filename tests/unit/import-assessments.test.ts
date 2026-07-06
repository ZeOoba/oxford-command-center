// @vitest-environment node
//
// tests/unit/import-assessments.test.ts
//
// CLI importer for docs/templates/property-tax-assessments.template.csv → property_tax_assessments
// (migration 020). Uses in-memory SQLite (tmpdir) with full migrations — never touches the live
// warehouse. parseAssessmentsCsv is pure (no DB); importAssessmentRows + parseArgs are tested
// against a fresh warehouse / plain arrays respectively.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import {
  parseAssessmentsCsv,
  importAssessmentRows,
  parseArgs,
  type ParsedAssessmentRow,
} from '../../scripts/import-assessments';

const HEADER = 'property_id,property_name,market,tax_year,jurisdiction,assessed_value,assessment_ratio,millage_rate,annual_tax_billed,source,as_of';

const CSV_TEXT = [
  '# Property tax assessment fill-in template — comment lines must be skipped.',
  '# Second comment line.',
  HEADER,
  'p1,"3540 E. 5th Ave, Columbus OH",Columbus OH,2026,Franklin County,900000,0.35,65,45000,county-portal,2026-01-15',
  'p2,"Blank Template Row",Columbus OH,2026,,,,,,county-portal,',
  'unknown-prop,"Unknown Property",Columbus OH,2026,Franklin County,500000,0.4,50,20000,county-portal,2026-01-10',
  'p3,"Bad Ratio Property",Columbus OH,2026,Franklin County,500000,1.5,50,20000,county-portal,2026-01-10',
  'p4,"Bad Year Property",Columbus OH,notayear,Franklin County,500000,0.4,50,20000,county-portal,2026-01-10',
  'p5,"Negative Value Property",Columbus OH,2026,Franklin County,-500000,0.4,50,20000,county-portal,2026-01-10',
].join('\n');

function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'import-assessments-test-'));
  return openWarehouse(join(dir, 'test.sqlite'));
}

function insertProperty(db: WarehouseDb, id: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO property_master
      (id, name, market, financial_mode, rentable_sf, acquisition_date, ownership_pct, ownership_status)
    VALUES (?, ?, 'Test Market', 'pnl', 10000, '2020-01-01', 1, 'active')
  `).run(id, id);
}

// ── parseAssessmentsCsv (pure) ────────────────────────────────────────────────────────────────

describe('parseAssessmentsCsv', () => {
  it('skips comment lines and the header, parsing only substantive rows', () => {
    const { rows, skippedComment } = parseAssessmentsCsv(CSV_TEXT);
    expect(skippedComment).toBe(2);
    // p1 valid, p2 blank (separately counted), unknown-prop valid-shaped, p3/p4/p5 invalid.
    expect(rows.map((r) => r.propertyId)).toEqual(['p1', 'unknown-prop']);
  });

  it('parses a quoted property_name field containing a comma without corrupting column alignment', () => {
    const { rows } = parseAssessmentsCsv(CSV_TEXT);
    const p1 = rows.find((r) => r.propertyId === 'p1')!;
    expect(p1.taxYear).toBe(2026);
    expect(p1.jurisdiction).toBe('Franklin County');
    expect(p1.assessedValue).toBe(900_000);
    expect(p1.assessmentRatio).toBe(0.35);
    expect(p1.millageRate).toBe(65);
    expect(p1.annualTaxBilled).toBe(45_000);
    expect(p1.source).toBe('county-portal');
    expect(p1.asOf).toBe('2026-01-15');
  });

  it('skips the blank-value template row (every optional numeric field empty)', () => {
    const { rows, skippedBlank } = parseAssessmentsCsv(CSV_TEXT);
    expect(skippedBlank).toBe(1);
    expect(rows.some((r) => r.propertyId === 'p2')).toBe(false);
  });

  it('records invalid rows without importing them: bad ratio, bad tax_year, negative value', () => {
    const { rows, invalidRows } = parseAssessmentsCsv(CSV_TEXT);
    expect(invalidRows).toHaveLength(3);
    const reasons = invalidRows.map((r) => `${r.propertyId}:${r.reason}`).join(' | ');
    expect(reasons).toMatch(/p3.*assessment_ratio/);
    expect(reasons).toMatch(/p4.*tax_year/);
    expect(reasons).toMatch(/p5.*assessed_value/);
    expect(rows.some((r) => ['p3', 'p4', 'p5'].includes(r.propertyId))).toBe(false);
  });

  it('defaults an empty source cell to county-portal and an empty jurisdiction/as_of to null', () => {
    const text = [
      HEADER,
      'p1,"Test Property",Columbus OH,2026,,900000,0.35,65,45000,,',
    ].join('\n');
    const { rows } = parseAssessmentsCsv(text);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('county-portal');
    expect(rows[0]!.jurisdiction).toBeNull();
    expect(rows[0]!.asOf).toBeNull();
  });

  it('finding 1a: rejects a blank tax_year even when every other field is filled (rather than silently coercing to 0)', () => {
    const text = [
      HEADER,
      'p1,"Blank Year Property",Columbus OH,,Franklin County,600000,0.4,55,25000,county-portal,2026-01-01',
    ].join('\n');
    const { rows, invalidRows } = parseAssessmentsCsv(text);
    expect(rows).toHaveLength(0);
    expect(invalidRows).toHaveLength(1);
    expect(invalidRows[0]!.reason).toMatch(/tax_year/);
  });

  it('finding 1a: rejects tax_year values outside [1990, 2100] (matches migration 020 CHECK exactly)', () => {
    const years = ['26', '206', '1889', '2200'];
    const text = [
      HEADER,
      ...years.map((y, i) => `p${i},"Out of Range ${y}",Columbus OH,${y},Franklin County,500000,0.4,50,20000,county-portal,2026-01-10`),
    ].join('\n');
    const { rows, invalidRows } = parseAssessmentsCsv(text);
    expect(rows).toHaveLength(0);
    expect(invalidRows).toHaveLength(years.length);
    for (const r of invalidRows) expect(r.reason).toMatch(/tax_year must be an integer between 1990 and 2100/);
  });

  it('finding 1a: rejects assessment_ratio = 0 (migration 020 CHECK requires strictly > 0)', () => {
    const text = [
      HEADER,
      'p1,"Zero Ratio Property",Columbus OH,2026,Franklin County,500000,0,50,20000,county-portal,2026-01-10',
    ].join('\n');
    const { rows, invalidRows } = parseAssessmentsCsv(text);
    expect(rows).toHaveLength(0);
    expect(invalidRows).toHaveLength(1);
    expect(invalidRows[0]!.reason).toMatch(/assessment_ratio/);
  });
});

// ── importAssessmentRows (DB) ─────────────────────────────────────────────────────────────────

describe('importAssessmentRows', () => {
  it('lands valid rows into property_tax_assessments', () => {
    const db = freshDb();
    insertProperty(db, 'p1');
    const { rows } = parseAssessmentsCsv(CSV_TEXT);
    const { imported } = importAssessmentRows(db, rows);
    expect(imported).toBe(1); // only p1 is both parse-valid and a known property

    const row = db.prepare('SELECT * FROM property_tax_assessments WHERE property_id = ? AND tax_year = ?')
      .get('p1', 2026) as { assessed_value: number; assessment_ratio: number; millage_rate: number };
    expect(row.assessed_value).toBe(900_000);
    expect(row.assessment_ratio).toBe(0.35);
    expect(row.millage_rate).toBe(65);
  });

  it('skips an unknown property_id and records a data_quality_issues row instead of inserting', () => {
    const db = freshDb();
    insertProperty(db, 'p1'); // 'unknown-prop' deliberately NOT seeded
    const { rows } = parseAssessmentsCsv(CSV_TEXT);
    const { skippedUnknownProperty } = importAssessmentRows(db, rows);
    expect(skippedUnknownProperty).toBe(1);

    const assessmentRow = db.prepare('SELECT * FROM property_tax_assessments WHERE property_id = ?').get('unknown-prop');
    expect(assessmentRow).toBeUndefined();

    const dq = db.prepare(`SELECT kind, property_id FROM data_quality_issues WHERE kind = 'tax-assessment-unknown-property'`)
      .get() as { kind: string; property_id: string };
    expect(dq.property_id).toBe('unknown-prop');
  });

  it('is idempotent: re-running the same rows does not duplicate a (property_id, tax_year) row', () => {
    const db = freshDb();
    insertProperty(db, 'p1');
    const { rows } = parseAssessmentsCsv(CSV_TEXT);
    importAssessmentRows(db, rows);
    importAssessmentRows(db, rows);

    const count = db.prepare('SELECT COUNT(*) AS n FROM property_tax_assessments WHERE property_id = ? AND tax_year = ?')
      .get('p1', 2026) as { n: number };
    expect(count.n).toBe(1);
  });

  it('re-running with updated values overwrites the prior row for the same (property_id, tax_year)', () => {
    const db = freshDb();
    insertProperty(db, 'p1');
    const { rows: firstRows } = parseAssessmentsCsv(CSV_TEXT);
    importAssessmentRows(db, firstRows);

    const updatedText = [
      HEADER,
      'p1,"3540 E. 5th Ave, Columbus OH",Columbus OH,2026,Franklin County,950000,0.4,70,50000,county-portal,2026-02-01',
    ].join('\n');
    const { rows: secondRows } = parseAssessmentsCsv(updatedText);
    importAssessmentRows(db, secondRows);

    const row = db.prepare('SELECT assessed_value, millage_rate FROM property_tax_assessments WHERE property_id = ? AND tax_year = ?')
      .get('p1', 2026) as { assessed_value: number; millage_rate: number };
    expect(row.assessed_value).toBe(950_000);
    expect(row.millage_rate).toBe(70);
  });

  it('FINDING 1 repro: a good row plus a blank-tax_year row lands the good row and reports the bad row invalid — never a full rollback', () => {
    const db = freshDb();
    insertProperty(db, 'good1');
    insertProperty(db, 'bad-year');
    const reproCsv = [
      HEADER,
      'good1,"Good Property",Columbus OH,2026,Franklin County,900000,0.35,65,45000,county-portal,2026-01-15',
      'bad-year,"Blank Year Property",Columbus OH,,Franklin County,600000,0.4,55,25000,county-portal,2026-01-01',
    ].join('\n');

    const { rows, invalidRows } = parseAssessmentsCsv(reproCsv);
    expect(rows.map((r) => r.propertyId)).toEqual(['good1']);
    expect(invalidRows.some((r) => r.propertyId === 'bad-year')).toBe(true);

    const { imported } = importAssessmentRows(db, rows);
    expect(imported).toBe(1);

    const count = db.prepare('SELECT COUNT(*) AS n FROM property_tax_assessments').get() as { n: number };
    expect(count.n).toBe(1); // not 0, not a crash
    const good = db.prepare('SELECT * FROM property_tax_assessments WHERE property_id = ?').get('good1');
    expect(good).toBeDefined();
  });

  it('FINDING 1b/1c defense-in-depth: a row that violates a DB CHECK (bypassing parse validation) does not roll back the whole batch', () => {
    const db = freshDb();
    insertProperty(db, 'good2');
    insertProperty(db, 'bad2');
    // Hand-built rows bypass parseAssessmentsCsv entirely — simulates a direct caller, or any
    // future mismatch between parse validation and the DB CHECK. tax_year=26 cannot arise from
    // parseAssessmentsCsv anymore (finding 1a), but importAssessmentRows must still isolate it.
    const rows: ParsedAssessmentRow[] = [
      {
        propertyId: 'good2', taxYear: 2026, jurisdiction: null, assessedValue: 900_000,
        assessmentRatio: 0.35, millageRate: 65, annualTaxBilled: 45_000, source: 'county-portal', asOf: null,
      },
      {
        propertyId: 'bad2', taxYear: 26, jurisdiction: null, assessedValue: 500_000,
        assessmentRatio: 0.4, millageRate: 50, annualTaxBilled: 20_000, source: 'county-portal', asOf: null,
      },
    ];

    const { imported, skippedInvalid } = importAssessmentRows(db, rows);
    expect(imported).toBe(1);
    expect(skippedInvalid).toBe(1);

    const goodRow = db.prepare('SELECT * FROM property_tax_assessments WHERE property_id = ?').get('good2');
    expect(goodRow).toBeDefined();
    const badRow = db.prepare('SELECT * FROM property_tax_assessments WHERE property_id = ?').get('bad2');
    expect(badRow).toBeUndefined();

    const dq = db.prepare(`SELECT property_id FROM data_quality_issues WHERE kind = 'tax-assessment-check-violation'`)
      .get() as { property_id: string };
    expect(dq.property_id).toBe('bad2');
  });

  it('FINDING 3: flags an in-batch duplicate (property_id, tax_year) as a data-quality issue instead of silently letting file order pick the winner (no as_of on either row → first-occurrence fallback)', () => {
    const db = freshDb();
    insertProperty(db, 'p1');
    const text = [
      HEADER,
      'p1,"First Row",Columbus OH,2026,Franklin County,900000,0.35,65,45000,county-portal,',
      'p1,"Duplicate Row (different jurisdiction)",Columbus OH,2026,Cuyahoga County,999999,0.5,80,60000,county-portal,',
    ].join('\n');
    const { rows } = parseAssessmentsCsv(text);
    expect(rows).toHaveLength(2); // both parse-valid individually — the collision is a batch-level concern
    expect(rows.every((r) => r.asOf === null)).toBe(true); // neither has an as_of — exercises the fallback rule

    const { imported, skippedDuplicate } = importAssessmentRows(db, rows);
    expect(imported).toBe(1);
    expect(skippedDuplicate).toBe(1);

    const count = db.prepare('SELECT COUNT(*) AS n FROM property_tax_assessments WHERE property_id = ? AND tax_year = ?')
      .get('p1', 2026) as { n: number };
    expect(count.n).toBe(1);

    const row = db.prepare('SELECT jurisdiction, assessed_value FROM property_tax_assessments WHERE property_id = ? AND tax_year = ?')
      .get('p1', 2026) as { jurisdiction: string; assessed_value: number };
    expect(row.jurisdiction).toBe('Franklin County'); // first occurrence wins, deterministically (fallback rule)
    expect(row.assessed_value).toBe(900_000);

    const dq = db.prepare(`SELECT property_id FROM data_quality_issues WHERE kind = 'tax-assessment-duplicate-in-batch'`)
      .get() as { property_id: string };
    expect(dq.property_id).toBe('p1');
  });

  it('FINDING 3: the "first row in the batch wins" fallback rule is explicit and consistent, not an accidental side effect of row order', () => {
    const db = freshDb();
    insertProperty(db, 'p1');
    // Same two rows as the prior test (still no as_of on either — the fallback path), but
    // REVERSED — proves the outcome follows the stated rule (first-in-array wins) rather than
    // some other order-dependent SQL behavior.
    const textReversed = [
      HEADER,
      'p1,"Duplicate Row (different jurisdiction)",Columbus OH,2026,Cuyahoga County,999999,0.5,80,60000,county-portal,',
      'p1,"First Row",Columbus OH,2026,Franklin County,900000,0.35,65,45000,county-portal,',
    ].join('\n');
    const { rows } = parseAssessmentsCsv(textReversed);
    const { imported, skippedDuplicate } = importAssessmentRows(db, rows);
    expect(imported).toBe(1);
    expect(skippedDuplicate).toBe(1);

    const row = db.prepare('SELECT jurisdiction FROM property_tax_assessments WHERE property_id = ? AND tax_year = ?')
      .get('p1', 2026) as { jurisdiction: string };
    expect(row.jurisdiction).toBe('Cuyahoga County'); // now-first row wins — explicit rule, not silent last-write-wins
  });

  it('FINDING B: when both same-key rows carry an as_of, the MORE RECENT as_of wins regardless of CSV order (an appended correction beats the stale original)', () => {
    const older = 'p1,"Original",Columbus OH,2026,Franklin County,900000,0.35,65,45000,county-portal,2026-01-15';
    const newer = 'p1,"Corrected",Columbus OH,2026,Franklin County,950000,0.4,70,50000,county-portal,2026-03-01';

    // Order 1: older first, newer second — the natural "analyst appends a correction" workflow.
    {
      const db = freshDb();
      insertProperty(db, 'p1');
      const { rows } = parseAssessmentsCsv([HEADER, older, newer].join('\n'));
      const { imported, skippedDuplicate } = importAssessmentRows(db, rows);
      expect(imported).toBe(1);
      expect(skippedDuplicate).toBe(1);
      const row = db.prepare('SELECT assessed_value, as_of FROM property_tax_assessments WHERE property_id = ? AND tax_year = ?')
        .get('p1', 2026) as { assessed_value: number; as_of: string };
      expect(row.assessed_value).toBe(950_000); // the corrected (newer as_of) row wins
      expect(row.as_of).toBe('2026-03-01');
    }

    // Order 2: newer first, older second — SAME winner, proving the rule is as_of-driven, not
    // position-driven (the exact scenario the old first-wins fix got backwards for a correction).
    {
      const db = freshDb();
      insertProperty(db, 'p1');
      const { rows } = parseAssessmentsCsv([HEADER, newer, older].join('\n'));
      const { imported, skippedDuplicate } = importAssessmentRows(db, rows);
      expect(imported).toBe(1);
      expect(skippedDuplicate).toBe(1);
      const row = db.prepare('SELECT assessed_value, as_of FROM property_tax_assessments WHERE property_id = ? AND tax_year = ?')
        .get('p1', 2026) as { assessed_value: number; as_of: string };
      expect(row.assessed_value).toBe(950_000);
      expect(row.as_of).toBe('2026-03-01');
    }
  });

  it('FINDING A repro: an earlier same-key row that fails its OWN check does not block a later, valid same-key row from landing (both orders)', () => {
    const validRow: ParsedAssessmentRow = {
      propertyId: 'samekey-prop', taxYear: 2026, jurisdiction: null, assessedValue: 900_000,
      assessmentRatio: 0.35, millageRate: 65, annualTaxBilled: 45_000, source: 'county-portal', asOf: null,
    };
    // Same key (propertyId + taxYear) as validRow — differs only in assessment_ratio=0, which
    // violates migration 020's CHECK(assessment_ratio > 0). Hand-built to bypass parseAssessmentsCsv
    // (which independently rejects ratio<=0 at parse time — finding 1a) — simulates a direct
    // caller, matching the existing findings 1b/1c test style.
    const invalidRow: ParsedAssessmentRow = { ...validRow, assessmentRatio: 0 };

    // Order 1: invalid first, valid second. THE OLD BUG: seenInBatch claimed the key on first
    // sight (before the insert even ran), so the valid second row was rejected as a "duplicate" —
    // imported:0, no row at all for this property/year.
    {
      const db = freshDb();
      insertProperty(db, 'samekey-prop');
      const { imported, skippedInvalid, skippedDuplicate } = importAssessmentRows(db, [invalidRow, validRow]);
      expect(imported).toBe(1);
      expect(skippedInvalid).toBe(1);
      expect(skippedDuplicate).toBe(0); // the valid row was a genuine retry, not a duplicate
      const row = db.prepare('SELECT assessment_ratio FROM property_tax_assessments WHERE property_id = ? AND tax_year = ?')
        .get('samekey-prop', 2026) as { assessment_ratio: number } | undefined;
      expect(row).toBeDefined();
      expect(row!.assessment_ratio).toBe(0.35);
    }

    // Order 2: valid first, invalid second — must land the same way (valid row present).
    {
      const db = freshDb();
      insertProperty(db, 'samekey-prop');
      const { imported } = importAssessmentRows(db, [validRow, invalidRow]);
      expect(imported).toBe(1);
      const row = db.prepare('SELECT assessment_ratio FROM property_tax_assessments WHERE property_id = ? AND tax_year = ?')
        .get('samekey-prop', 2026) as { assessment_ratio: number } | undefined;
      expect(row).toBeDefined();
      expect(row!.assessment_ratio).toBe(0.35);
    }
  });
});

// ── parseArgs (CLI) ────────────────────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('parses a bare csv path with no --db override', () => {
    expect(parseArgs(['assessments.csv'])).toEqual({ csvPath: 'assessments.csv', db: undefined });
  });

  it('parses --db alongside the csv path regardless of order', () => {
    expect(parseArgs(['assessments.csv', '--db', '/tmp/x.sqlite'])).toEqual({ csvPath: 'assessments.csv', db: '/tmp/x.sqlite' });
    expect(parseArgs(['--db', '/tmp/x.sqlite', 'assessments.csv'])).toEqual({ csvPath: 'assessments.csv', db: '/tmp/x.sqlite' });
  });

  it('throws when no csv path is given', () => {
    expect(() => parseArgs([])).toThrow();
    expect(() => parseArgs(['--db', '/tmp/x.sqlite'])).toThrow();
  });

  it('throws when --db is missing its value', () => {
    expect(() => parseArgs(['assessments.csv', '--db'])).toThrow();
  });
});
