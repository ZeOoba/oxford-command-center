// @vitest-environment node
//
// tests/unit/briefing-pdf-narrative.test.ts
//
// Phase 2 · Workstream 2 — AI Narrative Briefings (Step 10).
// Spec: docs/superpowers/specs/2026-06-21-phase-2-w2-ai-narrative-briefings.md
//
// Proves the Step 10 NON-REGRESSION contract for renderBriefingPdf:
//  • Content-identical invariant: the EXTRACTED TEXT of renderBriefingPdf(model),
//    renderBriefingPdf(model, null) and renderBriefingPdf(model, undefined) is identical
//    for BOTH property and manager models — i.e. an absent/null narrative changes NOTHING
//    in the rendered page.
//  • The no-narrative text does NOT contain the narrative section (no leakage of the
//    conditional block when narrative is absent).
//  • With a non-null NarrativeBlock the buffer is LARGER (the section was added), rendering
//    succeeds without throwing, and the headline appears in the extracted text.
//
// NOTE on "byte-identical": raw PDF bytes are NOT reproducible — pdfkit embeds a
// non-deterministic document /ID, so two renders of the SAME model differ at the byte level.
// The existing Phase C determinism test (tests/unit/briefing.test.ts:243) compares extracted
// TEXT for exactly this reason; this test follows that established, sound pattern. Content/text
// identity is the correct expression of the spec's byte-identical non-regression intent.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pdfToText } from '../../server/lib/pdf-text';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import { composePropertyBriefing, composeManagerBriefing, managerSlug } from '../../server/briefing/compose';
import { renderBriefingPdf } from '../../server/briefing/pdf';
import { PropertyBriefingModel, ManagerBriefingModel } from '../../src/contracts/briefing';
import type { NarrativeBlock } from '../../src/contracts/briefing';
import { DEFAULT_MODEL } from '../../server/ai/narrative';

const pdfParse = pdfToText;

const GEN = '2026-06-21';
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
  const dir = mkdtempSync(join(tmpdir(), 'briefing-pdf-narrative-'));
  const db = openWarehouse(join(dir, 'f.sqlite'));
  seedPropertyMaster(db);
  for (const id of KRG_PROPS) {
    insertFy(db, id, '2024', 120000, 30000);
    insertFy(db, id, '2025', 132000, 28000);
  }
  return db;
}

/** A minimal valid NarrativeBlock for use in tests. */
const NARRATIVE: NarrativeBlock = {
  headline: 'Strong NOI Growth Trajectory',
  summary: 'Property delivered 10% NOI growth driven by revenue gains.',
  bullets: ['NOI grew $14,000 (+15.6%)', 'Expense ratio improved', '2nd quartile cohort'],
  model: DEFAULT_MODEL,
};

// ── Content-identical non-regression — property ──────────────────────────────────────────────

describe('renderBriefingPdf — property model content-identical invariant (narrative absent)', () => {
  it(
    'extracted text is identical for no-arg, null, and undefined narrative',
    async () => {
      const db = seededDb();
      const model = PropertyBriefingModel.parse(composePropertyBriefing(db, KRG_PROPS[0]!, { generatedDate: GEN }));
      const noArg = (await pdfParse(await renderBriefingPdf(model))).text;
      const nullArg = (await pdfParse(await renderBriefingPdf(model, null))).text;
      const undefinedArg = (await pdfParse(await renderBriefingPdf(model, undefined))).text;
      expect(noArg).toBe(nullArg);
      expect(noArg).toBe(undefinedArg);
    },
  );

  it(
    'the narrative section does not appear when narrative is absent',
    async () => {
      const db = seededDb();
      const model = PropertyBriefingModel.parse(composePropertyBriefing(db, KRG_PROPS[0]!, { generatedDate: GEN }));
      const { text } = await pdfParse(await renderBriefingPdf(model, null));
      expect(text).not.toContain(NARRATIVE.headline);
    },
  );
});

// ── Content-identical non-regression — manager ───────────────────────────────────────────────

