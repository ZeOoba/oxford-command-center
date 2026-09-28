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
//
// REVIEW ELIGIBILITY IS A PROPERTY LINE, NOT THE RATE COHORT (2026-09-24, refute wf_f867be02-d49;
// ratified by Gabriel): a policy takes loss attachment + a deductible review when its policy_type is
// a first-party property line (property/package/building — insurance-policy-lines.ts) and it is not
// a tenant's evidence-of-insurance certificate. coverage_tiv plays no part: the review math never
// uses TIV, and gating on the TIV-based 'property-package' cohort hid every live policy (all 30
// current terms carry null TIV) and let a TIV-less policy's loss fall onto its sibling.
//
// LOSS ATTACHMENT IS PER EVENT (2026-09-24, refute wf_b8d4eadd-e31): each loss event is attached
// to exactly ONE eligible policy at its property — the policy whose policy_number matches the
// event's policy_ref when there is one (a ref naming a NON-eligible policy at the property, e.g.
// its GL line, leaves the event EAL-only rather than moving it onto a property deductible), else
// the policy whose term [effective, expiration] covers the loss date, else (no term covers it) the
// eligible policy with the most recent effective date. That last tier is a GO-FORWARD framing: a
// loss that predates every current term (prior terms are collapsed away upstream) is reviewed
// against the most recently incepted property policy — "what would we retain under the policy we
// carry now" — not against the historical carrier's terms.
//
// Two more rules (refute wf_9161a34b-7f0):
//   • A third-party cause (liability / bodily injury / employment practices — isThirdPartyLossCause)
//     is never booked against a property deductible: the event stays EAL-only. This also covers a
//     bundled BOP number shared by the property line and its liability lines.
//   • policy_ref (normalizePolicyNumber'd — case- and whitespace-insensitive) matches a policy's OWN
//     number first (PolicyTerm.policyNumber). Only when no policy at the property carries it as its
//     own number does it fall back to the line aliases (PolicyTerm.lineNumbers — every number the
//     same raw line + policy_type has carried, e.g. a same-term reissue's base number 'REDACTED-600'
//     for the surviving 'REDACTED-477'). Own-first keeps an exact ref authoritative when one line
//     carries two surviving policies (refute wf_4af14459-c62).
// Ties break on the most recent effective date, then policyId, as a total order — so the
// attachment never depends on input order. A property can carry several concurrently in-force
// property policies (9620 Raytown: Westchester 2025-10-18→2026-10-18 and Hartford BOP
// 2026-05-28→2027-05-28); matching by propertyId alone booked every event against every one of
// them, and the old "primary = lowest policyId" roll-up then split a Hartford-term loss against
// the Westchester deductible. Review rows are now disjoint, so the self-insure roll-up is a plain
// Σ over them and counts each event exactly once.
//
// UNMATCHED POLICY REFS ARE REPORTED, NEVER ACTED ON (2026-09-24): an event whose non-blank
// policy_ref (normalized) matches neither any policy's own number nor any number its line carried,
// across ALL policies at its property (any line — a ref naming the GL line is a match), is listed
// in `unmatchedPolicyRefs` with the RAW ref. Zero policies at the property counts as unmatched. The
// signal is visibility only: attachment still falls through to the covering term / most recent
// policy exactly as before, and EAL, reviews and the self-insure split are untouched. It is flagged
// REGARDLESS of cause — a third-party claim citing a number not on file is as much a loss-run typo
// or register gap as a first-party one — so it is computed apart from attachEvent, which returns
// early for third-party causes. Both paths share `policiesMatchingRef` so the definitions cannot
// drift. Blank-propertyId events are unattributable and are not flagged. WAREHOUSE-ONLY (refute
// wf_dd1d6f45-da0): the list is computed solely when lossEvents.source === 'warehouse'. The
// placeholder fixture's every ref is the synthetic 'PLACEHOLDER' sentinel (docs/placeholder-data.md),
// so on a fixture-sourced report the list is [] rather than a false "loss-run typo" per event.
// A blank or NULL event id is listed as '' (both loaders admit ''; the SQL column admits NULL, which
// resolveLossEvents coerces to '' before any reader sees it). '' can therefore repeat — eventId is a
// display-only tiebreak, never a key — so one bad id can never fail the engine's own parse and 500
// the report.
import {
  InsuranceLossReport,
  type UnmatchedPolicyRef,
  type PropertyEal,
  type DeductibleReview,
  type SelfInsureSplit,
  type RebidPipelineItem,
  type RebidStage,
  type LossDataSource,
} from '../../src/contracts/insurance-loss';
import type { PolicyEconomics } from '../../src/contracts/insurance-analysis';
import type { DecPagesResolved, LossEventRow, LossEventsResolved } from './placeholder-data';
import { isPropertyLinePolicyType, isTenantEvidenceCertificate, isThirdPartyLossCause } from './insurance-policy-lines';

