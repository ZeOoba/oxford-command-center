// server/warehouse/insurance-loss-analysis.ts
//
// Phase 4c — Insurance LOSS reasoning layer engine (P4c placeholder buildout).
// Produces the InsuranceLossReport wire contract (src/contracts/insurance-loss.ts) from
// already-resolved inputs: PolicyEconomics (insurance-analysis engine), plus Task 2's
// warehouse-first loss-run and dec-page resolvers.
//
// PURE FUNCTION — NO DB access, NO I/O, NO calibration imports/writes. Every resolver dependency
// below is a `import type` (fully elided at runtime), so this file drags in none of Task 2's fs
// code. All state arrives via LossAnalysisInputs; the only output is the Zod-parsed report.
//
// DOCTRINE (mirrors the contract header — the one rule a future edit must never break): DISPERSION
// / ARITHMETIC ONLY. Expected annual loss is grossIncurred ÷ observed years — a plain arithmetic
// mean, no loss-development factors. The retained-vs-transferred split is a mechanical bucketing of
// observed events against the stated deductible/limit. There are NO risk-load, transfer-share, or
// capture-rate constants anywhere here — this layer does not price risk or promise a saving. The
// placeholder discriminators (`lossDataSource`, `decPageDataSource`) declare, per report, whether
// the loss runs / dec-page terms came from the warehouse or from placeholder fixtures.
import {
  InsuranceLossReport,
  type PropertyEal,
  type DeductibleReview,
  type SelfInsureSplit,
  type RebidPipelineItem,
  type RebidStage,
  type LossDataSource,
} from '../../src/contracts/insurance-loss';
import type { PolicyEconomics } from '../../src/contracts/insurance-analysis';
import type { DecPagesResolved, LossEventRow, LossEventsResolved } from './placeholder-data';

/** Minimum distinct observation years before an arithmetic-mean EAL is trustworthy. Below this the
 *  EAL is reported as indeterminate (null) rather than a false-precision figure over a thin window. */
export const MIN_LOSS_YEARS = 3;

export interface LossAnalysisInputs {
  asOf: string;
  /** From buildInsuranceAnalysis(db, asOf) — already deduped/classified. */
  policies: PolicyEconomics[];
  /** Task 2 dec-page resolver; byPolicyId is keyed by String(policy.id) = PolicyEconomics.policyId. */
  decPages: DecPagesResolved;
  /** Task 2 loss-run resolver (warehouse-first, placeholder fallback). */
  lossEvents: LossEventsResolved;
}

// ── small pure helpers ────────────────────────────────────────────────────────────────────────

/** Leading 4-digit calendar year of an ISO-ish date string ("2024-06-01" → "2024"); null when the
 *  string carries no parseable leading year (such an event still counts toward gross totals but
 *  cannot be attributed to a calendar year, so it is excluded from the distinct-year count). */
function calendarYear(dateStr: string): string | null {
  const m = /^\s*(\d{4})/.exec(dateStr);
  return m?.[1] ?? null;
}

/** Loss-run provenance source label, driven by where the loss runs actually came from. */
function lossSourceLabel(source: LossDataSource): string {
  return source === 'warehouse' ? 'insurance_loss_events' : 'loss-runs.placeholder.json';
}

