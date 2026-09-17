// server/warehouse/entity-xref.ts
//
// Canonical identity across stores. This module stores and reads links; it does NOT normalize
// addresses — that is the lease-market module's normalizer (src/analytics/lease-market/
// normalize.ts, splitAddress), imported by the seeder rather than reimplemented. A second
// implementation that agrees with it today is precisely the drift this crosswalk exists to
// prevent, and that normalizer is actively changing.
//
// A wrong auto-link is worse than an unmatched row, because every later join inherits it
// silently, so anything short of an unambiguous match is reported to a human.
import type { WarehouseDb } from './db';

export type EntityType = 'property' | 'unit' | 'tenant' | 'lease';
export type MatchMethod = 'exact_id' | 'exact_address' | 'identity_key' | 'manual' | 'ambiguous';

export interface EntityLink {
  entityType: EntityType;
  canonicalId: string;
  system: string;
  externalId: string;
  matchMethod: MatchMethod;
  confidence?: number;
}

export interface UnmatchedRow {
  canonicalId: string;
  name: string;
}

export function linkEntity(db: WarehouseDb, link: EntityLink): void {
  const existing = db
    .prepare(
      'SELECT canonical_id FROM entity_xref WHERE system = ? AND entity_type = ? AND external_id = ?',
    )
    .get(link.system, link.entityType, link.externalId) as { canonical_id: string } | undefined;

  if (existing) {
    if (existing.canonical_id !== link.canonicalId) {
      throw new Error(
        `${link.system}:${link.entityType}:${link.externalId} is already linked to ${existing.canonical_id} — ` +
          `refusing to repoint it at ${link.canonicalId}; resolve by hand and record the change in audit_log`,
      );
    }
    return;
  }

  db.prepare(
    `INSERT INTO entity_xref (entity_type, canonical_id, system, external_id, match_method, confidence)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    link.entityType,
    link.canonicalId,
    link.system,
    link.externalId,
    link.matchMethod,
    link.confidence ?? 1.0,
  );
}

export function canonicalIdFor(
  db: WarehouseDb,
  system: string,
  entityType: EntityType,
  externalId: string,
): string | null {
  const row = db
    .prepare(
      'SELECT canonical_id FROM entity_xref WHERE system = ? AND entity_type = ? AND external_id = ?',
    )
    .get(system, entityType, externalId) as { canonical_id: string } | undefined;
  return row?.canonical_id ?? null;
}

export function unmatchedReport(db: WarehouseDb, entityType: EntityType): UnmatchedRow[] {
  if (entityType !== 'property') return [];
  return db
    .prepare(
      `SELECT pm.id AS canonicalId, pm.name AS name
         FROM property_master pm
        WHERE NOT EXISTS (
              SELECT 1 FROM entity_xref x
               WHERE x.entity_type = 'property' AND x.canonical_id = pm.id)
        ORDER BY pm.id`,
    )
    .all() as UnmatchedRow[];
}
