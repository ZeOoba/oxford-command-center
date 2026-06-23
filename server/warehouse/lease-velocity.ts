// server/warehouse/lease-velocity.ts — Phase 3 W1 Spine B Leasing Velocity
//
// Computes per-property leasing velocity (median days from vacate to commence)
// from the lease_events table (migration 011). Spine B — DB-reading.
//
// Where warehouse has no vacancy/turnover history, returns medianDaysToLease: null,
// leasingEventsN: 0, slowLeasing: false. NEVER fabricates a number.
//
// v1 derives medianDaysToLease from vacate→commence gaps within lease_events for the
// same (property_id, suite) pair. Multi-tenant suite-level velocity; single-tenant
// uses suite=null (treats all null-suite events in a property as the same "unit").
import type { WarehouseDb } from './db';
import type { LeasingVelocity } from '../../src/contracts/lease-forecast';
import { VELOCITY_SLOW_DAYS } from '../../src/analytics/lease-forecast';
import { DAY_MS } from './time-constants';

// Re-export so tests can import from one place
export { VELOCITY_SLOW_DAYS };

// ── Types ─────────────────────────────────────────────────────────────────────
interface LeaseEventRow {
  property_id: string;
  suite: string | null;
  event_kind: 'vacate' | 'commence';
  event_date: string; // ISO YYYY-MM-DD
}

/** Median of a sorted numeric array. Returns null if empty. */
function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1]! + sorted[mid]!) / 2)
    : sorted[mid]!;
}

/**
 * Compute per-property leasing velocity (median days vacate→commence).
 *
 * Algorithm (suite-aware):
 *   For each (property_id, suite) pair:
 *     Sort events chronologically.
 *     Walk pairs: find a 'vacate' event, then the next 'commence' after it.
 *     Compute daysBetween; collect into the property's gap array.
 *   Median over all gaps in the property → medianDaysToLease.
 *   leasingEventsN = count of matched vacate→commence pairs.
 *   slowLeasing = medianDaysToLease !== null && medianDaysToLease > VELOCITY_SLOW_DAYS.
 *
 * @param db - Warehouse DB (migration 011 must have run).
 * @param properties - Property list for name lookup (from snapshot).
 */
export function leasingVelocity(
  db: WarehouseDb,
  properties: { id: string; name: string }[],
): LeasingVelocity[] {
  // Read all lease events ordered by property+suite+date
  let events: LeaseEventRow[];
  try {
    events = db.prepare(`
      SELECT property_id, suite, event_kind, event_date
      FROM lease_events
      ORDER BY property_id ASC, suite ASC NULLS FIRST, event_date ASC,
               CASE event_kind WHEN 'vacate' THEN 0 ELSE 1 END ASC,
               id ASC
    `).all() as LeaseEventRow[];
  } catch (err) {
    // Fail open only when migration 011 table is absent; rethrow all other errors.
    if (err instanceof Error && /no such table:\s*lease_events/i.test(err.message)) {
      events = [];
    } else {
      throw err;
    }
  }

  // Build property name map for display
  const propNames = new Map<string, string>(properties.map((p) => [p.id, p.name]));

  // Group events by (property_id, suite) key
  const groups = new Map<string, LeaseEventRow[]>();
  for (const ev of events) {
    // Use null as the suite key for single-tenant (null suite)
    const key = `${ev.property_id}::${ev.suite ?? '__null__'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(ev);
  }

  // Per-property: collect gap arrays
  const propGaps = new Map<string, number[]>();
  for (const [key, evs] of groups) {
    const propertyId = key.split('::')[0]!;
    if (!propGaps.has(propertyId)) propGaps.set(propertyId, []);
    const gaps = propGaps.get(propertyId)!;

    // Walk events chronologically, matching vacate→nearest-subsequent-commence pairs
    let pendingVacate: LeaseEventRow | null = null;
    for (const ev of evs) {
      if (ev.event_kind === 'vacate') {
        pendingVacate = ev;
      } else if (ev.event_kind === 'commence' && pendingVacate !== null) {
        // Compute days between vacate and commence
        const vacateMs = new Date(pendingVacate.event_date).getTime();
        const commenceMs = new Date(ev.event_date).getTime();
        const days = Math.round((commenceMs - vacateMs) / DAY_MS);
        if (days >= 0) {
          gaps.push(days);
        }
        pendingVacate = null; // consume the pair
      }
    }
  }

  // Collect all property IDs that appear in events
  const allPropertyIds = new Set<string>(events.map((e) => e.property_id));

  // Build result — only properties that appear in events (per V-1 spec: return [] when no events)
  const out: LeasingVelocity[] = [];
  for (const propertyId of allPropertyIds) {
    const gaps = propGaps.get(propertyId) ?? [];
    const sortedGaps = [...gaps].sort((a, b) => a - b);
    const med = median(sortedGaps);
    out.push({
      propertyId,
      propertyName: propNames.get(propertyId) ?? propertyId,
      medianDaysToLease: med,
      leasingEventsN: gaps.length,
      slowLeasing: med !== null && med > VELOCITY_SLOW_DAYS,
    });
  }

  return out;
}
