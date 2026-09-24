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
//  • GET /briefing/property/:slug.pdf?narrative=1 → 200 application/pdf, streaming the renderer's
//    bytes verbatim (no key → narrative null). Real %PDF- validity is briefing.test.ts's job.
//  • GET /briefing/manager/:slug.pdf?narrative=1 → same.
//  • ?narrative=1 is honoured: a composed narrative reaches the renderer; without the param the
//    composer is never consulted and the renderer gets null.
//  • The ?narrative=1 PDF is content-identical to the no-param PDF when no key is set: the route
//    hands the renderer the SAME arguments (model, narrative null) on both paths, so the renderer
//    cannot produce different output.
//
// The renderer is stubbed here (2026-09-24). This file tests the ROUTE: status, headers, 404/503,
// and how ?narrative=1 is threaded into renderBriefingPdf. It does not test what the renderer
// draws. That is covered with real renders by briefing-pdf-narrative.test.ts (null / undefined /
// no-arg give identical text; a narrative adds its section) and by briefing.test.ts's routes
// block (the real .pdf route streams a real %PDF- body). Each real render was the whole cost of
// these tests: ~150-300ms CPU, but 30-60s wall inside a loaded `npm run gate`. Under the
// machine's CPU-starvation bursts a render's wall time ran 40-300x its CPU time. One real render
// took this file's "manager .pdf returns 200" test to 60114ms under a 32-burner load reproduction,
// and the gate on 2026-09-24 failed the same way. Recording the renderer's arguments is also a
// sharper check of "content-identical" than comparing extracted text.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../server/briefing/pdf', () => ({
  // Deterministic stand-in: a %PDF- header plus the arguments it was given, so a test can check
  // that the route streamed the renderer's bytes verbatim.
  renderBriefingPdf: vi.fn(async (model: unknown, narrative?: unknown) =>
    Buffer.from(`%PDF-stub ${JSON.stringify({ model, narrative: narrative === undefined ? '<undefined>' : narrative })}`, 'latin1'),
  ),
}));
import { renderBriefingPdf } from '../../server/briefing/pdf';
import type * as NarrativeModule from '../../server/ai/narrative';

// composeNarrative stays REAL by default (the JSON routes' null/degraded contract is tested against
// it). One test overrides a single call to prove ?narrative=1 threads a composed narrative through.
vi.mock('../../server/ai/narrative', async (importOriginal) => {
  const actual = await importOriginal<typeof NarrativeModule>();
  return { ...actual, composeNarrative: vi.fn(actual.composeNarrative) };
});
import { composeNarrative, DEFAULT_MODEL } from '../../server/ai/narrative';
import { warehouseRoutes } from '../../server/warehouse/api';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import { managerSlug } from '../../server/briefing/compose';
import {
  NarrativePropertyBriefingModel,
  NarrativeManagerBriefingModel,
} from '../../src/contracts/briefing';

const renderSpy = vi.mocked(renderBriefingPdf);
const composeSpy = vi.mocked(composeNarrative);

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
  renderSpy.mockClear();
  composeSpy.mockClear();
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
  it('returns 200 application/pdf (valid PDF even when no key → null narrative)', async () => {
    const db = seededDb();
    const app = warehouseRoutes(() => db);
    const res = await app.request(`/briefing/property/${KRG_PROPS[0]!}.pdf?narrative=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const buf = Buffer.from(await res.arrayBuffer());
    // The route streams exactly what the renderer returned, and the renderer got a null narrative.
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(buf.equals(await renderSpy.mock.results[0]!.value)).toBe(true);
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(renderSpy.mock.calls[0]![1]).toBeNull();
  });

  it('without ?narrative=1 is still unaffected (no-param path unchanged)', async () => {
    const db = seededDb();
    const app = warehouseRoutes(() => db);
    const res = await app.request(`/briefing/property/${KRG_PROPS[0]!}.pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(renderSpy.mock.calls[0]![1]).toBeNull();
  });

  it('?narrative=1 with no key yields content-identical PDF to no-param (null narrative → same render)', async () => {
    await withoutApiKey(async () => {
      const db = seededDb();
      const app = warehouseRoutes(() => db);
      const plain = Buffer.from(await (await app.request(`/briefing/property/${KRG_PROPS[0]!}.pdf`)).arrayBuffer());
      const withParam = Buffer.from(await (await app.request(`/briefing/property/${KRG_PROPS[0]!}.pdf?narrative=1`)).arrayBuffer());
      // Same renderer arguments on both paths (model + a null narrative), hence the same PDF.
      expect(renderSpy).toHaveBeenCalledTimes(2);
      const [plainArgs, withParamArgs] = renderSpy.mock.calls;
      expect(plainArgs![1]).toBeNull();
      expect(withParamArgs).toEqual(plainArgs);
      expect(withParam.equals(plain)).toBe(true);
    });
  });
});

describe('?narrative=1 threads a composed narrative into the renderer', () => {
  const SENTINEL = {
    headline: 'Sentinel headline',
    summary: 'Sentinel summary.',
    bullets: ['Sentinel bullet'],
    model: DEFAULT_MODEL,
  };

  for (const [kind, path] of [
    ['property', `/briefing/property/${KRG_PROPS[0]!}`],
    ['manager', `/briefing/manager/${KRG_SLUG}`],
  ] as const) {
    it(`${kind}: the composed narrative reaches the renderer; without the param it is never composed`, async () => {
      const db = seededDb();
      const app = warehouseRoutes(() => db);
      composeSpy.mockResolvedValueOnce({ narrative: SENTINEL, degraded: false });
      expect((await app.request(`${path}.pdf?narrative=1`)).status).toBe(200);
      expect(renderSpy.mock.calls[0]![1]).toEqual(SENTINEL);

      expect((await app.request(`${path}.pdf`)).status).toBe(200);
      expect(composeSpy).toHaveBeenCalledTimes(1);
      expect(renderSpy.mock.calls[1]![1]).toBeNull();
    });
  }
});

describe('GET /briefing/manager/:slug.pdf?narrative=1', () => {
  it('returns 200 application/pdf', async () => {
    const db = seededDb();
    const app = warehouseRoutes(() => db);
    const res = await app.request(`/briefing/manager/${KRG_SLUG}.pdf?narrative=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(buf.equals(await renderSpy.mock.results[0]!.value)).toBe(true);
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(renderSpy.mock.calls[0]![1]).toBeNull();
  });

  it('?narrative=1 with no key yields content-identical PDF to no-param', async () => {
    await withoutApiKey(async () => {
      const db = seededDb();
      const app = warehouseRoutes(() => db);
      const plain = Buffer.from(await (await app.request(`/briefing/manager/${KRG_SLUG}.pdf`)).arrayBuffer());
      const withParam = Buffer.from(await (await app.request(`/briefing/manager/${KRG_SLUG}.pdf?narrative=1`)).arrayBuffer());
      // Same renderer arguments on both paths (model + a null narrative), hence the same PDF.
      expect(renderSpy).toHaveBeenCalledTimes(2);
      const [plainArgs, withParamArgs] = renderSpy.mock.calls;
      expect(plainArgs![1]).toBeNull();
      expect(withParamArgs).toEqual(plainArgs);
      expect(withParam.equals(plain)).toBe(true);
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