/** Term identity of one policy, keyed in LossAnalysisInputs.policyTerms by PolicyEconomics.policyId.
 *  PolicyEconomics (a wire contract) carries no term dates, so the caller supplies them. */
export interface PolicyTerm {
  /** This row's own policy number, normalizePolicyNumber'd; null when none is on file. */
  policyNumber: string | null;
  /** Every number this policy's LINE has carried (normalized) — its own plus any superseded /
   *  reissued row's on the same line — consulted only when no policy owns the ref outright. */
  lineNumbers: readonly string[];
  effectiveDate: string | null;
  expirationDate: string | null;
}

/** Canonical policy-number form for matching a loss run's policy_ref: upper-case with ALL
 *  whitespace removed ('REDACTED-519' ≡ 'REDACTED-584'). Null for a missing/blank number. */
export function normalizePolicyNumber(n: string | null | undefined): string | null {
  const t = n?.replace(/\s+/g, '').toUpperCase();
  return t ? t : null;
}

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
  /** Term identity per policyId — decides which policy a loss event attaches to. A policy with no
   *  entry (or a null date) never "covers" a loss date; it can still receive an event through a
   *  policy_ref match or the most-recent-effective fallback. */
  policyTerms: ReadonlyMap<string, PolicyTerm>;
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

/** ISO date prefix ('YYYY-MM-DD'); null for a missing/blank value. Lexicographic order on this
 *  prefix is chronological order. */
function isoDay(dateStr: string | null | undefined): string | null {
  const d = dateStr?.trim().slice(0, 10);
  return d ? d : null;
}

/** Total order for picking among candidate policies: most recent effective date first (a policy
 *  with no effective date sorts last), then policyId ascending. Never 0 for distinct policies, so
 *  the pick is independent of input order. */
function preferPolicy(a: PolicyEconomics, b: PolicyEconomics, terms: ReadonlyMap<string, PolicyTerm>): number {
  const ea = isoDay(terms.get(a.policyId)?.effectiveDate) ?? '';
  const eb = isoDay(terms.get(b.policyId)?.effectiveDate) ?? '';
  if (ea !== eb) return ea > eb ? -1 : 1;
  return a.policyId.localeCompare(b.policyId);
}

/** Takes loss attachment + a deductible review: an ORA first-party property line (see header). */
function isReviewable(p: PolicyEconomics): boolean {
  return isPropertyLinePolicyType(p.policyType) && !isTenantEvidenceCertificate(p.policyType);
}

/**
 * The policies (any line) at a property that a normalized policy_ref names: those whose OWN number
 * is `ref`, else — only when none owns it — those whose line carried it (PolicyTerm.lineNumbers).
 * Empty when the ref names nothing at the property. The SINGLE definition of "the ref matches",
 * shared by attachEvent and the unmatched-ref detection so the two can never drift.
 * Invariant: loadPolicyTerms (insurance-loss-api.ts) always includes a row's own number in its
 * lineNumbers, so own ⊆ line — the own-first check exists for attachEvent's pool precedence, not
 * for the emptiness test, which the line check alone decides.
 */
