// server/warehouse/insurance-conditions.ts
//
// Server-side insurance alert conditions (Phase 5).
// Reads property_insurance_policies (migration 008) from the warehouse DB and
// returns Insight[] for two conditions:
//
//   insurance-expiry-soon  — severity: critical
//     Fires when ANY policy row has expiration_date 0..60 days away (inclusive on 60).
//     One insight per DISTINCT property_id VALUE, soonest-expiring row winning within a
//     value, so the detail always describes the most urgent renewal. Insight id is stable:
//     `ins-expiry-<property_id value>`.
//     NOTE (verified 2026-08-11, corrects the original "one insight per PROPERTY" claim):
//     property_id holds POLICY-level slugs in production ("ins-fvc-pckg"), not property ids
//     — 25 rows, 25 distinct values — so this grouping is per-POLICY there, and each policy
//     at a property alerts separately. That is the intended behaviour (Gabriel, 2026-08-11:
//     two lapsed policies are two things to fix), and the title resolves the slug to the
//     property name + coverage so co-located policies are distinguishable in the inbox.
//     BOUNDARY: daysToExpiry <= 60 AND daysToExpiry >= 0.
//     impactAnnualUsd = premium_annual of the soonest-expiring policy
//                       (null when the winning row has no premium on file).
//     provenance = 'real' — the expiry DATE is a hard fact from the warehouse;
//     the premium being null does NOT demote date provenance.
//     spine = 'B' (warehouse read).
//     FIXED 2026-08-17 (adversarial refute pass on the insurance-analysis.ts rollover fix,
//     sweep-completer lens): this condition used to evaluate against RAW, uncollapsed rows —
//     a rolled-over policy's superseded prior term still carries its own (already near/past-due)
//     expiration_date, so it won the per-property "soonest" pick and fired a false CRITICAL
//     "renew immediately" alert for a policy that was already renewed, while the real (rolled,
//     ~1-year-out) term sat unalarmed in the same table. Verified live against production data:
//     two 1900 Broadway policies false-alarmed this way, reaching the alert-email/daily-brief
//     path. Now runs insurance-analysis.ts's collapseToCurrentTerm on the rows first — the same
//     algorithm buildInsuranceAnalysis uses, so this condition and that engine cannot drift apart
//     on what "current" means again.
//
//   insurance-gap          — severity: warning
//     Fires for every Property in snapshot.properties with NO matching row in
//     property_insurance_policies (i.e. we have no policy on file at all).
//     FIXED 2026-09-24: property_id holds policy-line keys ('ins-<stem>-<line>'), so matching
//     the raw column covered 0 of 14 properties and this warned on EVERY property. Each key now
//     resolves through insurance-property-map.ts's explicit stem table (resolveInsuranceProperty)
//     to its property_master id; a key the table cannot place on a master row stays raw and
//     covers nothing (no inferred attribution). A tenant's ACORD evidence-of-insurance row
//     counts as coverage on file (Gabriel, 2026-09-24: NNN single-tenant buildings are insured by
//     the tenant). Warning severity only: never emails.
//     impactAnnualUsd = null (no policy → no known premium).
//     provenance = 'absent' — the absence of data is the finding.
//     spine = 'B'.
//
// PURE — no mutations of inputs. Throws nothing (callers guard with try/catch).
// DETERMINISTIC — output is sorted by id (lexicographic) for stable ordering.
//
// NOT a financial-decision function. Read-only alert conditions surfacing
// existing warehouse data. No engine math, scoring, NOI, or capital-allocation.
import type { WarehouseDb } from './db';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import type { Insight } from '../../src/analytics/types';
import { DAY_MS } from './time-constants';
import { collapseToCurrentTerm, type CollapsibleInsuranceRow } from './insurance-analysis';
import { resolveInsuranceProperty } from './insurance-property-map';
// BOUNDARY: policies expiring within this window (inclusive) → critical alert.
const EXPIRY_ALERT_DAYS = 60;
// BOUNDARY: a same-property/same-type policy pair with no shared policy_number and a non-overlapping
// gap of 1..this-many days between one's expiration and the other's effective date is flagged as a
// possible gapped rollover (see Condition 2.5 below) rather than silently double-counted.
const GAPPED_ROLLOVER_WINDOW_DAYS = 30;

