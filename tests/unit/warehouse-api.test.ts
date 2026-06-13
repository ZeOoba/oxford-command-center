// tests/unit/warehouse-api.test.ts
//
// Route tests for the /api/warehouse sub-router via Hono's app.request() (no network).
// The router is built with an injected db-getter so the test controls the warehouse:
// a committed Rarig 2025 import plus a separate pending-review import (only 'Rent'
// seeded → HVAC Repair + Distribution come back unmapped). The fixture writer + SEED
// are copied locally — tests never import across test files.
import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { warehouseRoutes } from '../../server/warehouse/api';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { ingestFile } from '../../server/warehouse/ingest';
import { seedMappings } from '../../server/warehouse/mapping';
import { seedPropertyMaster } from '../../server/warehouse/property-master';

async function writeFixture(path: string, propertyLine = 'Property: 1100 Rarig Ave'): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  const rows: Array<[string | null, string | null, string | null, number | null]> = [
    ['Profit & Loss', null, null, null],
    [propertyLine, null, null, null],
    ['01/01/25 - 12/31/25  (cash basis)', null, null, null],
    [null, 'INCOME', null, null],
    [null, null, '     5002 RENTAL INCOME', null],
    [null, null, '          5064 Rent', 100000],
    [null, 'EXPENSE', null, null],
    [null, null, '     6160 REPAIR', null],
    [null, null, '          6285 HVAC Repair', 5000],
    [null, 'NON OPERATING EXPENSE', null, null],
    [null, null, '          7402 Distribution to Owner', 25000],
  ];
  for (const r of rows) ws.addRow(r);
  await wb.xlsx.writeFile(path);
}

const SEED = [
  { account: 'Rent', code: '5064', normalized_category: 'Rental Revenue', classification: 'revenue' },
  { account: 'HVAC Repair', code: '6285', normalized_category: 'Repairs & Maintenance', classification: 'opex' },
  { account: 'Distribution to Owner', code: '7402', normalized_category: 'Distributions', classification: 'excluded' },
];

const JSON_HEADERS = { 'content-type': 'application/json' };

/** One committed Rarig 2025 import. */
async function committedWarehouse(): Promise<{ db: WarehouseDb }> {
  const dir = mkdtempSync(join(tmpdir(), 'whapi-'));
  const db = openWarehouse(join(dir, 'f.sqlite'));
  seedPropertyMaster(db);
  seedMappings(db, SEED);
  const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
  await writeFixture(file);
  const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });
  expect(r.status).toBe('committed');
  return { db };
}

/** A single pending-review import (only 'Rent' seeded → HVAC + Distribution unmapped). */
async function pendingWarehouse(): Promise<{ db: WarehouseDb; importId: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'whapi-'));
  const db = openWarehouse(join(dir, 'f.sqlite'));
  seedPropertyMaster(db);
  seedMappings(db, SEED.slice(0, 1));
  const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
  await writeFixture(file);
  const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });
  expect(r.status).toBe('pending-review');
  return { db, importId: r.importId! };
}

