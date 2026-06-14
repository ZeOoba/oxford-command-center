// tests/unit/calibration-api.test.ts
// Route tests for the read-only /calibration/* sub-routes via Hono app.request() (no network).
// Spec: docs/superpowers/specs/2026-06-13-calibration-log-design.md §3.2, §4.
// Proves: empty-warehouse no-op (the central Phase-2 caveat — never an error), the Zod read
// boundary (every route .parse()s its envelope), query validation (bad kind → 400), the 503 guard,
// and that a resolved verdict surfaces in the log + report.
import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { warehouseRoutes } from '../../server/warehouse/api';
import { resolveDueOutcomes } from '../../server/warehouse/calibration';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { approveImport } from '../../server/warehouse/actions';
import { ingestFile } from '../../server/warehouse/ingest';
import { seedMappings } from '../../server/warehouse/mapping';
import { seedPropertyMaster } from '../../server/warehouse/property-master';

const SEED = [
  { account: 'Rent', code: '5064', normalized_category: 'Rental Revenue', classification: 'revenue' },
  { account: 'HVAC Repair', code: '6285', normalized_category: 'Repairs & Maintenance', classification: 'opex' },
];

async function writeFixture(path: string, opts: { token: string; year: number; rent: number; repair: number }): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  const yy = String(opts.year).slice(2);
  for (const r of [
    ['Profit & Loss', null, null, null],
    [`Property: ${opts.token}`, null, null, null],
    [`01/01/${yy} - 12/31/${yy}  (cash basis)`, null, null, null],
    [null, 'INCOME', null, null],
    [null, null, '     5002 RENTAL INCOME', null],
    [null, null, '          5064 Rent', opts.rent],
    [null, 'EXPENSE', null, null],
    [null, null, '     6160 REPAIR', null],
    [null, null, '          6285 HVAC Repair', opts.repair],
  ] as Array<[string | null, string | null, string | null, number | null]>) {
    ws.addRow(r);
  }
  await wb.xlsx.writeFile(path);
}

async function commitYear(db: WarehouseDb, dir: string, opts: { token: string; year: number; rent: number; repair: number; at: string }): Promise<void> {
  const file = join(dir, `P&L ${opts.year} -- ${opts.token} ${opts.rent}.xlsx`);
  await writeFixture(file, opts);
  const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: opts.at, autoCommitThreshold: 0.99 });
  if (r.status === 'pending-review') expect(approveImport(db, r.importId!).ok).toBe(true);
}

function emptyDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'cal-api-'));
  const db = openWarehouse(join(dir, 'f.sqlite'));
  seedPropertyMaster(db);
  seedMappings(db, SEED);
  return db;
}

async function resolvedDb(): Promise<WarehouseDb> {
  const dir = mkdtempSync(join(tmpdir(), 'cal-api-'));
  const db = openWarehouse(join(dir, 'f.sqlite'));
  seedPropertyMaster(db);
  seedMappings(db, SEED);
  await commitYear(db, dir, { token: '1100 rarig', year: 2024, rent: 100000, repair: 8000, at: '2026-06-12T00:00:00Z' });
  await commitYear(db, dir, { token: '1100 rarig', year: 2025, rent: 112000, repair: 9000, at: '2026-06-12T01:00:00Z' });
  resolveDueOutcomes(db);
  return db;
}

describe('calibration api routes — empty warehouse (the central Phase-2 caveat)', () => {
  it('GET /calibration/log → 200 {log:[]} on a warehouse with no verdicts (never errors)', async () => {
    const app = warehouseRoutes(() => emptyDb());
    const res = await app.request('/calibration/log');
    expect(res.status).toBe(200);
    expect((await res.json()) as { log: unknown[] }).toEqual({ log: [] });
  });

  it('GET /calibration/pending → 200 {pending:[]} when no horizon has elapsed', async () => {
    const app = warehouseRoutes(() => emptyDb());
    const res = await app.request('/calibration/pending');
    expect(res.status).toBe(200);
    expect((await res.json()) as { pending: unknown[] }).toEqual({ pending: [] });
  });

  it('GET /calibration/report → 200 with zeroed counts + NULL rates (never NaN)', async () => {
    const app = warehouseRoutes(() => emptyDb());
    const res = await app.request('/calibration/report');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totalVerdicts: number; resolvedVerdicts: number; overallHitRate: number | null; byKind: unknown[];
    };
    expect(body.totalVerdicts).toBe(0);
    expect(body.resolvedVerdicts).toBe(0);
    expect(body.overallHitRate).toBeNull();
    expect(body.byKind).toEqual([]);
  });
});

describe('calibration api routes — query validation', () => {
  it('GET /calibration/log?kind=bogus → 400 (Zod)', async () => {
    const app = warehouseRoutes(() => emptyDb());
    const res = await app.request('/calibration/log?kind=bogus');
    expect(res.status).toBe(400);
  });

  it('GET /calibration/report?kind=bogus → 400 (Zod)', async () => {
    const app = warehouseRoutes(() => emptyDb());
    const res = await app.request('/calibration/report?kind=bogus');
    expect(res.status).toBe(400);
  });

  it('GET /calibration/log?status=open → 200 (valid filter)', async () => {
    const app = warehouseRoutes(() => emptyDb());
    const res = await app.request('/calibration/log?status=open');
    expect(res.status).toBe(200);
  });
});

describe('calibration api routes — resolved data surfaces', () => {
  it('GET /calibration/log → resolved verdicts carry their outcome (resolved=true, hit∈{0,1})', async () => {
    const app = warehouseRoutes(await resolvedDb().then((db) => () => db));
    const res = await app.request('/calibration/log?status=resolved');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      log: Array<{ resolved: boolean; hit: number | null; outcomePeriod: string | null; verdictKind: string }>;
    };
    expect(body.log.length).toBeGreaterThan(0);
    for (const row of body.log) {
      expect(row.resolved).toBe(true);
      expect(row.outcomePeriod).not.toBeNull();
    }
  });

  it('GET /calibration/report → resolved>0, overallHitRate finite + in [0,1]', async () => {
    const db = await resolvedDb();
    const app = warehouseRoutes(() => db);
    const res = await app.request('/calibration/report');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resolvedVerdicts: number; overallHitRate: number | null;
      byKind: Array<{ verdictKind: string; hitRate: number | null; wilsonLow: number | null; wilsonHigh: number | null }>;
    };
    expect(body.resolvedVerdicts).toBeGreaterThan(0);
    if (body.overallHitRate !== null) {
      expect(body.overallHitRate).toBeGreaterThanOrEqual(0);
      expect(body.overallHitRate).toBeLessThanOrEqual(1);
    }
    // No byKind rate is NaN; wilson bounds bracket the point estimate when present.
    for (const k of body.byKind) {
      expect(Number.isNaN(k.hitRate as unknown as number)).toBe(false);
      if (k.hitRate !== null) {
        expect(k.wilsonLow!).toBeLessThanOrEqual(k.hitRate);
        expect(k.wilsonHigh!).toBeGreaterThanOrEqual(k.hitRate);
      }
    }
  });
});

describe('calibration api routes — 503 guard', () => {
  it('an unopenable warehouse → every /calibration route returns 503, never throws', async () => {
    const app = warehouseRoutes(() => { throw new Error('cannot open warehouse db'); });
    for (const path of ['/calibration/log', '/calibration/pending', '/calibration/report']) {
      const res = await app.request(path);
      expect(res.status).toBe(503);
      expect((await res.json()) as { error: string }).toEqual({ error: 'warehouse unavailable' });
    }
  });
});
