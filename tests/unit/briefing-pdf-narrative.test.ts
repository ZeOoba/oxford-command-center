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
//
// Render-once fixtures (2026-09-24): each subject has four distinct documents (no-arg, null,
// undefined, and a real narrative). Every one is rendered and text-extracted at most once per file
// and shared by the tests that assert on it (see render() / text() below). The tests used to
// re-render the same documents: 18 renders and 12 extractions, now 8 and 8. A render costs
// ~150-300ms CPU, but in a loaded `npm run gate` its wall time ran 40-300x that during
// CPU-starvation bursts. That timed out "does not throw when narrative is provided (manager)" at
// 60s on 2026-09-24, one render away from the previous test's identical call. Each fixture is
// built lazily, so any single test still works alone (e.g. under `-t`). A renderer throw rejects
// the memoized promise and fails every test that uses it.
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

// ── Shared, lazily-built fixtures (read-only: nothing below writes to the warehouse) ─────────────

type Subject = 'property' | 'manager';
/** How the narrative argument is passed: omitted, explicit null, explicit undefined, or NARRATIVE. */
type Variant = 'no-arg' | 'null' | 'undefined' | 'narrative';

let fixtureDb: WarehouseDb | undefined;
const db = (): WarehouseDb => (fixtureDb ??= seededDb());

const models = new Map<Subject, PropertyBriefingModel | ManagerBriefingModel>();
function model(subject: Subject): PropertyBriefingModel | ManagerBriefingModel {
  let m = models.get(subject);
  if (!m) {
    m =
      subject === 'property'
        ? PropertyBriefingModel.parse(composePropertyBriefing(db(), KRG_PROPS[0]!, { generatedDate: GEN }))
        : ManagerBriefingModel.parse(composeManagerBriefing(db(), KRG_SLUG, { generatedDate: GEN }));
    models.set(subject, m);
  }
  return m;
}

const renders = new Map<string, Promise<Buffer>>();
/** renderBriefingPdf for this subject/variant, called at most once per file. */
function render(subject: Subject, variant: Variant): Promise<Buffer> {
  const key = `${subject}:${variant}`;
  let r = renders.get(key);
  if (!r) {
    const m = model(subject);
    r =
      variant === 'no-arg'
        ? renderBriefingPdf(m)
        : variant === 'null'
          ? renderBriefingPdf(m, null)
          : variant === 'undefined'
            ? renderBriefingPdf(m, undefined)
            : renderBriefingPdf(m, NARRATIVE);
    renders.set(key, r);
  }
  return r;
}

const texts = new Map<string, Promise<string>>();
/** Extracted text of render(subject, variant), extracted at most once per file. */
function text(subject: Subject, variant: Variant): Promise<string> {
  const key = `${subject}:${variant}`;
  let t = texts.get(key);
  if (!t) {
    t = render(subject, variant).then(async (bytes) => (await pdfParse(bytes)).text);
    texts.set(key, t);
  }
  return t;
}

// ── Content-identical non-regression — property and manager ─────────────────────────────────

for (const subject of ['property', 'manager'] as const) {
  describe(`renderBriefingPdf — ${subject} model content-identical invariant (narrative absent)`, () => {
    it('extracted text is identical for no-arg, null, and undefined narrative', async () => {
      const noArg = await text(subject, 'no-arg');
      expect(noArg).toBe(await text(subject, 'null'));
      expect(noArg).toBe(await text(subject, 'undefined'));
    });

    it('the narrative section does not appear when narrative is absent', async () => {
      expect(await text(subject, 'null')).not.toContain(NARRATIVE.headline);
    });
  });
}

// ── With non-null narrative — property and manager ───────────────────────────────────────────

for (const subject of ['property', 'manager'] as const) {
  describe(`renderBriefingPdf — with non-null narrative (${subject})`, () => {
    it('buffer is larger than the no-narrative buffer (the narrative section was added)', async () => {
      const withoutNarrative = await render(subject, 'null');
      const withNarrative = await render(subject, 'narrative');
      expect(withNarrative.length).toBeGreaterThan(withoutNarrative.length);
    });

    it('narrative headline appears in extractable PDF text', async () => {
      // The headline must appear as real extractable text (not an image).
      expect(await text(subject, 'narrative')).toContain(NARRATIVE.headline);
    });

    it('does not throw when narrative is provided', async () => {
      await expect(render(subject, 'narrative')).resolves.toBeInstanceOf(Buffer);
    });

    it('narrative summary and bullets appear in extractable text (and not when absent)', async () => {
      const withText = await text(subject, 'narrative');
      const withoutText = await text(subject, 'null');
      // pdf-parse can drop inter-word spaces at line wraps; compare on space-stripped text.
      const flat = (s: string): string => s.replace(/\s+/g, '');
      expect(flat(withText)).toContain(flat(NARRATIVE.summary));
      expect(flat(withText)).toContain(flat(NARRATIVE.bullets[0]!));
      expect(flat(withoutText)).not.toContain(flat(NARRATIVE.summary));
    });
  });
}