describe('warehouse api routes', () => {
  it('GET /imports → 200 {imports:[...]} with the committed import', async () => {
    const { db } = await committedWarehouse();
    const app = warehouseRoutes(() => db);
    const res = await app.request('/imports');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { imports: Array<{ id: number; fileName: string; status: string }> };
    expect(body.imports).toHaveLength(1);
    expect(body.imports[0]).toMatchObject({
      fileName: 'P&L 2025 -- 1100 Rarig.xlsx',
      propertyId: '1100-rarig-ave-columbus-oh',
      status: 'committed',
      version: 1,
    });
  });

  it('GET /imports/:id → 200 detail; unknown id → 404', async () => {
    const { db } = await committedWarehouse();
    const app = warehouseRoutes(() => db);
    const id = (db.prepare('SELECT id FROM import_batches LIMIT 1').get() as { id: number }).id;

    const ok = await app.request(`/imports/${id}`);
    expect(ok.status).toBe(200);
    const detail = (await ok.json()) as { id: number; rows: unknown[]; issues: unknown[] };
    expect(detail.id).toBe(id);
    expect(detail.rows).toHaveLength(3);

    const missing = await app.request('/imports/999999');
    expect(missing.status).toBe(404);
    expect((await missing.json()) as { error: string }).toHaveProperty('error');

    // a non-numeric id is a 404, never a 500
    const bad = await app.request('/imports/not-a-number');
    expect(bad.status).toBe(404);
  });

  it('GET /noi → 200 {matrix:[...]}; GET /issues → 200 {issues:[...]}', async () => {
    const { db } = await committedWarehouse();
    const app = warehouseRoutes(() => db);

    const noiRes = await app.request('/noi');
    expect(noiRes.status).toBe(200);
    const noi = (await noiRes.json()) as { matrix: Array<{ propertyId: string; period: string; noi: number }> };
    expect(noi.matrix).toEqual([
      { propertyId: '1100-rarig-ave-columbus-oh', propertyName: '1100 Rarig Ave, Columbus OH', period: '2025', noi: 95000 },
    ]);

    const issuesRes = await app.request('/issues');
    expect(issuesRes.status).toBe(200);
    const issues = (await issuesRes.json()) as { issues: unknown[] };
    expect(issues.issues).toEqual([]); // a clean committed import opens no DQ issues
  });

  it('POST /imports/:id/action {action:"approve"} on unmapped pending → 409 {ok:false, unmapped:[...]}', async () => {
    const { db, importId } = await pendingWarehouse();
    const app = warehouseRoutes(() => db);
    const res = await app.request(`/imports/${importId}/action`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ action: 'approve' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; unmapped: string[] };
    expect(body.ok).toBe(false);
    expect(body.unmapped).toEqual(expect.arrayContaining(['HVAC Repair', 'Distribution to Owner']));
  });

  it('POST /mappings then approve: 200 {mappingId, rederived}; approve → 200 {ok:true}', async () => {
    const { db, importId } = await pendingWarehouse();
    const app = warehouseRoutes(() => db);

    for (const account of ['HVAC Repair', 'Distribution to Owner']) {
      const normalizedCategory = account === 'HVAC Repair' ? 'Repairs & Maintenance' : 'Distributions';
      const classification = account === 'HVAC Repair' ? 'opex' : 'excluded';
      const m = await app.request('/mappings', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ account, normalizedCategory, classification }),
      });
      expect(m.status).toBe(200);
      const mBody = (await m.json()) as { mappingId: number; rederived: number };
      expect(typeof mBody.mappingId).toBe('number');
      expect(mBody).toHaveProperty('rederived');
    }

    const approve = await app.request(`/imports/${importId}/action`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ action: 'approve' }),
    });
    expect(approve.status).toBe(200);
    expect((await approve.json()) as { ok: boolean }).toMatchObject({ ok: true });
    expect((db.prepare('SELECT status FROM import_batches WHERE id=?').get(importId) as { status: string }).status)
      .toBe('committed');
  });

  it('POST /imports/:id/action {action:"reject"} → 200 {ok:true}; status becomes rejected', async () => {
    const { db, importId } = await pendingWarehouse();
    const app = warehouseRoutes(() => db);
    const res = await app.request(`/imports/${importId}/action`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ action: 'reject' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
    expect((db.prepare('SELECT status FROM import_batches WHERE id=?').get(importId) as { status: string }).status)
      .toBe('rejected');
  });

  it('POST /imports/:id/action with an invalid action → 400', async () => {
    const { db, importId } = await pendingWarehouse();
    const app = warehouseRoutes(() => db);
    const res = await app.request(`/imports/${importId}/action`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ action: 'frobnicate' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
  });

  it('POST /mappings with an invalid body → 400 (Zod)', async () => {
    const { db } = await committedWarehouse();
    const app = warehouseRoutes(() => db);
    // missing classification, and a junk classification value
    for (const body of [
      { account: 'X', normalizedCategory: 'Y' },
      { account: 'X', normalizedCategory: 'Y', classification: 'not-a-class' },
      { account: '', normalizedCategory: 'Y', classification: 'opex' },
    ]) {
      const res = await app.request('/mappings', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
      expect(res.status).toBe(400);
    }
  });

  it('POST /issues/:id/resolve → 200 {ok:true}; unknown/invalid id → not 2xx', async () => {
    const { db, importId } = await pendingWarehouse();
    const app = warehouseRoutes(() => db);
    const issue = db.prepare(
      "SELECT id FROM data_quality_issues WHERE import_id=? AND kind='unmapped-account' ORDER BY id LIMIT 1",
    ).get(importId) as { id: number };

    const ok = await app.request(`/issues/${issue.id}/resolve`, { method: 'POST' });
    expect(ok.status).toBe(200);
    expect((await ok.json()) as { ok: boolean }).toMatchObject({ ok: true });
    expect((db.prepare('SELECT status FROM data_quality_issues WHERE id=?').get(issue.id) as { status: string }).status)
      .toBe('resolved');

    const missing = await app.request('/issues/999999/resolve', { method: 'POST' });
    expect(missing.status).not.toBe(200);
    const bad = await app.request('/issues/not-a-number/resolve', { method: 'POST' });
    expect(bad.status).toBe(404);
  });

  it('a warehouse that cannot be opened → every route returns 503 {error:"warehouse unavailable"}, never throws', async () => {
    const app = warehouseRoutes(() => {
      throw new Error('cannot open warehouse db');
    });
    for (const [method, path, body] of [
      ['GET', '/imports', undefined],
      ['GET', '/imports/1', undefined],
      ['GET', '/noi', undefined],
      ['GET', '/issues', undefined],
      ['POST', '/imports/1/action', JSON.stringify({ action: 'approve' })],
      ['POST', '/mappings', JSON.stringify({ account: 'X', normalizedCategory: 'Y', classification: 'opex' })],
      ['POST', '/issues/1/resolve', undefined],
    ] as const) {
      const res = await app.request(path, { method, headers: body ? JSON_HEADERS : undefined, body });
      expect(res.status).toBe(503);
      expect((await res.json()) as { error: string }).toEqual({ error: 'warehouse unavailable' });
    }
  });
});
