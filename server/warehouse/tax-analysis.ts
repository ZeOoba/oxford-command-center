// server/warehouse/tax-analysis.ts
//
// Phase 6 — Property Tax Analysis engine (6a.3). Reads property_tax_assessments (migration 020)
// + tax_appeals + the ledger, and surfaces advisory-only appeal/watch opportunities. Never a
// governor: `advisoryOnly: true` on every opportunity AND the report envelope.
//
// BASIS DOCTRINE (contracts/tax.ts header): assessments, millage, and the ledger 'Taxes' category
// are FULL-ASSET — a county assessor taxes the whole building, not Oxford's fractional share.
// Spine-A property economics (Property.estValue100 / oxfordOwnPct) are Oxford-share-adjacent but
// estValue100 itself is documented full-asset (100% basis) — so it is the correct anchor for the
// assessment-vs-market comparison here. This module NEVER re-derives a property's value; the
// caller (the route) supplies `indicatedValues` from the live Spine-A snapshot. An empty/missing
// map entry makes every value-dependent figure `indeterminate`, never a guessed dollar amount —
// the doctrine the contract file states explicitly.
import type { WarehouseDb } from './db';
import { isOperatingRealEstate, propertyPeriodMetrics } from './metrics';
import type { PeriodMetrics } from './metrics';
import { clamp } from './clamp';
import {
  TaxAnalysisReport, TaxAssessment, TaxAppeal, TaxOpportunity,
  type TaxAnalysisReport as TaxAnalysisReportT,
  type TaxAssessment as TaxAssessmentT,
  type TaxAppeal as TaxAppealT,
  type TaxOpportunity as TaxOpportunityT,
  type TaxOpportunityKind,
} from '../../src/contracts/tax';
import {
  CalibrationVerdictSchema,
  type CalibrationVerdict,
  type InputsVersion,
} from '../../src/contracts/warehouse';

/** Advisory overshoot threshold (6a.3 spec): an 'appeal' opportunity requires the assessment's
 *  implied market value to exceed the Spine-A indicated full-asset value by more than this
 *  fraction. Advisory only — this is a proposed analysis cutoff, never a governor. */
export const ADVISORY_OVERSHOOT = 0.15;

/** Cohort gate for an 'appeal' opportunity: the property's taxesPerSf must sit at/above this
 *  percentile of its same-period operating-real-estate cohort (a top-quartile tax burden is
 *  corroborating evidence the assessment itself, not just the property's own economics, is out of
 *  line). Applied ONLY when the cohort is computable — see `taxesPerSfCohortPercentile`. */
export const APPEAL_PERCENTILE_THRESHOLD = 0.75;

const TAXES_CATEGORY = 'Taxes';

/** Per-property Spine-A anchor the route supplies. `fullAssetValue` MUST be full-asset (100%-basis)
 *  — Property.estValue100, never Property.oxfordValue. Either field null (or the property absent
 *  from the map entirely) makes the corresponding downstream figure indeterminate, never guessed. */
export interface IndicatedPropertyValue {
  fullAssetValue: number | null;
  oxfordOwnPct: number | null;
}

interface AssessmentRow {
  property_id: string;
  tax_year: number;
  jurisdiction: string | null;
  assessed_value: number | null;
  assessment_ratio: number | null;
  millage_rate: number | null;
  annual_tax_billed: number | null;
  source: string;
  as_of: string | null;
}

interface AppealRow {
  id: string;
  property_id: string;
  tax_year: number;
  status: string;
  filed_date: string | null;
  est_savings_annual: number | null;
  realized_savings_annual: number | null;
  notes: string | null;
}

interface PropertyNameRow {
  id: string;
  name: string;
}

/** The latest (MAX tax_year) assessment row per property — one row per property. */
function latestAssessments(db: WarehouseDb): AssessmentRow[] {
  return db.prepare(`
    SELECT t.property_id, t.tax_year, t.jurisdiction, t.assessed_value, t.assessment_ratio,
           t.millage_rate, t.annual_tax_billed, t.source, t.as_of
    FROM property_tax_assessments t
    INNER JOIN (
      SELECT property_id, MAX(tax_year) AS max_year
      FROM property_tax_assessments
      GROUP BY property_id
    ) latest ON latest.property_id = t.property_id AND latest.max_year = t.tax_year
    ORDER BY t.property_id
  `).all() as AssessmentRow[];
}