interface PolicyRow extends CollapsibleInsuranceRow {
  premium_annual: number | null;
}

/**
 * Fetch property_insurance_policies and reduce to the current-term view ONCE. Shared by
 * insuranceConditions and insuranceWarehouseDriftConditions below — server/brief/run.ts calls
 * both, back-to-back, on the same db handle/snapshot/refDate in a single runBrief() execution.
 *
 * FIXED 2026-08-21 (adversarial review finding): each function used to run its own near-identical
 * full-table SELECT and its own full collapseToCurrentTerm union-find pass, so every brief run
 * paid for two scans + two O(n^2) clustering passes over nearly the same rows. collapseToCurrentTerm
 * never drops a property_id (an undated row is passed through untouched; every dated group
 * produces at least one winner row), so the resulting set of property_id values is identical to
 * the raw table's — safe for insuranceConditions' coveredIds check below to read from this
 * collapsed set instead of a second raw fetch.
 */
export function fetchCurrentInsuranceRows(db: WarehouseDb): PolicyRow[] {
  const rows = db
    .prepare(
      `SELECT id, property_id, policy_number, effective_date, expiration_date,
              premium_annual, policy_type, source_date
       FROM property_insurance_policies
       ORDER BY id`,
    )
    .all() as PolicyRow[];
  return collapseToCurrentTerm(rows);
}

/** What a warehouse `property_id` value actually points at, once resolved. */
interface ResolvedOwner {
  /** Best available human label for the subject line. Never empty. */
  label: string;
  /** Coverage/policy-type label, when one is known. */
  coverage: string | null;
}

/**
 * property_master id → name, for resolveInsuranceProperty. FAILS OPEN to an empty map:
 * insuranceConditions runs inside run.ts's catch-all, where a throw drops EVERY insurance
 * critical — an unreadable master table must degrade to raw-key behaviour, not silence alerts.
 */
function loadMasterNames(db: WarehouseDb): Map<string, string> {
  try {
    const rows = db.prepare('SELECT id, name FROM property_master').all() as Array<{ id: string; name: string }>;
    return new Map(rows.map((r) => [r.id, r.name]));
  } catch {
    return new Map();
  }
}

/**
 * Resolve a warehouse `property_id` into a human-readable LABEL for the alert subject.
 *
 * The column holds POLICY-level keys ("ins-fvc-pckg") in production, not property ids.
 * Label resolution runs: direct property id → the stem table's property_master name (the same
 * explicit, auditable map the Insurance module uses — never a token heuristic, which
 * mis-attributed 4 of 25) → `snapshot.insurance[]`'s descriptive address → the stem table's
 * label-only address → the raw value. Coverage comes from the live `snapshot.insurance[]` row
 * whenever one exists. Every branch FAILS OPEN: the alert always fires, because a policy we
 * can't attribute is not a reason to go quiet about it expiring.
 */
function buildOwnerResolver(
  snapshot: PortfolioSnapshot,
  masterNames: ReadonlyMap<string, string>,
): (rawId: string) => ResolvedOwner {
  const propertiesById = new Map(snapshot.properties.map((p) => [p.id, p]));
  // `?? []` guards a snapshot missing the key entirely: insuranceConditions runs inside
  // run.ts's catch-all, where any throw here silently drops EVERY insurance critical.
  const policiesById = new Map((snapshot.insurance ?? []).map((i) => [i.id, i]));

  return (rawId: string): ResolvedOwner => {
    const direct = propertiesById.get(rawId);
    if (direct) return { label: direct.name, coverage: null };

    const policy = policiesById.get(rawId);
    const coverage = policy?.coverage ?? null;
    const stem = resolveInsuranceProperty(rawId, masterNames);
    if (stem.propertyId !== null) return { label: stem.name, coverage };
    if (policy) return { label: policy.property, coverage };

    // Label-only stem address, or the raw value itself (resolveInsuranceProperty's last resort).
    return { label: stem.name, coverage: null };
  };
}

