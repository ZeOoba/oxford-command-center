# Lease & Obligation Intelligence P1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Columbus lease documents into dated, page-cited obligations — every economically consequential term extracted, its page verified against our own text, and every option-notice or escalation date computed deterministically.

**Architecture:** A pipeline, not an agent. Documents are registered (hash, type, amendment-chain order, executed flag) → per-page text is extracted locally → Pass A asks Sonnet 5 for structured field values → Pass B asks Opus 5 for the verbatim quote backing each field → **we resolve the page ourselves** by locating that quote in our own page text, so a wrong page is a caught error rather than a trusted claim → disagreements become `disputed` and queue for a human → verified facts feed a pure-function date engine that emits obligations.

**Why we resolve pages instead of trusting model-reported citations:** a model-reported page number is an assertion; a quote located in our own extracted page text is a verifiable fact. The check is deterministic, costs nothing, and catches the exact failure mode that matters here (a plausible term attributed to the wrong clause). The Anthropic citations feature can be layered on later as a second signal; it is not a substitute for the check.

**Tech Stack:** TypeScript (ESM, Node ≥20), better-sqlite3, vitest, pdf-parse ^2.4.5, mammoth ^1.12.0 (both already dependencies), Anthropic Messages API via raw `fetch` (matching `server/warehouse/om-extract.ts`).

## Global Constraints

- **Depends on Track 1 Task 3** (migration 030: `documents`, `lease_facts`, `obligations`, `audit_log`, `agent_runs`).
- **Lease PDFs are read-only.** They live under `OneDrive - Oxford Capital Partners/Business/Master Lease Database/`. Never move, rename, or rewrite an original (Invariant 5). The registry stores hash + path only.
- **Guarantor PII never goes to the API.** A document classified `guaranty` is registered with `contains_pii = 1` and is excluded from extraction unless explicitly opted in per document.
- Every LLM call is wrapped in `withAgentRun` (Track 1 Task 7) so model, prompt version and cost are recorded.
- Every LLM call takes an injectable `fetchImpl` so tests never hit the network (pattern: `server/warehouse/om-extract.ts:11-12`).
- Model ids: Sonnet 5 = `claude-sonnet-5`, Opus 5 = `claude-opus-5`. Override via `LEASE_EXTRACT_MODEL` / `LEASE_QUOTE_MODEL`.
- **Fixtures must be redacted.** No real tenant name, rent figure or address in `tests/fixtures/`. Synthesize them.
- Scope is **Columbus leases only** for P1, matching the leasing-intelligence market.

---

### Task 1: Per-page text extraction

**Files:**
- Create: `server/warehouse/lease-page-text.ts`, `tests/unit/lease-page-text.test.ts`, `tests/fixtures/leases/make-fixture.ts`

**Interfaces:**
- Produces: `extractPageTexts(filePath: string): Promise<string[]>` (index 0 = page 1) · `normalizeForMatch(s: string): string`.

> **Implementation note:** `pdf-parse` v2's default export returns whole-document text. Per-page text comes from its page-level callback/option (v2 exposes a `pagerender` hook; confirm the exact name against `node_modules/pdf-parse/` before writing — the test below pins the behaviour either way). If the installed version cannot emit per-page text, split on `\f` (form feed) as the fallback and record that in a code comment.

- [ ] **Step 1: Create a deterministic fixture generator**

Create `tests/fixtures/leases/make-fixture.ts`:

```ts
/** Generates a synthetic 3-page PDF with known text per page. No real ORA data. */
import { writeFileSync } from 'node:fs';

export const FIXTURE_PAGES = [
  'LEASE AGREEMENT\nThis Lease is made as of January 1, 2024 between LANDLORD LLC and EXAMPLE TENANT INC.',
  'Section 4. Term. The Term commences February 1, 2024 and expires January 31, 2029.',
  'Section 9. Renewal Option. Tenant shall have one option to renew for five years, exercisable by written notice ' +
    'delivered to Landlord not later than one hundred eighty (180) days prior to the expiration of the Term.',
];

/** Minimal single-stream-per-page PDF. Enough for a text extractor to read; not a real-world PDF. */
export function writeFixturePdf(path: string): void {
  const esc = (s: string) => s.replace(/([()\\])/g, '\\$1');
  const objects: string[] = [];
  const pageIds = FIXTURE_PAGES.map((_, i) => 4 + i * 2);
  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${FIXTURE_PAGES.length} >>\nendobj\n`);
  objects.push('3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');
  FIXTURE_PAGES.forEach((text, i) => {
    const pageId = pageIds[i];
    const streamId = pageId + 1;
    const lines = text.split('\n').map((l, n) => `BT /F1 11 Tf 40 ${740 - n * 16} Td (${esc(l)}) Tj ET`).join('\n');
    objects.push(`${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${streamId} 0 R /Resources << /Font << /F1 3 0 R >> >> >>\nendobj\n`);
    objects.push(`${streamId} 0 obj\n<< /Length ${lines.length} >>\nstream\n${lines}\nendstream\nendobj\n`);
  });

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const obj of objects) { offsets.push(pdf.length); pdf += obj; }
  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  writeFileSync(path, pdf, 'latin1');
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/lease-page-text.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractPageTexts, normalizeForMatch } from '../../server/warehouse/lease-page-text';
import { writeFixturePdf, FIXTURE_PAGES } from '../fixtures/leases/make-fixture';

let dir: string; let pdfPath: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'ora-lease-')); pdfPath = join(dir, 'lease.pdf'); writeFixturePdf(pdfPath); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('extractPageTexts', () => {
  it('returns one entry per page', async () => {
    expect(await extractPageTexts(pdfPath)).toHaveLength(FIXTURE_PAGES.length);
  });

  it('puts the renewal-notice clause on page 3, not page 1', async () => {
    const pages = await extractPageTexts(pdfPath);
    expect(normalizeForMatch(pages[2])).toContain('one hundred eighty');
    expect(normalizeForMatch(pages[0])).not.toContain('one hundred eighty');
  });
});

