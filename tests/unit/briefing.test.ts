// @vitest-environment node
//
// tests/unit/briefing.test.ts
//
// PFI Phase C — Briefings + PDF export. Spec: docs/superpowers/specs/2026-06-14-pfi-phase-c-briefings-pdf.md.
// Runs in the NODE environment (not jsdom): the briefing pipeline is server-side, and the PDF text
// extractor (pdf-parse → pdfjs) needs a real Node worker, not jsdom's fake-worker stub.
//
// Proves the behavior contract:
//  • compose → BriefingModel for a property and a PM, off the SAME analytics the screen reads
//    (adversarial #1: no recompute — figures equal the engine output formatted with fmtUsd/fmtPct).
//  • graceful degradation: empty/missing sections render '—'/'n/a', never crash (contract #4).
//  • extractable text: render → pdf-parse → key figures appear as TEXT (contract #1; guards a
//    flattened/image regression — adversarial #2).
//  • determinism: same model → identical EXTRACTED text; the only date is the injected
//    generatedDate, never Date.now() in the renderer (contract #2).
//  • confidentiality: a property tied to an active confidential deal carries NO deal term in the
//    model; the guard catches a leak (contract #3, adversarial #4).
//  • brand-face health: every brand TTF/woff resolved (no silent Helvetica swap — adversarial #3).
//  • per-PM roll-up totals managed properties correctly (adversarial #6).
//  • routes: .pdf streams application/pdf with the right filename; JSON sibling Zod-parses; 503 / 404.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { warehouseRoutes } from '../../server/warehouse/api';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import { propertyPeriodMetrics } from '../../server/warehouse/metrics';
import { scoreProperties } from '../../server/warehouse/scores';
import { composePropertyBriefing, composeManagerBriefing, managerSlug } from '../../server/briefing/compose';
import { renderBriefingPdf } from '../../server/briefing/pdf';
import { briefingFilename, subjectToken } from '../../server/briefing/filename';
import { scanForConfidential, assertNoConfidential } from '../../server/briefing/confidential';
import { fontHealth } from '../../server/briefing/theme';
import { fmtUsd } from '../../src/analytics/format';
import { PropertyBriefingModel, ManagerBriefingModel } from '../../src/contracts/briefing';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse') as (b: Buffer) => Promise<{ text: string }>;

const GEN = '2026-06-14';
// Two real seeded properties with a property_manager (Kohr Royer Griffith manages the Columbus 5).
const KRG_SLUG = managerSlug('Kohr Royer Griffith');

/** A warehouse seeded with property_master + a couple of committed full-year ledger rows so the
 *  analytics engines have data to read (mirrors the lease-run-api test's deterministic seeder). */
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
      '2026-06-12T00:00:00Z',
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

const KRG_PROPS = [
  '1100-rarig-ave-columbus-oh',
  '3034-westerville-rd-columbus-oh',
];

function seededDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'briefing-'));
  const db = openWarehouse(join(dir, 'f.sqlite'));
  seedPropertyMaster(db);
  // Give two KRG-managed properties two full years each so scores/drivers/since-acquisition populate.
  for (const id of KRG_PROPS) {
    insertFy(db, id, '2024', 120000, 30000);
    insertFy(db, id, '2025', 132000, 28000);
  }
  return db;
}

describe('confidential scanner (the guard the composer leans on)', () => {
  it('flags a known active-deal identifier (always-term)', () => {
    expect(scanForConfidential('the 3520 E. Fulton Street deal')).not.toBeNull();
    expect(scanForConfidential('SIJ Partnership terms')).not.toBeNull();
  });
  it('flags a context term only with an anchor present', () => {
    expect(scanForConfidential('chlorinated solvent plume')).toBeNull(); // no anchor
    expect(scanForConfidential('fulton: chlorinated solvent plume')).not.toBeNull(); // anchored
  });
  it('passes clean ownership-financial text', () => {
    expect(scanForConfidential('1100 Rarig Ave NOI $104,000 health 72.3')).toBeNull();
    expect(() => assertNoConfidential({ name: '1100 Rarig Ave', noi: 104000 })).not.toThrow();
  });
  it('assertNoConfidential throws on a leak, naming only the deal label (never the term)', () => {
    let msg = '';
    try {
      assertNoConfidential({ note: 'columbus stamping co' });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/confidential deal term/);
    expect(msg.toLowerCase()).not.toContain('columbus stamping'); // never echoes the matched term
  });
});