/**
 * Compute days from isoFrom to isoTarget (positive = future, negative = past).
 * Mirrors the daysBetween helper in src/analytics/conditions.ts.
 */
function daysBetween(isoTarget: string, isoFrom: string): number {
  return Math.round(
    (new Date(isoTarget).getTime() - new Date(isoFrom).getTime()) / DAY_MS,
  );
}

/**
 * Coerce a raw DB premium value to a safe number or null.
 * SQLite stores NULL as null; non-finite JS values (NaN, Infinity) from any
 * in-process transformation are guarded here.
 */
function coercePremium(raw: number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (!Number.isFinite(raw)) return null;
  return raw;
}

/**
 * Candidate for the soonest-expiring policy per property (within the alert window).
 */
interface ExpiryCandidate {
  days: number;
  expirationDate: string;
  premium: number | null;
  policyType: string | null;
}

/**
 * Evaluate warehouse-sourced insurance alert conditions against a snapshot.
 *
 * @param db       Open WarehouseDb (caller owns lifecycle).
 * @param snapshot PortfolioSnapshot (Spine A) — snapshot.properties[], snapshot.meta.asOf,
 *                 and (since 2026-08-11) snapshot.insurance[] are consumed. The last is used
 *                 for LABELLING ONLY, to turn a policy slug into a readable subject line; no
 *                 Spine-A insurance DATES or amounts feed any condition here.
 * @param referenceDateIso Optional day-count reference (YYYY-MM-DD); the brief passes its RUN
 *                 date so "expires in Nd" tracks today (frozen-dateline defect, 2026-07).
 *                 Defaults to snapshot.meta.asOf for backward compatibility.
 * @param currentRowsOverride Pre-fetched, already-current-term rows (fetchCurrentInsuranceRows(db)),
 *                 for a caller (server/brief/run.ts) that also calls
 *                 insuranceWarehouseDriftConditions in the same pass and wants to share one
 *                 fetch+collapse instead of paying for it twice. Omit to have this function fetch
 *                 for itself (unchanged default behavior, what every existing test relies on).
 * @returns        Insight[] sorted by id (lexicographic) for deterministic output.
 */
