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
