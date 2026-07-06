// @vitest-environment node
//
// tests/unit/tax-analysis.test.ts
//
// Phase 6 tax module: the analysis engine (buildTaxAnalysis), its calibration verdict mapper
// (verdictsFromTaxOpportunities), and the API sub-router (taxApi). Uses in-memory SQLite
// (tmpdir) with full migrations — never touches the live warehouse.
//
// Hand-computed fixture used throughout (Ohio-style ratio assessment):
//   assessedValue = 900,000, assessmentRatio = 0.35
//     → impliedValue = 900,000 / 0.35 = 2,571,428.57
//   indicated (Spine-A) fullAssetValue = 2,000,000
//     → 2,000,000 × (1 + ADVISORY_OVERSHOOT[0.15]) = 2,300,000
//     → impliedValue (2,571,428.57) > 2,300,000 ⇒ overshoot threshold cleared
//   excessAssessment = assessedValue − fullAssetValue × assessmentRatio
//                    = 900,000 − 2,000,000 × 0.35 = 900,000 − 700,000 = 200,000
//   millageRate = 65 mills → savingsFullAsset = 200,000 × 65 / 1000 = 13,000
//   oxfordOwnPct = 0.5 → savingsOxfordShare = 13,000 × 0.5 = 6,500
//   annualTaxBilled = 45,000 → effectiveRate = 45,000 / 900,000 = 0.05
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { computeInputsVersion, logVerdicts } from '../../server/warehouse/calibration';
import {
  buildTaxAnalysis,
  verdictsFromTaxOpportunities,
  ADVISORY_OVERSHOOT,
  APPEAL_PERCENTILE_THRESHOLD,
  type IndicatedPropertyValue,
} from '../../server/warehouse/tax-analysis';
import type { Property } from '../../src/contracts/property';
import type { PortfolioSnapshot } from '../../src/contracts/index';

vi.mock('../../server/brain', () => ({
  brain: { getSnapshot: vi.fn() },
}));

// ── DB fixture helpers (local — tests never import across test files) ────────────────────────

function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'tax-analysis-test-'));
  return openWarehouse(join(dir, 'test.sqlite'));
}

function insertProperty(db: WarehouseDb, id: string, rentableSf: number | null = 10000): void {
  db.prepare(`
    INSERT OR IGNORE INTO property_master
      (id, name, market, financial_mode, rentable_sf, acquisition_date, ownership_pct, ownership_status)
    VALUES (?, ?, 'Test Market', 'pnl', ?, '2020-01-01', 1, 'active')
  `).run(id, id, rentableSf);
}

interface AssessmentFixture {
  propertyId: string;
  taxYear: number;
  jurisdiction?: string | null;
  assessedValue?: number | null;
  assessmentRatio?: number | null;
  millageRate?: number | null;
  annualTaxBilled?: number | null;
  source?: string;
  asOf?: string | null;
}