/** Deterministic USD label with thousands separators, no Intl dependency (env-independent). */
function usd(n: number): string {
  return `$${Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

/** decPageDataSource across the REVIEWED policies' dec entries: 'warehouse' only when every entry
 *  is warehouse; 'placeholder' if any is placeholder; otherwise (all/any absent, or empty) 'absent'.
 *  Placeholder contamination wins; a warehouse claim is made only when it is unambiguously all-warehouse. */
function rollUpDecSource(sources: readonly LossDataSource[]): LossDataSource {
  if (sources.length === 0) return 'absent';
  if (sources.some((s) => s === 'placeholder')) return 'placeholder';
  if (sources.every((s) => s === 'warehouse')) return 'warehouse';
  return 'absent';
}

/** rebid stage from renewal proximity: soonest renewal → most urgent action. */
function rebidStage(renewalBucket: string): RebidStage {
  if (renewalBucket === 'now-45') return 'rebid';
  if (renewalBucket === 'soon-90') return 'quote';
  return 'watch';
}

// ── the engine ────────────────────────────────────────────────────────────────────────────────

interface EalAccum {
  eventsN: number;
  grossIncurredTotal: number;
}

/**
 * Build the insurance LOSS report from resolved inputs. Pure: no side effects, Zod-parses its own
 * output before returning (boundary discipline, mirrors buildInsuranceAnalysis).
 */
export function buildInsuranceLossReport(input: LossAnalysisInputs): InsuranceLossReport {
  const { asOf, policies, decPages, lossEvents } = input;

  // observationYears = distinct calendar years across ALL loss events (0 when empty).
  const years = new Set<string>();
  for (const e of lossEvents.rows) {
    const y = calendarYear(e.lossDate);
    if (y !== null) years.add(y);
  }
  const observationYears = years.size;
  const indeterminate = observationYears < MIN_LOSS_YEARS;

  // Property display names come from the policy register; a property with loss events but no policy
  // falls back to its id (mirrors buildInsuranceAnalysis's `property_name ?? property_id`).
  const nameById = new Map<string, string>();
  for (const p of policies) {
    if (p.propertyId !== null && p.propertyId !== '' && !nameById.has(p.propertyId)) {
      nameById.set(p.propertyId, p.property);
    }
  }

  // Group events by propertyId for BOTH the EAL table and the deductible reviews. Events with a
  // blank propertyId are unattributable (they still counted toward observationYears above) and are
  // dropped here — a PropertyEal requires a non-empty propertyId (contract min(1)).
  const eventsByProperty = new Map<string, LossEventRow[]>();
  for (const e of lossEvents.rows) {
    if (e.propertyId === '') continue;
    const arr = eventsByProperty.get(e.propertyId);
    if (arr) arr.push(e);
    else eventsByProperty.set(e.propertyId, [e]);
  }

  const lossSource = lossSourceLabel(lossEvents.source);

  // ── EAL per property ──────────────────────────────────────────────────────────────────────
  const eal: PropertyEal[] = [];
  for (const [propertyId, events] of eventsByProperty) {
    const acc: EalAccum = { eventsN: 0, grossIncurredTotal: 0 };
    for (const e of events) {
      acc.eventsN += 1;
      acc.grossIncurredTotal += e.grossIncurred;
    }
    eal.push({
      propertyId,
      property: nameById.get(propertyId) ?? propertyId,
      eventsN: acc.eventsN,
      grossIncurredTotal: acc.grossIncurredTotal,
      observationYears,
      ealAnnual: indeterminate ? null : acc.grossIncurredTotal / observationYears,
      indeterminate,
      prov: {
        source: lossSource,
        confidence: 'estimated',
        formula: 'Σ gross_incurred ÷ observed years',
      },
    });
  }

  // ── Deductible reviews (property-package policies only) ────────────────────────────────────
  const deductibleReviews: DeductibleReview[] = [];
  for (const policy of policies) {
    if (policy.cohort !== 'property-package') continue;

    const decEntry = decPages.byPolicyId.get(policy.policyId);
    const deductible = decEntry?.deductible ?? null;
    const coverageLimit = decEntry?.coverageLimit ?? null;
    const decSource: LossDataSource = decEntry?.source ?? 'absent';

    const matched = (policy.propertyId !== null ? eventsByProperty.get(policy.propertyId) : undefined) ?? [];

    let retainedUsd = 0;
    let transferredUsd = 0;
    let overLimitUsd = 0;
    let grossIncurredTotal = 0;
    let lossesBelowDeductible = 0;
    const d = deductible ?? 0;
    const limitCap = coverageLimit ?? Number.POSITIVE_INFINITY;
    for (const e of matched) {
      const gross = e.grossIncurred;
      grossIncurredTotal += gross;
      retainedUsd += Math.min(gross, d);
      transferredUsd += Math.max(0, Math.min(gross, limitCap) - d);
      if (coverageLimit !== null) overLimitUsd += Math.max(0, gross - coverageLimit);
      if (deductible !== null && gross <= deductible) lossesBelowDeductible += 1;
    }
    const eventsN = matched.length;

    deductibleReviews.push({
      policyId: policy.policyId,
      property: policy.property,
      propertyId: policy.propertyId,
      deductible,
      coverageLimit,
      decSource,
      eventsN,
      lossesBelowDeductible,
      lossesAboveDeductible: eventsN - lossesBelowDeductible,
      retainedUsd,
      transferredUsd,
      overLimitUsd,
      lossRatio: policy.premium === 0 ? null : grossIncurredTotal / policy.premium,
      prov: {
        source: lossSource,
        confidence: 'estimated',
        formula: 'retained=Σ min(gross,ded); transferred=Σ max(0, min(gross,limit)−ded); lossRatio=Σ gross ÷ premium',
      },
    });
  }

  const decPageDataSource = rollUpDecSource(deductibleReviews.map((r) => r.decSource));

  // ── Re-bid pipeline (derive-only, excess>0 policies) ──────────────────────────────────────
  const rebidPipeline: RebidPipelineItem[] = [];
  for (const p of policies) {
    const excess = p.excessPremiumVsMedian;
    if (excess === null || excess <= 0) continue;
    const stage = rebidStage(p.renewalBucket);
    rebidPipeline.push({
      policyId: p.policyId,
      property: p.property,
      stage,
      excessPremiumVsMedian: excess,
      renewalBucket: p.renewalBucket,
      reason: `Premium runs ${usd(excess)} above own-book median; renewal bucket '${p.renewalBucket}' → ${stage}.`,
    });
  }

  // ── Deterministic ordering (total orders — policyId/propertyId tiebreak, per insurance-analysis) ──
  eal.sort((a, b) => b.grossIncurredTotal - a.grossIncurredTotal || a.propertyId.localeCompare(b.propertyId));
  deductibleReviews.sort((a, b) => b.retainedUsd - a.retainedUsd || a.policyId.localeCompare(b.policyId));
  rebidPipeline.sort((a, b) => (b.excessPremiumVsMedian ?? 0) - (a.excessPremiumVsMedian ?? 0) || a.policyId.localeCompare(b.policyId));

  // ── Self-insure roll-up ───────────────────────────────────────────────────────────────────
  const nonNullEals = eal.filter((e): e is PropertyEal & { ealAnnual: number } => e.ealAnnual !== null);
  const selfInsure: SelfInsureSplit = {
    retainedUsd: deductibleReviews.reduce((s, r) => s + r.retainedUsd, 0),
    transferredUsd: deductibleReviews.reduce((s, r) => s + r.transferredUsd, 0),
    overLimitUsd: deductibleReviews.reduce((s, r) => s + r.overLimitUsd, 0),
    premiumAnnualTotal: policies.reduce((s, p) => s + p.premium, 0),
    portfolioEalAnnual: nonNullEals.length > 0 ? nonNullEals.reduce((s, e) => s + e.ealAnnual, 0) : null,
    observationYears,
  };

  const basisNote =
    `Dispersion only — expected annual loss and the retained-vs-transferred split are a mechanical ` +
    `roll-up of observed loss runs against stated dec-page terms, not a savings, capture, or ` +
    `risk-priced claim; loss runs are ${lossEvents.source} and dec-page terms are ${decPageDataSource}.`;

  return InsuranceLossReport.parse({
    asOf,
    lossDataSource: lossEvents.source,
    decPageDataSource,
    droppedFixtureRows: lossEvents.droppedRows,
    eal,
    deductibleReviews,
    selfInsure,
    rebidPipeline,
    basisNote,
    advisoryOnly: true,
  });
}
