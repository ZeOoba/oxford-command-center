// @vitest-environment node
//
// tests/unit/prospect-demand.test.ts
//
// Direction 3 — Prospect Demand Intelligence foundation.
// Covers: the data-access engine (getProspectDemandReport / addProspectEvent), the contract
// (ProspectDemandEvent parse), and the API routes (GET/POST /prospect-demand).
//
// All tests use a fresh in-memory SQLite warehouse (tmpdir) — never touches finance.sqlite.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { warehouseRoutes } from '../../server/warehouse/api';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import {
  getProspectDemandReport,
  addProspectEvent,
} from '../../server/warehouse/prospect-demand';
import { ProspectDemandEvent, ProspectDemandReport } from '@contracts/prospect-demand';

/** Open a fresh in-memory warehouse (all migrations applied, incl. 012). */
function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'prospect-demand-test-'));
  return openWarehouse(join(dir, 'test.sqlite'));
}

function makeApp(db: WarehouseDb) {
  return warehouseRoutes(() => db);
}

async function post(app: ReturnType<typeof makeApp>, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── Migration ────────────────────────────────────────────────────────────────────

describe('migration 012', () => {
  it('creates the prospect_demand_events table', () => {
    const db = freshDb();
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='prospect_demand_events'",
    ).get() as { name: string } | undefined;
    expect(row?.name).toBe('prospect_demand_events');
  });
});

// ── Engine: getProspectDemandReport ────────────────────────────────────────────────

describe('getProspectDemandReport', () => {
  it('returns an empty report on an empty warehouse', () => {
    const db = freshDb();
    const report = getProspectDemandReport(db);
    expect(report.summaries).toHaveLength(0);
    expect(report.totalEventCount).toBe(0);
    expect(typeof report.asOf).toBe('string');
  });

  it('an inserted event appears in the report', () => {
    const db = freshDb();
    addProspectEvent(db, {
      property_id: 'my-property-columbus-oh',
      event_type: 'showing',
      event_date: '2026-06-20',
      contact: 'Jane Broker',
      company: 'CBRE',
      sf_interest: 15000,
      notes: 'Walked the back bay',
      source: 'manual',
    });

    const report = getProspectDemandReport(db);
    expect(report.totalEventCount).toBe(1);
    expect(report.summaries).toHaveLength(1);
    expect(report.summaries[0]!.propertyId).toBe('my-property-columbus-oh');
    expect(report.summaries[0]!.eventCount).toBe(1);
    expect(report.summaries[0]!.lastEventDate).toBe('2026-06-20');
    expect(report.summaries[0]!.eventTypes).toEqual(['showing']);
  });

  it('aggregates eventCount and lastEventDate (max date) per property', () => {
    const db = freshDb();
    const pid = 'flex-park-cincinnati-oh';
    addProspectEvent(db, { property_id: pid, event_type: 'inquiry', event_date: '2026-05-01', contact: null, company: null, sf_interest: null, notes: null, source: 'manual' });
    addProspectEvent(db, { property_id: pid, event_type: 'tour', event_date: '2026-06-15', contact: null, company: null, sf_interest: null, notes: null, source: 'manual' });
    addProspectEvent(db, { property_id: pid, event_type: 'loi', event_date: '2026-06-10', contact: null, company: null, sf_interest: null, notes: null, source: 'manual' });

    const report = getProspectDemandReport(db);
    expect(report.totalEventCount).toBe(3);
    const summary = report.summaries.find((s) => s.propertyId === pid)!;
    expect(summary.eventCount).toBe(3);
    // lastEventDate is the MAX date, not the most-recently-inserted.
    expect(summary.lastEventDate).toBe('2026-06-15');
    // eventTypes is the distinct set in canonical enum order.
    expect(summary.eventTypes).toEqual(['inquiry', 'loi', 'tour']);
  });

  it('orders summaries by eventCount DESC', () => {
    const db = freshDb();
    addProspectEvent(db, { property_id: 'quiet-prop', event_type: 'inquiry', event_date: '2026-06-01', contact: null, company: null, sf_interest: null, notes: null, source: 'manual' });
    addProspectEvent(db, { property_id: 'busy-prop', event_type: 'showing', event_date: '2026-06-02', contact: null, company: null, sf_interest: null, notes: null, source: 'manual' });
    addProspectEvent(db, { property_id: 'busy-prop', event_type: 'tour', event_date: '2026-06-03', contact: null, company: null, sf_interest: null, notes: null, source: 'manual' });

    const report = getProspectDemandReport(db);
    expect(report.summaries[0]!.propertyId).toBe('busy-prop');
    expect(report.summaries[0]!.eventCount).toBe(2);
    expect(report.summaries[1]!.propertyId).toBe('quiet-prop');
  });

  it('addProspectEvent returns a fully-formed event with id + created_at', () => {
    const db = freshDb();
    const event = addProspectEvent(db, {
      property_id: 'p1', event_type: 'follow_up', event_date: '2026-06-20',
      contact: null, company: null, sf_interest: null, notes: null, source: 'manual',
    });
    expect(event.id).toBeTruthy();
    expect(event.created_at).toBeTruthy();
    expect(event.property_id).toBe('p1');
    expect(event.source).toBe('manual');
  });
});