function insertAssessment(db: WarehouseDb, a: AssessmentFixture): void {
  insertProperty(db, a.propertyId);
  db.prepare(`
    INSERT INTO property_tax_assessments
      (property_id, tax_year, jurisdiction, assessed_value, assessment_ratio, millage_rate, annual_tax_billed, source, as_of)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    a.propertyId, a.taxYear, a.jurisdiction ?? null, a.assessedValue ?? null, a.assessmentRatio ?? null,
    a.millageRate ?? null, a.annualTaxBilled ?? null, a.source ?? 'county-portal', a.asOf ?? null,
  );
}

interface AppealFixture {
  id: string;
  propertyId: string;
  taxYear: number;
  status?: string;
  filedDate?: string | null;
  estSavingsAnnual?: number | null;
  realizedSavingsAnnual?: number | null;
  notes?: string | null;
}

function insertAppeal(db: WarehouseDb, a: AppealFixture): void {
  insertProperty(db, a.propertyId);
  db.prepare(`
    INSERT INTO tax_appeals
      (id, property_id, tax_year, status, filed_date, est_savings_annual, realized_savings_annual, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    a.id, a.propertyId, a.taxYear, a.status ?? 'draft', a.filedDate ?? null,
    a.estSavingsAnnual ?? null, a.realizedSavingsAnnual ?? null, a.notes ?? null,
  );
}

let importCounter = 0;

/** Insert a minimal import_batches row and return its id. */
function insertImportBatch(db: WarehouseDb, periodGrain: string, periodEnd: string | null, basis: string): number {
  importCounter += 1;
  const hash = `hash-${importCounter}`;
  const info = db.prepare(`
    INSERT INTO import_batches (file_name, file_hash, raw_path, imported_at, period_grain, period_end, basis, source_system, version, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'quickbooks', 1, 'committed')
  `).run(`${hash}.xlsx`, hash, `/raw/${hash}.xlsx`, '2026-01-01T00:00:00Z', periodGrain, periodEnd, basis);
  return Number(info.lastInsertRowid);
}

// One import batch per (db, propertyId, period, grain, basis) — mirrors a single P&L file carrying
// several category lines. Without this, two insertLedgerCategory calls for the same
// property/period/grain/basis would create TWO import batches for the same group, and
// selectCoherentBatch (metrics.ts) would keep only the higher-import_id batch and silently drop
// the other's rows (the exact multi-batch collision that function exists to resolve for a real
// full-year/YTD coexistence).
const importBatchCacheByDb = new WeakMap<WarehouseDb, Map<string, number>>();

interface LedgerCategoryOpts {
  /** import_batches.period_grain — 'year' (default) for a full-year batch, 'ytd' for a partial-year
   *  peer (refute finding 2's YTD-contamination trigger). */
  grain?: string;
  /** import_batches.basis — 'cash' (default), or e.g. 'accrual' for a cross-basis peer (refute
   *  finding 2's basis-contamination trigger). */
  basis?: string;
}

/**
 * Insert one ledger row for a property/period, reusing one shared import batch per
 * (property, period, grain, basis). `normalizedCategory` is the bucket key metrics.ts groups by
 * (PeriodMetrics.categories / taxesPerSf reads `categories['Taxes']` — NOT the raw account text),
 * so it must be the literal 'Taxes' string for a row to register as tax expense; `rawAccount` is
 * display-only realism.
 */
function insertLedgerCategory(
  db: WarehouseDb,
  propertyId: string,
  period: string,
  normalizedCategory: string,
  classification: string,
  amount: number,
  rawAccount: string = normalizedCategory,
  opts: LedgerCategoryOpts = {},
): void {
  insertProperty(db, propertyId);
  const grain = opts.grain ?? 'year';
  const basis = opts.basis ?? 'cash';
  let cache = importBatchCacheByDb.get(db);
  if (!cache) { cache = new Map(); importBatchCacheByDb.set(db, cache); }
  const cacheKey = `${propertyId}|${period}|${grain}|${basis}`;
  let importId = cache.get(cacheKey);
  if (importId === undefined) {
    const periodEnd = grain === 'ytd' ? `${period}-06-30` : `${period}-12-31`;
    importId = insertImportBatch(db, grain, periodEnd, basis);
    cache.set(cacheKey, importId);
  }
  db.prepare(`
    INSERT INTO ledger_entries (import_id, property_id, period, raw_account, gl_code, amount, normalized_category, classification, is_active)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 1)
  `).run(importId, propertyId, period, rawAccount, amount, normalizedCategory, classification);
}

function indicated(map: Record<string, IndicatedPropertyValue>): ReadonlyMap<string, IndicatedPropertyValue> {
  return new Map(Object.entries(map));
}

const P1_ASSESSMENT: AssessmentFixture = {
  propertyId: 'p1',
  taxYear: 2026,
  jurisdiction: 'Franklin County',
  assessedValue: 900_000,
  assessmentRatio: 0.35,
  millageRate: 65,
  annualTaxBilled: 45_000,
  asOf: '2026-01-15',
};
const P1_INDICATED: IndicatedPropertyValue = { fullAssetValue: 2_000_000, oxfordOwnPct: 0.5 };

// ── buildTaxAnalysis ───────────────────────────────────────────────────────────────────────────

describe('buildTaxAnalysis', () => {
  it('fires an appeal opportunity with hand-verified excess/savings math when the cohort is not computable (value-only test)', () => {
    // Confirms the fixture actually clears the module's own named overshoot threshold (2,571,428.57
    // implied vs. the indicated 2,000,000 × (1 + ADVISORY_OVERSHOOT) = 2,300,000 cutoff) rather than
    // some other unstated number.
    const impliedValue = 900_000 / 0.35;
    expect(impliedValue).toBeGreaterThan(2_000_000 * (1 + ADVISORY_OVERSHOOT));

    const db = freshDb();
    insertAssessment(db, P1_ASSESSMENT);
    const report = buildTaxAnalysis(db, '2026-07-06', indicated({ p1: P1_INDICATED }));

    expect(report.opportunities).toHaveLength(1);
    const opp = report.opportunities[0]!;
    expect(opp.kind).toBe('appeal');
    expect(opp.indeterminate).toBe(false);
    expect(opp.cohortPercentile).toBeNull(); // no ledger data at all → not computable
    expect(opp.effectiveRate).toBeCloseTo(0.05, 10);
    expect(opp.savingsFullAsset).toBeCloseTo(13_000, 6);
    expect(opp.savingsOxfordShare).toBeCloseTo(6_500, 6);
    expect(opp.advisoryOnly).toBe(true);

    expect(report.propertiesCovered).toBe(1);
    expect(report.propertiesIndeterminate).toBe(0);
    expect(report.ledgerTaxAnnualUsd).toBeNull();
    expect(report.advisoryOnly).toBe(true);
  });

  it('marks the opportunity indeterminate (assessment-watch) when the Spine-A indicated value is missing (fail-open empty map)', () => {
    const db = freshDb();
    insertAssessment(db, P1_ASSESSMENT);
    const report = buildTaxAnalysis(db, '2026-07-06', indicated({})); // empty map

    expect(report.opportunities).toHaveLength(1);
    const opp = report.opportunities[0]!;
    expect(opp.kind).toBe('assessment-watch');
    expect(opp.indeterminate).toBe(true);
    expect(opp.savingsFullAsset).toBeNull();
    expect(opp.savingsOxfordShare).toBeNull();
    expect(report.propertiesIndeterminate).toBe(1);
  });

  it('marks assessment-watch (not appeal, not a guessed value) when assessment_ratio is null', () => {
    const db = freshDb();
    insertAssessment(db, { ...P1_ASSESSMENT, assessmentRatio: null });
    const report = buildTaxAnalysis(db, '2026-07-06', indicated({ p1: P1_INDICATED }));

    expect(report.opportunities).toHaveLength(1);
    const opp = report.opportunities[0]!;
    expect(opp.kind).toBe('assessment-watch');
    expect(opp.indeterminate).toBe(true);
    expect(opp.savingsFullAsset).toBeNull(); // excessAssessment never computed without a ratio
  });

  it('surfaces nothing for a fully determinate assessment whose implied value never clears the indicated value', () => {
    const db = freshDb();
    // impliedValue = 700,000 / 0.5 = 1,400,000 < indicated 2,000,000 → no overshoot at all.
    insertAssessment(db, {
      propertyId: 'p1', taxYear: 2026, assessedValue: 700_000, assessmentRatio: 0.5,
      millageRate: 50, annualTaxBilled: 35_000,
    });
    const report = buildTaxAnalysis(db, '2026-07-06', indicated({ p1: { fullAssetValue: 2_000_000, oxfordOwnPct: 1 } }));

    expect(report.opportunities).toHaveLength(0);
    expect(report.assessments).toHaveLength(1); // still reported in the raw assessments list
    expect(report.propertiesCovered).toBe(1);
    expect(report.propertiesIndeterminate).toBe(0);
  });

  it('fires appeal when the cohort IS computable and the property clears the percentile gate (exactly at threshold)', () => {
    const db = freshDb();
    insertAssessment(db, P1_ASSESSMENT);
    // 4-property cohort at the same full-year period; p1's taxesPerSf is the cohort MAX →
    // percentile = 3/4 = 0.75 = APPEAL_PERCENTILE_THRESHOLD exactly (gate is >=, so this clears it).
    insertLedgerCategory(db, 'p1', '2025', 'Taxes', 'opex', 40_000, 'Real Estate Taxes'); // taxesPerSf = 4
    insertLedgerCategory(db, 'p2', '2025', 'Taxes', 'opex', 10_000, 'Real Estate Taxes'); // taxesPerSf = 1
    insertLedgerCategory(db, 'p3', '2025', 'Taxes', 'opex', 20_000, 'Real Estate Taxes'); // taxesPerSf = 2
    insertLedgerCategory(db, 'p4', '2025', 'Taxes', 'opex', 30_000, 'Real Estate Taxes'); // taxesPerSf = 3

    const report = buildTaxAnalysis(db, '2026-07-06', indicated({ p1: P1_INDICATED }));
    expect(report.opportunities).toHaveLength(1);
    const opp = report.opportunities[0]!;
    expect(opp.cohortPercentile).toBeCloseTo(0.75, 10);
    expect(opp.kind).toBe('appeal');
    expect(opp.savingsFullAsset).toBeCloseTo(13_000, 6);
  });

  it('downgrades to assessment-watch when the value test clears but the percentile gate does not', () => {
    const db = freshDb();
    insertAssessment(db, P1_ASSESSMENT);
    // Same 4-property cohort, but p1 is now the SECOND-lowest taxesPerSf → percentile = 1/4 = 0.25.
    insertLedgerCategory(db, 'p1', '2025', 'Taxes', 'opex', 20_000, 'Real Estate Taxes'); // taxesPerSf = 2
    insertLedgerCategory(db, 'p2', '2025', 'Taxes', 'opex', 10_000, 'Real Estate Taxes'); // taxesPerSf = 1
    insertLedgerCategory(db, 'p3', '2025', 'Taxes', 'opex', 30_000, 'Real Estate Taxes'); // taxesPerSf = 3
    insertLedgerCategory(db, 'p4', '2025', 'Taxes', 'opex', 40_000, 'Real Estate Taxes'); // taxesPerSf = 4

    const report = buildTaxAnalysis(db, '2026-07-06', indicated({ p1: P1_INDICATED }));
    expect(report.opportunities).toHaveLength(1);
    const opp = report.opportunities[0]!;
    expect(opp.cohortPercentile).toBeCloseTo(0.25, 10);
    expect(opp.kind).toBe('assessment-watch');
    expect(opp.indeterminate).toBe(false); // data was complete — it just failed the corroboration gate
    expect(opp.savingsFullAsset).toBeCloseTo(13_000, 6); // still reported for context on a watch item
  });

  it('FINDING 2 repro: excludes YTD-only peers from the cohort so a real overshoot is not silently buried as a watch item', () => {
    const db = freshDb();
    insertAssessment(db, P1_ASSESSMENT);
    // p1: full-year, taxesPerSf = 4 (40,000 / 10,000 sf).
    insertLedgerCategory(db, 'p1', '2025', 'Taxes', 'opex', 40_000, 'Real Estate Taxes');
    // p2/p3: ONLY a YTD (partial-year) record at the SAME period label '2025' — no full-year record
    // at all for either property. Their taxesPerSf (5, 6) is HIGHER than p1's, so if wrongly pooled
    // (the pre-fix bug) p1 would rank last → percentile 0/3 = 0 < 0.75 → wrongly downgraded to
    // assessment-watch, even though p1's own value overshoot genuinely clears both gates.
    insertLedgerCategory(db, 'p2', '2025', 'Taxes', 'opex', 50_000, 'Real Estate Taxes', { grain: 'ytd' });
    insertLedgerCategory(db, 'p3', '2025', 'Taxes', 'opex', 60_000, 'Real Estate Taxes', { grain: 'ytd' });

    const report = buildTaxAnalysis(db, '2026-07-06', indicated({ p1: P1_INDICATED }));
    expect(report.opportunities).toHaveLength(1);
    const opp = report.opportunities[0]!;
    // p1 is the ONLY full-year peer in its own cohort (n=1 < 2) → not computable → null.
    expect(opp.cohortPercentile).toBeNull();
    // Not computable → percentile gate skipped → value test alone governs → fires 'appeal'.
    expect(opp.kind).toBe('appeal');
    expect(opp.indeterminate).toBe(false);
    expect(opp.savingsFullAsset).toBeCloseTo(13_000, 6);
  });

  it('FINDING 2 repro: excludes a cross-basis peer from the cohort (same fixture, basis mismatch instead of grain mismatch)', () => {
    const db = freshDb();
    insertAssessment(db, P1_ASSESSMENT);
    // p1: full-year, 'cash' basis (the insertLedgerCategory default), taxesPerSf = 4.
    insertLedgerCategory(db, 'p1', '2025', 'Taxes', 'opex', 40_000, 'Real Estate Taxes');
    // p2/p3: full-year but 'accrual' basis — same grain as p1, still must be excluded (G3 discipline).
    insertLedgerCategory(db, 'p2', '2025', 'Taxes', 'opex', 50_000, 'Real Estate Taxes', { basis: 'accrual' });
    insertLedgerCategory(db, 'p3', '2025', 'Taxes', 'opex', 60_000, 'Real Estate Taxes', { basis: 'accrual' });

    const report = buildTaxAnalysis(db, '2026-07-06', indicated({ p1: P1_INDICATED }));
    expect(report.opportunities).toHaveLength(1);
    const opp = report.opportunities[0]!;
    expect(opp.cohortPercentile).toBeNull(); // cross-basis peers excluded → p1 alone → n=1 < 2
    expect(opp.kind).toBe('appeal');
    expect(opp.savingsFullAsset).toBeCloseTo(13_000, 6);
  });

  it('does not fire appeal when millage is the only missing input — falls to assessment-watch instead of a guessed-figure-free appeal (finding 5)', () => {
    const db = freshDb();
    insertAssessment(db, { ...P1_ASSESSMENT, millageRate: null });
    const report = buildTaxAnalysis(db, '2026-07-06', indicated({ p1: P1_INDICATED }));

    expect(report.opportunities).toHaveLength(1);
    const opp = report.opportunities[0]!;
    expect(opp.kind).toBe('assessment-watch');
    expect(opp.indeterminate).toBe(true);
    expect(opp.savingsFullAsset).toBeNull();
  });

  it('surfaces an indeterminate assessment-watch (never a silent drop) when the Spine-A indicated fullAssetValue is exactly 0 (finding 6)', () => {
    const db = freshDb();
    insertAssessment(db, P1_ASSESSMENT);
    const report = buildTaxAnalysis(db, '2026-07-06', indicated({ p1: { fullAssetValue: 0, oxfordOwnPct: 0.5 } }));

    expect(report.opportunities).toHaveLength(1); // NOT silently dropped
    const opp = report.opportunities[0]!;
    expect(opp.kind).toBe('assessment-watch');
    expect(opp.indeterminate).toBe(true);
    expect(opp.savingsFullAsset).toBeNull();
    expect(report.propertiesIndeterminate).toBe(1);
  });

  it('surfaces an indeterminate assessment-watch (never a silent drop) when assessment_ratio is exactly 0 (finding 6, defense-in-depth)', () => {
    // migration 020's CHECK(assessment_ratio > 0) means a ratio=0 row can never be INSERTed through
    // the normal path (and the importer's own parse validation independently rejects it too — see
    // scripts/import-assessments.ts). PRAGMA ignore_check_constraints briefly bypasses the CHECK
    // here to simulate a pre-existing/legacy row and prove the ENGINE's own defensive guard (not
    // just the importer's) treats a non-positive ratio as missing, not a silent drop.
    const db = freshDb();
    insertProperty(db, 'p1');
    db.pragma('ignore_check_constraints = ON');
    try {
      db.prepare(`
        INSERT INTO property_tax_assessments
          (property_id, tax_year, jurisdiction, assessed_value, assessment_ratio, millage_rate, annual_tax_billed, source, as_of)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('p1', 2026, 'Franklin County', 900_000, 0, 65, 45_000, 'county-portal', null);
    } finally {
      db.pragma('ignore_check_constraints = OFF');
    }

    const report = buildTaxAnalysis(db, '2026-07-06', indicated({ p1: P1_INDICATED }));
    expect(report.opportunities).toHaveLength(1); // NOT silently dropped
    const opp = report.opportunities[0]!;
    expect(opp.kind).toBe('assessment-watch');
    expect(opp.indeterminate).toBe(true);
    expect(opp.savingsFullAsset).toBeNull();
  });

  it('keeps only the latest tax_year assessment per property', () => {
    const db = freshDb();
    insertAssessment(db, { propertyId: 'p1', taxYear: 2024, assessedValue: 500_000, assessmentRatio: 0.35 });
    insertAssessment(db, P1_ASSESSMENT); // taxYear 2026
    const report = buildTaxAnalysis(db, '2026-07-06', indicated({}));

    expect(report.assessments).toHaveLength(1);
    expect(report.assessments[0]!.taxYear).toBe(2026);
    expect(report.assessments[0]!.assessedValue).toBe(900_000);
  });

  it('computes ledgerTaxAnnualUsd as the portfolio Taxes total for the latest full-year period only', () => {
    const db = freshDb();
    insertLedgerCategory(db, 'p1', '2024', 'Taxes', 'opex', 5_000, 'Real Estate Taxes');
    insertLedgerCategory(db, 'p1', '2025', 'Taxes', 'opex', 10_000, 'Real Estate Taxes');
    insertLedgerCategory(db, 'p2', '2025', 'Taxes', 'opex', 15_000, 'Real Estate Taxes');
    insertLedgerCategory(db, 'p2', '2025', 'Repairs & Maintenance', 'opex', 99_999); // not Taxes — excluded

    const report = buildTaxAnalysis(db, '2026-07-06', indicated({}));
    expect(report.ledgerTaxAnnualUsd).toBeCloseTo(25_000, 6); // 10,000 + 15,000 at 2025 only
  });

  it('returns ledgerTaxAnnualUsd null when a full-year period exists but has no Taxes category anywhere', () => {
    const db = freshDb();
    insertLedgerCategory(db, 'p1', '2025', 'Repairs & Maintenance', 'opex', 5_000);
    const report = buildTaxAnalysis(db, '2026-07-06', indicated({}));
    expect(report.ledgerTaxAnnualUsd).toBeNull();
  });

  it('includes existing appeals verbatim, ordered deterministically by property then tax_year then id', () => {
    const db = freshDb();
    insertAppeal(db, { id: 'appeal-b', propertyId: 'p2', taxYear: 2025, status: 'filed', filedDate: '2025-03-01', estSavingsAnnual: 4_000, notes: 'county hearing set' });
    insertAppeal(db, { id: 'appeal-a', propertyId: 'p1', taxYear: 2026, status: 'draft', notes: 'preparing filing' });
    const report = buildTaxAnalysis(db, '2026-07-06', indicated({}));

    expect(report.appeals).toHaveLength(2);
    expect(report.appeals.map((a) => a.propertyId)).toEqual(['p1', 'p2']);
    const filed = report.appeals.find((a) => a.id === 'appeal-b')!;
    expect(filed.status).toBe('filed');
    expect(filed.filedDate).toBe('2025-03-01');
    expect(filed.estSavingsAnnual).toBe(4_000);
    expect(filed.realizedSavingsAnnual).toBeNull();
  });
});

// ── verdictsFromTaxOpportunities + calibration logging ────────────────────────────────────────

describe('verdictsFromTaxOpportunities / calibration', () => {
  it('logs a written tax-appeal calibration verdict for a determinate appeal opportunity (written>0)', () => {
    const db = freshDb();
    insertAssessment(db, P1_ASSESSMENT);
    const report = buildTaxAnalysis(db, '2026-07-06', indicated({ p1: P1_INDICATED }));
    expect(report.opportunities[0]!.kind).toBe('appeal');

    const iv = computeInputsVersion(db);
    const verdicts = verdictsFromTaxOpportunities(report, iv, 'test-emitter');
    expect(verdicts).toHaveLength(1);
    const v = verdicts[0]!;
    expect(v.verdictKind).toBe('tax-appeal');
    expect(v.verdictEngine).toBe('tax-analysis');
    expect(v.subjectId).toBe('p1');
    // Refute finding 4: predictedValue is the Oxford-SHARE figure (6,500 = 13,000 × 0.5 ownership),
    // not the full-asset figure — contracts/tax.ts's own doctrine reserves full-asset for display.
    expect(v.predictedValue).toBeCloseTo(6_500, 6);
    expect(v.predictedUnit).toBe('usd');
    expect(v.asOfPeriod).toBe(String(P1_ASSESSMENT.taxYear));
    expect(v.confidence).toBe(0.5); // no computable cohort → neutral floor

    const result = logVerdicts(db, verdicts);
    expect(result.written).toBeGreaterThan(0);
  });

  it('derives verdict confidence from the cohort percentile when computable', () => {
    const db = freshDb();
    insertAssessment(db, P1_ASSESSMENT);
    insertLedgerCategory(db, 'p1', '2025', 'Taxes', 'opex', 40_000, 'Real Estate Taxes');
    insertLedgerCategory(db, 'p2', '2025', 'Taxes', 'opex', 10_000, 'Real Estate Taxes');
    insertLedgerCategory(db, 'p3', '2025', 'Taxes', 'opex', 20_000, 'Real Estate Taxes');
    insertLedgerCategory(db, 'p4', '2025', 'Taxes', 'opex', 30_000, 'Real Estate Taxes');
    const report = buildTaxAnalysis(db, '2026-07-06', indicated({ p1: P1_INDICATED }));

    const iv = computeInputsVersion(db);
    const verdicts = verdictsFromTaxOpportunities(report, iv, 'test-emitter');
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.confidence).toBeCloseTo(APPEAL_PERCENTILE_THRESHOLD, 10);
  });

  it('skips indeterminate opportunities when building calibration verdicts', () => {
    const db = freshDb();
    insertAssessment(db, P1_ASSESSMENT);
    const report = buildTaxAnalysis(db, '2026-07-06', indicated({})); // empty map → assessment-watch, indeterminate
    expect(report.opportunities[0]!.kind).toBe('assessment-watch');

    const iv = computeInputsVersion(db);
    const verdicts = verdictsFromTaxOpportunities(report, iv, 'test-emitter');
    expect(verdicts).toHaveLength(0);
  });

  it('finding 4: skips a determinate appeal opportunity when savingsOxfordShare is null (oxfordOwnPct missing) even though savingsFullAsset is present', () => {
    const db = freshDb();
    insertAssessment(db, P1_ASSESSMENT);
    // fullAssetValue present (so the value test + excess/savings math all resolve) but oxfordOwnPct
    // is null — indeterminate stays false (it never checked oxfordOwnPct), yet savingsOxfordShare
    // is null. The OLD guard (savingsFullAsset === null) would have missed this and logged a verdict.
    const report = buildTaxAnalysis(db, '2026-07-06', indicated({ p1: { fullAssetValue: 2_000_000, oxfordOwnPct: null } }));
    const opp = report.opportunities[0]!;
    expect(opp.kind).toBe('appeal');
    expect(opp.indeterminate).toBe(false);
    expect(opp.savingsFullAsset).toBeCloseTo(13_000, 6);
    expect(opp.savingsOxfordShare).toBeNull();

    const iv = computeInputsVersion(db);
    const verdicts = verdictsFromTaxOpportunities(report, iv, 'test-emitter');
    expect(verdicts).toHaveLength(0);
  });
});

// ── taxApi router ──────────────────────────────────────────────────────────────────────────────

function makeProperty(id: string, estValue100: number, oxfordOwnPct: number): Property {
  return {
    id, index: 1, name: id, address: id, city: null, state: null,
    market: 'Columbus OH', type: 'Flex', sf: 10000, tenantCount: 1, occPct: 1, acqDate: null,
    estValue100, oxfordOwnPct, oxfordValue: estValue100 * oxfordOwnPct,
    grossIncome: 100_000, expenses: 20_000, noi: 80_000, noiScenarioAdj: 80_000,
    debtService: 0, netCashFlow: 80_000, capRate: null, dscr: null, lender: null,
    loanBalance: 0, ltv: null, valuePerSf: null, rentPerSf: null, equityInvested: 0,
    cashOnCash: null, holdYrs: null, encumbered: false, flags: [],
  };
}

describe('taxApi router', () => {
  it('GET /analysis → 200 fail-open (empty indicated-value map) when the snapshot is unavailable', async () => {
    const { brain } = await import('../../server/brain');
    vi.mocked(brain.getSnapshot).mockReturnValue(null);
    const { taxApi } = await import('../../server/warehouse/tax-api');

    const db = freshDb();
    insertAssessment(db, P1_ASSESSMENT);
    const router = taxApi(() => db);
    const res = await router.fetch(new Request('http://localhost/analysis'));
    expect(res.status).toBe(200);
    const body = await res.json() as { propertiesIndeterminate: number; opportunities: Array<{ kind: string }> };
    expect(body.propertiesIndeterminate).toBe(1);
    expect(body.opportunities[0]!.kind).toBe('assessment-watch');
  });

  it('GET /analysis → 200 using the live Spine-A snapshot indicated values end-to-end', async () => {
    const { brain } = await import('../../server/brain');
    const snapshot = { properties: [makeProperty('p1', 2_000_000, 0.5)] } as unknown as PortfolioSnapshot;
    vi.mocked(brain.getSnapshot).mockReturnValue(snapshot);
    const { taxApi } = await import('../../server/warehouse/tax-api');

    const db = freshDb();
    insertAssessment(db, P1_ASSESSMENT);
    const router = taxApi(() => db);
    const res = await router.fetch(new Request('http://localhost/analysis'));
    expect(res.status).toBe(200);
    const body = await res.json() as { opportunities: Array<{ kind: string; savingsFullAsset: number; savingsOxfordShare: number }> };
    expect(body.opportunities).toHaveLength(1);
    expect(body.opportunities[0]!.kind).toBe('appeal');
    expect(body.opportunities[0]!.savingsFullAsset).toBeCloseTo(13_000, 6);
    expect(body.opportunities[0]!.savingsOxfordShare).toBeCloseTo(6_500, 6);
  });

  it('GET /analysis → 503 when the warehouse is unavailable', async () => {
    const { taxApi } = await import('../../server/warehouse/tax-api');
    const router = taxApi(() => { throw new Error('no warehouse'); });
    const res = await router.fetch(new Request('http://localhost/analysis'));
    expect(res.status).toBe(503);
  });

  it('POST /appeals creates then updates the same appeal (round-trip)', async () => {
    const { taxApi } = await import('../../server/warehouse/tax-api');
    const db = freshDb();
    insertProperty(db, 'p1');
    const router = taxApi(() => db);

    const createRes = await router.fetch(new Request('http://localhost/appeals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ propertyId: 'p1', taxYear: 2026, status: 'draft', notes: 'initial filing prep' }),
    }));
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { id: string; status: string };
    expect(typeof created.id).toBe('string');
    expect(created.status).toBe('draft');

    const updateRes = await router.fetch(new Request('http://localhost/appeals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: created.id, propertyId: 'p1', taxYear: 2026, status: 'filed',
        filedDate: '2026-07-01', estSavingsAnnual: 13_000, notes: 'filed with county',
      }),
    }));
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json() as { id: string; status: string; filedDate: string | null; estSavingsAnnual: number | null };
    expect(updated.id).toBe(created.id);
    expect(updated.status).toBe('filed');
    expect(updated.filedDate).toBe('2026-07-01');
    expect(updated.estSavingsAnnual).toBe(13_000);
  });

  it('POST /appeals → 400 on an invalid body', async () => {
    const { taxApi } = await import('../../server/warehouse/tax-api');
    const db = freshDb();
    const router = taxApi(() => db);
    const res = await router.fetch(new Request('http://localhost/appeals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taxYear: 2026 }), // missing propertyId
    }));
    expect(res.status).toBe(400);
  });

  it('POST /appeals → 404 when updating a nonexistent id', async () => {
    const { taxApi } = await import('../../server/warehouse/tax-api');
    const db = freshDb();
    insertProperty(db, 'p1');
    const router = taxApi(() => db);
    const res = await router.fetch(new Request('http://localhost/appeals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'does-not-exist', propertyId: 'p1', taxYear: 2026, status: 'draft' }),
    }));
    expect(res.status).toBe(404);
  });
});
