// server/warehouse/prospect-demand.ts — Prospect Demand Intelligence data access (Direction 3).
//
// Reads/writes the prospect_demand_events table (migration 012). Pure given the injected db:
// the route layer (api.ts) Zod-validates input before it reaches addProspectEvent, and
// .parse()s the report at the read boundary.
//
// FUTURE — Outlook ingest: when the Outlook pipeline ships, it will call addProspectEvent with
// `source: 'outlook'` (instead of the route default 'manual') for each demand signal it detects
// in an inbound broker email. No schema or function change is needed — the pipeline becomes
// another caller of this same insert path. The per-property aggregate (getProspectDemandReport)
// already mixes manual + outlook events transparently.
import { randomUUID } from 'node:crypto';
import type { WarehouseDb } from './db';
import {
  ProspectDemandEvent,
  ProspectDemandReport,
  ProspectEventType,
  type ProspectDemandEventInput,
  type ProspectDemandSummary,
} from '../../src/contracts/prospect-demand';

/** A raw prospect_demand_events row as it comes back from SQLite (snake_case columns). */
interface ProspectEventRow {
  id: string;
  property_id: string;
  event_type: string;
  event_date: string;
  contact: string | null;
  company: string | null;
  sf_interest: number | null;
  notes: string | null;
  source: string;
  created_at: string;
}

/**
 * Per-property demand report: one summary per property with at least one event, plus the
 * portfolio-wide event total. Summaries are ordered by eventCount DESC (most-active first),
 * then propertyId for stability. Empty warehouse → empty summaries, totalEventCount 0.
 */
export function getProspectDemandReport(db: WarehouseDb): ProspectDemandReport {
  const rows = db.prepare(`
    SELECT property_id, event_type, event_date
    FROM prospect_demand_events
  `).all() as Array<{ property_id: string; event_type: string; event_date: string }>;

  // Aggregate per property in one pass.
  const byProperty = new Map<string, { count: number; lastDate: string | null; types: Set<string> }>();
  for (const r of rows) {
    const agg = byProperty.get(r.property_id) ?? { count: 0, lastDate: null, types: new Set<string>() };
    agg.count += 1;
    // Max ISO date (lexicographic compare is valid for YYYY-MM-DD).
    if (agg.lastDate === null || r.event_date > agg.lastDate) agg.lastDate = r.event_date;
    agg.types.add(r.event_type);
    byProperty.set(r.property_id, agg);
  }

  // Canonical event-type ordering for the eventTypes array (enum declaration order).
  const typeOrder = ProspectEventType.options;
  const summaries: ProspectDemandSummary[] = [...byProperty.entries()]
    .map(([propertyId, agg]) => ({
      propertyId,
      eventCount: agg.count,
      lastEventDate: agg.lastDate,
      eventTypes: typeOrder.filter((t) => agg.types.has(t)),
    }))
    .sort((a, b) => b.eventCount - a.eventCount || a.propertyId.localeCompare(b.propertyId));

  return ProspectDemandReport.parse({
    summaries,
    totalEventCount: rows.length,
    asOf: new Date().toISOString(),
  });
}

/**
 * Insert a new prospect demand event. The id (UUID) and created_at (ISO timestamp) are
 * generated server-side; everything else comes from the validated input. Returns the
 * fully-formed event (Zod-parsed) so the caller can echo it back to the client (201).
 */
export function addProspectEvent(
  db: WarehouseDb,
  event: ProspectDemandEventInput,
): ProspectDemandEvent {
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO prospect_demand_events
      (id, property_id, event_type, event_date, contact, company, sf_interest, notes, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    event.property_id,
    event.event_type,
    event.event_date,
    event.contact ?? null,
    event.company ?? null,
    event.sf_interest ?? null,
    event.notes ?? null,
    event.source,
    createdAt,
  );

  return ProspectDemandEvent.parse({ ...event, id, created_at: createdAt });
}

/** Read every event for a single property, newest first. (Read helper; not yet route-exposed.) */
export function listProspectEventsForProperty(db: WarehouseDb, propertyId: string): ProspectDemandEvent[] {
  const rows = db.prepare(`
    SELECT id, property_id, event_type, event_date, contact, company, sf_interest, notes, source, created_at
    FROM prospect_demand_events
    WHERE property_id = ?
    ORDER BY event_date DESC, created_at DESC
  `).all(propertyId) as ProspectEventRow[];
  return rows.map((r) => ProspectDemandEvent.parse(r));
}