export function insuranceConditions(
  db: WarehouseDb,
  snapshot: PortfolioSnapshot,
  referenceDateIso?: string,
  currentRowsOverride?: PolicyRow[],
): Insight[] {
  const asOf = referenceDateIso ?? snapshot.meta.asOf;

  // CURRENT-TERM REDUCTION (2026-08-17, sweep-completer refute finding): this condition used to
  // read raw, uncollapsed rows. A rolled-over policy's stale prior term still has the
  // (already-past-due) near-term expiry that made it "soonest" in the per-property min-days pick
  // below, so the ALREADY-RENEWED policy fired a false CRITICAL "expires in N days — renew
  // immediately" alert while its actual (rolled, ~1-year-out) term sat unalarmed in the same
  // table. Verified live 2026-08-17 against production data: 1900 Broadway's BCL and UFX policies
  // both false-alarmed this way, feeding server/brief/run.ts's criticalIds -> email/daily-brief
  // path. Reusing insurance-analysis.ts's collapseToCurrentTerm (rather than a second
  // implementation) is what keeps this condition and buildInsuranceAnalysis from silently
  // drifting apart again.
  const currentRows = currentRowsOverride ?? fetchCurrentInsuranceRows(db);

  const masterNames = loadMasterNames(db);
  const resolveOwner = buildOwnerResolver(snapshot, masterNames);

  // Property ids with at least one warehouse policy row (for the gap check). In production
  // property_id holds policy-line keys ('ins-<stem>-<line>'), so each resolves through the
  // explicit stem table (insurance-property-map.ts) to its property_master id; `?? r.property_id`
  // keeps plain ids as-is, and a key the table cannot place on a master row stays raw and covers
  // nothing — no inferred attribution (the token matcher the 2026-08-11 note rejected
  // mis-attributed 4 of 25). Reads from currentRows, not a second raw fetch —
  // collapseToCurrentTerm never drops a property_id (see fetchCurrentInsuranceRows' doc).
  const coveredIds = new Set<string>(
    currentRows.map((r) => resolveInsuranceProperty(r.property_id, masterNames).propertyId ?? r.property_id),
  );

  // ── Condition 1: insurance-expiry-soon ──────────────────────────────────
  // Deduplicate by raw property_id VALUE, soonest-expiring row winning within a value. In
  // production those values are policy slugs, so this is one insight per POLICY (intended --
  // see the header note); it collapses genuine duplicates only where a value repeats.
  // This prevents duplicate insight IDs when a property has multiple policy rows
  // (the schema allows multiple rows per property_id via the UNIQUE on
  // (property_id, policy_number, effective_date)).
  const expiryMap = new Map<string, ExpiryCandidate>();

  for (const row of currentRows) {
    if (!row.expiration_date) continue; // no date → cannot compute days; skip

    const days = daysBetween(row.expiration_date, asOf);

    // 0 <= days <= EXPIRY_ALERT_DAYS (inclusive): upcoming renewal window.
    // days < 0 = already expired; not surfaced here (a different concern).
    if (days < 0 || days > EXPIRY_ALERT_DAYS) continue;

    const existing = expiryMap.get(row.property_id);
    // Keep the soonest-expiring policy (smallest days) as the most urgent signal.
    if (!existing || days < existing.days) {
      expiryMap.set(row.property_id, {
        days,
        expirationDate: row.expiration_date,
        premium: coercePremium(row.premium_annual),
        policyType: row.policy_type,
      });
    }
  }

  const out: Insight[] = [];

  for (const [rawId, candidate] of expiryMap) {
    // The insight id stays keyed on the raw column so existing alert-state entries keep
    // matching (changing it would re-alert every open policy once). Only the human-facing
    // title is resolved — that is what reaches Gabriel's subject line.
    const owner = resolveOwner(rawId);
    const coverage = owner.coverage ?? candidate.policyType;
    out.push({
      id: `ins-expiry-${rawId}`,
      severity: 'critical',
      category: 'insurance',
      title: `Insurance expiring soon — ${owner.label}${coverage ? ` · ${coverage}` : ''}`,
      detail: `Policy expires in ${candidate.days} day${candidate.days === 1 ? '' : 's'} (${candidate.expirationDate}). Renew or replace immediately.`,
      entityType: 'insurance',
      entityId: rawId,
      action: { label: 'Review policy', kind: 'review' },
      impactAnnualUsd: candidate.premium,
      spine: 'B',
      provenance: 'real',
    });
  }

  // ── Condition 2: insurance-gap ────────────────────────────────────────────
  for (const prop of snapshot.properties) {
    if (coveredIds.has(prop.id)) continue; // has at least one policy row

    out.push({
      id: `ins-gap-${prop.id}`,
      severity: 'warning',
      category: 'insurance',
      title: `No insurance policy on file — ${prop.name}`,
      detail: `Property "${prop.name}" has no entry in the insurance policy warehouse. Verify coverage and upload policy data.`,
      entityType: 'property',
      entityId: prop.id,
      action: { label: 'Review policy', kind: 'review' },
      impactAnnualUsd: null,
      spine: 'B',
      provenance: 'absent',
    });
  }

  // ── Condition 2.5: insurance-possible-gapped-rollover — severity: warning ────────────────
  // sameLineage (insurance-analysis.ts) requires EXACT-DAY adjacency (old.expiration_date ===
  // new.effective_date) before treating two same-property/same-policy_type rows as one rollover
  // — see that file's 2026-08-21 fix, which closed a false-MERGE bug. A real renewal whose dates
  // are off by a day or more (a carrier date-convention difference, an admin gap) is NOT caught
  // by that rule: both rows survive collapseToCurrentTerm as "distinct concurrent" policies, so
  // buildInsuranceAnalysis double-counts the stale term's premium in premiumAnnualTotal/policiesN,
  // and the stale term's now-past-due expiration can re-fire Condition 1's CRITICAL "renew
  // immediately" alert on coverage that has already been renewed (2026-08-24 integrity sweep,
  // Finding 4). No real gapped rollover has been verified in this portfolio's data, so
  // sameLineage's threshold stays exact per that fix's own reasoning — this condition instead
  // surfaces the FIRST one as a review item rather than letting it silently double-count or
  // false-alarm: same property + same policy_type, no shared policy_number, non-overlapping, and
  // within GAPPED_ROLLOVER_WINDOW_DAYS of each other in either direction.
  // "Same property" here is the RAW policy line (a.property_id), deliberately — this condition
  // catches what collapseToCurrentTerm, which groups on the raw line, failed to merge; two
  // different lines at one property (e.g. a carrier switch that opened a new line key) are
  // distinct policies by that rule. Only the title resolves to the property name.
  for (let i = 0; i < currentRows.length; i++) {
    for (let j = i + 1; j < currentRows.length; j++) {
      const a = currentRows[i]!;
      const b = currentRows[j]!;
      if (a.property_id !== b.property_id) continue;
      if (a.policy_type.trim().toLowerCase() !== b.policy_type.trim().toLowerCase()) continue;
      if (a.policy_number !== null && a.policy_number === b.policy_number) continue; // already one lineage
      if (!a.expiration_date || !a.effective_date || !b.expiration_date || !b.effective_date) continue;

      // Try both orderings: does a's term end shortly before b's starts, or vice versa?
      const gaps: Array<{ olderExpiry: string; newerEffective: string }> = [
        { olderExpiry: a.expiration_date, newerEffective: b.effective_date },
        { olderExpiry: b.expiration_date, newerEffective: a.effective_date },
      ];
      for (const { olderExpiry, newerEffective } of gaps) {
        const gapDays = daysBetween(newerEffective, olderExpiry);
        // gapDays === 0 is exact adjacency — sameLineage already merged that case, so it cannot
        // reach here as two separate rows. A negative gap is overlap, a different (existing)
        // data-quality concern, not a gapped rollover.
        if (gapDays <= 0 || gapDays > GAPPED_ROLLOVER_WINDOW_DAYS) continue;
        const pairId = [a.id, b.id].sort((x, y) => x - y).join('-');
        // Sane data can only satisfy this branch for ONE of the two orderings above -- but a row
        // with effective_date AFTER expiration_date (corrupt source dates, unvalidated on capture)
        // can satisfy BOTH, which would push two insights sharing the identical id `pairId` (PR #302
        // review, LOW). `break` after the first hit: one pair, one insight, regardless of how many
        // orderings would otherwise qualify.
        out.push({
          id: `ins-gapped-rollover-${pairId}`,
          severity: 'warning',
          category: 'insurance',
          title: `Possible gapped policy rollover — ${resolveOwner(a.property_id).label}`,
          detail: `Two ${a.policy_type} policies at property_id "${a.property_id}" are ${gapDays} day(s) apart (one expires ${olderExpiry}, the other becomes effective ${newerEffective}) with no shared policy number — they were NOT merged as one rollover and both count toward premium/policy totals. Confirm whether this is a single renewal (fix the source dates or add the shared policy number) or two genuinely distinct policies.`,
          entityType: 'insurance',
          entityId: a.property_id,
          action: { label: 'Review policy', kind: 'review' },
          impactAnnualUsd: null,
          spine: 'B',
          provenance: 'real',
        });
        break;
      }
    }
  }

  // Deterministic sort: expiry insights (id starts 'ins-expiry-') sort before gap-family insights
  // ('ins-gap-', 'ins-gapped-rollover-') because 'e' < 'g'. Within each kind, ordering is
  // lexicographic on id. Stable because ids are unique per-property (or per-pair).
  out.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  return out;
}