describe('brand-font health (adversarial #3 — no silent non-brand swap)', () => {
  it('every brand face resolved to a real file', () => {
    const health = fontHealth();
    const missing = health.filter((f) => !f.brandFaceLoaded);
    expect(missing).toHaveLength(0);
    // sanity: the brand font files are present where we expect (the spec's @fontsource source).
    expect(() => require.resolve('@fontsource/eb-garamond/files/eb-garamond-latin-400-normal.woff')).not.toThrow();
  });
});

describe('composePropertyBriefing — reads the same analytics the screen does (adversarial #1)', () => {
  it('builds a Zod-valid property model with figures equal to the engine output', () => {
    const db = seededDb();
    const id = KRG_PROPS[0]!;
    const model = composePropertyBriefing(db, id, { generatedDate: GEN });
    expect(model).not.toBeNull();
    const parsed = PropertyBriefingModel.parse(model);
    expect(parsed.subject.propertyId).toBe(id);
    expect(parsed.subject.name).not.toBe('');
    expect(parsed.meta.generatedDate).toBe(GEN);
    expect(parsed.meta.masthead).toBe('OXFORD REALTY ADVISORS');
    expect(parsed.meta.confidentialMarking).toBe('CONFIDENTIAL — INTERNAL');

    // The NOI figure equals the engine's level NOI, formatted with the SAME helper as the screen.
    const metrics = propertyPeriodMetrics(db).filter((m) => m.propertyId === id);
    const latestFy = metrics.filter((m) => m.grainHint === 'year').sort((a, b) => a.period.localeCompare(b.period)).slice(-1)[0]!;
    const noiKpi = parsed.kpis.find((k) => k.label === 'NOI')!;
    expect(noiKpi.figure.display).toBe(fmtUsd(latestFy.noi));
    expect(noiKpi.figure.value).toBe(latestFy.noi);

    // The verdict health equals the score engine's health (no recompute).
    const score = scoreProperties(db, propertyPeriodMetrics(db)).find((s) => s.propertyId === id)!;
    expect(parsed.verdict.health.value).toBe(score.health);
    expect(parsed.verdict.healthBand).toBe(score.healthBand);

    // Two full years → a non-empty driver bridge and a non-empty NOI trend sparkline.
    expect(parsed.drivers.length).toBeGreaterThan(0);
    expect(parsed.noiTrend.length).toBeGreaterThanOrEqual(2);
  });

  it('degrades gracefully for a property with no ledger data (empty sections → —/n.a., no crash)', () => {
    const db = seededDb();
    // A real master property we did NOT seed ledger rows for.
    const id = '29000-information-lane-easton-md';
    const model = composePropertyBriefing(db, id, { generatedDate: GEN });
    expect(model).not.toBeNull();
    const parsed = PropertyBriefingModel.parse(model);
    expect(parsed.kpis.find((k) => k.label === 'NOI')!.figure.display).toBe('—');
    expect(parsed.drivers).toEqual([]); // no two full years → no bridge
    expect(parsed.verdict.rootCause).toBeNull();
  });

  it('returns null for a property absent from the master (caller → 404)', () => {
    const db = seededDb();
    expect(composePropertyBriefing(db, 'no-such-property', { generatedDate: GEN })).toBeNull();
  });
});

describe('composeManagerBriefing — per-PM roll-up (adversarial #6: totals must be correct)', () => {
  it('builds a Zod-valid manager model whose aggregate NOI equals the sum of managed-property NOI', () => {
    const db = seededDb();
    const model = composeManagerBriefing(db, KRG_SLUG, { generatedDate: GEN });
    expect(model).not.toBeNull();
    const parsed = ManagerBriefingModel.parse(model);
    expect(managerSlug(parsed.subject.name)).toBe(KRG_SLUG);
    expect(parsed.managedProperties.length).toBeGreaterThan(0);

    // Independently total the latest-FY NOI for the two seeded KRG properties and compare.
    const allMetrics = propertyPeriodMetrics(db);
    let expected = 0;
    for (const id of KRG_PROPS) {
      const latest = allMetrics
        .filter((m) => m.propertyId === id && m.grainHint === 'year')
        .sort((a, b) => a.period.localeCompare(b.period))
        .slice(-1)[0];
      if (latest) expected += latest.noi;
    }
    expect(parsed.scorecard.aggregateNoi.value).toBeCloseTo(expected, 2);
    expect(parsed.scorecard.aggregateNoi.display).toBe(fmtUsd(expected));
  });

  it('returns null for an unknown manager slug (caller → 404)', () => {
    const db = seededDb();
    expect(composeManagerBriefing(db, 'no-such-manager', { generatedDate: GEN })).toBeNull();
  });
});

