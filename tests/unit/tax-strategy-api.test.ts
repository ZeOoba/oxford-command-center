// @vitest-environment node
//
// tests/unit/tax-strategy-api.test.ts
//
// server/warehouse/tax-api.ts — GET /strategy route (P4c / C2, Task 9). Wires Task 8's
// buildTaxStrategyReport(db, asOf) onto the EXISTING taxApi Hono factory (already mounted at
// /api/warehouse/tax by server/index.ts, and already covering GET /analysis + POST /appeals —
// this test file only adds coverage for the new /strategy handler in the same factory).
// Mirrors the withDb 503-guard pattern + in-memory-db harness established in
// insurance-loss-api.test.ts (Task 5).
//
// HARD REQUIREMENT UNDER TEST: /strategy must NEVER call logVerdicts/computeInputsVersion or
// write to calibration_verdict. tax-strategy.ts's cost-seg/entity/filed-return figures are
// placeholder-tainted by design (see that file's module header) — a placeholder-tainted verdict
// must never enter calibration history. The EXISTING GET /analysis route in tax-api.ts DOES call
// logVerdicts/computeInputsVersion, and that is correct, pre-existing behavior for /analysis —
// this test suite must not require or tolerate that same call firing for /strategy.
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../server/warehouse/migrate';
import type { WarehouseDb } from '../../server/warehouse/db';
import { taxApi } from '../../server/warehouse/tax-api';
import { TaxStrategyReport } from '../../src/contracts/tax-strategy';

function freshDb(): WarehouseDb {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

/** Insert one property_master row with an explicit ownership_pct (default 1.0). */
function insertProperty(db: WarehouseDb, id: string, name: string, ownershipPct = 1): void {
  db.prepare('INSERT INTO property_master (id, name, ownership_pct) VALUES (?, ?, ?)').run(id, name, ownershipPct);
}

function calibrationVerdictCount(db: WarehouseDb): number {
  const row = db.prepare('SELECT count(*) AS c FROM calibration_verdict').get() as { c: number };
  return row.c;
}

function makeApp(db: WarehouseDb) {
  return taxApi(() => db);
}

function makeAppUnavailableDb() {
  return taxApi(() => {
    throw new Error('warehouse unavailable in test');
  });
}

describe('GET /api/warehouse/tax/strategy', () => {
  it('503s when the warehouse is unavailable', async () => {
    const app = makeAppUnavailableDb();
    const res = await app.request('/strategy');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'warehouse unavailable' });
  });

  it('200s with a contract-valid, placeholder-sourced report and writes ZERO calibration_verdict rows', async () => {
    const db = freshDb();
    // Seed a real fixture property (from depreciable-basis.placeholder.json) with a
    // discriminating ownershipPct so the engine actually produces a costSeg row — exercising
    // the full wiring (buildTaxStrategyReport -> resolvers -> property master), not just an
    // empty-report happy path.
    insertProperty(db, '3540-e-5th-ave-columbus-oh', '3540 E 5th Ave', 0.5);

    const before = calibrationVerdictCount(db);
    const app = makeApp(db);
    const res = await app.request('/strategy');
    expect(res.status).toBe(200);

    const body = await res.json();
    const parsed = TaxStrategyReport.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    if (parsed.success) {
      expect(parsed.data.basisDataSource).toBe('placeholder');
      expect(parsed.data.advisoryOnly).toBe(true);
      expect(parsed.data.costSeg.length).toBeGreaterThan(0);
      // rule 2 (contract): savings figures are hard-null, always.
      expect(parsed.data.costSeg[0]!.savingsFullAsset).toBeNull();
      expect(parsed.data.costSeg[0]!.savingsOxfordShare).toBeNull();
      expect(parsed.data.entityStrategies).toHaveLength(3);
    }

    // The hard requirement: this route must never write to calibration_verdict, regardless of
    // how placeholder-tainted the tax-strategy inputs are.
    const after = calibrationVerdictCount(db);
    expect(after).toBe(before);
    expect(after).toBe(0);
  });

  it('200s with an empty, contract-valid report when property_master has no matching rows', async () => {
    const db = freshDb();
    const app = makeApp(db);
    const res = await app.request('/strategy');
    expect(res.status).toBe(200);
    const parsed = TaxStrategyReport.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    if (parsed.success) {
      expect(parsed.data.costSeg).toEqual([]);
      // All 5 depreciable-basis.placeholder.json rows dropped (no seeded properties survive
      // the resolver's known-property filter).
      expect(parsed.data.droppedFixtureRows).toBe(5);
      expect(parsed.data.entityStrategies).toHaveLength(3);
    }
    expect(calibrationVerdictCount(db)).toBe(0);
  });

  it('500s and reports a stable error shape when the underlying query fails unexpectedly', async () => {
    // A raw, un-migrated in-memory db: getDb() itself succeeds (no 503), but the handler's own
    // resolver query (property_master lookup) throws once it runs — exercising the route's own
    // try/catch, distinct from the withDb 503 guard.
    const rawDb = new Database(':memory:');
    const app = makeApp(rawDb);
    const res = await app.request('/strategy');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'tax strategy failed' });
  });
});