// ── Condition 3: insurance-warehouse-drift ──────────────────────────────────
//
// Cross-checks Source A ("workbook rows" — the LIVE read of PortfolioSnapshot.insurance[],
// straight off the Insurance Renewals tab) against Source B ("warehouse rows" —
// property_insurance_policies, a periodic BATCH snapshot of that same tab written at ingest
// time). Until now these were only ever compared by hand. Joined on `property_id` /
// `insurance[].id`, which are the SAME key on both sides: both are `slug(RowID)`
// (server/workbook/parse.ts's parseInsurance sets `id: slug(rowId)`; server/warehouse/
// insurance.ts's snapshotPoliciesToWarehouse sets `propertyId: p.id`) — unlike the
// property-name join above (coveredIds), this join is exact by construction, not heuristic.
//
// Two independent findings, checked in this priority order for a given property_id:
//
//   1. INGEST DRIFT (warning) — the stored `expiration_date` (warehouse) and the live
//      `expires` (workbook) disagree. This is the EXPECTED shape of the warehouse being a
//      periodic snapshot rather than a live mirror — Gabriel's 2026-08-15 finding (FVC,
//      3883 Livingston) is exactly this: the workbook was hand-corrected and the warehouse
//      had not yet re-ingested. The insight states both dates plainly and does NOT assert
//      which side is stale: an earlier warehouse date is consistent with the warehouse
//      lagging a later workbook correction, but a correction that pulls the workbook date
//      EARLIER (as in the FVC case) leaves the warehouse holding the LATER of the two — so
//      "earlier = stale" is not a safe inference in general. Re-ingesting resolves this
//      class regardless of direction.
//
//   2. LOGIC DISAGREEMENT (warning) — the two dates AGREE, but the computed lapsed/expired
//      VERDICT differs: the warehouse side is a pure date comparison
//      (`expiration_date < asOf`), the workbook side is its own live Status column
//      (Expired/Cancelled — a `=TODAY()`-driven formula, column K in the workbook). Same
//      input, different output means the two systems compute "lapsed" differently, which a
//      matching date can otherwise mask. Checked only when case 1 does NOT fire — a date
//      mismatch already explains any verdict difference on that row, so firing both would
//      be redundant noise describing the same underlying fact.
//
// Both severities are 'warning' and category 'data' (not 'insurance'): this reports a
// data-RECONCILIATION finding — the two systems disagree — not a coverage claim; the coverage
// claim itself belongs to insurance-expiry-soon/insurance-gap above and to
// src/analytics/conditions.ts's ins-lapsed-*/ins-lapsed-live-* conditions. 'warning' keeps this
// out of the immediate per-critical alert email (server/brief/run.ts's criticalIds filter);
// it still reaches Gabriel via the existing brief digest / Notion Ops Hub path once merged into
// the same `insights` array insuranceConditions() feeds — no new notification channel.
//
// A property_id with no matching row on the OTHER side is skipped, not flagged: that gap is
// insurance-gap's job (warehouse side) or simply not yet ingested (workbook-only side), and is
// not evidence of drift. A missing date on either side is likewise skipped — nothing to compare.
//
// PURE — no mutations of inputs. Never throws (callers guard with try/catch, matching
// insuranceConditions above). DETERMINISTIC — sorted by id (lexicographic).
type DriftPolicyRow = CollapsibleInsuranceRow;