describe('PDF render — extractable text layer (contract #1, adversarial #2)', () => {
  it('renders a property briefing whose key figures appear as EXTRACTABLE TEXT (not a flattened image)', { timeout: 30000 }, async () => {
    const db = seededDb();
    const id = KRG_PROPS[0]!;
    const model = PropertyBriefingModel.parse(composePropertyBriefing(db, id, { generatedDate: GEN }));
    const bytes = await renderBriefingPdf(model);
    expect(bytes.length).toBeGreaterThan(1000);
    const { text } = await pdfParse(bytes);
    const flat = text.replace(/\s+/g, ' ');
    const noSpace = text.replace(/\s+/g, '');
    // The masthead carries brand letter-spacing, so it extracts with inter-glyph spaces — assert it
    // space-stripped (proving the glyphs ARE real text, not a flattened image).
    expect(noSpace).toContain('OXFORDREALTYADVISORS');
    expect(flat).toContain('CONFIDENTIAL');
    // Confidential marking, property name, a real $ figure, and the generated-date all extract verbatim.
    expect(flat).toContain(model.subject.name);
    const noi = model.kpis.find((k) => k.label === 'NOI')!.figure.display;
    expect(flat).toContain(noi);
    expect(flat).toContain(GEN); // generated-date stamp
  });

  it('renders a manager briefing whose name + aggregate NOI extract as text', { timeout: 30000 }, async () => {
    const db = seededDb();
    const model = ManagerBriefingModel.parse(composeManagerBriefing(db, KRG_SLUG, { generatedDate: GEN }));
    const bytes = await renderBriefingPdf(model);
    const { text } = await pdfParse(bytes);
    const flat = text.replace(/\s+/g, ' ');
    expect(flat).toContain(model.subject.name);
    expect(flat).toContain(model.scorecard.aggregateNoi.display);
  });
});

describe('determinism (contract #2 — same model → identical extracted text, no Date.now in renderer)', () => {
  it('two renders of the same model yield identical extracted text', { timeout: 30000 }, async () => {
    const db = seededDb();
    const model = PropertyBriefingModel.parse(composePropertyBriefing(db, KRG_PROPS[0]!, { generatedDate: GEN }));
    const t1 = (await pdfParse(await renderBriefingPdf(model))).text;
    const t2 = (await pdfParse(await renderBriefingPdf(model))).text;
    expect(t1).toBe(t2);
  });
});

describe('confidentiality (contract #3, adversarial #4)', () => {
  it('a composed property model carries NO confidential deal term', () => {
    const db = seededDb();
    for (const id of KRG_PROPS) {
      const model = composePropertyBriefing(db, id, { generatedDate: GEN });
      expect(scanForConfidential(model)).toBeNull();
    }
  });
  it('the composer would THROW if a confidential term reached the model (fail-loud backstop)', () => {
    // The guard runs inside compose; here we prove the assertion semantics directly on a poisoned model.
    expect(() => assertNoConfidential({ kind: 'property', subject: { name: '3520 E. Fulton Street' } })).toThrow(/confidential/);
  });

  it('ADVERSARIAL #4: a property whose master NAME carries a confidential term makes compose THROW (no silent leak)', () => {
    const db = seededDb();
    // Poison a master row's display name with a confidential always-term, then seed it ledger data.
    db.prepare(`UPDATE property_master SET name = ? WHERE id = ?`).run(
      '3520 E. Fulton Street Portfolio',
      KRG_PROPS[0],
    );
    // compose runs assertNoConfidential on the finished model → it must REFUSE to produce the briefing.
    expect(() => composePropertyBriefing(db, KRG_PROPS[0]!, { generatedDate: GEN })).toThrow(/confidential deal term/);
  });
});

