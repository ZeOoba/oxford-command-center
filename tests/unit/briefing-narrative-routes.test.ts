// @vitest-environment node
//
// tests/unit/briefing-narrative-routes.test.ts
//
// Phase 2 · Workstream 2 — AI Narrative Briefings (Step 9).
// Spec: docs/superpowers/specs/2026-06-21-phase-2-w2-ai-narrative-briefings.md
//
// Proves the Step 9 route behaviour contract:
//  • GET /briefing/property/:slug/narrative → 200 with NarrativePropertyBriefingModel shape.
//    No API key in test env → narrative: null, degraded: true — still 200.
//  • GET /briefing/manager/:slug/narrative → same for manager.
//  • Unknown subject → 404 on both narrative routes.
//  • GET /briefing/property/:slug.pdf?narrative=1 → 200 application/pdf (still a valid PDF
//    even when no key → narrative null → plain PDF, content-identical to no-narrative path).
//  • GET /briefing/manager/:slug.pdf?narrative=1 → same.
//  • The ?narrative=1 PDF is CONTENT-identical (extracted text) to the no-param PDF when no key is
//    set (no-narrative branch is exercised → renderBriefingPdf(model, null) === renderBriefingPdf(model)).
//    Raw bytes are NOT compared — pdfkit embeds a non-deterministic /ID (see briefing.test.ts:243).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { warehouseRoutes } from '../../server/warehouse/api';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import { managerSlug } from '../../server/briefing/compose';
import {
  NarrativePropertyBriefingModel,
  NarrativeManagerBriefingModel,
} from '../../src/contracts/briefing';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse') as (b: Buffer) => Promise<{ text: string }>;

/** Run `fn` with ANTHROPIC_API_KEY guaranteed unset, then restore it — so the no-key
 *  (null-narrative) branch is exercised deterministically and no real API call is ever made. */
async function withoutApiKey<T>(fn: () => Promise<T>): Promise<T> {
  const prior = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prior;
  }
}

const KRG_PROPS = [
  '1100-rarig-ave-columbus-oh',
  '3034-westerville-rd-columbus-oh',
];
const KRG_SLUG = managerSlug('Kohr Royer Griffith');

function insertFy(db: WarehouseDb, propertyId: string, year: string, revenue: number, opex: number): void {
  const batch = db
    .prepare(
      `INSERT INTO import_batches
         (file_name, file_hash, raw_path, imported_at, property_id, period_start, period_end,
          period_grain, basis, source_system, version, status, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'year', 'cash', 'test', 1, 'committed', 0.99)`,
    )
    .run(
      `seed-${propertyId}-${year}.xlsx`,
      `hash-${propertyId}-${year}`,
      `raw/${propertyId}-${year}`,
      '2026-06-21T00:00:00Z',
      propertyId,
      `${year}-01-01`,
      `${year}-12-31`,
    );
  db.prepare(
    `INSERT INTO ledger_entries (import_id, property_id, period, raw_account, gl_code, amount, normalized_category, classification, is_active)
     VALUES (?, ?, ?, 'Rent', '5064', ?, 'Rental Revenue', 'revenue', 1)`,
  ).run(batch.lastInsertRowid, propertyId, year, revenue);
  db.prepare(
    `INSERT INTO ledger_entries (import_id, property_id, period, raw_account, gl_code, amount, normalized_category, classification, is_active)
     VALUES (?, ?, ?, 'Repairs', '6100', ?, 'Repairs & Maintenance', 'opex', 1)`,
  ).run(batch.lastInsertRowid, propertyId, year, opex);
}

function seededDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'briefing-narrative-routes-'));
  const db = openWarehouse(join(dir, 'f.sqlite'));
  seedPropertyMaster(db);
  for (const id of KRG_PROPS) {
    insertFy(db, id, '2024', 120000, 30000);
    insertFy(db, id, '2025', 132000, 28000);
  }
  return db;
}

// Ensure no API key leaks in from the environment during these tests so the
// "no key → degraded" path is always exercised deterministically.
let priorKey: string | undefined;
beforeEach(() => {
  priorKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});
afterEach(() => {
  if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = priorKey;
});

// ── GET /briefing/property/:slug/narrative ────────────────────────────────────────────────────

