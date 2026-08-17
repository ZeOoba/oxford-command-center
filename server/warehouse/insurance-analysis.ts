// server/warehouse/insurance-analysis.ts
//
// Insurance reasoning layer (Phase 4a.3) — own-book dispersion, never a market/savings claim.
// Reads property_insurance_policies (migration 008 + 022's additive deductible/coverage_limit
// columns — neither is part of this contract's output; loss-run history (insurance_loss_events,
// migration 022) is likewise out of scope until a future phase gives it a contract field).
//
// DOCTRINE (mirrors src/contracts/insurance-analysis.ts header — repeat it here because it is the
// one rule a future edit to this file must never violate): the benchmark is an OWN-BOOK median,
// never a market rate. `excessPremiumVsMedian` is dispersion, NOT a savings promise — no haircut
// factors, no invented capture rates. Null-TIV policies are excluded from rate math but still
// listed so the register stays complete.
//
// COHORT CLASSIFIER (order matters — tiv is checked BEFORE policy_type):
//   1. tiv null or <= 0        → 'excluded-null-tiv' (regardless of policy_type — a policy with no
//                                 usable TIV can never produce a rate, so it is pulled out of rate
//                                 math first; this is what keeps a property-package policy with a
//                                 data-entry gap from silently forcing a shaky median/excess=0).
//   2. policy_type contains 'property' | 'package' | 'building' (case-insensitive) → 'property-package'.
//   3. otherwise                → 'other'.
//
// CALIBRATION: logRebidVerdicts() seeds a SYNTHETIC calibration_inputs_version row (mirrors
// acq-engine.ts persistAndLogScore — insurance policies are not ledger-derived, so the
// ledger-fingerprint hash calibration.ts's computeInputsVersion(db) computes is the wrong content
// to hash here; a digest of the current policy book is the right one) before calling the existing
// logVerdicts() (fail-open).
import { createHash } from 'node:crypto';
import type { WarehouseDb } from './db';
import {
  InsuranceAnalysisReport,
  type PolicyEconomics,
  type BookBenchmark,
  type InsuranceCohort,
  type RenewalBucket,
} from '../../src/contracts/insurance-analysis';
import { CalibrationVerdictSchema, type CalibrationVerdict } from '../../src/contracts/warehouse';
import { logVerdicts, type LogVerdictsResult } from './calibration';

// ── named thresholds (no bare literals in comparisons) ────────────────────────────────────────
const MIN_COHORT_N = 5;
const RENEWAL_NOW_DAYS = 45;
const RENEWAL_SOON_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const EXCESS_BAND_HIGH_USD = 10_000;
const EXCESS_BAND_MID_USD = 2_000;
/** The rebid verdict's evaluation horizon — one renewal cycle (annual), same convention as the
 *  scores engine's health-band/attention/capital-action verdicts (calibration.ts horizonPeriods=1). */
const INSURANCE_REBID_HORIZON_PERIODS = 1;
/** 'derived' confidence tier — mirrors acq-engine.ts's confirmed/estimated/derived → 1.0/0.75/0.5
 *  numeric mapping (CalibrationVerdictSchema.confidence is a 0..1 proxy, not that string enum).
 *  An own-book dispersion figure is never a confirmed/measured market comparison, so it is always
 *  recorded at the weakest tier — never inflated. */
const DERIVED_CONFIDENCE = 0.5;