function policiesMatchingRef(
  ref: string,
  atProperty: readonly PolicyEconomics[],
  terms: ReadonlyMap<string, PolicyTerm>,
): readonly PolicyEconomics[] {
  const byOwn = atProperty.filter((p) => terms.get(p.policyId)?.policyNumber === ref);
  if (byOwn.length > 0) return byOwn;
  return atProperty.filter((p) => terms.get(p.policyId)?.lineNumbers.includes(ref) ?? false);
}

/**
 * The ONE policy a loss event is booked against, or undefined (EAL-only). A third-party cause is
 * EAL-only outright. `atProperty` is every policy at the event's property (any line). A policy_ref
 * matching a policy's own number (else a number its line carried) decides the pool outright: the matching reviewable
 * policies, or — when it names only non-reviewable lines — no policy at all. Otherwise the pool is
 * the reviewable policies, narrowed to those whose term covers the loss date (inclusive both ends)
 * when any does. preferPolicy then picks within the pool.
 */
function attachEvent(
  e: LossEventRow,
  atProperty: readonly PolicyEconomics[],
  terms: ReadonlyMap<string, PolicyTerm>,
): PolicyEconomics | undefined {
  if (isThirdPartyLossCause(e.cause)) return undefined;
  let pool: readonly PolicyEconomics[] = atProperty.filter(isReviewable);
  const ref = normalizePolicyNumber(e.policyRef);
  if (ref !== null) {
    const byRef = policiesMatchingRef(ref, atProperty, terms);
    if (byRef.length > 0) pool = byRef.filter(isReviewable);
  }
  const day = isoDay(e.lossDate);
  if (day !== null) {
    const covering = pool.filter((p) => {
      const t = terms.get(p.policyId);
      const eff = isoDay(t?.effectiveDate);
      const exp = isoDay(t?.expirationDate);
      return eff !== null && exp !== null && eff <= day && day <= exp;
    });
    if (covering.length > 0) pool = covering;
  }
  return [...pool].sort((a, b) => preferPolicy(a, b, terms))[0];
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
  const { asOf, policies, decPages, lossEvents, policyTerms } = input;

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
  // Ordered over CONTENT — (lossDate, id, cause, grossIncurred, policyRef) — so every float sum below
  // (EAL and per-policy review) is a function of the event SET, not of the loss-run row order. id
  // alone is not a key: '' repeats (blank ids; NULL ids coerced by resolveLossEvents), and SQLite's
  // ORDER BY loss_date leaves ties unspecified — with non-dyadic amounts (0.1+0.2+0.3) the sum would
  // then differ by input order (refute wf_45165937-d0b). Rows that still tie on every key carry the
  // same grossIncurred, so their order cannot move a sum. It is NOT strictly total: NULL and ''
  // cause/policyRef collapse, localeCompare treats ignorable code points as equal, and 022's UNIQUE
  // treats NULLs as distinct — such ties only reorder the diagnostic list (refute wf_5289ba71-3ed).
  // Per-policy lists inherit this order.
  for (const events of eventsByProperty.values()) {
    events.sort(
      (a, b) =>
        a.lossDate.localeCompare(b.lossDate) ||
        a.id.localeCompare(b.id) ||
        (a.cause ?? '').localeCompare(b.cause ?? '') ||
        a.grossIncurred - b.grossIncurred ||
        (a.policyRef ?? '').localeCompare(b.policyRef ?? ''),
    );
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

  // ── Loss attachment: each event → at most one reviewable policy at its property ────────────
  const policiesByProperty = new Map<string, PolicyEconomics[]>();
  for (const p of policies) {
    if (p.propertyId === null || p.propertyId === '') continue;
    const arr = policiesByProperty.get(p.propertyId);
    if (arr) arr.push(p);
    else policiesByProperty.set(p.propertyId, [p]);
  }
  const eventsByPolicy = new Map<string, LossEventRow[]>();
  // Data-quality signal (see header): a non-blank ref naming nothing at the property. Computed
  // apart from attachEvent's return value (which is undefined for a third-party cause before the
  // ref is ever consulted) and never fed back into attachment. Iterating eventsByProperty means a
  // blank-propertyId event — unattributable, already dropped above — is never flagged. Warehouse
  // loss runs only: fixture refs are the synthetic 'PLACEHOLDER' sentinel, not typos (see header).
  const detectUnmatched = lossEvents.source === 'warehouse';
  const unmatchedPolicyRefs: UnmatchedPolicyRef[] = [];
  for (const [propertyId, events] of eventsByProperty) {
    const atProperty = policiesByProperty.get(propertyId) ?? [];
    for (const e of events) {
      const rawRef = e.policyRef;
      const ref = normalizePolicyNumber(rawRef);
      if (detectUnmatched && rawRef !== null && ref !== null && policiesMatchingRef(ref, atProperty, policyTerms).length === 0) {
        unmatchedPolicyRefs.push({
          eventId: e.id,
          propertyId,
          property: nameById.get(propertyId) ?? propertyId,
          policyRef: rawRef,
          lossDate: e.lossDate,
          cause: e.cause,
          grossIncurred: e.grossIncurred,
        });
      }
      const policy = attachEvent(e, atProperty, policyTerms);
      if (policy === undefined) continue; // no reviewable policy for this event — EAL only
      const arr = eventsByPolicy.get(policy.policyId);
      if (arr) arr.push(e);
      else eventsByPolicy.set(policy.policyId, [e]);
    }
  }

  // ── Deductible reviews (reviewable property lines only) ────────────────────────────────────
  const deductibleReviews: DeductibleReview[] = [];
  for (const policy of policies) {
    if (!isReviewable(policy)) continue;

    const decEntry = decPages.byPolicyId.get(policy.policyId);
    const deductible = decEntry?.deductible ?? null;
    const coverageLimit = decEntry?.coverageLimit ?? null;
    const decSource: LossDataSource = decEntry?.source ?? 'absent';

    const matched = eventsByPolicy.get(policy.policyId) ?? [];

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
  // Ordered over CONTENT — (propertyId, lossDate, eventId, cause, grossIncurred, policyRef).
  // eventId is a tiebreak, not a unique key: '' can repeat (blank ids, and NULL ids — SQLite allows
  // many NULLs in a non-INTEGER PRIMARY KEY — which resolveLossEvents coerces to ''). For
  // well-formed rows this fixes the list order; rows differing only by NULL-vs-'' cause or by
  // collation-ignorable characters still tie and keep input order (display only; refute
  // wf_5289ba71-3ed).
  unmatchedPolicyRefs.sort(
    (a, b) =>
      a.propertyId.localeCompare(b.propertyId) ||
      a.lossDate.localeCompare(b.lossDate) ||
      a.eventId.localeCompare(b.eventId) ||
      (a.cause ?? '').localeCompare(b.cause ?? '') ||
      a.grossIncurred - b.grossIncurred ||
      a.policyRef.localeCompare(b.policyRef),
  );

  // ── Self-insure roll-up (no double-count) ─────────────────────────────────────────────────
  // Every event sits in at most one review row (attachEvent above), so Σ over review rows counts
  // each event's dollars exactly once, against the terms of the policy it was attached to.
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
    `risk-priced claim; loss runs are ${lossEvents.source} and dec-page terms are ${decPageDataSource}. ` +
    `Policies without deductible/limit data book losses as fully transferred — dec-page data refines this.`;

  return InsuranceLossReport.parse({
    asOf,
    lossDataSource: lossEvents.source,
    decPageDataSource,
    droppedFixtureRows: lossEvents.droppedRows,
    coercedLossEventRows: lossEvents.coercedRows,
    unmatchedPolicyRefs,
    eal,
    deductibleReviews,
    selfInsure,
    rebidPipeline,
    basisNote,
    advisoryOnly: true,
  });
}
