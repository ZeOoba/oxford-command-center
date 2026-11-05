// tests/unit/warehouse-api.test.ts
//
// Route tests for the /api/warehouse sub-router via Hono's app.request() (no network).
// The router is built with an injected db-getter so the test controls the warehouse:
// a committed Rarig 2025 import plus a separate pending-review import (only 'Rent'
// seeded → HVAC Repair + Distribution come back unmapped). The fixture writer + SEED
// are copied locally — tests never import across test files.
import ExcelJS from 'exceljs';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
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

/**
 * A second, EARLIER period for the same property so growth/drivers/anomalies have a
 * consecutive pair. 2024: Rent 90000, HVAC Repair 4000 → NOI 86000 (vs 2025 NOI 95000).
 */
async function writeFixture2024(path: string, propertyLine = 'Property: 1100 Rarig Ave'): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  const rows: Array<[string | null, string | null, string | null, number | null]> = [
    ['Profit & Loss', null, null, null],
    [propertyLine, null, null, null],
    ['01/01/24 - 12/31/24  (cash basis)', null, null, null],
    [null, 'INCOME', null, null],
    [null, null, '     5002 RENTAL INCOME', null],
    [null, null, '          5064 Rent', 90000],
    [null, 'EXPENSE', null, null],
    [null, null, '     6160 REPAIR', null],
    [null, null, '          6285 HVAC Repair', 4000],
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

/** Two committed Rarig imports (2024 + 2025) so analytics have a consecutive period pair. */
async function populatedWarehouse(): Promise<{ db: WarehouseDb }> {
  const dir = mkdtempSync(join(tmpdir(), 'whapi-'));
  const db = openWarehouse(join(dir, 'f.sqlite'));
  seedPropertyMaster(db);
  seedMappings(db, SEED);

  const f2024 = join(dir, 'P&L 2024 -- 1100 Rarig.xlsx');
  await writeFixture2024(f2024);
  const r1 = await ingestFile(db, f2024, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });
  expect(r1.status).toBe('committed');

  const f2025 = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
  await writeFixture(f2025);
  const r2 = await ingestFile(db, f2025, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });
  expect(r2.status).toBe('committed');

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

  it('POST approve on a sign-undecidable pending import → 409 {ok:false, unmapped:[], reason:"sign-undecidable"}; after POST /issues/:id/resolve → 200 {ok:true}', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whapi-undec-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, [
      { account: 'Rent', code: null, normalized_category: 'Rental Revenue', classification: 'revenue' },
      { account: 'HVAC Repair', code: null, normalized_category: 'Repairs & Maintenance', classification: 'opex' },
      { account: 'Insurance Expense', code: null, normalized_category: 'Insurance', classification: 'opex' },
    ]);
    // EXPENSE section closed by a stray zero Total before its negative-booked leaves => sign undecidable, no flip
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    const rows: Array<[string | null, string | null, string | null, number | null]> = [
      ['Profit & Loss', null, null, null],
      ['Property: 1100 Rarig Ave', null, null, null],
      ['01/01/25 - 12/31/25  (cash basis)', null, null, null],
      [null, 'INCOME', null, null],
      [null, null, '          Rent', 100000],
      [null, 'EXPENSE', null, null],
      [null, null, '          Total Expense', 0],
      [null, null, '          Insurance Expense', -30000],
      [null, null, '          HVAC Repair', -10000],
    ];
    for (const r of rows) ws.addRow(r);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await wb.xlsx.writeFile(file);
    const ing = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-10-15T00:00:00Z' });
    expect(ing.status).toBe('pending-review');
    const importId = ing.importId!;
    const app = warehouseRoutes(() => db);
    const approve = () => app.request(`/imports/${importId}/action`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ action: 'approve' }) });

    const refused = await approve();
    expect(refused.status).toBe(409); // NOT 404 (the not-found / not-pending status)
    const body = (await refused.json()) as { ok: boolean; unmapped: string[]; reason?: string; error?: string };
    expect(body).toMatchObject({ ok: false, unmapped: [], reason: 'sign-undecidable' });
    expect(body.error).toContain('sign');

    const issueId = (db.prepare("SELECT id FROM data_quality_issues WHERE import_id=? AND kind='sign-undecidable' AND status='open'").get(importId) as { id: number }).id;
    const resolved = await app.request(`/issues/${issueId}/resolve`, { method: 'POST', headers: JSON_HEADERS });
    expect(resolved.status).toBe(200);
    const ok = await approve();
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
  });

  it('POST approve on an OLDER pending version while a newer one is committed → 409 {ok:false, unmapped:[], reason:"newer-version-committed"}; the newer version keeps serving', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whapi-sup-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    mkdirSync(a);
    mkdirSync(b);
    const pathA = join(a, 'P&L 2025 -- 1100 Rarig.xlsx');
    const pathB = join(b, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeFixture(pathA);
    await writeFixture(pathB);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(pathB);
    wb.worksheets[0]!.getCell('D6').value = 110000;
    await wb.xlsx.writeFile(pathB);
    const v1 = await ingestFile(db, pathA, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z', autoCommitThreshold: 0.99 });
    const v2 = await ingestFile(db, pathB, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T01:00:00Z' });
    expect([v1.status, v2.status]).toEqual(['pending-review', 'committed']);
    const app = warehouseRoutes(() => db);
    const res = await app.request(`/imports/${v1.importId}/action`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ action: 'approve' }) });
    expect(res.status).toBe(409); // a policy refusal, not the 404 not-found / not-pending status
    const body = (await res.json()) as { ok: boolean; unmapped: string[]; reason?: string; error?: string };
    expect(body).toMatchObject({ ok: false, unmapped: [], reason: 'newer-version-committed' });
    expect(body.error).toContain('v2');
    expect(db.prepare('SELECT status FROM import_batches WHERE id=?').get(v2.importId)).toMatchObject({ status: 'committed' });
  });

  it('POST approve on an import whose ledger rows were re-derived to another property -> 409 {ok:false, unmapped:[], reason:"property-mismatch"}', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whapi-div-'));
    const db = openWarehouse(':memory:');
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    for (const sub of ['v1', 'v2', 'redrop']) mkdirSync(join(dir, sub));
    const v1File = join(dir, 'v1', 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeFixture(v1File);
    expect((await ingestFile(db, v1File, { rawDir: join(dir, 'raw'), importedAt: '2026-11-05T00:00:00Z' })).status).toBe('committed');
    const v2File = join(dir, 'v2', 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeFixture(v2File, 'Property: 1100 Rarig Ave (corrected export)');
    const v2 = await ingestFile(db, v2File, { rawDir: join(dir, 'raw'), importedAt: '2026-11-05T01:00:00Z', autoCommitThreshold: 0.99 });
    expect(v2.status).toBe('pending-review');
    db.prepare('UPDATE import_batches SET parser_version = 0 WHERE id = ?').run(v2.importId); // simulate a parser bump
    const redrop = join(dir, 'redrop', 'P&L 2025 -- Zorvane Flex Park.xlsx'); // identical bytes, unrecognized name
    copyFileSync(v2File, redrop);
    const re = await ingestFile(db, redrop, { rawDir: join(dir, 'raw'), importedAt: '2026-11-05T02:00:00Z' });
    expect(re).toMatchObject({ status: 'pending-review', importId: v2.importId }); // re-derived in place: ledger now 'unknown'
    const app = warehouseRoutes(() => db);
    const res = await app.request(`/imports/${v2.importId}/action`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ action: 'approve' }) });
    expect(res.status).toBe(409); // a policy refusal, not the 404 not-found / not-pending status
    const body = (await res.json()) as { ok: boolean; unmapped: string[]; reason?: string; error?: string };
    expect(body).toMatchObject({ ok: false, unmapped: [], reason: 'property-mismatch' });
    expect(db.prepare('SELECT status FROM import_batches WHERE id=?').get(v2.importId)).toMatchObject({ status: 'pending-review' });
  });

  it('POST approve on an unresolved-property pending import -> 409 {ok:false, unmapped:[], reason:"property-unresolved"}; the batch stays pending', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whapi-unres-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const file = join(dir, 'P&L 2025 -- Zorvane Flex Park.xlsx'); // synthetic token: not a detect.ts alias
    await writeFixture(file, 'Property: Zorvane Flex Park');
    const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-11-05T00:00:00Z' });
    expect(r.status).toBe('pending-review');
    const app = warehouseRoutes(() => db);
    const res = await app.request(`/imports/${r.importId}/action`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ action: 'approve' }) });
    expect(res.status).toBe(409); // a policy refusal, not the 404 not-found / not-pending status
    const body = (await res.json()) as { ok: boolean; unmapped: string[]; reason?: string; error?: string };
    expect(body).toMatchObject({ ok: false, unmapped: [], reason: 'property-unresolved' });
    expect(db.prepare('SELECT status FROM import_batches WHERE id=?').get(r.importId)).toMatchObject({ status: 'pending-review' });
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
      ['GET', '/analytics/metrics', undefined],
      ['GET', '/analytics/growth', undefined],
      ['GET', '/analytics/drivers/1100-rarig-ave-columbus-oh', undefined],
      ['GET', '/analytics/anomalies', undefined],
      ['GET', '/analytics/benchmarks', undefined],
      ['GET', '/analytics/scores', undefined],
      ['GET', '/analytics/pm', undefined],
    ] as const) {
      const res = await app.request(path, { method, headers: body ? JSON_HEADERS : undefined, body });
      expect(res.status).toBe(503);
      expect((await res.json()) as { error: string }).toEqual({ error: 'warehouse unavailable' });
    }
  });
});