describe('normalizeForMatch', () => {
  it('collapses whitespace and newlines', () => {
    expect(normalizeForMatch('not  later\nthan   one')).toBe('not later than one');
  });

  it('repairs hyphenation across a line break', () => {
    expect(normalizeForMatch('commence-\nment date')).toBe('commencement date');
  });

  it('folds smart quotes, dashes and ligatures to ASCII', () => {
    expect(normalizeForMatch('“Landlord’s” — oﬃce')).toBe('"landlord\'s" - office');
  });

  it('lowercases so a quote matches regardless of case', () => {
    expect(normalizeForMatch('RENEWAL Option')).toBe('renewal option');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/unit/lease-page-text.test.ts`
Expected: FAIL — cannot resolve `../../server/warehouse/lease-page-text`.

- [ ] **Step 4: Implement**

Create `server/warehouse/lease-page-text.ts`:

```ts
// server/warehouse/lease-page-text.ts
//
// Per-page text is the ground truth every citation is checked against. Without page-level text
// there is no way to falsify a model's claim about where a clause lives, and an unfalsifiable
// citation is decoration.
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

/** Canonical form for quote matching: case-folded, ASCII-folded, whitespace-collapsed,
 *  de-hyphenated across line breaks. Applied to BOTH the page text and the model's quote so
 *  cosmetic PDF artifacts never cause a false mismatch. */
export function normalizeForMatch(s: string): string {
  return s
    .replace(/-\s*\n\s*/g, '')                 // hyphenation across a line break
    .replace(/[\u2018\u2019\u201B]/g, "'")     // smart single quotes
    .replace(/[\u201C\u201D]/g, '"')           // smart double quotes
    .replace(/[\u2013\u2014]/g, '-')           // en/em dash
    .replace(/\uFB01/g, 'fi').replace(/\uFB02/g, 'fl') // ligatures
    .replace(/\u00A0/g, ' ')                   // non-breaking space
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export async function extractPageTexts(filePath: string): Promise<string[]> {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.pdf') return extractPdfPages(filePath);
  if (ext === '.docx') return extractDocxPages(filePath);
  throw new Error(`unsupported lease document type: ${ext} (${filePath})`);
}

async function extractPdfPages(filePath: string): Promise<string[]> {
  const { default: pdfParse } = await import('pdf-parse');
  const pages: string[] = [];
  const buf = await readFile(filePath);
  await pdfParse(buf, {
    // Collect text per page as the parser walks the document.
    pagerender: async (pageData: { getTextContent: () => Promise<{ items: Array<{ str: string }> }> }) => {
      const content = await pageData.getTextContent();
      const text = content.items.map((i) => i.str).join(' ');
      pages.push(text);
      return text;
    },
  } as never);

  if (pages.length > 0) return pages;

  // Fallback: some builds ignore pagerender. Form feed is the page separator in the flat text.
  const flat = await pdfParse(buf);
  return String(flat.text).split('\f');
}

async function extractDocxPages(filePath: string): Promise<string[]> {
  const mammoth = await import('mammoth');
  const { value } = await mammoth.extractRawText({ path: filePath });
  // DOCX has no fixed pagination; the whole document is one logical page, and a citation to it
  // is honest about that rather than inventing page numbers.
  return [value];
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/unit/lease-page-text.test.ts`
Expected: PASS, 6 tests. If the two `extractPageTexts` cases fail on page count, `pagerender` is not supported by the installed build — confirm the fallback path returns 3 entries and leave a comment naming the installed version.

- [ ] **Step 6: Commit**

```bash
git add server/warehouse/lease-page-text.ts tests/unit/lease-page-text.test.ts tests/fixtures/leases/make-fixture.ts
git commit -m "feat(leases): per-page text extraction with match normalization"
```

---

### Task 2: Document registry — classification, chain order, executed detection

**Files:**
- Create: `server/warehouse/lease-documents.ts`, `tests/unit/lease-documents.test.ts`

**Interfaces:**
- Consumes: `documents` table (Track 1 Task 3), `extractPageTexts` (Task 1).
- Produces: `sha256File(path: string): string` · `classifyDocType(fileName: string, firstPageText: string): DocType` · `detectExecuted(text: string): 'yes' | 'no' | 'unknown'` · `orderChain<T extends ChainInput>(docs: T[]): T[]` · `registerDocument(db, input: RegisterInput): string` (returns `document_id`). `DocType = 'lease'|'amendment'|'addendum'|'guaranty'|'snda'|'estoppel'|'coi'|'om'|'other'`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/lease-documents.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/warehouse/migrate';
import { classifyDocType, detectExecuted, orderChain, registerDocument } from '../../server/warehouse/lease-documents';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('classifyDocType', () => {
  it('classifies by filename when it is unambiguous', () => {
    expect(classifyDocType('Lease_ExampleTenant_01012024.pdf', '')).toBe('lease');
    expect(classifyDocType('FirstAmendment_ExampleTenant.pdf', '')).toBe('amendment');
    expect(classifyDocType('Guaranty_ExampleTenant.pdf', '')).toBe('guaranty');
    expect(classifyDocType('SNDA_Lender.pdf', '')).toBe('snda');
    expect(classifyDocType('COI_2026.pdf', '')).toBe('coi');
  });

  it('falls back to the first page when the filename is uninformative', () => {
    expect(classifyDocType('scan001.pdf', 'FIRST AMENDMENT TO LEASE')).toBe('amendment');
    expect(classifyDocType('scan002.pdf', 'GUARANTY OF LEASE')).toBe('guaranty');
    expect(classifyDocType('scan003.pdf', 'LEASE AGREEMENT')).toBe('lease');
  });

  it('returns other when nothing matches', () => {
    expect(classifyDocType('notes.pdf', 'some unrelated text')).toBe('other');
  });
});

describe('detectExecuted', () => {
  it('treats a signature block with a date as executed', () => {
    expect(detectExecuted('IN WITNESS WHEREOF /s/ Jane Roe  Dated: 01/15/2024')).toBe('yes');
  });

  it('treats an unfilled signature block as not executed', () => {
    expect(detectExecuted('IN WITNESS WHEREOF  By: ______________  Date: __________')).toBe('no');
  });

  it('flags a draft watermark as not executed even with a signature line', () => {
    expect(detectExecuted('DRAFT — FOR DISCUSSION ONLY\n/s/ Jane Roe')).toBe('no');
  });

  it('returns unknown when there is no signature evidence at all', () => {
    expect(detectExecuted('Section 4. Term. The Term commences February 1, 2024.')).toBe('unknown');
  });
});

describe('orderChain', () => {
  it('puts the lease first, then amendments by ordinal, then by date', () => {
    const ordered = orderChain([
      { fileName: 'SecondAmendment.pdf', docType: 'amendment', effectiveDate: '2026-01-01' },
      { fileName: 'Lease.pdf', docType: 'lease', effectiveDate: '2024-01-01' },
      { fileName: 'FirstAmendment.pdf', docType: 'amendment', effectiveDate: '2025-01-01' },
    ]);
    expect(ordered.map((d) => d.fileName)).toEqual(['Lease.pdf', 'FirstAmendment.pdf', 'SecondAmendment.pdf']);
  });

  it('orders undated amendments with no ordinal after the ones that have them', () => {
    const ordered = orderChain([
      { fileName: 'Addendum.pdf', docType: 'addendum', effectiveDate: null },
      { fileName: 'FirstAmendment.pdf', docType: 'amendment', effectiveDate: '2025-01-01' },
      { fileName: 'Lease.pdf', docType: 'lease', effectiveDate: '2024-01-01' },
    ]);
    expect(ordered.map((d) => d.fileName)).toEqual(['Lease.pdf', 'FirstAmendment.pdf', 'Addendum.pdf']);
  });
});

describe('registerDocument', () => {
  it('stores the document and returns a stable id for the same hash', () => {
    const db = makeDb();
    const input = {
      sha256: 'abc123', path: 'C:/leases/Lease.pdf', docType: 'lease' as const,
      leaseCanonicalId: 'lease-1', chainSeq: 0, executed: 'yes' as const, pageCount: 3,
    };
    const id1 = registerDocument(db, input);
    const id2 = registerDocument(db, input);
    expect(id1).toBe(id2);
    expect((db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n).toBe(1);
  });

  it('marks a guaranty as PII-bearing automatically', () => {
    const db = makeDb();
    registerDocument(db, {
      sha256: 'def456', path: 'C:/leases/Guaranty.pdf', docType: 'guaranty',
      leaseCanonicalId: 'lease-1', chainSeq: 2, executed: 'yes', pageCount: 2,
    });
    expect((db.prepare('SELECT contains_pii AS p FROM documents WHERE sha256=?').get('def456') as { p: number }).p).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/lease-documents.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Implement**

Create `server/warehouse/lease-documents.ts`:

```ts
// server/warehouse/lease-documents.ts
//
// A lease is not one document: it is a chain (lease → amendments → addenda), and the LAST
// instrument to touch a term wins. Chain order is therefore load-bearing, and so is knowing
// whether an instrument was ever executed — an unexecuted draft has already been mistaken for
// operative terms once in this portfolio.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { WarehouseDb } from './db';

export type DocType = 'lease' | 'amendment' | 'addendum' | 'guaranty' | 'snda' | 'estoppel' | 'coi' | 'om' | 'other';

export interface ChainInput { fileName: string; docType: DocType; effectiveDate: string | null }

export interface RegisterInput {
  sha256: string; path: string; docType: DocType; leaseCanonicalId: string | null;
  chainSeq: number | null; executed: 'yes' | 'no' | 'unknown'; pageCount: number | null;
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function classifyDocType(fileName: string, firstPageText: string): DocType {
  const hay = `${basename(fileName)} \n ${firstPageText}`.toLowerCase();
  if (/\bguarant(y|ee|or)\b/.test(hay)) return 'guaranty';
  if (/\bsnda\b|subordination[\s,]+non[- ]?disturbance/.test(hay)) return 'snda';
  if (/\bestoppel\b/.test(hay)) return 'estoppel';
  if (/\bcoi\b|certificate of insurance/.test(hay)) return 'coi';
  if (/\bamendment\b/.test(hay)) return 'amendment';
  if (/\baddend(um|a)\b/.test(hay)) return 'addendum';
  if (/offering memorandum|\bom[_\s-]/.test(hay)) return 'om';
  if (/\blease\b/.test(hay)) return 'lease';
  return 'other';
}

export function detectExecuted(text: string): 'yes' | 'no' | 'unknown' {
  const t = text.toLowerCase();
  if (/\bdraft\b|for discussion only|not for execution/.test(t)) return 'no';
  const hasSignature = /\/s\/|in witness whereof|\bby:\s*\S/.test(t);
  if (!hasSignature) return 'unknown';
  const blankLine = /_{5,}/.test(text);
  const datedSignature = /dated?\s*:?\s*\d{1,4}[\/-]\d{1,2}[\/-]\d{1,4}/i.test(text);
  if (datedSignature && !blankLine) return 'yes';
  if (blankLine) return 'no';
  return 'unknown';
}

function ordinalRank(fileName: string): number {
  const lower = fileName.toLowerCase();
  const idx = ORDINALS.findIndex((o) => lower.includes(o));
  if (idx >= 0) return idx + 1;
  const numeric = /\b(?:amendment|addendum)[\s_-]*#?(\d{1,2})\b/.exec(lower);
  return numeric ? Number(numeric[1]) : Number.MAX_SAFE_INTEGER;
}

const TYPE_RANK: Record<DocType, number> = {
  lease: 0, amendment: 1, addendum: 2, guaranty: 3, snda: 4, estoppel: 5, coi: 6, om: 7, other: 8,
};

export function orderChain<T extends ChainInput>(docs: T[]): T[] {
  return [...docs].sort((a, b) => {
    if (TYPE_RANK[a.docType] !== TYPE_RANK[b.docType]) return TYPE_RANK[a.docType] - TYPE_RANK[b.docType];
    const ra = ordinalRank(a.fileName); const rb = ordinalRank(b.fileName);
    if (ra !== rb) return ra - rb;
    if (a.effectiveDate && b.effectiveDate) return a.effectiveDate.localeCompare(b.effectiveDate);
    if (a.effectiveDate) return -1;
    if (b.effectiveDate) return 1;
    return a.fileName.localeCompare(b.fileName);
  });
}

export function registerDocument(db: WarehouseDb, input: RegisterInput): string {
  const existing = db.prepare('SELECT document_id FROM documents WHERE sha256 = ?').get(input.sha256) as
    { document_id: string } | undefined;
  if (existing) return existing.document_id;

  const documentId = `doc-${input.sha256.slice(0, 16)}`;
  const containsPii = input.docType === 'guaranty' ? 1 : 0;
  db.prepare(
    `INSERT INTO documents (document_id, sha256, path, doc_type, lease_canonical_id, chain_seq,
                            executed, contains_pii, page_count, landed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(documentId, input.sha256, input.path, input.docType, input.leaseCanonicalId, input.chainSeq,
        input.executed, containsPii, input.pageCount, new Date().toISOString());
  return documentId;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/lease-documents.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add server/warehouse/lease-documents.ts tests/unit/lease-documents.test.ts
git commit -m "feat(leases): document registry with chain ordering and executed detection"
```

---

### Task 3: The twelve critical fields

**Files:**
- Create: `server/warehouse/lease-fact-fields.ts`, `tests/unit/lease-fact-fields.test.ts`

**Interfaces:**
- Produces: `LEASE_FIELDS: readonly LeaseFieldSpec[]` · `FIELD_IDS: readonly string[]` · `leaseFieldSchema: z.ZodType` per field · `validateFieldValue(fieldId: string, value: unknown): { ok: true; value: unknown } | { ok: false; error: string }`. `LeaseFieldSpec = { id: string; label: string; kind: 'date'|'money'|'text'|'duration_days'|'schedule'|'enum'; economic: boolean; prompt: string }`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/lease-fact-fields.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { LEASE_FIELDS, FIELD_IDS, validateFieldValue } from '../../server/warehouse/lease-fact-fields';

describe('LEASE_FIELDS', () => {
  it('covers exactly the twelve P1 fields', () => {
    expect(FIELD_IDS).toEqual([
      'commencement_date', 'expiration_date', 'rent_schedule', 'escalations',
      'renewal_options', 'renewal_notice_days', 'termination_rights', 'rofr_rofo',
      'security_deposit', 'guaranty', 'insurance_requirements', 'maintenance_split',
    ]);
  });

  it('marks the economically consequential fields, which drive mandatory human verification', () => {
    const economic = LEASE_FIELDS.filter((f) => f.economic).map((f) => f.id);
    expect(economic).toContain('expiration_date');
    expect(economic).toContain('renewal_notice_days');
    expect(economic).toContain('escalations');
    expect(economic).not.toContain('insurance_requirements');
  });

  it('gives every field a prompt line for the extractor', () => {
    for (const f of LEASE_FIELDS) expect(f.prompt.length).toBeGreaterThan(20);
  });
});

describe('validateFieldValue', () => {
  it('accepts an ISO date for a date field', () => {
    expect(validateFieldValue('expiration_date', '2029-01-31')).toEqual({ ok: true, value: '2029-01-31' });
  });

  it('rejects a US-format date, which is the classic silent corruption', () => {
    const r = validateFieldValue('expiration_date', '01/31/2029');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/YYYY-MM-DD/);
  });

  it('accepts a positive integer for a notice period', () => {
    expect(validateFieldValue('renewal_notice_days', 180)).toEqual({ ok: true, value: 180 });
  });

  it('rejects a negative notice period', () => {
    expect(validateFieldValue('renewal_notice_days', -30).ok).toBe(false);
  });

  it('accepts a rent schedule of dated steps', () => {
    const value = [{ from: '2024-02-01', to: '2025-01-31', annualRent: 96000 }];
    expect(validateFieldValue('rent_schedule', value)).toEqual({ ok: true, value });
  });

  it('rejects a rent schedule step missing its end date', () => {
    expect(validateFieldValue('rent_schedule', [{ from: '2024-02-01', annualRent: 96000 }]).ok).toBe(false);
  });

  it('rejects an unknown field id', () => {
    const r = validateFieldValue('favourite_colour', 'blue');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown field/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/lease-fact-fields.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Implement**

Create `server/warehouse/lease-fact-fields.ts`:

```ts
// server/warehouse/lease-fact-fields.ts — the P1 field set, its validation, and the prompt text
// each field contributes. One definition feeds the extractor, the validator and the UI, so a
// field cannot be extracted in a shape the database will not accept.
import { z } from 'zod';

export type FieldKind = 'date' | 'money' | 'text' | 'duration_days' | 'schedule' | 'enum';

export interface LeaseFieldSpec {
  id: string;
  label: string;
  kind: FieldKind;
  /** Economic fields require human verification before their alerts count as verified. */
  economic: boolean;
  prompt: string;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dates must be ISO format YYYY-MM-DD');
const rentSchedule = z.array(z.object({
  from: isoDate, to: isoDate, annualRent: z.number().nonnegative(),
})).min(1);

export const LEASE_FIELDS: readonly LeaseFieldSpec[] = [
  { id: 'commencement_date', label: 'Commencement date', kind: 'date', economic: true,
    prompt: 'The date the Term commences (not the execution date, not the delivery date).' },
  { id: 'expiration_date', label: 'Expiration date', kind: 'date', economic: true,
    prompt: 'The date the Term expires, as amended by any later instrument in the chain.' },
  { id: 'rent_schedule', label: 'Rent schedule', kind: 'schedule', economic: true,
    prompt: 'Every base-rent step as {from, to, annualRent}. Annualize monthly figures and say so in the quote.' },
  { id: 'escalations', label: 'Escalations', kind: 'text', economic: true,
    prompt: 'The escalation mechanism: fixed percentage, fixed dollar, CPI, or none. Include the anniversary it applies on.' },
  { id: 'renewal_options', label: 'Renewal options', kind: 'text', economic: true,
    prompt: 'Number of renewal options, length of each, and how renewal rent is set (fixed, market, formula).' },
  { id: 'renewal_notice_days', label: 'Renewal notice (days)', kind: 'duration_days', economic: true,
    prompt: 'Days of advance written notice required to exercise a renewal option, as an integer. Convert months to days at 30/month and say so in the quote.' },
  { id: 'termination_rights', label: 'Termination rights', kind: 'text', economic: true,
    prompt: 'Any early-termination right of either party, its window, its fee, and its notice period.' },
  { id: 'rofr_rofo', label: 'ROFR / ROFO', kind: 'text', economic: true,
    prompt: 'Any right of first refusal or first offer on the premises or the building, including response deadlines. These bind a sale or refinancing.' },
  { id: 'security_deposit', label: 'Security deposit', kind: 'money', economic: true,
    prompt: 'Cash security deposit amount, plus any letter of credit and burn-down schedule.' },
  { id: 'guaranty', label: 'Guaranty', kind: 'text', economic: true,
    prompt: 'Whether a guaranty exists, who the guarantor is, and whether it is full, limited or burn-off. Do not extract personal financial details.' },
  { id: 'insurance_requirements', label: 'Insurance requirements', kind: 'text', economic: false,
    prompt: 'Required coverage types and limits, and whether the landlord must be an additional insured.' },
  { id: 'maintenance_split', label: 'Maintenance split', kind: 'text', economic: false,
    prompt: 'Who maintains and who replaces roof, structure, and HVAC. State each of the three separately.' },
] as const;

export const FIELD_IDS: readonly string[] = LEASE_FIELDS.map((f) => f.id);

const SCHEMAS: Record<string, z.ZodType> = {
  commencement_date: isoDate,
  expiration_date: isoDate,
  rent_schedule: rentSchedule,
  escalations: z.string().min(1),
  renewal_options: z.string().min(1),
  renewal_notice_days: z.number().int().positive(),
  termination_rights: z.string().min(1),
  rofr_rofo: z.string().min(1),
  security_deposit: z.number().nonnegative(),
  guaranty: z.string().min(1),
  insurance_requirements: z.string().min(1),
  maintenance_split: z.string().min(1),
};

export function validateFieldValue(
  fieldId: string, value: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const schema = SCHEMAS[fieldId];
  if (!schema) return { ok: false, error: `unknown field: ${fieldId}` };
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/lease-fact-fields.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add server/warehouse/lease-fact-fields.ts tests/unit/lease-fact-fields.test.ts
git commit -m "feat(leases): twelve-field P1 schema with validation"
```

---

### Task 4: Pass A — structured extraction (Sonnet 5)

**Files:**
- Create: `server/warehouse/lease-extract-structured.ts`, `tests/unit/lease-extract-structured.test.ts`

**Interfaces:**
- Consumes: `LEASE_FIELDS`, `validateFieldValue` (Task 3).
- Produces: `extractFields(input: ExtractInput): Promise<ExtractOutput>` where `ExtractInput = { pages: string[]; fetchImpl?: typeof fetch; model?: string; apiKey?: string }` and `ExtractOutput = { ok: true; values: Record<string, unknown>; usage: { tokensIn: number; tokensOut: number } } | { ok: false; error: string }` · `EXTRACTOR_VERSION: string`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/lease-extract-structured.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { extractFields, EXTRACTOR_VERSION } from '../../server/warehouse/lease-extract-structured';

function fakeFetch(toolInput: unknown, usage = { input_tokens: 1200, output_tokens: 300 }): typeof fetch {
  return (async () => new Response(JSON.stringify({
    content: [{ type: 'tool_use', name: 'record_lease_fields', input: toolInput }],
    usage,
  }), { status: 200 })) as unknown as typeof fetch;
}

const PAGES = ['LEASE AGREEMENT', 'Term expires January 31, 2029.'];

describe('extractFields', () => {
  it('returns validated values and usage', async () => {
    const out = await extractFields({
      pages: PAGES, apiKey: 'test-key',
      fetchImpl: fakeFetch({ expiration_date: '2029-01-31', renewal_notice_days: 180 }),
    });
    expect(out).toEqual({
      ok: true,
      values: { expiration_date: '2029-01-31', renewal_notice_days: 180 },
      usage: { tokensIn: 1200, tokensOut: 300 },
    });
  });

  it('drops a field whose value fails validation rather than persisting a bad shape', async () => {
    const out = await extractFields({
      pages: PAGES, apiKey: 'test-key',
      fetchImpl: fakeFetch({ expiration_date: '01/31/2029', renewal_notice_days: 180 }),
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.values).toEqual({ renewal_notice_days: 180 });
  });

  it('treats an explicit null as "not present in this lease"', async () => {
    const out = await extractFields({
      pages: PAGES, apiKey: 'test-key', fetchImpl: fakeFetch({ rofr_rofo: null, renewal_notice_days: 180 }),
    });
    if (out.ok) expect('rofr_rofo' in out.values).toBe(false);
  });

  it('fails cleanly without an API key', async () => {
    const out = await extractFields({ pages: PAGES, apiKey: '' });
    expect(out).toEqual({ ok: false, error: 'lease extraction requires ANTHROPIC_API_KEY' });
  });

  it('surfaces an API error instead of throwing', async () => {
    const failing = (async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch;
    const out = await extractFields({ pages: PAGES, apiKey: 'k', fetchImpl: failing });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/429/);
  });

  it('pins an extractor version so a regression is attributable', () => {
    expect(EXTRACTOR_VERSION).toMatch(/^lease-extract-v\d+$/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/lease-extract-structured.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Implement**

Create `server/warehouse/lease-extract-structured.ts`:

```ts
// server/warehouse/lease-extract-structured.ts
//
// Pass A: what the lease says. A forced tool call with strict schema validation keeps the model
// from returning prose where a date belongs. Pass B (lease-extract-quotes) independently supplies
// the evidence; this pass never reports a page.
import { LEASE_FIELDS, validateFieldValue } from './lease-fact-fields';

export const EXTRACTOR_VERSION = 'lease-extract-v1';

export interface ExtractInput {
  pages: string[];
  fetchImpl?: typeof fetch;
  model?: string;
  apiKey?: string;
}

export type ExtractOutput =
  | { ok: true; values: Record<string, unknown>; usage: { tokensIn: number; tokensOut: number } }
  | { ok: false; error: string };

const SYSTEM = [
  'You are abstracting a commercial industrial lease for the landlord.',
  'Use ONLY the lease text supplied. Never infer a term that is not written.',
  'A later instrument in the chain supersedes an earlier one; report the operative value.',
  'If a field is not present, return null for it — do not guess.',
  'Do not extract personal financial details of any guarantor.',
].join(' ');

function toolSchema(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const f of LEASE_FIELDS) {
    properties[f.id] = { description: f.prompt };
  }
  return { type: 'object', properties, additionalProperties: false };
}

export async function extractFields(input: ExtractInput): Promise<ExtractOutput> {
  const apiKey = input.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
  if (!apiKey) return { ok: false, error: 'lease extraction requires ANTHROPIC_API_KEY' };

  const f = input.fetchImpl ?? fetch;
  const numbered = input.pages.map((p, i) => `--- PAGE ${i + 1} ---\n${p}`).join('\n\n');

  let res: Response;
  try {
    res = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: input.model ?? process.env.LEASE_EXTRACT_MODEL ?? 'claude-sonnet-5',
        max_tokens: 4096,
        system: SYSTEM,
        tools: [{
          name: 'record_lease_fields',
          description: 'Record the operative value of each lease field, or null when absent.',
          input_schema: toolSchema(),
        }],
        tool_choice: { type: 'tool', name: 'record_lease_fields' },
        messages: [{ role: 'user', content: `Lease text:\n\n${numbered}` }],
      }),
    });
  } catch (err) {
    return { ok: false, error: `lease extraction request failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!res.ok) return { ok: false, error: `lease extraction API error ${res.status}` };

  const body = (await res.json()) as {
    content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const block = body.content?.find((c) => c.type === 'tool_use' && c.name === 'record_lease_fields');
  if (!block?.input) return { ok: false, error: 'lease extraction returned no tool_use block' };

  const values: Record<string, unknown> = {};
  for (const [fieldId, raw] of Object.entries(block.input)) {
    if (raw === null || raw === undefined) continue; // explicit "not in this lease"
    const check = validateFieldValue(fieldId, raw);
    if (check.ok) values[fieldId] = check.value;
    // A value that fails validation is dropped, not coerced: a silently repaired date is the
    // failure mode this whole pipeline exists to prevent.
  }

  return {
    ok: true,
    values,
    usage: { tokensIn: body.usage?.input_tokens ?? 0, tokensOut: body.usage?.output_tokens ?? 0 },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/lease-extract-structured.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add server/warehouse/lease-extract-structured.ts tests/unit/lease-extract-structured.test.ts
git commit -m "feat(leases): pass A structured field extraction"
```

---

### Task 5: Pass B — verbatim quotes, and deterministic page resolution

**Files:**
- Create: `server/warehouse/lease-extract-quotes.ts`, `server/warehouse/lease-quote-verify.ts`, `tests/unit/lease-quote-verify.test.ts`

**Interfaces:**
- Consumes: `normalizeForMatch` (Task 1), `LEASE_FIELDS` (Task 3).
- Produces: `extractQuotes(input: QuoteInput): Promise<QuoteOutput>` (same injectable shape as Task 4; returns `Record<fieldId, string>`) · `resolveQuotePage(quote: string, pages: string[]): { page: number; quoteOnPage: boolean }` — page is 1-indexed, `0` with `quoteOnPage: false` when the quote appears nowhere.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/lease-quote-verify.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveQuotePage } from '../../server/warehouse/lease-quote-verify';

const PAGES = [
  'LEASE AGREEMENT between LANDLORD LLC and EXAMPLE TENANT INC.',
  'Section 4. Term. The Term commences February 1, 2024 and expires January 31, 2029.',
  'Section 9. Renewal Option. Tenant shall deliver written notice not later than one hundred eighty (180) days prior to expiration.',
];

describe('resolveQuotePage', () => {
  it('finds the page a verbatim quote came from', () => {
    expect(resolveQuotePage('expires January 31, 2029', PAGES)).toEqual({ page: 2, quoteOnPage: true });
  });

  it('matches across cosmetic differences in whitespace and case', () => {
    expect(resolveQuotePage('NOT LATER  THAN\nONE HUNDRED EIGHTY', PAGES)).toEqual({ page: 3, quoteOnPage: true });
  });

  it('matches across smart quotes and dashes', () => {
    const pages = ['The “Commencement Date” — as defined herein'];
    expect(resolveQuotePage('The "Commencement Date" - as defined herein', pages)).toEqual({ page: 1, quoteOnPage: true });
  });

  it('matches a quote hyphenated across a line break in the source', () => {
    const pages = ['the commence-\nment date is fixed'];
    expect(resolveQuotePage('the commencement date is fixed', pages)).toEqual({ page: 1, quoteOnPage: true });
  });

  it('reports not-found for a quote that appears nowhere — the hallucination signal', () => {
    expect(resolveQuotePage('Tenant shall pay a termination fee of $50,000', PAGES))
      .toEqual({ page: 0, quoteOnPage: false });
  });

  it('returns the first page when a quote appears on several', () => {
    const pages = ['common boilerplate clause', 'common boilerplate clause'];
    expect(resolveQuotePage('common boilerplate clause', pages)).toEqual({ page: 1, quoteOnPage: true });
  });

  it('rejects an empty or whitespace-only quote', () => {
    expect(resolveQuotePage('   ', PAGES)).toEqual({ page: 0, quoteOnPage: false });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/lease-quote-verify.test.ts`
Expected: FAIL — cannot resolve `../../server/warehouse/lease-quote-verify`.

- [ ] **Step 3: Implement page resolution**

Create `server/warehouse/lease-quote-verify.ts`:

```ts
// server/warehouse/lease-quote-verify.ts
//
// The falsification step. A model-reported page number is an assertion; a quote located in our
// own page text is a fact. Every lease_facts row carries the result, and a quote that matches no
// page (quote_on_page = 0) sends the fact straight to the human queue as disputed.
import { normalizeForMatch } from './lease-page-text';

export interface QuoteLocation { page: number; quoteOnPage: boolean }

export function resolveQuotePage(quote: string, pages: string[]): QuoteLocation {
  const needle = normalizeForMatch(quote);
  if (needle.length === 0) return { page: 0, quoteOnPage: false };
  for (let i = 0; i < pages.length; i += 1) {
    if (normalizeForMatch(pages[i]).includes(needle)) return { page: i + 1, quoteOnPage: true };
  }
  return { page: 0, quoteOnPage: false };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/lease-quote-verify.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Implement the quote pass**

Create `server/warehouse/lease-extract-quotes.ts`:

```ts
// server/warehouse/lease-extract-quotes.ts
//
// Pass B: the evidence. Deliberately a SEPARATE call from Pass A, on a stronger model, with no
// sight of Pass A's values — two independent reads disagreeing is the signal that sends a fact
// to a human, and a single call asked for both would just rationalize its own answer.
import { LEASE_FIELDS } from './lease-fact-fields';

export const QUOTE_EXTRACTOR_VERSION = 'lease-quotes-v1';

export interface QuoteInput {
  pages: string[];
  fields?: string[];
  fetchImpl?: typeof fetch;
  model?: string;
  apiKey?: string;
}

export type QuoteOutput =
  | { ok: true; quotes: Record<string, string>; usage: { tokensIn: number; tokensOut: number } }
  | { ok: false; error: string };

const SYSTEM = [
  'You locate evidence in a commercial lease.',
  'For each requested field, return the SHORTEST VERBATIM span from the lease text that establishes it.',
  'Copy the text EXACTLY as written, including punctuation. Never paraphrase, never summarize, never join text from two places.',
  'If the lease does not address a field, return null for it.',
].join(' ');

export async function extractQuotes(input: QuoteInput): Promise<QuoteOutput> {
  const apiKey = input.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
  if (!apiKey) return { ok: false, error: 'quote extraction requires ANTHROPIC_API_KEY' };

  const fieldIds = input.fields ?? LEASE_FIELDS.map((f) => f.id);
  const properties: Record<string, unknown> = {};
  for (const id of fieldIds) {
    const spec = LEASE_FIELDS.find((f) => f.id === id);
    properties[id] = { type: ['string', 'null'], description: `Verbatim span establishing: ${spec?.prompt ?? id}` };
  }

  const f = input.fetchImpl ?? fetch;
  const numbered = input.pages.map((p, i) => `--- PAGE ${i + 1} ---\n${p}`).join('\n\n');

  let res: Response;
  try {
    res = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: input.model ?? process.env.LEASE_QUOTE_MODEL ?? 'claude-opus-5',
        max_tokens: 8192,
        system: SYSTEM,
        tools: [{
          name: 'record_quotes',
          description: 'Record the verbatim span establishing each field.',
          input_schema: { type: 'object', properties, additionalProperties: false },
        }],
        tool_choice: { type: 'tool', name: 'record_quotes' },
        messages: [{ role: 'user', content: `Lease text:\n\n${numbered}` }],
      }),
    });
  } catch (err) {
    return { ok: false, error: `quote extraction request failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!res.ok) return { ok: false, error: `quote extraction API error ${res.status}` };

  const body = (await res.json()) as {
    content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const block = body.content?.find((c) => c.type === 'tool_use' && c.name === 'record_quotes');
  if (!block?.input) return { ok: false, error: 'quote extraction returned no tool_use block' };

  const quotes: Record<string, string> = {};
  for (const [fieldId, raw] of Object.entries(block.input)) {
    if (typeof raw === 'string' && raw.trim().length > 0) quotes[fieldId] = raw;
  }
  return {
    ok: true, quotes,
    usage: { tokensIn: body.usage?.input_tokens ?? 0, tokensOut: body.usage?.output_tokens ?? 0 },
  };
}
```

- [ ] **Step 6: Commit**

```bash
git add server/warehouse/lease-extract-quotes.ts server/warehouse/lease-quote-verify.ts tests/unit/lease-quote-verify.test.ts
git commit -m "feat(leases): pass B quote extraction with deterministic page resolution"
```

---

### Task 6: Persist facts — status rules and the dispute path

**Files:**
- Create: `server/warehouse/lease-facts-persist.ts`, `tests/unit/lease-facts-persist.test.ts`

**Interfaces:**
- Consumes: Tasks 3–5, `appendAudit` (Track 1 Task 7), `documents`/`lease_facts` tables.
- Produces: `persistFacts(db, input: PersistInput): PersistResult` where `PersistInput = { leaseCanonicalId: string; documentId: string; pages: string[]; values: Record<string, unknown>; quotes: Record<string, string>; runId: string; extractorVersion: string }` and `PersistResult = { written: number; disputed: string[] }` · `verifyFact(db, factId: string, actor: string): void` · `correctFact(db, factId: string, newValue: unknown, actor: string): string`.

**Status rules (the whole point of the task):**
- value present + quote present + `quoteOnPage` → `extracted`, confidence 0.9
- value present + no quote, or quote matches no page → `disputed`, confidence 0.3
- quote present + no value → `disputed`, confidence 0.3
- an economic field is never `verified` except through `verifyFact` (a human)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/lease-facts-persist.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/warehouse/migrate';
import { persistFacts, verifyFact, correctFact } from '../../server/warehouse/lease-facts-persist';
import { auditTrail } from '../../server/warehouse/audit';

const PAGES = ['LEASE AGREEMENT', 'The Term expires January 31, 2029.'];

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(`INSERT INTO documents (document_id, sha256, path, doc_type, landed_at)
              VALUES ('doc-1','h1','C:/x.pdf','lease','2026-09-17T00:00:00Z')`).run();
  return db;
}

const base = {
  leaseCanonicalId: 'lease-1', documentId: 'doc-1', pages: PAGES,
  runId: 'run-1', extractorVersion: 'lease-extract-v1',
};

describe('persistFacts', () => {
  it('writes a verifiable fact as extracted with its resolved page', () => {
    const db = makeDb();
    const result = persistFacts(db, {
      ...base,
      values: { expiration_date: '2029-01-31' },
      quotes: { expiration_date: 'The Term expires January 31, 2029.' },
    });
    expect(result).toEqual({ written: 1, disputed: [] });
    const row = db.prepare('SELECT page, quote_on_page, status, confidence FROM lease_facts').get() as
      { page: number; quote_on_page: number; status: string; confidence: number };
    expect(row).toMatchObject({ page: 2, quote_on_page: 1, status: 'extracted' });
    expect(row.confidence).toBeGreaterThan(0.8);
  });

  it('disputes a fact whose quote appears on no page', () => {
    const db = makeDb();
    const result = persistFacts(db, {
      ...base,
      values: { expiration_date: '2031-12-31' },
      quotes: { expiration_date: 'The Term expires December 31, 2031.' },
    });
    expect(result.disputed).toEqual(['expiration_date']);
    const row = db.prepare('SELECT status, page, quote_on_page FROM lease_facts').get() as
      { status: string; page: number; quote_on_page: number };
    expect(row).toMatchObject({ status: 'disputed', page: 0, quote_on_page: 0 });
  });

  it('disputes a value that arrived with no quote at all', () => {
    const db = makeDb();
    const result = persistFacts(db, { ...base, values: { escalations: '3% annually' }, quotes: {} });
    expect(result.disputed).toEqual(['escalations']);
  });

  it('disputes a quote that arrived with no value', () => {
    const db = makeDb();
    const result = persistFacts(db, { ...base, values: {}, quotes: { escalations: 'increase by three percent' } });
    expect(result.disputed).toEqual(['escalations']);
  });
});

describe('verifyFact / correctFact', () => {
  it('marks a fact verified and records who did it', () => {
    const db = makeDb();
    persistFacts(db, { ...base, values: { expiration_date: '2029-01-31' }, quotes: { expiration_date: 'The Term expires January 31, 2029.' } });
    const factId = (db.prepare('SELECT fact_id FROM lease_facts').get() as { fact_id: string }).fact_id;

    verifyFact(db, factId, 'gabriel');

    const row = db.prepare('SELECT status, verified_by FROM lease_facts WHERE fact_id = ?').get(factId) as
      { status: string; verified_by: string };
    expect(row).toEqual({ status: 'verified', verified_by: 'gabriel' });
    expect(auditTrail(db, 'lease_facts', factId).map((e) => e.action)).toEqual(['verify']);
  });

  it('supersedes rather than overwrites when a human corrects a value', () => {
    const db = makeDb();
    persistFacts(db, { ...base, values: { expiration_date: '2029-01-31' }, quotes: { expiration_date: 'The Term expires January 31, 2029.' } });
    const original = (db.prepare('SELECT fact_id FROM lease_facts').get() as { fact_id: string }).fact_id;

    const replacement = correctFact(db, original, '2029-02-28', 'gabriel');

    const old = db.prepare('SELECT status, superseded_by FROM lease_facts WHERE fact_id = ?').get(original) as
      { status: string; superseded_by: string };
    expect(old).toEqual({ status: 'superseded', superseded_by: replacement });
    const fresh = db.prepare('SELECT value_json, status, verified_by FROM lease_facts WHERE fact_id = ?').get(replacement) as
      { value_json: string; status: string; verified_by: string };
    expect(fresh).toEqual({ value_json: '"2029-02-28"', status: 'verified', verified_by: 'gabriel' });
    expect(auditTrail(db, 'lease_facts', original).map((e) => e.action)).toEqual(['correct']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/lease-facts-persist.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Implement**

Create `server/warehouse/lease-facts-persist.ts`:

```ts
// server/warehouse/lease-facts-persist.ts
//
// Where the two passes meet. A fact is only "extracted" when a value and a page-verified quote
// agree; anything else is "disputed" and goes to a human. Corrections supersede rather than
// overwrite, so the original extraction stays auditable forever.
import { randomUUID } from 'node:crypto';
import type { WarehouseDb } from './db';
import { resolveQuotePage } from './lease-quote-verify';
import { appendAudit } from './audit';

export interface PersistInput {
  leaseCanonicalId: string;
  documentId: string;
  pages: string[];
  values: Record<string, unknown>;
  quotes: Record<string, string>;
  runId: string;
  extractorVersion: string;
}

export interface PersistResult { written: number; disputed: string[] }

const CONFIDENCE_VERIFIABLE = 0.9;
const CONFIDENCE_UNSUPPORTED = 0.3;

export function persistFacts(db: WarehouseDb, input: PersistInput): PersistResult {
  const fieldIds = new Set([...Object.keys(input.values), ...Object.keys(input.quotes)]);
  const disputed: string[] = [];
  let written = 0;

  const insert = db.prepare(
    `INSERT INTO lease_facts (fact_id, lease_canonical_id, field, value_json, document_id, page, quote,
                              quote_on_page, confidence, extractor_version, run_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const tx = db.transaction(() => {
    for (const field of fieldIds) {
      const hasValue = field in input.values;
      const quote = input.quotes[field] ?? '';
      const located = quote ? resolveQuotePage(quote, input.pages) : { page: 0, quoteOnPage: false };
      const supported = hasValue && located.quoteOnPage;
      if (!supported) disputed.push(field);

      insert.run(
        `fact-${randomUUID()}`, input.leaseCanonicalId, field,
        JSON.stringify(hasValue ? input.values[field] : null),
        input.documentId, located.page, quote, located.quoteOnPage ? 1 : 0,
        supported ? CONFIDENCE_VERIFIABLE : CONFIDENCE_UNSUPPORTED,
        input.extractorVersion, input.runId,
        supported ? 'extracted' : 'disputed',
      );
      written += 1;
    }
  });
  tx();

  return { written, disputed };
}

export function verifyFact(db: WarehouseDb, factId: string, actor: string): void {
  const before = db.prepare('SELECT status FROM lease_facts WHERE fact_id = ?').get(factId) as
    { status: string } | undefined;
  if (!before) throw new Error(`no such fact: ${factId}`);

  db.prepare("UPDATE lease_facts SET status = 'verified', verified_by = ?, verified_at = ? WHERE fact_id = ?")
    .run(actor, new Date().toISOString(), factId);

  appendAudit(db, {
    at: new Date().toISOString(), actor, action: 'verify', entity: 'lease_facts', entityId: factId,
    before, after: { status: 'verified' },
  });
}

/** Returns the new fact_id. The original row is preserved and marked superseded. */
export function correctFact(db: WarehouseDb, factId: string, newValue: unknown, actor: string): string {
  const original = db.prepare(
    `SELECT lease_canonical_id, field, value_json, document_id, page, quote, quote_on_page, extractor_version, run_id
       FROM lease_facts WHERE fact_id = ?`,
  ).get(factId) as {
    lease_canonical_id: string; field: string; value_json: string; document_id: string;
    page: number; quote: string; quote_on_page: number; extractor_version: string; run_id: string;
  } | undefined;
  if (!original) throw new Error(`no such fact: ${factId}`);

  const replacementId = `fact-${randomUUID()}`;
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO lease_facts (fact_id, lease_canonical_id, field, value_json, document_id, page, quote,
                                quote_on_page, confidence, extractor_version, run_id, status, verified_by, verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1.0, ?, ?, 'verified', ?, ?)`,
    ).run(replacementId, original.lease_canonical_id, original.field, JSON.stringify(newValue),
          original.document_id, original.page, original.quote, original.quote_on_page,
          original.extractor_version, original.run_id, actor, now);

    db.prepare("UPDATE lease_facts SET status = 'superseded', superseded_by = ? WHERE fact_id = ?")
      .run(replacementId, factId);

    appendAudit(db, {
      at: now, actor, action: 'correct', entity: 'lease_facts', entityId: factId,
      before: { value: JSON.parse(original.value_json) }, after: { value: newValue, factId: replacementId },
    });
  });
  tx();

  return replacementId;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/lease-facts-persist.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add server/warehouse/lease-facts-persist.ts tests/unit/lease-facts-persist.test.ts
git commit -m "feat(leases): fact persistence with dispute rules and supersede-on-correct"
```

---

### Task 7: Obligation date engine

**Files:**
- Create: `server/warehouse/lease-obligation-dates.ts`, `tests/unit/lease-obligation-dates.test.ts`

**Interfaces:**
- Produces: `noticeDeadline(expiration: string, noticeDays: number): string` · `escalationDates(commencement: string, expiration: string): string[]` · `previousBusinessDay(iso: string): string` · `buildObligations(input: BuildInput): ObligationDraft[]` where `ObligationDraft = { kind: string; responsibleParty: 'landlord'|'tenant'|'shared'|'unknown'; triggerDate: string|null; dueDate: string|null; recurrence: string|null; sourceFactIds: string[] }`.

> Pure functions only — no database, no clock. Every date is an ISO `YYYY-MM-DD` string in UTC; never a local `Date` rendered to string, which silently shifts a day across time zones.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/lease-obligation-dates.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  noticeDeadline, escalationDates, previousBusinessDay, buildObligations,
} from '../../server/warehouse/lease-obligation-dates';

describe('noticeDeadline', () => {
  it('subtracts the notice period from expiration', () => {
    expect(noticeDeadline('2029-01-31', 180)).toBe('2028-08-05');
  });

  it('handles a leap day correctly', () => {
    expect(noticeDeadline('2028-03-01', 1)).toBe('2028-02-29');
  });

  it('crosses a year boundary', () => {
    expect(noticeDeadline('2027-01-15', 30)).toBe('2026-12-16');
  });

  it('rejects a non-positive notice period', () => {
    expect(() => noticeDeadline('2029-01-31', 0)).toThrow(/positive/);
  });

  it('rejects a malformed date rather than producing Invalid Date', () => {
    expect(() => noticeDeadline('01/31/2029', 180)).toThrow(/YYYY-MM-DD/);
  });
});

describe('previousBusinessDay', () => {
  it('moves a Saturday back to Friday', () => {
    expect(previousBusinessDay('2026-09-19')).toBe('2026-09-18');
  });

  it('moves a Sunday back to Friday', () => {
    expect(previousBusinessDay('2026-09-20')).toBe('2026-09-18');
  });

  it('leaves a weekday alone', () => {
    expect(previousBusinessDay('2026-09-17')).toBe('2026-09-17');
  });
});

describe('escalationDates', () => {
  it('returns each anniversary of commencement strictly inside the term', () => {
    expect(escalationDates('2024-02-01', '2029-01-31')).toEqual([
      '2025-02-01', '2026-02-01', '2027-02-01', '2028-02-01',
    ]);
  });

  it('clamps a Feb 29 commencement to Feb 28 in non-leap years', () => {
    expect(escalationDates('2024-02-29', '2027-02-28')).toEqual(['2025-02-28', '2026-02-28']);
  });

  it('returns nothing for a term under one year', () => {
    expect(escalationDates('2026-01-01', '2026-06-30')).toEqual([]);
  });
});

describe('buildObligations', () => {
  it('emits a renewal-notice obligation dated by the notice period, adjusted off a weekend', () => {
    const obligations = buildObligations({
      leaseCanonicalId: 'lease-1',
      facts: {
        expiration_date: { value: '2029-01-31', factId: 'f-exp' },
        renewal_notice_days: { value: 180, factId: 'f-notice' },
      },
    });
    const notice = obligations.find((o) => o.kind === 'renewal_notice');
    expect(notice).toEqual({
      kind: 'renewal_notice', responsibleParty: 'tenant', triggerDate: '2029-01-31',
      dueDate: '2028-08-04', recurrence: null, sourceFactIds: ['f-exp', 'f-notice'],
    });
  });

  it('emits an escalation obligation carrying its recurrence', () => {
    const obligations = buildObligations({
      leaseCanonicalId: 'lease-1',
      facts: {
        commencement_date: { value: '2024-02-01', factId: 'f-com' },
        expiration_date: { value: '2027-01-31', factId: 'f-exp' },
        escalations: { value: '3% on each anniversary', factId: 'f-esc' },
      },
    });
    const escalation = obligations.find((o) => o.kind === 'escalation');
    expect(escalation?.dueDate).toBe('2025-02-03'); // 2025-02-01 is a Saturday
    expect(escalation?.recurrence).toBe('annual');
    expect(escalation?.responsibleParty).toBe('landlord');
  });

  it('emits nothing when the required facts are absent, rather than guessing', () => {
    expect(buildObligations({ leaseCanonicalId: 'lease-1', facts: {} })).toEqual([]);
  });

  it('skips the renewal obligation when the notice period is missing', () => {
    const obligations = buildObligations({
      leaseCanonicalId: 'lease-1',
      facts: { expiration_date: { value: '2029-01-31', factId: 'f-exp' } },
    });
    expect(obligations.find((o) => o.kind === 'renewal_notice')).toBeUndefined();
  });
});
```

> Note on the escalation case: a due date is moved **forward** to the next business day (the landlord acts on or after the anniversary), while a notice deadline moves **backward** (acting late is fatal). The tests pin both directions.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/lease-obligation-dates.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Implement**

Create `server/warehouse/lease-obligation-dates.ts`:

```ts
// server/warehouse/lease-obligation-dates.ts
//
// Deterministic date math. Never an LLM: a notice deadline is arithmetic, and arithmetic that is
// occasionally wrong is worse than no calendar at all. All dates are ISO YYYY-MM-DD in UTC.
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseIso(iso: string): Date {
  if (!ISO_RE.test(iso)) throw new Error(`date must be YYYY-MM-DD, got: ${iso}`);
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) throw new Error(`invalid calendar date: ${iso}`);
  return dt;
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function noticeDeadline(expiration: string, noticeDays: number): string {
  if (!Number.isInteger(noticeDays) || noticeDays <= 0) {
    throw new Error(`notice period must be a positive integer number of days, got: ${noticeDays}`);
  }
  const d = parseIso(expiration);
  d.setUTCDate(d.getUTCDate() - noticeDays);
  return toIso(d);
}

/** Weekend-only adjustment. Federal holidays are deliberately NOT modelled: a lease's notice
 *  provision rarely tracks them, and a wrong holiday calendar would move a date that matters. */
export function previousBusinessDay(iso: string): string {
  const d = parseIso(iso);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return toIso(d);
}

export function nextBusinessDay(iso: string): string {
  const d = parseIso(iso);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return toIso(d);
}

export function escalationDates(commencement: string, expiration: string): string[] {
  const start = parseIso(commencement);
  const end = parseIso(expiration);
  const out: string[] = [];
  for (let year = 1; ; year += 1) {
    const targetYear = start.getUTCFullYear() + year;
    const month = start.getUTCMonth();
    // Clamp Feb 29 (and any month-end overflow) to the last valid day of that month.
    const lastDayOfMonth = new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate();
    const day = Math.min(start.getUTCDate(), lastDayOfMonth);
    const anniversary = new Date(Date.UTC(targetYear, month, day));
    if (anniversary.getTime() > end.getTime()) break;
    out.push(toIso(anniversary));
  }
  return out;
}

export interface FactRef { value: unknown; factId: string }
export interface BuildInput { leaseCanonicalId: string; facts: Record<string, FactRef> }
export interface ObligationDraft {
  kind: string;
  responsibleParty: 'landlord' | 'tenant' | 'shared' | 'unknown';
  triggerDate: string | null;
  dueDate: string | null;
  recurrence: string | null;
  sourceFactIds: string[];
}

export function buildObligations(input: BuildInput): ObligationDraft[] {
  const out: ObligationDraft[] = [];
  const expiration = input.facts.expiration_date;
  const noticeDays = input.facts.renewal_notice_days;
  const commencement = input.facts.commencement_date;
  const escalations = input.facts.escalations;

  if (expiration && typeof expiration.value === 'string' && noticeDays && typeof noticeDays.value === 'number') {
    out.push({
      kind: 'renewal_notice',
      responsibleParty: 'tenant', // the tenant exercises; the landlord must know the window
      triggerDate: expiration.value,
      // Backward off a weekend: a notice delivered late is a notice not given.
      dueDate: previousBusinessDay(noticeDeadline(expiration.value, noticeDays.value)),
      recurrence: null,
      sourceFactIds: [expiration.factId, noticeDays.factId],
    });
  }

  if (escalations && commencement && expiration
      && typeof commencement.value === 'string' && typeof expiration.value === 'string') {
    const dates = escalationDates(commencement.value, expiration.value);
    if (dates.length > 0) {
      out.push({
        kind: 'escalation',
        responsibleParty: 'landlord', // the landlord must bill it — this is the leakage point
        triggerDate: dates[0],
        dueDate: nextBusinessDay(dates[0]),
        recurrence: 'annual',
        sourceFactIds: [commencement.factId, expiration.factId, escalations.factId],
      });
    }
  }

  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/lease-obligation-dates.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add server/warehouse/lease-obligation-dates.ts tests/unit/lease-obligation-dates.test.ts
git commit -m "feat(leases): deterministic obligation date engine"
```

---

### Task 8: Pipeline CLI — scan and extract Columbus leases

**Files:**
- Create: `scripts/scan-lease-documents.ts`, `scripts/extract-lease-facts.ts`
- Modify: `package.json` (scripts `leases:scan`, `leases:extract`)

**Interfaces:**
- Consumes: every module from Tasks 1–7, `withAgentRun` + `recordUsage` (Track 1 Task 7).
- Produces: two CLIs. `leases:scan` registers documents under a directory; `leases:extract` runs both passes for one lease chain and persists facts + obligations.

- [ ] **Step 1: Write the scan CLI**

Create `scripts/scan-lease-documents.ts`:

```ts
/**
 * Registers lease documents into the warehouse. READ-ONLY over the source directory — files are
 * never moved, renamed or rewritten (Invariant 5: Oxford business OneDrive folders).
 *
 * Usage: npm run leases:scan -- --dir "<path to lease folder>" --lease <leaseCanonicalId>
 */
import { loadEnvFile } from '../server/load-env';
loadEnvFile();
import { readdirSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { openWarehouse } from '../server/warehouse/db';
import { extractPageTexts } from '../server/warehouse/lease-page-text';
import { classifyDocType, detectExecuted, orderChain, registerDocument, sha256File } from '../server/warehouse/lease-documents';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dir = arg('dir');
const leaseId = arg('lease');
if (!dir || !leaseId) {
  console.error('usage: npm run leases:scan -- --dir "<folder>" --lease <leaseCanonicalId>');
  process.exit(2);
}

const files = readdirSync(dir)
  .filter((f) => ['.pdf', '.docx'].includes(extname(f).toLowerCase()))
  .filter((f) => statSync(join(dir, f)).isFile());

const db = openWarehouse(process.env.WAREHOUSE_DB ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite'));
try {
  const described = [];
  for (const file of files) {
    const path = join(dir, file);
    const pages = await extractPageTexts(path);
    const docType = classifyDocType(file, pages[0] ?? '');
    described.push({ fileName: file, path, docType, effectiveDate: null as string | null,
                     executed: detectExecuted(pages.join('\n')), pageCount: pages.length });
  }

  orderChain(described).forEach((doc, seq) => {
    const id = registerDocument(db, {
      sha256: sha256File(doc.path), path: doc.path, docType: doc.docType,
      leaseCanonicalId: leaseId, chainSeq: seq, executed: doc.executed, pageCount: doc.pageCount,
    });
    const pii = doc.docType === 'guaranty' ? '  [PII — excluded from extraction]' : '';
    console.log(`${String(seq).padStart(2)}  ${doc.docType.padEnd(10)} executed=${doc.executed.padEnd(7)} ${basename(doc.path)}  ${id}${pii}`);
  });

  console.log(`\n${described.length} document(s) registered for ${leaseId}.`);
  console.log('Review the chain order and the executed flags before extracting — an unexecuted draft ' +
              'treated as operative has caused a real error in this portfolio.');
} finally {
  db.close();
}
```

- [ ] **Step 2: Write the extract CLI**

Create `scripts/extract-lease-facts.ts`:

```ts
/**
 * Runs both extraction passes for one lease chain and persists facts + obligations.
 *
 * Usage: npm run leases:extract -- --lease <leaseCanonicalId>
 * Requires ANTHROPIC_API_KEY. Guaranty documents are skipped (PII).
 */
import { loadEnvFile } from '../server/load-env';
loadEnvFile();
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openWarehouse } from '../server/warehouse/db';
import { extractPageTexts } from '../server/warehouse/lease-page-text';
import { extractFields, EXTRACTOR_VERSION } from '../server/warehouse/lease-extract-structured';
import { extractQuotes } from '../server/warehouse/lease-extract-quotes';
import { persistFacts } from '../server/warehouse/lease-facts-persist';
import { buildObligations } from '../server/warehouse/lease-obligation-dates';
import { withAgentRun, recordUsage } from '../server/warehouse/agent-runs';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const leaseId = arg('lease');
if (!leaseId) { console.error('usage: npm run leases:extract -- --lease <leaseCanonicalId>'); process.exit(2); }

const db = openWarehouse(process.env.WAREHOUSE_DB ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite'));
try {
  const docs = db.prepare(
    `SELECT document_id, path FROM documents
      WHERE lease_canonical_id = ? AND contains_pii = 0 AND executed <> 'no'
      ORDER BY chain_seq`,
  ).all(leaseId) as Array<{ document_id: string; path: string }>;

  if (docs.length === 0) { console.error(`no extractable documents registered for ${leaseId}`); process.exit(1); }

  // The chain is read as one corpus so a later amendment supersedes an earlier term; each fact is
  // attributed to the document whose text carries its quote.
  const pagesByDoc = new Map<string, string[]>();
  for (const d of docs) pagesByDoc.set(d.document_id, await extractPageTexts(d.path));

  for (const doc of docs) {
    const pages = pagesByDoc.get(doc.document_id) ?? [];
    await withAgentRun(db, { pipeline: 'lease-extract', model: process.env.LEASE_EXTRACT_MODEL ?? 'claude-sonnet-5' }, async (runId) => {
      const a = await extractFields({ pages });
      if (!a.ok) throw new Error(a.error);
      const b = await extractQuotes({ pages });
      if (!b.ok) throw new Error(b.error);
      recordUsage(db, runId, {
        tokensIn: a.usage.tokensIn + b.usage.tokensIn,
        tokensOut: a.usage.tokensOut + b.usage.tokensOut,
      });

      const result = persistFacts(db, {
        leaseCanonicalId: leaseId, documentId: doc.document_id, pages,
        values: a.values, quotes: b.quotes, runId, extractorVersion: EXTRACTOR_VERSION,
      });
      console.log(`${doc.path}: ${result.written} fact(s), ${result.disputed.length} disputed` +
                  (result.disputed.length ? ` → ${result.disputed.join(', ')}` : ''));
    });
  }

  const facts = db.prepare(
    `SELECT fact_id, field, value_json FROM lease_facts
      WHERE lease_canonical_id = ? AND status IN ('extracted','verified')`,
  ).all(leaseId) as Array<{ fact_id: string; field: string; value_json: string }>;

  const factMap = Object.fromEntries(facts.map((f) => [f.field, { value: JSON.parse(f.value_json), factId: f.fact_id }]));
  const drafts = buildObligations({ leaseCanonicalId: leaseId, facts: factMap });

  const insert = db.prepare(
    `INSERT INTO obligations (obligation_id, lease_canonical_id, kind, responsible_party, trigger_date,
                              due_date, recurrence, source_fact_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const d of drafts) {
    insert.run(`obl-${randomUUID()}`, leaseId, d.kind, d.responsibleParty, d.triggerDate, d.dueDate,
               d.recurrence, JSON.stringify(d.sourceFactIds));
    console.log(`obligation: ${d.kind} due ${d.dueDate}`);
  }
  console.log(`\n${drafts.length} obligation(s) written. Economic facts stay unverified until a human confirms them.`);
} finally {
  db.close();
}
```

- [ ] **Step 3: Register both npm scripts**

In `package.json`, after `"xref:seed"`:

```json
    "leases:scan": "tsx scripts/scan-lease-documents.ts",
    "leases:extract": "tsx scripts/extract-lease-facts.ts",
```

- [ ] **Step 4: Run against one real Columbus lease**

```bash
npm run leases:scan -- --dir "C:/Users/Owner/OneDrive - Oxford Capital Partners/Business/Master Lease Database/<one Columbus tenant folder>" --lease lease-columbus-001
```
Expected: one line per document with its type, executed flag and chain position. **Confirm the chain order and executed flags by eye before continuing** — this is the gate that catches a draft being treated as operative.

```bash
npm run leases:extract -- --lease lease-columbus-001
```
Expected: per-document fact counts, a disputed list, and the obligations written.

- [ ] **Step 5: Commit**

```bash
git add scripts/scan-lease-documents.ts scripts/extract-lease-facts.ts package.json
git commit -m "feat(leases): scan and extract CLIs for a lease chain"
```

---

### Task 9: Gold-set accuracy harness

**Files:**
- Create: `scripts/lease-extract-eval.ts`, `tests/fixtures/leases/gold-set.example.json`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces: a per-field accuracy report against hand-verified leases. Run it before and after any model or prompt change; a silent extraction regression is otherwise invisible until someone reads a lease.

> Follows the precedent of ora-pm's `evals/lease-intake-model-eval/`. The gold set itself holds real lease values and therefore **must not be committed** — only the example file is. Add `tests/fixtures/leases/gold-set.json` to `.gitignore`.

- [ ] **Step 1: Create the example gold set**

Create `tests/fixtures/leases/gold-set.example.json`:

```json
{
  "//": "Copy to gold-set.json and fill in from hand-verified leases. gold-set.json is gitignored: it holds real lease terms.",
  "leases": [
    {
      "leaseCanonicalId": "lease-columbus-001",
      "documentPath": "C:/path/to/executed/lease.pdf",
      "expected": {
        "commencement_date": "2024-02-01",
        "expiration_date": "2029-01-31",
        "renewal_notice_days": 180,
        "escalations": "3% on each anniversary"
      }
    }
  ]
}
```

- [ ] **Step 2: Write the harness**

Create `scripts/lease-extract-eval.ts`:

```ts
/**
 * Scores extraction against hand-verified leases, per field.
 *
 * Usage: npm run leases:eval -- --gold tests/fixtures/leases/gold-set.json
 * Run before and after any change to the model, the prompts, or EXTRACTOR_VERSION.
 */
import { loadEnvFile } from '../server/load-env';
loadEnvFile();
import { readFileSync } from 'node:fs';
import { extractPageTexts } from '../server/warehouse/lease-page-text';
import { extractFields } from '../server/warehouse/lease-extract-structured';
import { extractQuotes } from '../server/warehouse/lease-extract-quotes';
import { resolveQuotePage } from '../server/warehouse/lease-quote-verify';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface GoldLease { leaseCanonicalId: string; documentPath: string; expected: Record<string, unknown> }

const goldPath = arg('gold') ?? 'tests/fixtures/leases/gold-set.json';
const gold = JSON.parse(readFileSync(goldPath, 'utf8')) as { leases: GoldLease[] };

const tally: Record<string, { correct: number; wrong: number; missing: number; unsupported: number }> = {};
const bump = (field: string, key: 'correct' | 'wrong' | 'missing' | 'unsupported') => {
  tally[field] ??= { correct: 0, wrong: 0, missing: 0, unsupported: 0 };
  tally[field][key] += 1;
};

for (const lease of gold.leases) {
  const pages = await extractPageTexts(lease.documentPath);
  const a = await extractFields({ pages });
  const b = await extractQuotes({ pages });
  if (!a.ok || !b.ok) { console.error(`${lease.leaseCanonicalId}: ${a.ok ? (b as { error: string }).error : a.error}`); continue; }

  for (const [field, expected] of Object.entries(lease.expected)) {
    const actual = a.values[field];
    if (actual === undefined) { bump(field, 'missing'); continue; }
    const same = JSON.stringify(actual) === JSON.stringify(expected);
    bump(field, same ? 'correct' : 'wrong');
    const quote = b.quotes[field];
    if (!quote || !resolveQuotePage(quote, pages).quoteOnPage) bump(field, 'unsupported');
    if (!same) console.log(`  MISMATCH ${lease.leaseCanonicalId} ${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

console.log('\nfield                    correct  wrong  missing  unsupported-quote');
for (const [field, t] of Object.entries(tally)) {
  console.log(`${field.padEnd(24)} ${String(t.correct).padStart(7)} ${String(t.wrong).padStart(6)} ${String(t.missing).padStart(8)} ${String(t.unsupported).padStart(18)}`);
}
```

- [ ] **Step 3: Register the script and ignore the real gold set**

In `package.json`, after `"leases:extract"`:

```json
    "leases:eval": "tsx scripts/lease-extract-eval.ts",
```

Add to `.gitignore`:

```
tests/fixtures/leases/gold-set.json
```

- [ ] **Step 4: Build a 5-lease gold set and run it**

Hand-verify five Columbus leases (Gabriel, ~2 hours), fill `gold-set.json`, then:

Run: `npm run leases:eval`
Expected: a per-field table. **Record the numbers in the commit message** — they are the baseline every later model or prompt change is measured against.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run gate
git add scripts/lease-extract-eval.ts tests/fixtures/leases/gold-set.example.json package.json .gitignore
git commit -m "feat(leases): gold-set accuracy harness"
```

---

## Deferred to P2 (explicitly not in this plan)

| Item | Why deferred |
|---|---|
| Review-queue UI + `/api/warehouse/lease-obligations` routes | The CLI + `verifyFact`/`correctFact` cover the pilot; UI is worth building once the dispute rate is known. Adds an entry to `sub-routers.ts` and `modules.tsx`, which the lease-market branch also touches. |
| Alert wiring into `conditions.ts` and the daily brief | Needs verified facts to exist first; alerting on unverified extraction trains people to ignore alerts. |
| Billed-vs-lease escalation audit against PM rent rolls | The measurable-ROI deliverable; needs the portfolio extracted, not just Columbus. |
| Portfolio rollout (~140 tenants) | Sequenced after the Columbus accuracy numbers justify it. |
| Anthropic citations feature as a second signal | The deterministic quote check is the primary guarantee; citations add cost and a second failure mode. |
| Lease-market P2-a (freshness KPI) and P2-b (stale-gap removal annotation) | Belong to the lease-market module; see the overview's Track 2 section. |

## Track 3 completion criteria

1. All Columbus leases registered with reviewed chain order and executed flags.
2. Twelve fields extracted per lease; every non-disputed fact has `quote_on_page = 1`.
3. Gold-set accuracy recorded per field; economic fields at or above the bar before any alert is marked verified.
4. Obligations written with correct notice deadlines; spot-checked against three leases by hand.
5. `npm run gate` green.