function sha16(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/** Engine code version — mirrors calibration.ts's (unexported) codeVersion(). */
function codeVersion(): string {
  return process.env.ORA_CODE_VERSION ?? process.env.GIT_SHA ?? 'dev';
}

// ── raw row shape ──────────────────────────────────────────────────────────────────────────────

interface RawPolicyRow {
  id: number;
  property_id: string;
  property_name: string | null;
  insurer: string;
  policy_number: string | null;
  effective_date: string | null;
  expiration_date: string | null;
  premium_annual: number | null;
  coverage_tiv: number | null;
  policy_type: string;
  source_date: string;
}

/**
 * Reduce to the latest source_date per (property_id, policy_number, effective_date). The table's
 * own UNIQUE constraint + INSERT OR REPLACE already enforces this for the non-null-key case, but
 * SQLite treats each NULL as distinct in a UNIQUE index, so a NULL policy_number or effective_date
 * can leave several "duplicate" rows for the same logical policy — this is the defensive backstop.
 * Ties (identical source_date) break on the higher row id (the more recently inserted row).
 *
 * NULL-KEY GUARD (refute F2, corrected): a row with BOTH policy_number AND effective_date NULL
 * carries no identifying key at all. The writer's INSERT OR REPLACE (insurance.ts captureInsurance)
 * does NOT dedupe these — SQLite treats each NULL as distinct in the UNIQUE index, so a null-keyed
 * policy re-persisted on every brain 'snapshot' event (i.e. every workbook refresh) INSERTS A NEW
 * PHYSICAL ROW every time rather than replacing. (An earlier version of this function keyed these
 * rows on their own row id, which stopped two genuinely distinct null-keyed policies from
 * colliding but — because it treated every re-ingested copy as a new "distinct" row too — let
 * those accumulating duplicates through uncollapsed: policiesN/premiumAnnualTotal/the cohort
 * median all drift upward on every refresh. That is the wrong tradeoff.)
 *
 * The fix: key a null-keyed row on its remaining CONTENT (insurer, premium, tiv, policy_type,
 * expiration_date) rather than on identity (policy_number/effective_date, both null) or on
 * physical row id. A re-ingest of the SAME logical policy reproduces identical content on every
 * refresh, so repeat copies collapse to one (latest source_date, then higher id) exactly like the
 * identified case above. Two REAL distinct null-keyed policies differ in at least one content
 * field (premium, TIV, type, or expiry — see the F2 regression test) and so still key apart and
 * both survive. Residual risk: two distinct policies that coincidentally share ALL of those fields
 * would still collapse; there is no stronger identity available on this row shape.
 */
function dedupeLatest(rows: RawPolicyRow[]): RawPolicyRow[] {
  const byKey = new Map<string, RawPolicyRow>();
  for (const r of rows) {
    // Fully-null keys dedupe on content; identified keys dedupe on identity. The literal
    // 'null-key' segment keeps the two shapes from ever colliding with each other.
    const key =
      r.policy_number === null && r.effective_date === null
        ? `${r.property_id}|null-key|${r.insurer}|${r.premium_annual ?? ''}|${r.coverage_tiv ?? ''}|${r.policy_type}|${r.expiration_date ?? ''}`
        : `${r.property_id}|${r.policy_number ?? ''}|${r.effective_date ?? ''}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, r);
      continue;
    }
    const isBetter =
      r.source_date > existing.source_date ||
      (r.source_date === existing.source_date && r.id > existing.id);
    if (isBetter) byKey.set(key, r);
  }
  return [...byKey.values()];
}

/**
 * Collapse to one row per (property_id, policy_type) — the CURRENT term. A genuine policy
 * rollover changes effective_date (and often policy_number too — e.g. a carrier's suffix bump
 * REDACTED-600 -> REDACTED-477), so it is a NEW row under the table's
 * UNIQUE(property_id, policy_number, effective_date) key: dedupeLatest's identity key treats it
 * as a distinct policy, not a replacement, so the prior term is never removed from the table (no
 * delete path exists — see insurance.ts captureInsurance's INSERT OR REPLACE). Confirmed live
 * 2026-08-17: stale prior-term rows accumulated in renewalCalendar (policiesN 34 vs the correct
 * 26; a property's card showed last year's premium/days-to-expiry instead of the rolled term).
 *
 * This is the "current view" reduction only — it keeps every other row's data intact in the
 * table (no UI or feature currently reads multi-term history from this table; grep confirmed
 * before choosing this over a delete-on-capture approach), so a future premium-history feature
 * can still read the full table directly rather than through buildInsuranceAnalysis.
 *
 * Grouped by policy_type (not a stable per-row id — the table doesn't persist one; see module
 * header) so two genuinely distinct concurrent coverages on the same property (e.g. Property vs.
 * General Liability) never collide. Latest wins by effective_date, then the same source_date/id
 * tiebreak as dedupeLatest.
 *
 * NULL-DATED ROWS ARE NEVER COLLAPSED BY THIS STEP (left for dedupeLatest's own null-key content
 * dedup to arbitrate): a rollover always carries a real effective_date on both the old and new
 * term, so grouping on it is only meaningful for dated rows. Two undated rows sharing a
 * property_id/policy_type have no ordering signal — collapsing them here would silently drop a
 * genuinely distinct concurrent policy that dedupeLatest's own F2 doctrine deliberately keeps
 * apart (see dedupeLatest's null-key content key, which folds policy_type in for exactly this).
 */
type DatedPolicyRow = RawPolicyRow & { effective_date: string };
const hasEffectiveDate = (r: RawPolicyRow): r is DatedPolicyRow => r.effective_date !== null;

function collapseToCurrentTerm(rows: RawPolicyRow[]): RawPolicyRow[] {
  const undated: RawPolicyRow[] = [];
  const byKey = new Map<string, DatedPolicyRow>();
  for (const r of rows) {
    if (!hasEffectiveDate(r)) {
      undated.push(r);
      continue;
    }
    const key = `${r.property_id}|${r.policy_type}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, r);
      continue;
    }
    const isNewer =
      r.effective_date > existing.effective_date ||
      (r.effective_date === existing.effective_date &&
        (r.source_date > existing.source_date ||
          (r.source_date === existing.source_date && r.id > existing.id)));
    if (isNewer) byKey.set(key, r);
  }
  return [...byKey.values(), ...undated];
}

