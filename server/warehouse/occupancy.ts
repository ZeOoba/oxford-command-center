// server/warehouse/occupancy.ts
//
// PFI Phase 1 — Occupancy time-series. Stores and retrieves per-property
// occupancy snapshots sourced from the workbook PortfolioSnapshot (Property.occPct).
//
// Source discipline: these are workbook-side (rent-roll derived) snapshots, not P&L.
// The P&L warehouse pipeline (import_batches / ledger_entries) is income-statement only.
import type { WarehouseDb } from './db';

export type OccupancySource = 'workbook' | 'rent-roll' | 'manual';

export interface OccupancyPoint {
  propertyId: string;
  asOf: string;     // ISO date YYYY-MM-DD
  occPct: number;   // 0..1
  source: OccupancySource;
}

export interface RecordOccupancyInput {
  propertyId: string;
  asOf: string;
  occPct: number;
  source?: OccupancySource;
}

/**
 * Upsert one occupancy snapshot. Idempotent: a second call with the same
 * (propertyId, asOf, source) replaces the prior occPct — handles workbook re-exports
 * on the same date cleanly.
 */
export function recordOccupancy(db: WarehouseDb, input: RecordOccupancyInput): void {
  if (!Number.isFinite(input.occPct) || input.occPct < 0 || input.occPct > 1) {
    throw new RangeError(
      `occPct must be 0..1, got ${input.occPct} for property ${input.propertyId}`,
    );
  }
  db.prepare(
    `INSERT INTO property_occupancy (property_id, as_of, occ_pct, source)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (property_id, as_of, source) DO UPDATE SET occ_pct = excluded.occ_pct`,
  ).run(input.propertyId, input.asOf, input.occPct, input.source ?? 'workbook');
}

/**
 * Bulk-record occupancy snapshots. Skips (rather than aborts on) three classes of bad row, so a
 * single orphan or duplicate can never silently zero out the whole capture:
 *  - occPct not finite or outside [0,1];
 *  - a property absent from property_master — property_occupancy.property_id is an FK with
 *    foreign_keys=ON, and the loop runs in ONE transaction, so an unguarded orphan (e.g. the
 *    Potomac residence, excluded from the PFI income roster) would throw and roll back EVERY
 *    property's row, not just its own. Pre-filtering to known master ids prevents that;
 *  - a duplicate id within the batch — first occurrence wins. This makes the COUNT order-independent;
 *    the stored VALUE is deterministic for the parser's stable workbook-row order. A duplicate id
 *    carrying a DIFFERENT occPct is a likely slug collision between two distinct properties (id =
 *    slug(name)); that is not silently resolved — it is console.warn'd so it surfaces.
 *
 * Fails LOUD (throws) when property_master is empty while there ARE properties to record: that means
 * the warehouse was never backfilled (the server opens the DB via migrations only — seedPropertyMaster
 * runs from scripts), and a silent {recorded:0} would invisibly drop occupancy history. Throwing lets
 * the caller's catch surface it. `recorded` counts DISTINCT keys written; `skipped` counts rejects.
 */
export function recordOccupancyBatch(
  db: WarehouseDb,
  properties: ReadonlyArray<{ id: string; occPct: number }>,
  asOf: string,
  source: OccupancySource = 'workbook',
): { recorded: number; skipped: number } {
  const validIds = new Set(
    (db.prepare('SELECT id FROM property_master').all() as Array<{ id: string }>).map((r) => r.id),
  );
  if (validIds.size === 0 && properties.length > 0) {
    throw new Error(
      'occupancy capture: property_master is empty — run `npm run warehouse:backfill` before capturing occupancy',
    );
  }
  const upsert = db.prepare(
    `INSERT INTO property_occupancy (property_id, as_of, occ_pct, source)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (property_id, as_of, source) DO UPDATE SET occ_pct = excluded.occ_pct`,
  );
  let recorded = 0;
  let skipped = 0;
  const orphanIds: string[] = []; // ids absent from property_master — for the roster-drift warning
  const seen = new Map<string, number>(); // id → first occPct seen (for collision detection)
  const run = db.transaction(() => {
    for (const p of properties) {
      // The range skip is load-bearing for the workbook source too: the parser clamps only the
      // UPPER bound (Math.min(occ,1)), not the lower — a negative cell would otherwise pass through.
      if (!Number.isFinite(p.occPct) || p.occPct < 0 || p.occPct > 1) { skipped++; continue; }
      if (!validIds.has(p.id)) { skipped++; orphanIds.push(p.id); continue; } // orphan — skip, don't abort
      if (seen.has(p.id)) {
        if (seen.get(p.id) !== p.occPct) {
          console.warn(
            `occupancy capture: duplicate id '${p.id}' with differing occPct ` +
              `(${seen.get(p.id)} vs ${p.occPct}) — keeping first; likely slug collision between distinct properties.`,
          );
        }
        skipped++; // duplicate id within the batch — first occurrence wins
        continue;
      }
      seen.set(p.id, p.occPct);
      upsert.run(p.id, asOf, p.occPct, source);
      recorded++;
    }
  });
  run();
  // Roster-drift signal: on a populated master, an orphan id means a snapshot property's slug did not
  // match any curated property_master id (e.g. a workbook name lost its city suffix). Residences and
  // other intentionally-excluded units are filtered upstream (captureOccupancy), so any orphan here is
  // unexpected and worth surfacing — a silent {recorded:n-1} would invisibly stall that property's series.
  if (orphanIds.length > 0) {
    console.warn(
      `occupancy capture: ${orphanIds.length} property id(s) not in property_master — skipped (possible roster/slug drift): ${orphanIds.join(', ')}`,
    );
  }
  return { recorded, skipped };
}

