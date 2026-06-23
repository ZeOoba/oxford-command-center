// server/warehouse/insurance-conditions.ts
//
// Server-side insurance alert conditions (Phase 5).
// Reads property_insurance_policies (migration 008) from the warehouse DB and
// returns Insight[] for two conditions:
//
//   insurance-expiry-soon  — severity: critical
//     Fires when ANY policy for a property has expiration_date 0..60 days away
//     (inclusive on 60). One insight per PROPERTY (not per row): multiple policies
//     for the same property are deduplicated — the soonest-expiring policy wins so
//     the detail always describes the most urgent renewal. Insight id is stable:
//     `ins-expiry-<propertyId>`.
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
}

/**
 * Evaluate warehouse-sourced insurance alert conditions against a snapshot.
 *
 * @param db       Open WarehouseDb (caller owns lifecycle).
 * @param snapshot PortfolioSnapshot (Spine A) — only snapshot.properties[] and
 *                 snapshot.meta.asOf are consumed; no Spine-A insurance data used.
 * @returns        Insight[] sorted by id (lexicographic) for deterministic output.
 */
export function insuranceConditions(
  db: WarehouseDb,
  snapshot: PortfolioSnapshot,
): Insight[] {
  const asOf = snapshot.meta.asOf;

  // Read all policy rows (light: only three columns needed).
  const rows = db
    .prepare(
      'SELECT property_id, expiration_date, premium_annual FROM property_insurance_policies',
    )
    .all() as PolicyRow[];

  // Set of property_ids that have at least one warehouse policy row (for gap check).
  const coveredIds = new Set<string>(rows.map((r) => r.property_id));

  // ── Condition 1: insurance-expiry-soon ──────────────────────────────────
  // Deduplicate by property_id: one insight per property, soonest-expiring row wins.
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
      });
    }
  }

  const out: Insight[] = [];

  for (const [propertyId, candidate] of expiryMap) {
    out.push({
      id: `ins-expiry-${propertyId}`,
      severity: 'critical',
      category: 'insurance',
      title: `Insurance expiring soon — ${propertyId}`,
      detail: `Policy expires in ${candidate.days} day${candidate.days === 1 ? '' : 's'} (${candidate.expirationDate}). Renew or replace immediately.`,
      entityType: 'insurance',
      entityId: propertyId,
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