/** Cohort classifier — see module header for the documented precedence.
 *
 * KEYWORD ALLOWLIST IS DELIBERATELY NARROW (refute F1-MEDIUM): 'property'/'package'/'building' is
 * not a guess at Oxford's real policy_type vocabulary — the project doctrine (CLAUDE.md "never
 * invent") bars expanding it without real data to check against. A genuine property policy labeled
 * something else common in the industry ('All-Risk', 'Blanket', 'Special Form', ...) lands in
 * 'other' and is silently excluded from the rebid worklist. Rather than guess more keywords, the
 * caller (buildInsuranceAnalysis) flags this gap via a data_quality_issues row whenever a policy
 * has a valid TIV + computable rate but still lands here — visibility instead of a guess. */
function classifyCohort(policyType: string, tiv: number | null): InsuranceCohort {
  if (tiv === null || tiv <= 0) return 'excluded-null-tiv';
  const t = policyType.toLowerCase();
  if (t.includes('property') || t.includes('package') || t.includes('building')) return 'property-package';
  return 'other';
}

/** premium per $100 of TIV; null when tiv is null/<=0 or premium<=0 (never a false-precision rate). */
function computeRatePer100Tiv(premium: number, tiv: number | null): number | null {
  if (tiv === null || tiv <= 0) return null;
  if (premium <= 0) return null;
  return (premium / tiv) * 100;
}

/** Days-to-expiry + renewal bucket vs asOf. Null expiration_date → 'unknown' (no days value). */
function computeRenewal(
  expirationDate: string | null,
  asOf: string,
): { bucket: RenewalBucket; daysToExpiry: number | null } {
  if (expirationDate === null) return { bucket: 'unknown', daysToExpiry: null };
  const exp = Date.parse(expirationDate);
  const ref = Date.parse(asOf);
  if (Number.isNaN(exp) || Number.isNaN(ref)) return { bucket: 'unknown', daysToExpiry: null };
  const daysToExpiry = Math.round((exp - ref) / MS_PER_DAY);
  if (daysToExpiry < 0) return { bucket: 'expired', daysToExpiry };
  if (daysToExpiry <= RENEWAL_NOW_DAYS) return { bucket: 'now-45', daysToExpiry };
  if (daysToExpiry <= RENEWAL_SOON_DAYS) return { bucket: 'soon-90', daysToExpiry };
  return { bucket: 'later', daysToExpiry };
}

/** Median of a non-empty numeric array; null on empty (caller gates this via `sufficient`). */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  if (lo === undefined || hi === undefined) return null;
  return (lo + hi) / 2;
}

interface Draft {
  policyId: string;
  property: string;
  propertyId: string | null;
  carrier: string | null;
  policyType: string | null;
  premium: number;
  tiv: number | null;
  ratePer100Tiv: number | null;
  cohort: InsuranceCohort;
  renewalBucket: RenewalBucket;
  daysToExpiry: number | null;
}

function hasRate(d: Draft): d is Draft & { ratePer100Tiv: number } {
  return d.cohort === 'property-package' && d.ratePer100Tiv !== null;
}