/**
 * Return occupancy history for one property, oldest-first.
 * Returns an empty array if no snapshots exist.
 */
export function occupancySeries(db: WarehouseDb, propertyId: string): OccupancyPoint[] {
  return db
    .prepare(
      `SELECT property_id AS propertyId, as_of AS asOf, occ_pct AS occPct, source
       FROM property_occupancy
       WHERE property_id = ?
       ORDER BY as_of ASC`,
    )
    .all(propertyId) as OccupancyPoint[];
}

/** Structural view of the workbook snapshot — only the fields captureOccupancy reads. */
export interface OccupancySnapshotView {
  properties: ReadonlyArray<{ id: string; occPct: number; type?: string }>;
  meta: { generatedAt: string };
}

/**
 * Derive the operator's (US-Eastern) calendar day from an ISO timestamp. ORA reports on Eastern
 * time; meta.generatedAt is a UTC instant (new Date().toISOString()). Slicing the UTC string would
 * bucket an evening-ET refresh (after ~20:00 ET = next UTC day) onto tomorrow's date and break
 * same-day idempotency near UTC midnight. Formatting in America/New_York fixes the attribution
 * (handles EDT/EST automatically). Returns null for an unparseable timestamp.
 */
function easternCalendarDay(iso: string | undefined | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // en-CA + explicit 2-digit fields → 'YYYY-MM-DD' in the Eastern zone.
  const out = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  // Guard the contract: 'numeric' year is minimal-digit, so a year < 1000 would emit an unpadded,
  // non-sortable string. Unreachable from a current toISOString() but cheap to make airtight.
  return /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : null;
}

/**
 * Bridge a workbook PortfolioSnapshot into the occupancy warehouse: record every property's occPct,
 * keyed on the CAPTURE date (in Eastern time). Called from brain.refresh() (via the server 'snapshot'
 * subscription) so occupancy history accumulates on every workbook change. A null snapshot
 * (degraded-mode startup) or an unparseable generatedAt is a safe no-op.
 *
 * Critical: we key on meta.generatedAt (the real per-refresh build timestamp), NOT meta.asOf.
 * meta.asOf is a static config constant (WORKBOOK_AS_OF, default '2026-06-01') that does not move
 * with the calendar or the workbook contents — keying on it would collapse every refresh onto a
 * single (property, asOf, source) row and the "time-series" would never accumulate beyond one point.
 * generatedAt advances each refresh, so the series gains one point per Eastern calendar day; multiple
 * refreshes on the same ET day idempotently overwrite that day's point (recordOccupancyBatch upserts).
 */
export function captureOccupancy(
  db: WarehouseDb,
  snapshot: OccupancySnapshotView | null,
): { recorded: number; skipped: number } {
  if (!snapshot) return { recorded: 0, skipped: 0 };
  const captureDate = easternCalendarDay(snapshot.meta.generatedAt);
  if (!captureDate) return { recorded: 0, skipped: 0 }; // malformed timestamp — no-op
  // Residences (e.g. the Potomac home) carry no commercial occupancy and have no property_master
  // row by design — exclude them so they are not flagged as roster-drift orphans (mirrors the
  // residence exclusion in reconcile-noi).
  const relevant = snapshot.properties.filter((p) => p.type !== 'Residence');
  return recordOccupancyBatch(db, relevant, captureDate, 'workbook');
}

/**
 * Return the most recent occupancy snapshot per property — exactly ONE row each. A same-date
 * multi-source tie (e.g. a 'manual' correction and a 'workbook' value sharing a max as_of) is
 * broken deterministically by source precedence (manual > rent-roll > workbook). The trailing
 * `source ASC` is a genuine total-order tiebreak: two sources that both fall in the precedence
 * CASE's ELSE bucket (a future/out-of-enum value) would otherwise tie on every key and let SQLite
 * row order decide — `source` disambiguates them regardless. (The prior `(property_id, as_of) IN
 * (… GROUP BY property_id)` form returned BOTH tied rows.)
 */
export function latestOccupancyByProperty(db: WarehouseDb): OccupancyPoint[] {
  return db
    .prepare(
      `SELECT propertyId, asOf, occPct, source FROM (
         SELECT property_id AS propertyId, as_of AS asOf, occ_pct AS occPct, source,
                ROW_NUMBER() OVER (
                  PARTITION BY property_id
                  ORDER BY as_of DESC,
                           CASE source WHEN 'manual' THEN 0 WHEN 'rent-roll' THEN 1 ELSE 2 END,
                           source ASC
                ) AS rn
         FROM property_occupancy
       )
       WHERE rn = 1
       ORDER BY propertyId ASC`,
    )
    .all() as OccupancyPoint[];
}