/**
 * Pick the warehouse row that best represents the CURRENT term for a property_id that has
 * multiple rows on file (the schema's UNIQUE spans policy_number + effective_date, so a prior
 * term's row can sit alongside the current one).
 *
 * Reuses insurance-analysis.ts's collapseToCurrentTerm rather than a second, independently-tuned
 * comparator (2026-08-17: the prior version here ordered by max-effective_date with no
 * source_date signal at all — the same unsound "datedness beats capture recency" defect an
 * adversarial refute pass found in the original collapseToCurrentTerm, which would have let a
 * corrected/backdated effective_date get permanently masked here too). `rows` is already scoped
 * to one property_id by the caller; collapseToCurrentTerm can in principle return more than one
 * row — not just the documented "genuinely distinct concurrent policy" case, but also more than
 * one policy_type sharing this property_id/slug (logRebidVerdicts' own doc: "several policies can
 * share one property_id") — this comparison only wants ONE representative for the date-drift
 * check below.
 *
 * FIXED 2026-08-21 (adversarial review finding): picking purely by max source_date across
 * collapseToCurrentTerm's output silently compared across policy_type when more than one existed
 * for this property_id — e.g. a General Liability row's expiration_date getting diffed against
 * the live workbook's Property coverage, producing a spurious drift/lapse-disagreement alert for
 * the wrong coverage entirely. Now prefers whichever cluster's policy_type matches the live
 * workbook's `coverage` label (the coverage this comparison is actually checking); only falls
 * back to mixing types by pure recency when no type match exists, or the live coverage is
 * unknown — fail-open, matching this module's doctrine (a coarse comparison beats none).
 *
 * FIXED 2026-08-24 (integrity sweep, Finding 7): the reduce below used to tie-break on
 * source_date alone, with no fallback — and a tie is the COMMON case, not an edge, because
 * snapshotPoliciesToWarehouse stamps ONE uniform source_date on every policy in a single capture
 * batch. With no further tie-break, the winner was whichever row happened to come first in
 * SQLite's unordered SELECT — which churns between runs because migration 008's AUTOINCREMENT id
 * gets reassigned on every INSERT OR REPLACE re-capture. Demonstrated: two same-source-date rows,
 * reversing their row order flipped this function's pick and therefore flipped the drift/lapse
 * verdict with zero change in the underlying data. isMoreCurrentRow below gives this the same
 * total order insurance-analysis.ts's isMoreCurrent already uses elsewhere in this module
 * (source_date, then effective_date, then id) so a genuine tie can no longer exist.
 */