function hasExcess(p: PolicyEconomics): p is PolicyEconomics & { excessPremiumVsMedian: number } {
  return p.excessPremiumVsMedian !== null && p.excessPremiumVsMedian > 0;
}

// ── the engine ────────────────────────────────────────────────────────────────────────────────

/**
 * Build the insurance analysis report as of `asOf` ('YYYY-MM-DD'). Read-mostly: the one side
 * effect is a fail-open, best-effort data_quality_issues flag (kind 'insurance-cohort-unclassified')
 * for a policy with a valid TIV + computable rate that the cohort classifier still could not place
 * (see classifyCohort's module doc — refute F1-MEDIUM). Never throws on that write failing.
 * Zod-parses the result before returning (H6 boundary discipline, mirrors every other engine).
 */
export function buildInsuranceAnalysis(db: WarehouseDb, asOf: string): InsuranceAnalysisReport {
  const raw = db
    .prepare(
      `SELECT p.id, p.property_id, pm.name AS property_name, p.insurer, p.policy_number,
              p.effective_date, p.expiration_date, p.premium_annual, p.coverage_tiv,
              p.policy_type, p.source_date
       FROM property_insurance_policies p
       LEFT JOIN property_master pm ON pm.id = p.property_id
       ORDER BY p.id`,
    )
    .all() as RawPolicyRow[];

  const deduped = collapseToCurrentTerm(dedupeLatest(raw));

  // Pass 1: everything EXCEPT excessPremiumVsMedian, which needs the benchmark computed first.
  const drafts: Draft[] = deduped.map((r) => {
    // A negative TIV is nonsensical data — fold it into the null/0 exclusion rather than let it
    // flow into rate math (it would otherwise produce a negative "rate", a meaningless artifact).
    const tiv = r.coverage_tiv !== null && r.coverage_tiv >= 0 ? r.coverage_tiv : null;
    const premium = r.premium_annual !== null && r.premium_annual >= 0 ? r.premium_annual : 0;
    const cohort = classifyCohort(r.policy_type, tiv);
    const ratePer100Tiv = computeRatePer100Tiv(premium, tiv);
    // VISIBILITY SIGNAL (refute F1-MEDIUM): a policy with genuinely usable data (TIV known, rate
    // computable) that still lands in 'other' is exactly the shape of a plausible-but-unclassified
    // property policy (vs. a real non-property policy, which this can't distinguish from — a human
    // review is the point). Fail-open: a flagging failure must never break the report.
    if (cohort === 'other' && ratePer100Tiv !== null) {
      try {
        // This engine builds its report on every GET (no snapshot-event cadence to bound the
        // write, unlike insurance.ts's captureInsurance) — without this guard, opening the
        // Insurance UI repeatedly would insert an unbounded run of identical DQ rows for the
        // same policy. Skip if an OPEN flag for this exact policy already exists.
        const alreadyFlagged = db
          .prepare(
            `SELECT 1 FROM data_quality_issues
             WHERE property_id = ? AND kind = 'insurance-cohort-unclassified'
               AND status = 'open' AND detail LIKE ? LIMIT 1`,
          )
          .get(r.property_id, `policy_id=${r.id} %`);
        if (!alreadyFlagged) {
          db.prepare(
            `INSERT INTO data_quality_issues (property_id, kind, detail, severity)
             VALUES (?, 'insurance-cohort-unclassified', ?, 'warn')`,
          ).run(
            r.property_id,
            `policy_id=${r.id} policy_type "${r.policy_type}" has a valid TIV and computable rate but ` +
              `did not match the property-package cohort keywords (property/package/building) — review ` +
              `whether the policy_type vocabulary needs expanding`,
          );
        }
      } catch {
        // best-effort DQ flag — never let this break the report (mirrors insurance.ts's own
        // fail-open DQ writes and calibration.ts's recordResolveFailure).
      }
    }
    const { bucket, daysToExpiry } = computeRenewal(r.expiration_date, asOf);
    return {
      policyId: String(r.id),
      property: r.property_name ?? r.property_id,
      propertyId: r.property_id,
      carrier: r.insurer,
      policyType: r.policy_type,
      premium,
      tiv,
      ratePer100Tiv,
      cohort,
      renewalBucket: bucket,
      daysToExpiry,
    };
  });

  // Benchmark: median ratePer100Tiv over cohort='property-package' with a non-null rate.
  const cohortRates = drafts.filter(hasRate).map((d) => d.ratePer100Tiv);
  const cohortN = cohortRates.length;
  const sufficient = cohortN >= MIN_COHORT_N;
  const benchmark: BookBenchmark = {
    cohort: 'property-package',
    medianRatePer100Tiv: sufficient ? median(cohortRates) : null,
    cohortN,
    sufficient,
    basisNote: 'own-book median — dispersion, not market rate',
  };

  // Pass 2: excessPremiumVsMedian now that the benchmark is known.
  const policies: PolicyEconomics[] = drafts.map((d) => {
    // BASIS DISCIPLINE (refute F1): the median is a PROPERTY-PACKAGE cohort statistic. Scoring an
    // 'other'-cohort policy (Flood / Earthquake / GL / Equipment ...) against it is a cross-cohort
    // basis mismatch — a $100k flood premium is a different product, not "excess" vs a
    // property-package median. Excess is computed ONLY within the cohort the median describes;
    // every other cohort gets null and is thereby structurally excluded from rebidCandidates
    // (hasExcess) and from logRebidVerdicts.
    const excessPremiumVsMedian =
      d.cohort === 'property-package'
        && benchmark.sufficient && benchmark.medianRatePer100Tiv !== null
        && d.ratePer100Tiv !== null && d.tiv !== null
        ? ((d.ratePer100Tiv - benchmark.medianRatePer100Tiv) / 100) * d.tiv
        : null;
    return {
      policyId: d.policyId,
      property: d.property,
      propertyId: d.propertyId,
      carrier: d.carrier,
      policyType: d.policyType,
      premium: d.premium,
      tiv: d.tiv,
      ratePer100Tiv: d.ratePer100Tiv,
      cohort: d.cohort,
      excessPremiumVsMedian,
      renewalBucket: d.renewalBucket,
      daysToExpiry: d.daysToExpiry,
    };
  });

  // Both sorts are TOTAL orders (refute F3): a policyId tiebreak everywhere, so equal-excess /
  // equal-expiry rows never inherit insert order, and null-vs-null daysToExpiry is handled
  // explicitly (the old Infinity-padding comparator returned NaN for null-vs-null).
  const rebidCandidates = policies
    .filter(hasExcess)
    .sort(
      (a, b) => b.excessPremiumVsMedian - a.excessPremiumVsMedian || a.policyId.localeCompare(b.policyId),
    );

  const renewalCalendar = [...policies].sort((a, b) => {
    if (a.daysToExpiry === null && b.daysToExpiry === null) return a.policyId.localeCompare(b.policyId);
    if (a.daysToExpiry === null) return 1;
    if (b.daysToExpiry === null) return -1;
    return a.daysToExpiry - b.daysToExpiry || a.policyId.localeCompare(b.policyId);
  });

  const premiumAnnualTotal = policies.reduce((sum, p) => sum + p.premium, 0);
  const tivKnownN = policies.filter((p) => p.cohort !== 'excluded-null-tiv').length;

  return InsuranceAnalysisReport.parse({
    asOf,
    premiumAnnualTotal,
    policiesN: policies.length,
    tivKnownN,
    benchmark,
    rebidCandidates,
    renewalCalendar,
    advisoryOnly: true,
  });
}

