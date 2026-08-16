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
//
//   insurance-gap          — severity: warning
//     Fires for every Property in snapshot.properties with NO matching row in
//     property_insurance_policies (i.e. we have no policy on file at all).
//     ⚠ CURRENTLY OVER-FIRES (verified 2026-08-11): the match is against the raw property_id
//     column, which holds policy slugs, so it matches 0 of 14 properties and this warns on
//     EVERY property regardless of actual coverage. Not fixed here — see the coveredIds
//     comment below for why the two obvious joins are both unsafe. Warning severity only:
//     these never generate an email, they only add noise to the brief digest.
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
// BOUNDARY: policies expiring within this window (inclusive) → critical alert.
const EXPIRY_ALERT_DAYS = 60;

interface PolicyRow {
  property_id: string;
  expiration_date: string | null;
  premium_annual: number | null;
  policy_type: string | null;
}

/** What a warehouse `property_id` value actually points at, once resolved. */
interface ResolvedOwner {
  /** Best available human label for the subject line. Never empty. */
  label: string;
  /** Coverage/policy-type label, when one is known. */
  coverage: string | null;
}

/**
 * Resolve a warehouse `property_id` into a human-readable LABEL for the alert subject.
 *
 * DISPLAY ONLY. This deliberately does not attempt to produce a property id: an exact name
 * join resolves 0 of 25 in production (see the coveredIds comment in insuranceConditions),
 * and inferring one by token matching mis-attributes 4 of 25 — a wrong property name in a
 * CRITICAL subject is worse than a raw slug. Labelling has no such hazard, because the
 * fallback chain never invents an attribution it doesn't have.
 *
 * The column holds POLICY-level slugs ("ins-fvc-pckg") in production, not property ids —
 * 25 rows, 25 distinct values, 0 matching a property id directly. Resolution runs:
 * direct property id → policy slug via `snapshot.insurance[]` (whose `.property` carries the
 * property's descriptive address) → give up and use the raw value. Every branch FAILS OPEN:
 * the alert always fires, because a policy we can't attribute is not a reason to go quiet
 * about it expiring.
 */
function buildOwnerResolver(snapshot: PortfolioSnapshot): (rawId: string) => ResolvedOwner {
  const propertiesById = new Map(snapshot.properties.map((p) => [p.id, p]));
  // `?? []` guards a snapshot missing the key entirely: insuranceConditions runs inside
  // run.ts's catch-all, where any throw here silently drops EVERY insurance critical.
  const policiesById = new Map((snapshot.insurance ?? []).map((i) => [i.id, i]));

  return (rawId: string): ResolvedOwner => {
    const direct = propertiesById.get(rawId);
    if (direct) return { label: direct.name, coverage: null };

    const policy = policiesById.get(rawId);
    if (policy) return { label: policy.property, coverage: policy.coverage };

    return { label: rawId, coverage: null };
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
 * @returns        Insight[] sorted by id (lexicographic) for deterministic output.
 */
export function insuranceConditions(
  db: WarehouseDb,
  snapshot: PortfolioSnapshot,
  referenceDateIso?: string,
): Insight[] {
  const asOf = referenceDateIso ?? snapshot.meta.asOf;

  // Read all policy rows (light: only three columns needed).
  const rows = db
    .prepare(
      'SELECT property_id, expiration_date, premium_annual, policy_type FROM property_insurance_policies',
    )
    .all() as PolicyRow[];

  const resolveOwner = buildOwnerResolver(snapshot);

  // Set of raw property_id values that have at least one warehouse policy row (for gap check).
  //
  // KNOWN BROKEN, deliberately left unfixed here (2026-08-11): in production these are policy
  // slugs, so this set never intersects `prop.id` and EVERY property is reported as having no
  // policy on file. Resolving it needs a real slug->property mapping — the obvious fixes both
  // fail: an exact name join matches 0 of 25 (the display names disagree on abbreviation and
  // ZIP -- "55 New Plant Court, Owings Mills MD 21117" vs "55 New Plant Ct, Owings Mills MD"),
  // and parse.ts's token matcher resolves 24 of 25 but MIS-ATTRIBUTES 4, because "columbus"
  // matches whichever Columbus property comes first -- which would put a wrong property name
  // into a CRITICAL alert. Deferred to its own change with an explicit, auditable mapping
  // table and a fixture built from the real policy strings. These are warning-severity and
  // never email, so the cost is brief noise, not a missed alert.
  const coveredIds = new Set<string>(rows.map((r) => r.property_id));

  // ── Condition 1: insurance-expiry-soon ──────────────────────────────────
  // Deduplicate by raw property_id VALUE, soonest-expiring row winning within a value. In
  // production those values are policy slugs, so this is one insight per POLICY (intended --
  // see the header note); it collapses genuine duplicates only where a value repeats.
  // This prevents duplicate insight IDs when a property has multiple policy rows
  // (the schema allows multiple rows per property_id via the UNIQUE on
  // (property_id, policy_number, effective_date)).
  const expiryMap = new Map<string, ExpiryCandidate>();

  for (const row of rows) {
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

  // Deterministic sort: expiry insights (id starts 'ins-expiry-') sort before
  // gap insights ('ins-gap-') because 'e' < 'g'. Within each kind, property_id
  // ordering is lexicographic. Stable because ids are unique per-property.
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
interface DriftPolicyRow {
  id: number;
  property_id: string;
  expiration_date: string | null;
  effective_date: string | null;
}

/**
 * Pick the warehouse row that best represents the CURRENT term for a property_id that has
 * multiple rows on file (the schema's UNIQUE spans policy_number + effective_date, so a prior
 * term's row can sit alongside the current one). Greatest effective_date wins; ties broken by
 * greatest expiration_date, then by highest row id (insertion order) for full determinism.
 */
function pickCurrentRow(rows: DriftPolicyRow[]): DriftPolicyRow {
  return [...rows].sort((a, b) => {
    const ae = a.effective_date ?? '';
    const be = b.effective_date ?? '';
    if (ae !== be) return ae < be ? 1 : -1;
    const aex = a.expiration_date ?? '';
    const bex = b.expiration_date ?? '';
    if (aex !== bex) return aex < bex ? 1 : -1;
    return b.id - a.id;
  })[0]!;
}

/**
 * Evaluate the warehouse-vs-live-workbook insurance cross-check.
 *
 * @param db       Open WarehouseDb (caller owns lifecycle).
 * @param snapshot PortfolioSnapshot — snapshot.insurance[] is the LIVE workbook read
 *                 (Source A for this comparison); snapshot.meta.asOf is the day-count fallback.
 * @param referenceDateIso Optional day-count reference (YYYY-MM-DD), mirroring
 *                 insuranceConditions above. Defaults to snapshot.meta.asOf.
 * @returns        Insight[] sorted by id (lexicographic).
 */
export function insuranceWarehouseDriftConditions(
  db: WarehouseDb,
  snapshot: PortfolioSnapshot,
  referenceDateIso?: string,
): Insight[] {
  const asOf = referenceDateIso ?? snapshot.meta.asOf;

  const rows = db
    .prepare(
      'SELECT id, property_id, expiration_date, effective_date FROM property_insurance_policies',
    )
    .all() as DriftPolicyRow[];

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

    const warehouseRow = pickCurrentRow(candidateRows);
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