describe('ADVERSARIAL — grain rule: a partial-year (YTD) NOI is never shown as the full-year figure (#5)', () => {
  it('the KPI NOI is the latest FULL-YEAR value even when a later YTD partial exists', () => {
    const db = seededDb();
    const id = KRG_PROPS[0]!;
    // Add a 2026 YTD (partial) row with a deliberately different NOI; it must NOT become the headline.
    const batch = db
      .prepare(
        `INSERT INTO import_batches (file_name, file_hash, raw_path, imported_at, property_id, period_start, period_end, period_grain, basis, source_system, version, status, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ytd', 'cash', 'test', 1, 'committed', 0.99)`,
      )
      .run('ytd.xlsx', 'ytdhash', 'raw/ytd', '2026-06-12T00:00:00Z', id, '2026-01-01', '2026-06-30');
    db.prepare(
      `INSERT INTO ledger_entries (import_id, property_id, period, raw_account, gl_code, amount, normalized_category, classification, is_active)
       VALUES (?, ?, '2026', 'Rent', '5064', 50000, 'Rental Revenue', 'revenue', 1)`,
    ).run(batch.lastInsertRowid, id);

    const model = PropertyBriefingModel.parse(composePropertyBriefing(db, id, { generatedDate: GEN }));
    const fyMetrics = propertyPeriodMetrics(db).filter((m) => m.propertyId === id && m.grainHint === 'year');
    const latestFy = fyMetrics.sort((a, b) => a.period.localeCompare(b.period)).slice(-1)[0]!;
    // The headline NOI equals the latest FY NOI (2025), NOT the 2026 YTD partial (which is ~$50k revenue).
    expect(model.kpis.find((k) => k.label === 'NOI')!.figure.value).toBe(latestFy.noi);
    expect(model.subject.scoredPeriod).toBe('2025');
    // The NOI trend sparkline contains ONLY full-year points (no YTD partial leaks in).
    expect(model.noiTrend).toEqual(
      fyMetrics.sort((a, b) => a.period.localeCompare(b.period)).map((m) => m.noi),
    );
  });
});

describe('ADVERSARIAL — composer reads, never recomputes: PDF figure equals the live score engine (#1)', () => {
  it('the verdict health in the model is byte-identical to scoreProperties output (not a re-derive)', () => {
    const db = seededDb();
    const id = KRG_PROPS[0]!;
    const engineScore = scoreProperties(db, propertyPeriodMetrics(db)).find((s) => s.propertyId === id)!;
    const model = composePropertyBriefing(db, id, { generatedDate: GEN })!;
    // Same number, same band, same capital action — the screen and the PDF cannot disagree.
    expect(model.verdict.health.value).toBe(engineScore.health);
    expect(model.verdict.health.display).toBe(engineScore.health.toFixed(1));
    expect(model.verdict.healthBand).toBe(engineScore.healthBand);
    expect(model.verdict.attentionBand).toBe(engineScore.attentionBand);
    expect(model.verdict.capitalAction).toBe(engineScore.capitalAction);
    expect(model.benchmark.noiPerSfQuartile).toBe(engineScore.noiPerSfQuartile);
  });
});

describe('filename', () => {
  it('builds ORA_Briefing_<Subject>_<YYYYMMDD>.pdf', () => {
    const db = seededDb();
    const model = PropertyBriefingModel.parse(composePropertyBriefing(db, KRG_PROPS[0]!, { generatedDate: GEN }));
    const fn = briefingFilename(model);
    expect(fn).toMatch(/^ORA_Briefing_.+_20260614\.pdf$/);
    expect(subjectToken('1100 Rarig Ave, Columbus OH')).toBe('1100_Rarig_Ave_Columbus_OH');
  });
});

describe('routes — /api/warehouse/briefing/*', () => {
  it('property .pdf streams application/pdf with the right filename', { timeout: 30000 }, async () => {
    const db = seededDb();
    const app = warehouseRoutes(() => db);
    const res = await app.request(`/briefing/property/${KRG_PROPS[0]}.pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="ORA_Briefing_.+_\d{8}\.pdf"/);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-'); // real PDF magic
  });

  it('property JSON sibling Zod-parses', async () => {
    const db = seededDb();
    const app = warehouseRoutes(() => db);
    const res = await app.request(`/briefing/property/${KRG_PROPS[0]}`);
    expect(res.status).toBe(200);
    const body = PropertyBriefingModel.parse(await res.json());
    expect(body.subject.propertyId).toBe(KRG_PROPS[0]);
  });

  it('manager .pdf + JSON sibling work', { timeout: 30000 }, async () => {
    const db = seededDb();
    const app = warehouseRoutes(() => db);
    const pdf = await app.request(`/briefing/manager/${KRG_SLUG}.pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    const json = await app.request(`/briefing/manager/${KRG_SLUG}`);
    const body = ManagerBriefingModel.parse(await json.json());
    expect(managerSlug(body.subject.name)).toBe(KRG_SLUG);
  });

  it('404 for an unknown property / manager', async () => {
    const db = seededDb();
    const app = warehouseRoutes(() => db);
    expect((await app.request(`/briefing/property/no-such.pdf`)).status).toBe(404);
    expect((await app.request(`/briefing/manager/no-such`)).status).toBe(404);
  });

  it('503 when the warehouse is unavailable', async () => {
    const app = warehouseRoutes(() => {
      throw new Error('cold');
    });
    expect((await app.request(`/briefing/property/${KRG_PROPS[0]}.pdf`)).status).toBe(503);
    expect((await app.request(`/briefing/manager/${KRG_SLUG}`)).status).toBe(503);
  });
});