// ── calibration hook ──────────────────────────────────────────────────────────────────────────

interface FingerprintRow {
  id: number;
  property_id: string;
  policy_number: string | null;
  effective_date: string | null;
  expiration_date: string | null;
  premium_annual: number | null;
  coverage_tiv: number | null;
  policy_type: string;
  source_date: string;
}

/** A deterministic digest of the current policy book — the content that must fork inputsVersion
 *  when the book changes (mirrors calibration.ts's classificationDigest, but over the insurance
 *  table instead of the ledger). */
function policyBookFingerprint(db: WarehouseDb): string {
  const rows = db
    .prepare(
      `SELECT id, property_id, policy_number, effective_date, expiration_date,
              premium_annual, coverage_tiv, policy_type, source_date
       FROM property_insurance_policies ORDER BY id`,
    )
    .all() as FingerprintRow[];
  const projection = rows
    .map((r) =>
      [
        r.id, r.property_id, r.policy_number ?? '', r.effective_date ?? '', r.expiration_date ?? '',
        r.premium_annual ?? '', r.coverage_tiv ?? '', r.policy_type, r.source_date,
      ].join(':'),
    )
    .join('|');
  return sha16(projection);
}

/** predicted_band per §-doc: 'excess-gt-10k' / 'excess-2k-10k' / 'excess-lt-2k' (excess is always
 *  > 0 here — logRebidVerdicts only maps rebidCandidates, which are already excess>0 by construction). */