describe('warehouse analytics routes', () => {
  const RARIG = '1100-rarig-ave-columbus-oh';

  it('GET /analytics/metrics → 200 {metrics:[...]} with per-period metrics', async () => {
    const { db } = await populatedWarehouse();
    const app = warehouseRoutes(() => db);
    const res = await app.request('/analytics/metrics');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      metrics: Array<{ propertyId: string; period: string; noi: number; noiPerSf: number | null }>;
    };
    expect(body.metrics.length).toBeGreaterThanOrEqual(2);
    const m2025 = body.metrics.find((m) => m.propertyId === RARIG && m.period === '2025')!;
    expect(m2025.noi).toBe(95000);
    expect(m2025.noiPerSf).not.toBeNull();
  });

  it('GET /analytics/growth → 200 {growth, sinceAcquisition} grouped per-property', async () => {
    const { db } = await populatedWarehouse();
    const app = warehouseRoutes(() => db);
    const res = await app.request('/analytics/growth');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      growth: Array<{ propertyId: string; period: string; noiGrowth: number | null }>;
      sinceAcquisition: Array<{ propertyId: string | null; anchorPeriod: string | null; latestPeriod: string | null }>;
    };
    expect(Array.isArray(body.growth)).toBe(true);
    const g2025 = body.growth.find((g) => g.propertyId === RARIG && g.period === '2025')!;
    expect(g2025.noiGrowth).toBeCloseTo((95000 - 86000) / 86000, 6);
    const sa = body.sinceAcquisition.find((s) => s.propertyId === RARIG)!;
    expect(sa.anchorPeriod).toBe('2024');
    expect(sa.latestPeriod).toBe('2025');
  });

  it('GET /analytics/drivers/:propertyId → 200 decomposition (default earliest→latest)', async () => {
    const { db } = await populatedWarehouse();
    const app = warehouseRoutes(() => db);
    const res = await app.request(`/analytics/drivers/${RARIG}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      propertyId: string;
      from: string;
      to: string;
      totalDelta: number;
      drivers: Array<{ category: string; delta: number; contributionPct: number | null }>;
    };
    expect(body.propertyId).toBe(RARIG);
    expect(body.from).toBe('2024');
    expect(body.to).toBe('2025');
    expect(body.totalDelta).toBeCloseTo(9000, 6); // NOI 86000 → 95000
    expect(body.drivers.length).toBeGreaterThan(0);
    expect(body.drivers.reduce((s, d) => s + d.delta, 0)).toBeCloseTo(body.totalDelta, 6);
  });

  it('GET /analytics/drivers/:unknown → 404', async () => {
    const { db } = await populatedWarehouse();
    const app = warehouseRoutes(() => db);
    const res = await app.request('/analytics/drivers/no-such-property');
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
  });

  it('GET /analytics/anomalies → 200 {anomalies:[...]}', async () => {
    const { db } = await populatedWarehouse();
    const app = warehouseRoutes(() => db);
    const res = await app.request('/analytics/anomalies');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { anomalies: Array<{ propertyId: string; kind: string }> };
    expect(Array.isArray(body.anomalies)).toBe(true);
  });

  it('GET /analytics/benchmarks → 200 {byMetric, rankings} (defaults latest/noiPerSf)', async () => {
    const { db } = await populatedWarehouse();
    const app = warehouseRoutes(() => db);
    const res = await app.request('/analytics/benchmarks');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      byMetric: { period: string; metric: string; median: number | null; n: number };
      rankings: Array<{ propertyId: string; value: number; rank: number; quartile: number }>;
    };
    expect(body.byMetric.metric).toBe('noiPerSf');
    expect(body.byMetric.period).toBe('2025');
    expect(Array.isArray(body.rankings)).toBe(true);
  });

  it('GET /analytics/benchmarks?period=2024&metric=noi → honors query params', async () => {
    const { db } = await populatedWarehouse();
    const app = warehouseRoutes(() => db);
    const res = await app.request('/analytics/benchmarks?period=2024&metric=noi');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { byMetric: { period: string; metric: string } };
    expect(body.byMetric.period).toBe('2024');
    expect(body.byMetric.metric).toBe('noi');
  });

  it('GET /analytics/benchmarks?metric=bogus → 400 (Zod)', async () => {
    const { db } = await populatedWarehouse();
    const app = warehouseRoutes(() => db);
    const res = await app.request('/analytics/benchmarks?metric=bogus');
    expect(res.status).toBe(400);
  });

  it('GET /analytics/scores → 200 {scores:[...]} with bands + capital action', async () => {
    const { db } = await populatedWarehouse();
    const app = warehouseRoutes(() => db);
    const res = await app.request('/analytics/scores');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scores: Array<{ propertyId: string; health: number; healthBand: string; capitalAction: string }>;
    };
    const rarig = body.scores.find((s) => s.propertyId === RARIG)!;
    expect(typeof rarig.health).toBe('number');
    expect(rarig.healthBand).toBeDefined();
    expect(rarig.capitalAction).toBeDefined();
  });

  it('GET /analytics/pm → 200 {scorecards:[...]}', async () => {
    const { db } = await populatedWarehouse();
    const app = warehouseRoutes(() => db);
    const res = await app.request('/analytics/pm');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scorecards: Array<{ propertyManager: string; propertyCount: number; avgNoiPerSf: number | null }>;
    };
    expect(Array.isArray(body.scorecards)).toBe(true);
  });
});
