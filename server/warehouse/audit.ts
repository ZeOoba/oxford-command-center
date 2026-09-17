// server/warehouse/audit.ts — every human verification, correction and override lands here.
// The table is append-only at the database level (migration 030 triggers); this module is the
// only sanctioned writer.
import type { WarehouseDb } from './db';

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  entity: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

export function appendAudit(db: WarehouseDb, entry: AuditEntry): number {
  const info = db
    .prepare(
      `INSERT INTO audit_log (at, actor, action, entity, entity_id, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.at,
      entry.actor,
      entry.action,
      entry.entity,
      entry.entityId,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
    );
  return Number(info.lastInsertRowid);
}

export function auditTrail(db: WarehouseDb, entity: string, entityId: string): AuditEntry[] {
  const rows = db
    .prepare(
      `SELECT at, actor, action, entity, entity_id AS entityId, before_json, after_json
         FROM audit_log WHERE entity = ? AND entity_id = ? ORDER BY seq`,
    )
    .all(entity, entityId) as Array<
    AuditEntry & { before_json: string | null; after_json: string | null }
  >;

  return rows.map((r) => ({
    at: r.at,
    actor: r.actor,
    action: r.action,
    entity: r.entity,
    entityId: r.entityId,
    before: r.before_json ? JSON.parse(r.before_json) : undefined,
    after: r.after_json ? JSON.parse(r.after_json) : undefined,
  }));
}