export function isMoreCurrentRow(a: DriftPolicyRow, b: DriftPolicyRow): boolean {
  if (a.source_date !== b.source_date) return a.source_date > b.source_date;
  // Compare the COALESCED values, not the raw ones (PR #302 review, LOW): comparing raw
  // a.effective_date !== b.effective_date first meant the pair (null, '') counted as "different"
  // without ever reaching a comparable state -- neither coalesced-null-safe compare would fire,
  // silently skipping the id fallback for an otherwise-tied pair. Not reachable on live data today
  // (source_date is NOT NULL and no row has an empty-string effective_date), but coalescing before
  // the inequality check makes this a genuine total order rather than one with an incomparable edge.
  const aEff = a.effective_date ?? '';
  const bEff = b.effective_date ?? '';
  if (aEff !== bEff) return aEff > bEff;
  return a.id > b.id;
}

function pickCurrentRow(rows: DriftPolicyRow[], liveCoverage: string | null): DriftPolicyRow {
  const current = collapseToCurrentTerm(rows);
  if (liveCoverage) {
    const norm = liveCoverage.trim().toLowerCase();
    const matching = current.filter((r) => r.policy_type.trim().toLowerCase() === norm);
    if (matching.length > 0) {
      return matching.reduce((best, r) => (isMoreCurrentRow(r, best) ? r : best));
    }
  }
  return current.reduce((best, r) => (isMoreCurrentRow(r, best) ? r : best));
}

/**
 * Evaluate the warehouse-vs-live-workbook insurance cross-check.
 *
 * @param db       Open WarehouseDb (caller owns lifecycle).
 * @param snapshot PortfolioSnapshot — snapshot.insurance[] is the LIVE workbook read
 *                 (Source A for this comparison); snapshot.meta.asOf is the day-count fallback.
 * @param referenceDateIso Optional day-count reference (YYYY-MM-DD), mirroring
 *                 insuranceConditions above. Defaults to snapshot.meta.asOf.
 * @param currentRowsOverride Pre-fetched, already-current-term rows (fetchCurrentInsuranceRows(db)),
 *                 shared with insuranceConditions above when a caller (server/brief/run.ts) runs
 *                 both in the same pass. Omit to have this function fetch for itself (unchanged
 *                 default behavior, what every existing test relies on).
 * @returns        Insight[] sorted by id (lexicographic).
 */