/** Every appeal row — appeals have their own lifecycle independent of the assessment table
 *  (migration 020 header comment), so this is NOT filtered to the latest tax_year. */
function allAppeals(db: WarehouseDb): AppealRow[] {
  return db.prepare(`
    SELECT id, property_id, tax_year, status, filed_date, est_savings_annual,
           realized_savings_annual, notes
    FROM tax_appeals
    ORDER BY property_id, tax_year, id
  `).all() as AppealRow[];
}

function propertyNames(db: WarehouseDb): Map<string, string> {
  const rows = db.prepare(`SELECT id, name FROM property_master`).all() as PropertyNameRow[];
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * Portfolio 'Taxes' ledger total for the latest FULL-YEAR period across the whole warehouse
 * (full-asset basis — same categories bucket metrics.ts builds for every opex classification).
 * Null when there is no full-year period at all, or that period has no 'Taxes' classification
 * row anywhere in the portfolio — never a guessed $0.
 */
function ledgerTaxAnnual(metrics: PeriodMetrics[]): number | null {
  const fullYearPeriods = [...new Set(metrics.filter((m) => m.grainHint === 'year').map((m) => m.period))].sort();
  const latestYear = fullYearPeriods[fullYearPeriods.length - 1];
  if (latestYear === undefined) return null;

  let sum = 0;
  let found = false;
  for (const m of metrics) {
    if (m.period !== latestYear || m.grainHint !== 'year') continue;
    const taxes = m.categories[TAXES_CATEGORY];
    if (typeof taxes === 'number') {
      sum += taxes;
      found = true;
    }
  }
  return found ? sum : null;
}

/**
 * Fraction of the same-period, same-grain, same-basis operating-real-estate cohort whose
 * taxesPerSf is strictly below this property's own value (0..1) — mirrors scores.ts's
 * percentileRank convention. Evaluated at the property's own latest full-year period. Null (not
 * computable) when the property has no full-year metrics, or the same-period cohort (including
 * itself) has fewer than 2 finite members — a singleton "cohort" would trivially self-rank to 1.0
 * and is not a real corroborating signal (mirrors the benchmarks.ts / scores.ts small-cohort
 * guards).
 *
 * Cohort filters (refute finding 2 — two independent lenses converged on this): a peer must ALSO
 * be grainHint==='year' — a same-period YTD/partial-year peer has an understated taxesPerSf that
 * can drag the percentile either direction (burying a legitimate appeal under a false low
 * percentile, or firing one a clean cohort wouldn't support) — AND must share the subject's own
 * `basis` (mirrors scores.ts's G3 cross-basis discipline: cash/accrual/tax cost ratios are not
 * like-for-like). An 'unknown' subject basis (period-header parse miss) pools with NOTHING, not
 * even other 'unknown' rows — identical to scores.ts's sameBasis partition.
 */
function taxesPerSfCohortPercentile(metrics: PeriodMetrics[], propertyId: string): number | null {
  const ownFullYear = metrics
    .filter((m) => m.propertyId === propertyId && m.grainHint === 'year')
    .sort((a, b) => a.period.localeCompare(b.period));
  const subject = ownFullYear[ownFullYear.length - 1];
  if (subject === undefined) return null;
  const period = subject.period;
  const subjectBasis = subject.basis;

  const cohortValues: number[] = [];
  let mine: number | null = null;
  for (const m of metrics) {
    if (m.period !== period) continue;
    if (m.grainHint !== 'year') continue; // exclude YTD/partial-year peers — see doc comment
    if (subjectBasis === 'unknown') {
      if (m.propertyId !== propertyId) continue; // 'unknown' never pools, even with other 'unknown' rows
    } else if (m.basis !== subjectBasis) {
      continue; // cross-basis peer — excluded (G3 discipline)
    }
    if (!isOperatingRealEstate(m)) continue;
    if (typeof m.taxesPerSf !== 'number' || !Number.isFinite(m.taxesPerSf)) continue;
    cohortValues.push(m.taxesPerSf);
    if (m.propertyId === propertyId) mine = m.taxesPerSf;
  }
  if (mine === null || cohortValues.length < 2) return null;
  const mineValue: number = mine;
  const below = cohortValues.filter((v) => v < mineValue).length;
  return below / cohortValues.length;
}

const fmtUsd = (n: number | null): string => (n === null ? 'unknown' : `$${Math.round(n).toLocaleString('en-US')}`);
const fmtPct = (n: number): string => `${(n * 100).toFixed(0)}%`;

/** Build one property's opportunity (or null when nothing is worth surfacing — a fully
 *  determinate assessment whose implied value does not exceed the indicated value is quiet). */
function buildOpportunity(
  a: AssessmentRow,
  indicated: IndicatedPropertyValue | undefined,
  propertyName: string | undefined,
  cohortPercentile: number | null,
): TaxOpportunityT | null {
  const fullAssetValue = indicated?.fullAssetValue ?? null;
  const oxfordOwnPct = indicated?.oxfordOwnPct ?? null;

  const effectiveRate =
    a.annual_tax_billed !== null && a.assessed_value !== null && a.assessed_value > 0
      ? a.annual_tax_billed / a.assessed_value
      : null;

  // Market-implied value from the assessment (Ohio-style ratio): assessed_value ÷ assessment_ratio.
  // Null when either input is missing — never inferred.
  const impliedValue =
    a.assessed_value !== null && a.assessment_ratio !== null && a.assessment_ratio > 0
      ? a.assessed_value / a.assessment_ratio
      : null;

  // A required value-dependent input is missing OR degenerate — every downstream $ figure that
  // depends on it must be indeterminate, never a guessed number (contracts/tax.ts doctrine).
  // Refute finding 6: a non-positive assessment_ratio or fullAssetValue passes the `=== null`
  // check yet fails the `> 0` guards impliedValue/overThreshold use below — without this, the
  // property silently vanished from opportunities entirely (no appeal, no watch, not counted
  // indeterminate) instead of surfacing as an honest indeterminate watch item.
  const missingValueInputs =
    a.assessed_value === null
    || a.assessment_ratio === null || a.assessment_ratio <= 0
    || a.millage_rate === null
    || fullAssetValue === null || fullAssetValue <= 0;

  // Finding 6 (continued): the >0 guards mirror missingValueInputs above exactly — a degenerate
  // ratio=0 or fullAssetValue<=0 must not anchor a computed excess/savings figure (that would be a
  // guess off a degenerate zero, not a real number), even though `indeterminate` already flags the
  // opportunity as a watch item.
  let excessAssessment: number | null = null;
  if (
    a.assessed_value !== null
    && a.assessment_ratio !== null && a.assessment_ratio > 0
    && fullAssetValue !== null && fullAssetValue > 0
  ) {
    excessAssessment = Math.max(0, a.assessed_value - fullAssetValue * a.assessment_ratio);
  }

  let savingsFullAsset: number | null = null;
  if (excessAssessment !== null && a.millage_rate !== null) {
    savingsFullAsset = (excessAssessment * a.millage_rate) / 1000;
  }

  const savingsOxfordShare =
    savingsFullAsset !== null && oxfordOwnPct !== null ? savingsFullAsset * oxfordOwnPct : null;

  const overshoot =
    impliedValue !== null && fullAssetValue !== null && fullAssetValue > 0 && impliedValue > fullAssetValue;
  const overThreshold =
    impliedValue !== null
    && fullAssetValue !== null
    && fullAssetValue > 0
    && impliedValue > fullAssetValue * (1 + ADVISORY_OVERSHOOT);

  // The percentile gate only applies when the cohort is computable; when it is not, the value
  // test alone governs (6a.3 spec) — a missing cohort must never SUPPRESS a genuine overshoot.
  // A null cohort here can mean genuinely no peer data, OR peers that exist but were excluded by
  // the grain/basis restriction (finding 2) — both are treated identically (gate auto-satisfied)
  // by design; this is the documented doctrine working as intended, not a gap, and every
  // opportunity carries advisoryOnly:true (human-reviewed, nothing auto-executes on it).
  const percentileGateSatisfied = cohortPercentile === null || cohortPercentile >= APPEAL_PERCENTILE_THRESHOLD;

  const indeterminate = missingValueInputs;

  let kind: TaxOpportunityKind | null = null;
  // Refute finding 5: 'appeal' additionally requires !indeterminate — overThreshold only checks
  // assessed_value/ratio/fullAssetValue, not millage, so a millage-null row could otherwise clear
  // the value+percentile gates with a null savingsFullAsset — a guessed-figure-free 'appeal' label
  // contradicts the doctrine (calibration already skips logging it, but the UI-facing kind was wrong).
  if (overThreshold && percentileGateSatisfied && !indeterminate) {
    kind = 'appeal';
  } else if (overshoot || indeterminate) {
    // Either a genuine (but sub-threshold, or threshold-cleared-yet-percentile-failed) overshoot,
    // or data too incomplete to reach a determination — both are honest "keep watching" states.
    kind = 'assessment-watch';
  }
  if (kind === null) return null;

  const missingParts: string[] = [];
  if (a.assessed_value === null) missingParts.push('assessed value');
  if (a.assessment_ratio === null) missingParts.push('assessment ratio');
  if (a.millage_rate === null) missingParts.push('millage rate');
  if (fullAssetValue === null) missingParts.push('workbook-basis indicated value');
  const missingNote =
    missingParts.length > 0
      ? ` Missing: ${missingParts.join(', ')} — the affected $ figures are indeterminate, not guessed.`
      : '';
  const percentileNote =
    cohortPercentile === null
      ? ' Cohort taxesPerSf percentile not computable (insufficient same-period peer data) — value test only.'
      : ` Cohort taxesPerSf percentile: ${fmtPct(cohortPercentile)}.`;

  const detail =
    kind === 'appeal'
      ? `Implied value ${fmtUsd(impliedValue)} exceeds the indicated full-asset value ${fmtUsd(fullAssetValue)} by more than ${fmtPct(ADVISORY_OVERSHOOT)}.${percentileNote}${missingNote}`
      : overshoot
        ? `Implied value ${fmtUsd(impliedValue)} is above the indicated full-asset value ${fmtUsd(fullAssetValue)} but ${overThreshold ? 'the cohort percentile gate was not met' : `under the ${fmtPct(ADVISORY_OVERSHOOT)} advisory threshold`}.${percentileNote}${missingNote}`
        : `Assessment data incomplete for a value determination.${missingNote}`;

  const basisNote =
    oxfordOwnPct !== null
      ? `Full-asset assessment basis (assessed value ÷ assessment ratio vs. workbook 100%-basis indicated value); Oxford share = full-asset savings × ${fmtPct(oxfordOwnPct)} ownership.`
      : 'Full-asset assessment basis (assessed value ÷ assessment ratio vs. workbook 100%-basis indicated value); Oxford ownership % unavailable — Oxford-share savings indeterminate.';

  return TaxOpportunity.parse({
    propertyId: a.property_id,
    propertyName: propertyName ?? null,
    kind,
    title: kind === 'appeal' ? 'Tax appeal opportunity' : 'Assessment watch',
    detail,
    savingsFullAsset,
    savingsOxfordShare,
    basisNote,
    effectiveRate,
    cohortPercentile,
    indeterminate,
    prov: {
      source: `property_tax_assessments (property ${a.property_id}, tax_year ${a.tax_year})`,
      confidence: indeterminate ? 'estimated' : 'derived',
      ...(a.as_of ? { asOf: a.as_of } : {}),
      formula: 'excessAssessment = max(0, assessedValue − fullAssetValue×assessmentRatio); savingsFullAsset = excessAssessment×millageRate/1000; savingsOxfordShare = savingsFullAsset×oxfordOwnPct',
    },
    advisoryOnly: true,
  });
}

/**
 * Build the full tax analysis report (6a.3/6a.4). Pure given `db` + `indicatedValues` — the only
 * I/O is reading property_tax_assessments / tax_appeals / property_master / the ledger; every
 * value-dependent figure is a deterministic function of those reads plus the caller-supplied map.
 */
export function buildTaxAnalysis(
  db: WarehouseDb,
  asOf: string,
  indicatedValues: ReadonlyMap<string, IndicatedPropertyValue>,
): TaxAnalysisReportT {
  const assessmentRows = latestAssessments(db);
  const appealRows = allAppeals(db);
  const names = propertyNames(db);
  const metrics = propertyPeriodMetrics(db);

  const assessments: TaxAssessmentT[] = assessmentRows.map((a) =>
    TaxAssessment.parse({
      propertyId: a.property_id,
      taxYear: a.tax_year,
      jurisdiction: a.jurisdiction,
      assessedValue: a.assessed_value,
      assessmentRatio: a.assessment_ratio,
      millageRate: a.millage_rate,
      annualTaxBilled: a.annual_tax_billed,
      source: a.source,
      asOf: a.as_of,
    }),
  );

  const appeals: TaxAppealT[] = appealRows.map((r) =>
    TaxAppeal.parse({
      id: r.id,
      propertyId: r.property_id,
      taxYear: r.tax_year,
      status: r.status,
      filedDate: r.filed_date,
      estSavingsAnnual: r.est_savings_annual,
      realizedSavingsAnnual: r.realized_savings_annual,
      notes: r.notes,
    }),
  );

  const opportunities: TaxOpportunityT[] = [];
  for (const a of assessmentRows) {
    const indicated = indicatedValues.get(a.property_id);
    const cohortPercentile = taxesPerSfCohortPercentile(metrics, a.property_id);
    const opp = buildOpportunity(a, indicated, names.get(a.property_id), cohortPercentile);
    if (opp !== null) opportunities.push(opp);
  }
  opportunities.sort((x, y) => x.propertyId.localeCompare(y.propertyId));

  const report: TaxAnalysisReportT = {
    asOf,
    propertiesCovered: assessmentRows.length,
    propertiesIndeterminate: opportunities.filter((o) => o.indeterminate).length,
    ledgerTaxAnnualUsd: ledgerTaxAnnual(metrics),
    opportunities,
    assessments,
    appeals,
    advisoryOnly: true,
  };
  return TaxAnalysisReport.parse(report);
}

/**
 * Map each 'appeal'-kind, DETERMINATE opportunity → one CalibrationVerdict row (verdict_kind
 * 'tax-appeal', verdict_engine 'tax-analysis'). Skips indeterminate opportunities and any
 * opportunity whose savingsOxfordShare is null — a null value carries nothing to log (mirrors
 * "skip indeterminate ones" in the 6a.3 spec). No auto-resolution arm exists yet (calibration.ts
 * scoreVerdict's default case returns null for this kind) — these are resolved manually via the
 * existing ResolveDialog.
 *
 * Refute finding 4: predictedValue is the OXFORD-SHARE figure (savingsOxfordShare), not the
 * full-asset one — contracts/tax.ts's own header doctrine states every cross-module ranked/tracked
 * surface uses the Oxford-share number; the full-asset figure is display-only. The null-guard is on
 * savingsOxfordShare directly (not just the indeterminate flag) since oxfordOwnPct can be absent
 * even when the full-asset figures are complete, which savingsOxfordShare's own null already
 * captures precisely.
 */
export function verdictsFromTaxOpportunities(
  report: Pick<TaxAnalysisReportT, 'opportunities' | 'assessments'>,
  iv: InputsVersion,
  emittedBy: string,
): CalibrationVerdict[] {
  const taxYearByProperty = new Map(report.assessments.map((a) => [a.propertyId, a.taxYear]));
  const out: CalibrationVerdict[] = [];
  for (const o of report.opportunities) {
    if (o.kind !== 'appeal' || o.indeterminate || o.savingsOxfordShare === null) continue;
    const taxYear = taxYearByProperty.get(o.propertyId);
    if (taxYear === undefined) continue; // defensive — every opportunity is built from an assessment row
    out.push(
      CalibrationVerdictSchema.parse({
        subjectKind: 'property',
        subjectId: o.propertyId,
        verdictKind: 'tax-appeal',
        verdictSubkind: '',
        verdictEngine: 'tax-analysis',
        predictedBand: null,
        predictedValue: o.savingsOxfordShare,
        predictedUnit: 'usd',
        // Cohort percentile doubles as the confidence proxy when available (a higher tax-burden
        // percentile is stronger corroborating evidence for the appeal); otherwise a neutral floor
        // (mirrors calibration.ts's [0.5, 0.95] confidence-proxy convention).
        confidence: o.cohortPercentile !== null ? clamp(o.cohortPercentile, 0.5, 0.95) : 0.5,
        direction: 'down', // predicts a reduction in the property's tax bill
        reasons: [o.detail],
        asOfPeriod: String(taxYear),
        horizonPeriods: 1,
        inputsVersion: iv.inputsVersion,
        emittedBy,
      }),
    );
  }
  return out;
}