function excessBand(excess: number): 'excess-gt-10k' | 'excess-2k-10k' | 'excess-lt-2k' {
  if (excess > EXCESS_BAND_HIGH_USD) return 'excess-gt-10k';
  if (excess >= EXCESS_BAND_MID_USD) return 'excess-2k-10k';
  return 'excess-lt-2k';
}

/**
 * Log one calibration_verdict (verdict_kind 'insurance-rebid') per rebid candidate. Fail-open —
 * mirrors acq-engine.ts / capital-allocation-api.ts: a calibration failure must never fail the
 * insurance-analysis response. Seeds a synthetic calibration_inputs_version row first (insurance
 * policies are not ledger-derived, so calibration.ts's ledger-fingerprint computeInputsVersion(db)
 * is the wrong content to hash — see module header).
 *
 * subjectKind is 'property' (SubjectKind has no 'insurance'/'policy' member); subjectId is the
 * policy's propertyId (falling back to its display `property` string on the — currently
 * unreachable, since property_id is NOT NULL — case it is absent). Because several policies can
 * share one property, verdictSubkind carries the policyId so each policy gets its own dedup_key
 * (the same D3 collision class anomalies/verdictSubkind and reasons/subkey already guard against).
 */
export function logRebidVerdicts(db: WarehouseDb, report: InsuranceAnalysisReport): LogVerdictsResult {
  try {
    const asOfPeriod = report.asOf.slice(0, 4);
    const fingerprint = policyBookFingerprint(db);
    const inputsVersion = sha16(`insurance-analysis:${fingerprint}:${asOfPeriod}`);

    // INSERT OR IGNORE keeps a re-run on an unchanged book (same fingerprint + asOfPeriod) idempotent.
    db.prepare(
      `INSERT OR IGNORE INTO calibration_inputs_version
         (inputs_version, ledger_fingerprint, config_hash, code_version, config_json)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      inputsVersion,
      `insurance-book:${fingerprint}`,
      `insurance-analysis:${asOfPeriod}`,
      codeVersion(),
      JSON.stringify({ source: 'insurance-analysis', asOf: report.asOf, policiesN: report.policiesN }),
    );

    const verdicts: CalibrationVerdict[] = report.rebidCandidates
      .filter(hasExcess)
      .map((p) =>
        CalibrationVerdictSchema.parse({
          subjectKind: 'property',
          subjectId: p.propertyId ?? p.property,
          verdictKind: 'insurance-rebid',
          verdictSubkind: p.policyId,
          verdictEngine: 'insurance-analysis',
          predictedBand: excessBand(p.excessPremiumVsMedian),
          predictedValue: p.excessPremiumVsMedian,
          predictedUnit: 'usd',
          confidence: DERIVED_CONFIDENCE,
          // No auto-resolution arm exists for 'insurance-rebid' (calibration.ts scoreVerdict's
          // default case returns null — manual resolution only), and this is dispersion, not a
          // savings promise, so no directional bet is recorded.
          direction: 'n/a',
          reasons: [
            `ratePer100Tiv ${p.ratePer100Tiv ?? 'n/a'} vs own-book median ${report.benchmark.medianRatePer100Tiv ?? 'n/a'} (cohort n=${report.benchmark.cohortN})`,
            report.benchmark.basisNote,
          ],
          asOfPeriod,
          horizonPeriods: INSURANCE_REBID_HORIZON_PERIODS,
          inputsVersion,
          emittedBy: 'insurance-analysis:buildInsuranceAnalysis',
        }),
      );

    return logVerdicts(db, verdicts);
  } catch (e) {
    // Fail-open (mirrors logVerdicts' own fail-open guarantee) — the seed step above is outside
    // logVerdicts' own try/catch, so a failure there must be caught here instead.
    return { written: 0, skipped: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