export function insuranceWarehouseDriftConditions(
  db: WarehouseDb,
  snapshot: PortfolioSnapshot,
  referenceDateIso?: string,
  currentRowsOverride?: PolicyRow[],
): Insight[] {
  const asOf = referenceDateIso ?? snapshot.meta.asOf;

  // Already current-term (one row per property_id+policy_type cluster) when shared via
  // currentRowsOverride — pickCurrentRow's own collapseToCurrentTerm call below still runs, but
  // over an already-singleton-per-type set, so it's a cheap pass-through rather than a second
  // full scan+clustering pass (2026-08-21 fix — see fetchCurrentInsuranceRows' doc).
  const rows: DriftPolicyRow[] = currentRowsOverride ?? fetchCurrentInsuranceRows(db);

  const rowsByPropertyId = new Map<string, DriftPolicyRow[]>();
  for (const row of rows) {
    const list = rowsByPropertyId.get(row.property_id);
    if (list) list.push(row);
    else rowsByPropertyId.set(row.property_id, [row]);
  }

  // `?? []` guards a snapshot missing the key entirely (fresh worktree / mirror), matching
  // buildOwnerResolver above — a throw here would silently drop this condition inside run.ts's
  // catch-all.
  const liveById = new Map((snapshot.insurance ?? []).map((p) => [p.id, p]));

  const out: Insight[] = [];

  for (const [propertyId, candidateRows] of rowsByPropertyId) {
    const live = liveById.get(propertyId);
    if (!live) continue; // no matching live-workbook row on file — not a drift, just not joinable

    const warehouseRow = pickCurrentRow(candidateRows, live.coverage);
    const warehouseExpiry = warehouseRow.expiration_date;
    const liveExpiry = live.expires;

    if (!warehouseExpiry || !liveExpiry) continue; // nothing to compare on one side

    const coverage = live.coverage ? ` · ${live.coverage}` : '';

    if (warehouseExpiry !== liveExpiry) {
      out.push({
        id: `insurance-warehouse-drift-${propertyId}`,
        severity: 'warning',
        category: 'data',
        title: `Insurance date mismatch — warehouse vs workbook — ${live.property}${coverage}`,
        detail: `Warehouse expiration ${warehouseExpiry} vs live workbook expiration ${liveExpiry} for the same policy. One source is stale relative to the other — the warehouse is a periodic batch snapshot and can lag a workbook correction, but the workbook can also be the one that changed. Re-ingest to confirm which is current.`,
        entityType: 'insurance',
        entityId: propertyId,
        action: { label: 'Review policy', kind: 'review' },
        impactAnnualUsd: null,
        spine: 'B',
        provenance: 'derived',
      });
      continue; // date drift already explains any verdict difference on this row
    }

    // Dates agree — check whether the two sides compute the SAME lapsed verdict from it.
    const warehouseLapsed = warehouseExpiry < asOf;
    const liveLapsed = live.status === 'Expired' || live.status === 'Cancelled';

    if (warehouseLapsed !== liveLapsed) {
      out.push({
        id: `insurance-warehouse-drift-logic-${propertyId}`,
        severity: 'warning',
        category: 'data',
        title: `Insurance lapse verdict disagreement — ${live.property}${coverage}`,
        detail: `Both sources agree on expiration ${warehouseExpiry}, but the warehouse date-check reads ${warehouseLapsed ? 'LAPSED' : 'current'} while the workbook Status column reads "${live.status}". Same input, different verdict — investigate before trusting either.`,
        entityType: 'insurance',
        entityId: propertyId,
        action: { label: 'Review policy', kind: 'review' },
        impactAnnualUsd: null,
        spine: 'B',
        provenance: 'derived',
      });
    }
  }

  out.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  return out;
}
