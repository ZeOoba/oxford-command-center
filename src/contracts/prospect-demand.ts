// src/contracts/prospect-demand.ts — Prospect Demand Intelligence contracts (Direction 3).
//
// External demand signals on portfolio properties: broker showings, inquiries, LOI
// activity, tours, and follow-ups. This is the FOUNDATION layer: a data model + manual-entry
// API + UI panel. The full vision (an Outlook ingest pipeline that auto-detects these signals
// from inbound broker mail) writes the SAME table with source='outlook' — see the `source`
// field below and server/warehouse/prospect-demand.ts for the integration seam.
//
// All dates ISO YYYY-MM-DD. Mirrors the existing contract patterns (lease-forecast, acquisition).
import { z } from 'zod';

// ── Event type ────────────────────────────────────────────────────────────────
// The kind of demand signal observed on a property.
export const ProspectEventType = z.enum(['showing', 'inquiry', 'loi', 'tour', 'follow_up']);
export type ProspectEventType = z.infer<typeof ProspectEventType>;

// ── Event source ──────────────────────────────────────────────────────────────
// 'manual' = analyst-entered via the UI form (today). 'outlook' = future Outlook ingest
// pipeline (not yet implemented; the schema reserves the value so no migration is needed
// when it ships).
export const ProspectEventSource = z.enum(['manual', 'outlook']);
export type ProspectEventSource = z.infer<typeof ProspectEventSource>;

// ── A single demand event ───────────────────────────────────────────────────────
// Matches the prospect_demand_events table 1:1.
export const ProspectDemandEvent = z.object({
  id: z.string(),                                     // UUID
  property_id: z.string().min(1),                     // matches Property.id slug
  event_type: ProspectEventType,
  event_date: z.string().min(1),                      // ISO date YYYY-MM-DD
  contact: z.string().nullable().default(null),       // broker/prospect name
  company: z.string().nullable().default(null),       // company/firm name
  sf_interest: z.number().int().nonnegative().nullable().default(null), // SF of interest
  notes: z.string().nullable().default(null),         // free text
  source: ProspectEventSource.default('manual'),
  created_at: z.string(),                             // ISO timestamp
});
export type ProspectDemandEvent = z.infer<typeof ProspectDemandEvent>;

// ── Per-property aggregate ───────────────────────────────────────────────────────
// One row per property that has at least one recorded event.
export const ProspectDemandSummary = z.object({
  propertyId: z.string(),
  eventCount: z.number().int().nonnegative(),
  lastEventDate: z.string().nullable(),               // max(event_date); null only if no events
  eventTypes: z.array(ProspectEventType),             // distinct event types seen, sorted
});
export type ProspectDemandSummary = z.infer<typeof ProspectDemandSummary>;

// ── Report envelope ───────────────────────────────────────────────────────────
// All per-property summaries + a portfolio-wide event total. The H6 read boundary:
// GET /api/warehouse/prospect-demand .parse()s this shape before crossing to the client.
export const ProspectDemandReport = z.object({
  summaries: z.array(ProspectDemandSummary),
  totalEventCount: z.number().int().nonnegative(),
  asOf: z.string(),                                   // ISO timestamp of report generation
});
export type ProspectDemandReport = z.infer<typeof ProspectDemandReport>;

// ── Manual-entry input ───────────────────────────────────────────────────────────
// The POST body: a ProspectDemandEvent minus the server-generated id + created_at.
// `source` defaults to 'manual'; the Outlook pipeline would supply 'outlook' explicitly.
export const ProspectDemandEventInput = ProspectDemandEvent.omit({ id: true, created_at: true });
export type ProspectDemandEventInput = z.infer<typeof ProspectDemandEventInput>;