// ── Contract: ProspectDemandEvent ──────────────────────────────────────────────────

describe('ProspectDemandEvent contract', () => {
  it('parses a valid event', () => {
    const parsed = ProspectDemandEvent.safeParse({
      id: 'abc-123',
      property_id: 'my-property-columbus-oh',
      event_type: 'loi',
      event_date: '2026-06-20',
      contact: 'Jane Broker',
      company: 'JLL',
      sf_interest: 20000,
      notes: 'Strong interest',
      source: 'manual',
      created_at: '2026-06-20T12:00:00.000Z',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown event_type', () => {
    const parsed = ProspectDemandEvent.safeParse({
      id: 'x', property_id: 'p', event_type: 'bogus', event_date: '2026-06-20',
      source: 'manual', created_at: '2026-06-20T12:00:00.000Z',
    });
    expect(parsed.success).toBe(false);
  });

  it('defaults source to manual and nullable fields to null', () => {
    const parsed = ProspectDemandEvent.parse({
      id: 'x', property_id: 'p', event_type: 'showing', event_date: '2026-06-20',
      created_at: '2026-06-20T12:00:00.000Z',
    });
    expect(parsed.source).toBe('manual');
    expect(parsed.contact).toBeNull();
    expect(parsed.sf_interest).toBeNull();
  });

  it('a built report validates against ProspectDemandReport', () => {
    const db = freshDb();
    addProspectEvent(db, { property_id: 'p1', event_type: 'showing', event_date: '2026-06-20', contact: null, company: null, sf_interest: null, notes: null, source: 'manual' });
    const report = getProspectDemandReport(db);
    expect(ProspectDemandReport.safeParse(report).success).toBe(true);
  });
});

// ── Routes: GET/POST /prospect-demand ───────────────────────────────────────────────

describe('GET /prospect-demand', () => {
  it('returns 200 + an empty ProspectDemandReport on an empty warehouse', async () => {
    const db = freshDb();
    const app = makeApp(db);
    const res = await app.request('/prospect-demand');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(ProspectDemandReport.safeParse(body).success).toBe(true);
    expect((body as ProspectDemandReport).totalEventCount).toBe(0);
  });

  it('reflects a posted event', async () => {
    const db = freshDb();
    const app = makeApp(db);
    await post(app, '/prospect-demand', {
      property_id: 'my-property-columbus-oh',
      event_type: 'showing',
      event_date: '2026-06-20',
    });
    const res = await app.request('/prospect-demand');
    const body = (await res.json()) as ProspectDemandReport;
    expect(body.totalEventCount).toBe(1);
    expect(body.summaries[0]!.propertyId).toBe('my-property-columbus-oh');
  });
});

describe('POST /prospect-demand', () => {
  it('returns 201 + the created event on a valid body', async () => {
    const db = freshDb();
    const app = makeApp(db);
    const res = await post(app, '/prospect-demand', {
      property_id: 'flex-park-cincinnati-oh',
      event_type: 'inquiry',
      event_date: '2026-06-18',
      contact: 'Sam Tenant',
      company: 'Acme Logistics',
      sf_interest: 12000,
      notes: 'Needs dock-high doors',
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    const parsed = ProspectDemandEvent.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.property_id).toBe('flex-park-cincinnati-oh');
    expect(parsed.success && parsed.data.source).toBe('manual');
    expect(parsed.success && parsed.data.id).toBeTruthy();
  });

  it('returns 400 when a required field is missing (no event_type)', async () => {
    const db = freshDb();
    const app = makeApp(db);
    const res = await post(app, '/prospect-demand', {
      property_id: 'p1',
      event_date: '2026-06-20',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 on an invalid event_type', async () => {
    const db = freshDb();
    const app = makeApp(db);
    const res = await post(app, '/prospect-demand', {
      property_id: 'p1',
      event_type: 'not-a-type',
      event_date: '2026-06-20',
    });
    expect(res.status).toBe(400);
  });
});
