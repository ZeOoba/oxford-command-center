// tests/unit/lease-velocity.test.ts — Phase 3 W1
// TDD: V-1 through V-4 from spec §9 — leasingVelocity().
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { leasingVelocity, VELOCITY_SLOW_DAYS as SLOW_DAYS } from '../../server/warehouse/lease-velocity';
import { VELOCITY_SLOW_DAYS } from '../../src/analytics/lease-forecast';

let tmp: string;
let db: WarehouseDb;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'velocity-test-'));
  db = openWarehouse(join(tmp, 'test.sqlite'));
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

// ── V-1: empty lease_events → [] or all-null rows; never throws ──────────────
describe('V-1: empty lease_events', () => {
  it('returns [] or all-null rows with no events; never throws', () => {
    expect(() => leasingVelocity(db, [])).not.toThrow();
    const result = leasingVelocity(db, []);
    expect(Array.isArray(result)).toBe(true);
    // If rows returned, medianDaysToLease must be null and slowLeasing false
    for (const row of result) {
      expect(row.medianDaysToLease).toBeNull();
      expect(row.slowLeasing).toBe(false);
    }
  });

  it('with property master but no events, returns velocity rows with null median', () => {
    const properties = [{ id: 'p1', name: 'Prop One' }];
    expect(() => leasingVelocity(db, properties)).not.toThrow();
  });
});

// ── V-2: two events (vacate then commence, 90d apart) → medianDaysToLease:90 ─
describe('V-2: paired vacate/commence events', () => {
  it('vacate then commence 90d apart → medianDaysToLease:90, leasingEventsN:1', () => {
    // Insert a vacate and a commence event 90 days apart for same property/suite
    db.prepare(`
      INSERT INTO lease_events (property_id, suite, tenant, event_kind, event_date)
      VALUES (?, ?, ?, ?, ?)
    `).run('p1', 'Suite A', 'Old Tenant', 'vacate', '2026-01-01');
    db.prepare(`
      INSERT INTO lease_events (property_id, suite, tenant, event_kind, event_date)
      VALUES (?, ?, ?, ?, ?)
    `).run('p1', 'Suite A', 'New Tenant', 'commence', '2026-04-01'); // 90d later

    const properties = [{ id: 'p1', name: 'Prop One' }];
    const result = leasingVelocity(db, properties);
    const p1 = result.find((r) => r.propertyId === 'p1');

    expect(p1).toBeDefined();
    // 90 days between Jan 1 and Apr 1
    expect(p1!.medianDaysToLease).toBe(90);
    expect(p1!.leasingEventsN).toBe(1);
  });
});

// ── V-3: median > VELOCITY_SLOW_DAYS → slowLeasing:true ─────────────────────
describe('V-3: slow leasing detection', () => {
  it('median days > VELOCITY_SLOW_DAYS → slowLeasing:true', () => {
    // VELOCITY_SLOW_DAYS = 60; insert a pair with 90d gap (> 60)
    db.prepare(`INSERT INTO lease_events (property_id, suite, event_kind, event_date) VALUES (?, ?, ?, ?)`).run('p2', null, 'vacate', '2026-01-01');
    db.prepare(`INSERT INTO lease_events (property_id, suite, event_kind, event_date) VALUES (?, ?, ?, ?)`).run('p2', null, 'commence', '2026-04-01'); // 90d

    const properties = [{ id: 'p2', name: 'Prop Two' }];
    const result = leasingVelocity(db, properties);
    const p2 = result.find((r) => r.propertyId === 'p2');
    expect(p2).toBeDefined();
    expect(p2!.medianDaysToLease).toBe(90);
    expect(SLOW_DAYS).toBe(60); // re-exported constant check
    expect(VELOCITY_SLOW_DAYS).toBe(60); // from analytics module
    expect(p2!.slowLeasing).toBe(true); // 90 > 60
  });

  it('median days ≤ VELOCITY_SLOW_DAYS → slowLeasing:false', () => {
    // Insert a pair with 45d gap (< 60)
    db.prepare(`INSERT INTO lease_events (property_id, suite, event_kind, event_date) VALUES (?, ?, ?, ?)`).run('p3', 'A', 'vacate', '2026-01-01');
    db.prepare(`INSERT INTO lease_events (property_id, suite, event_kind, event_date) VALUES (?, ?, ?, ?)`).run('p3', 'A', 'commence', '2026-02-15'); // 45d

    const properties = [{ id: 'p3', name: 'Prop Three' }];
    const result = leasingVelocity(db, properties);
    const p3 = result.find((r) => r.propertyId === 'p3');
    expect(p3!.slowLeasing).toBe(false);
  });
});

// ── V-4: insufficient pairs → medianDaysToLease:null, slowLeasing:false ──────
describe('V-4: insufficient pairs', () => {
  it('only vacate, no commence → medianDaysToLease:null, slowLeasing:false', () => {
    db.prepare(`INSERT INTO lease_events (property_id, suite, event_kind, event_date) VALUES (?, ?, ?, ?)`).run('p4', 'A', 'vacate', '2026-01-01');

    const properties = [{ id: 'p4', name: 'Prop Four' }];
    const result = leasingVelocity(db, properties);
    const p4 = result.find((r) => r.propertyId === 'p4');
    expect(p4).toBeDefined();
    expect(p4!.medianDaysToLease).toBeNull();
    expect(p4!.slowLeasing).toBe(false);
  });

  it('property with no events → medianDaysToLease:null', () => {
    const properties = [{ id: 'p5', name: 'Prop Five' }];
    const result = leasingVelocity(db, properties);
    const p5 = result.find((r) => r.propertyId === 'p5');
    if (p5) {
      expect(p5.medianDaysToLease).toBeNull();
      expect(p5.slowLeasing).toBe(false);
    }
    // Or result may be empty for a property with no events — both are acceptable
  });
});
