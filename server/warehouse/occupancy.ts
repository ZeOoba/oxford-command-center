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
 * Bulk-record occupancy snapshots from a workbook snapshot.
 * Skips properties where occPct is not a finite number.
 */
export function recordOccupancyBatch(
  db: WarehouseDb,
  properties: ReadonlyArray<{ id: string; occPct: number }>,
  asOf: string,
  source: OccupancySource = 'workbook',
): { recorded: number; skipped: number } {
  let recorded = 0;
  let skipped = 0;
  const upsert = db.prepare(
    `INSERT INTO property_occupancy (property_id, as_of, occ_pct, source)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (property_id, as_of, source) DO UPDATE SET occ_pct = excluded.occ_pct`,
  );
  const run = db.transaction(() => {
    for (const p of properties) {
      if (!Number.isFinite(p.occPct) || p.occPct < 0 || p.occPct > 1) {
        skipped++;
        continue;
      }
      upsert.run(p.id, asOf, p.occPct, source);
      recorded++;
    }
  });
  run();
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

/**
 * Return the most recent occupancy snapshot per property (latest as_of per property_id).
 * Useful for dashboard current-state views.
 */
export function latestOccupancyByProperty(db: WarehouseDb): OccupancyPoint[] {
  return db
    .prepare(
      `SELECT property_id AS propertyId, as_of AS asOf, occ_pct AS occPct, source
       FROM property_occupancy
       WHERE (property_id, as_of) IN (
         SELECT property_id, MAX(as_of) FROM property_occupancy GROUP BY property_id
       )
       ORDER BY property_id ASC`,
    )
    .all() as OccupancyPoint[];
}
