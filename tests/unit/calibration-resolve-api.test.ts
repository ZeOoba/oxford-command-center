// tests/unit/calibration-resolve-api.test.ts
// Route tests for the MANUAL resolution write route POST /calibration/:id/resolve, via Hono
// app.request() (no network). Spec §3.2.
// Proves: a valid resolution 200s and surfaces in the log; double-resolution is idempotent (no
// duplicate); a bad id 404s; a no-signal / malformed body 400s; the grain rule 422s; the 503 guard.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { warehouseRoutes } from '../../server/warehouse/api';
import { computeInputsVersion, logVerdicts } from '../../server/warehouse/calibration';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { seedMappings } from '../../server/warehouse/mapping';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import type { CalibrationVerdict } from '../../src/contracts/warehouse';

const SEED = [{ account: 'Rent', code: '5064', normalized_category: 'Rental Revenue', classification: 'revenue' }];

function dbWithVerdict(): { db: WarehouseDb; id: number } {
  const dir = mkdtempSync(join(tmpdir(), 'cal-resapi-'));
  const db = openWarehouse(join(dir, 'f.sqlite'));
  seedPropertyMaster(db);
  seedMappings(db, SEED);
  const iv = computeInputsVersion(db);
  const verdict: CalibrationVerdict = {
    subjectKind: 'property', subjectId: '1100-rarig', verdictKind: 'capital-action', verdictSubkind: '',
    verdictEngine: 'scores', predictedBand: 'disposition-candidate', predictedValue: null, predictedUnit: 'band',
    confidence: 0.7, direction: 'down', reasons: [], asOfPeriod: '2024', horizonPeriods: 1,
    inputsVersion: iv.inputsVersion, emittedBy: 'snapshot:test',
  };
  logVerdicts(db, [verdict]);
  const id = (db.prepare('SELECT id FROM calibration_verdict ORDER BY id DESC LIMIT 1').get() as { id: number }).id;
  return { db, id };
}

function post(app: ReturnType<typeof warehouseRoutes>, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID = {
  realizedBand: 'noi-flat-or-declined', realizedValue: -0.04, realizedUnit: 'pct-change',
  outcomePeriod: '2025', hit: 1, actionTaken: 'none', treatmentNote: 'clean test',
};

describe('POST /calibration/:id/resolve — happy path', () => {
  it('200s, records a blessed outcome, and the verdict then shows resolved in the log', async () => {
    const { db, id } = dbWithVerdict();
    const app = warehouseRoutes(() => db);
    const res = await post(app, `/calibration/${id}/resolve`, VALID);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; superseded: boolean; duplicate: boolean };
    expect(body.ok).toBe(true);
    expect(body.duplicate).toBe(false);

    const log = await (await app.request(`/calibration/log?status=resolved`)).json() as { log: Array<{ id: number; resolved: boolean; hit: number | null }> };
    const row = log.log.find((r) => r.id === id);
    expect(row?.resolved).toBe(true);
    expect(row?.hit).toBe(1);
  });
});

describe('POST /calibration/:id/resolve — idempotent (no double-resolution)', () => {
  it('a repeated identical submit returns duplicate:true and writes no second row', async () => {
    const { db, id } = dbWithVerdict();
    const app = warehouseRoutes(() => db);
    await post(app, `/calibration/${id}/resolve`, VALID);
    const res2 = await post(app, `/calibration/${id}/resolve`, VALID);
    expect(res2.status).toBe(200);
    expect(((await res2.json()) as { duplicate: boolean }).duplicate).toBe(true);
    const n = (db.prepare('SELECT COUNT(*) AS c FROM calibration_outcome WHERE calibration_id = ?').get(id) as { c: number }).c;
    expect(n).toBe(1);
  });
});

describe('POST /calibration/:id/resolve — rejections', () => {
  it('a non-integer id → 404', async () => {
    const { db } = dbWithVerdict();
    const app = warehouseRoutes(() => db);
    const res = await post(app, `/calibration/abc/resolve`, VALID);
    expect(res.status).toBe(404);
  });

  it('a nonexistent verdict id → 404', async () => {
    const { db } = dbWithVerdict();
    const app = warehouseRoutes(() => db);
    const res = await post(app, `/calibration/99999/resolve`, VALID);
    expect(res.status).toBe(404);
  });

  it('a malformed body (no realized signal) → 400', async () => {
    const { db, id } = dbWithVerdict();
    const app = warehouseRoutes(() => db);
    const res = await post(app, `/calibration/${id}/resolve`, { outcomePeriod: '2025' });
    expect(res.status).toBe(400);
  });

  it('the GRAIN RULE (full-year verdict, YTD outcome period) → 422', async () => {
    const { db, id } = dbWithVerdict();
    const app = warehouseRoutes(() => db);
    const res = await post(app, `/calibration/${id}/resolve`, { ...VALID, outcomePeriod: '2025-06' });
    expect(res.status).toBe(422);
  });
});

describe('POST /calibration/:id/resolve — 503 guard', () => {
  it('an unopenable warehouse → 503, never throws', async () => {
    const app = warehouseRoutes(() => { throw new Error('cannot open warehouse db'); });
    const res = await post(app, `/calibration/1/resolve`, VALID);
    expect(res.status).toBe(503);
  });
});