describe('renderBriefingPdf — manager model content-identical invariant (narrative absent)', () => {
  it(
    'extracted text is identical for no-arg, null, and undefined narrative',
    async () => {
      const db = seededDb();
      const model = ManagerBriefingModel.parse(composeManagerBriefing(db, KRG_SLUG, { generatedDate: GEN }));
      const noArg = (await pdfParse(await renderBriefingPdf(model))).text;
      const nullArg = (await pdfParse(await renderBriefingPdf(model, null))).text;
      const undefinedArg = (await pdfParse(await renderBriefingPdf(model, undefined))).text;
      expect(noArg).toBe(nullArg);
      expect(noArg).toBe(undefinedArg);
    },
  );

  it(
    'the narrative section does not appear when narrative is absent',
    async () => {
      const db = seededDb();
      const model = ManagerBriefingModel.parse(composeManagerBriefing(db, KRG_SLUG, { generatedDate: GEN }));
      const { text } = await pdfParse(await renderBriefingPdf(model, null));
      expect(text).not.toContain(NARRATIVE.headline);
    },
  );
});

// ── With non-null narrative — property ───────────────────────────────────────────────────────

describe('renderBriefingPdf — with non-null narrative (property)', () => {
  it(
    'buffer is larger than the no-narrative buffer (the narrative section was added)',
    async () => {
      const db = seededDb();
      const model = PropertyBriefingModel.parse(composePropertyBriefing(db, KRG_PROPS[0]!, { generatedDate: GEN }));
      const withoutNarrative = await renderBriefingPdf(model, null);
      const withNarrative = await renderBriefingPdf(model, NARRATIVE);
      expect(withNarrative.length).toBeGreaterThan(withoutNarrative.length);
    },
  );

  it(
    'narrative headline appears in extractable PDF text',
    async () => {
      const db = seededDb();
      const model = PropertyBriefingModel.parse(composePropertyBriefing(db, KRG_PROPS[0]!, { generatedDate: GEN }));
      const bytes = await renderBriefingPdf(model, NARRATIVE);
      const { text } = await pdfParse(bytes);
      // The headline must appear as real extractable text (not an image).
      expect(text).toContain(NARRATIVE.headline);
    },
  );

  it(
    'does not throw when narrative is provided',
    async () => {
      const db = seededDb();
      const model = PropertyBriefingModel.parse(composePropertyBriefing(db, KRG_PROPS[0]!, { generatedDate: GEN }));
      await expect(renderBriefingPdf(model, NARRATIVE)).resolves.toBeInstanceOf(Buffer);
    },
  );

  it(
    'narrative summary and bullets appear in extractable text (and not when absent)',
    async () => {
      const db = seededDb();
      const model = PropertyBriefingModel.parse(composePropertyBriefing(db, KRG_PROPS[0]!, { generatedDate: GEN }));
      const withText = (await pdfParse(await renderBriefingPdf(model, NARRATIVE))).text;
      const withoutText = (await pdfParse(await renderBriefingPdf(model, null))).text;
      // pdf-parse can drop inter-word spaces at line wraps; compare on space-stripped text.
      const flat = (s: string): string => s.replace(/\s+/g, '');
      expect(flat(withText)).toContain(flat(NARRATIVE.summary));
      expect(flat(withText)).toContain(flat(NARRATIVE.bullets[0]!));
      expect(flat(withoutText)).not.toContain(flat(NARRATIVE.summary));
    },
  );
});

// ── With non-null narrative — manager ────────────────────────────────────────────────────────

describe('renderBriefingPdf — with non-null narrative (manager)', () => {
  it(
    'buffer is larger than the no-narrative buffer',
    async () => {
      const db = seededDb();
      const model = ManagerBriefingModel.parse(composeManagerBriefing(db, KRG_SLUG, { generatedDate: GEN }));
      const withoutNarrative = await renderBriefingPdf(model, null);
      const withNarrative = await renderBriefingPdf(model, NARRATIVE);
      expect(withNarrative.length).toBeGreaterThan(withoutNarrative.length);
    },
  );

  it(
    'narrative headline appears in extractable PDF text',
    async () => {
      const db = seededDb();
      const model = ManagerBriefingModel.parse(composeManagerBriefing(db, KRG_SLUG, { generatedDate: GEN }));
      const bytes = await renderBriefingPdf(model, NARRATIVE);
      const { text } = await pdfParse(bytes);
      expect(text).toContain(NARRATIVE.headline);
    },
  );

  it(
    'does not throw when narrative is provided',
    async () => {
      const db = seededDb();
      const model = ManagerBriefingModel.parse(composeManagerBriefing(db, KRG_SLUG, { generatedDate: GEN }));
      await expect(renderBriefingPdf(model, NARRATIVE)).resolves.toBeInstanceOf(Buffer);
    },
  );
});