describe('GET /briefing/property/:slug/narrative', () => {
  it('returns 200 with NarrativePropertyBriefingModel shape (no key → narrative null, degraded true)', async () => {
    const db = seededDb();
    const app = warehouseRoutes(() => db);
    const res = await app.request(`/briefing/property/${KRG_PROPS[0]!}/narrative`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    // Must Zod-parse against the full NarrativePropertyBriefingModel envelope
    const parsed = NarrativePropertyBriefingModel.parse(body);
    expect(parsed.kind).toBe('property');
    expect(parsed.subject.propertyId).toBe(KRG_PROPS[0]);
    // No key → degraded
    expect(parsed.narrative).toBeNull();
    expect(parsed.degraded).toBe(true);
  });

  it('returns 200 even when AI fails (always-200 contract)', async () => {
    const db = seededDb();
    const app = warehouseRoutes(() => db);
    const res = await app.request(`/briefing/property/${KRG_PROPS[0]!}/narrative`);
    expect(res.status).toBe(200);
  });

  it('returns 404 for an unknown property slug', async () => {
    const db = seededDb();
    const app = warehouseRoutes(() => db);
    const res = await app.request('/briefing/property/no-such-property/narrative');
    expect(res.status).toBe(404);
  });

  it('the body includes all base PropertyBriefingModel fields', async () => {
    const db = seededDb();
    const app = warehouseRoutes(() => db);
    const res = await app.request(`/briefing/property/${KRG_PROPS[0]!}/narrative`);
    const body = NarrativePropertyBriefingModel.parse(await res.json());
    // Base model fields must be present
    expect(body.meta.generatedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.meta.masthead).toBe('OXFORD REALTY ADVISORS');
    expect(body.meta.confidentialMarking).toBe('CONFIDENTIAL — INTERNAL');
    expect(Array.isArray(body.kpis)).toBe(true);
    expect(Array.isArray(body.drivers)).toBe(true);
    expect(Array.isArray(body.anomalies)).toBe(true);
  });
});

// ── GET /briefing/manager/:slug/narrative ────────────────────────────────────────────────────

describe('GET /briefing/manager/:slug/narrative', () => {
  it('returns 200 with NarrativeManagerBriefingModel shape (no key → narrative null, degraded true)', async () => {
    const db = seededDb();
    const app = warehouseRoutes(() => db);
    const res = await app.request(`/briefing/manager/${KRG_SLUG}/narrative`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    const parsed = NarrativeManagerBriefingModel.parse(body);
    expect(parsed.kind).toBe('manager');
    expect(parsed.narrative).toBeNull();
    expect(parsed.degraded).toBe(true);
  });

  it('returns 200 even when AI fails (always-200 contract)', async () => {
    const db = seededDb();
    const app = warehouseRoutes(() => db);
    const res = await app.request(`/briefing/manager/${KRG_SLUG}/narrative`);
    expect(res.status).toBe(200);
  });

  it('returns 404 for an unknown manager slug', async () => {
    const db = seededDb();
    const app = warehouseRoutes(() => db);
    const res = await app.request('/briefing/manager/no-such-manager/narrative');
    expect(res.status).toBe(404);
  });

  it('the body includes all base ManagerBriefingModel fields', async () => {
    const db = seededDb();
    const app = warehouseRoutes(() => db);
    const res = await app.request(`/briefing/manager/${KRG_SLUG}/narrative`);
    const body = NarrativeManagerBriefingModel.parse(await res.json());
    expect(body.meta.masthead).toBe('OXFORD REALTY ADVISORS');
    expect(body.subject.propertyCount).toBeGreaterThan(0);
    expect(Array.isArray(body.managedProperties)).toBe(true);
  });
});

// ── ?narrative=1 on existing PDF routes ──────────────────────────────────────────────────────

describe('GET /briefing/property/:slug.pdf?narrative=1', () => {
  it('returns 200 application/pdf (valid PDF even when no key → null narrative)', { timeout: 30000 }, async () => {
    const db = seededDb();
    const app = warehouseRoutes(() => db);
    const res = await app.request(`/briefing/property/${KRG_PROPS[0]!}.pdf?narrative=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('without ?narrative=1 is still unaffected (no-param path unchanged)', { timeout: 30000 }, async () => {
    const db = seededDb();
    const app = warehouseRoutes(() => db);
    const res = await app.request(`/briefing/property/${KRG_PROPS[0]!}.pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
  });

  it('?narrative=1 with no key yields content-identical PDF to no-param (null narrative → same render)', { timeout: 30000 }, async () => {
    await withoutApiKey(async () => {
      const db = seededDb();
      const app = warehouseRoutes(() => db);
      const plain = Buffer.from(await (await app.request(`/briefing/property/${KRG_PROPS[0]!}.pdf`)).arrayBuffer());
      const withParam = Buffer.from(await (await app.request(`/briefing/property/${KRG_PROPS[0]!}.pdf?narrative=1`)).arrayBuffer());
      const plainText = (await pdfParse(plain)).text;
      const withParamText = (await pdfParse(withParam)).text;
      expect(plainText).toBe(withParamText);
    });
  });
});

describe('GET /briefing/manager/:slug.pdf?narrative=1', () => {
  it('returns 200 application/pdf', { timeout: 30000 }, async () => {
    const db = seededDb();
    const app = warehouseRoutes(() => db);
    const res = await app.request(`/briefing/manager/${KRG_SLUG}.pdf?narrative=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('?narrative=1 with no key yields content-identical PDF to no-param', { timeout: 30000 }, async () => {
    await withoutApiKey(async () => {
      const db = seededDb();
      const app = warehouseRoutes(() => db);
      const plain = Buffer.from(await (await app.request(`/briefing/manager/${KRG_SLUG}.pdf`)).arrayBuffer());
      const withParam = Buffer.from(await (await app.request(`/briefing/manager/${KRG_SLUG}.pdf?narrative=1`)).arrayBuffer());
      const plainText = (await pdfParse(plain)).text;
      const withParamText = (await pdfParse(withParam)).text;
      expect(plainText).toBe(withParamText);
    });
  });
});

// ── 503 when warehouse unavailable ───────────────────────────────────────────────────────────

describe('503 when warehouse is unavailable', () => {
  it('narrative property route returns 503', async () => {
    const app = warehouseRoutes(() => { throw new Error('cold'); });
    const res = await app.request(`/briefing/property/${KRG_PROPS[0]!}/narrative`);
    expect(res.status).toBe(503);
  });

  it('narrative manager route returns 503', async () => {
    const app = warehouseRoutes(() => { throw new Error('cold'); });
    const res = await app.request(`/briefing/manager/${KRG_SLUG}/narrative`);
    expect(res.status).toBe(503);
  });
});
