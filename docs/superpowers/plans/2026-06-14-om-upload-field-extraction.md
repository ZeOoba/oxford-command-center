# OM Upload & Field Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Upload OM" button to the Acquisition Workbench that parses an OM PDF and populates eligible form fields via a collapsible review drawer.

**Architecture:** A new server-side extractor (`server/warehouse/om-extract.ts`) parses the PDF with `pdf-parse` and calls Claude to return a `Partial<FormState>` (string-keyed, same format as the form). A new `POST /api/actions/om-extract` route receives the file. A new `OmImportDrawer.tsx` component shows extracted fields in a mini table before the user explicitly clicks "Apply to Form". The workbench merges the result into form state with a one-line spread.

**Tech Stack:** Hono (multipart), pdf-parse (already installed), Anthropic API (raw fetch, same pattern as `server/ai/comps.ts`), React + @testing-library/react (vitest/jsdom).

---

## File Map

| Action | Path | Purpose |
|---|---|---|
| Create | `server/warehouse/om-extract.ts` | PDF → text → Claude → `Partial<FormState>` |
| Create | `tests/unit/om-extract.test.ts` | Unit tests for extraction logic |
| Modify | `server/index.ts` | Add `POST /api/actions/om-extract` route |
| Modify | `src/modules/acquisitions/acquisition-score.ts` | Add `omExtractRequest`, `OmExtractResult`, `OmExtractError` |
| Create | `src/modules/acquisitions/OmImportDrawer.tsx` | Collapsible review drawer component |
| Create | `tests/unit/OmImportDrawer.test.tsx` | Component state-machine tests |
| Modify | `src/modules/acquisitions/AcquisitionWorkbench.tsx` | Add "Upload OM" button + drawer + onApply handler |

---

## Task 1: Extraction logic (`server/warehouse/om-extract.ts`)

**Files:**
- Create: `server/warehouse/om-extract.ts`
- Create: `tests/unit/om-extract.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/om-extract.test.ts`:

```typescript
// tests/unit/om-extract.test.ts
import { describe, it, expect } from 'vitest';
import { extractOmFields } from '../../server/warehouse/om-extract';

// Minimal real-shaped Anthropic response
function mockFetch(text: string, status = 200) {
  return async (_url: unknown, _opts: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ content: [{ type: 'text', text }] }),
    text: async () => text,
  });
}

const VALID_PDF_BUFFER = Buffer.from('fake-pdf');
const VALID_JSON = JSON.stringify({
  price: '1450000',
  totalSf: '17688',
  yearBuilt: '1987',
  clearHeightFt: '18',
  hasDock: 'yes',
  UNKNOWN_KEY: 'should-be-stripped',
});

describe('extractOmFields', () => {
  it('returns error when no API key', async () => {
    const pdfParseFn = async () => ({ text: 'some text' });
    const result = await extractOmFields(VALID_PDF_BUFFER, { pdfParseFn });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/ANTHROPIC_API_KEY/i);
  });

  it('returns error when PDF text is empty (image-only PDF)', async () => {
    const pdfParseFn = async () => ({ text: '   ' });
    const result = await extractOmFields(VALID_PDF_BUFFER, {
      apiKey: 'test-key',
      pdfParseFn,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/scanned/i);
  });

  it('extracts known fields and strips unknown keys', async () => {
    const pdfParseFn = async () => ({ text: 'Industrial OM with lots of detail.' });
    const result = await extractOmFields(VALID_PDF_BUFFER, {
      apiKey: 'test-key',
      pdfParseFn,
      fetchImpl: mockFetch(VALID_JSON) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields.price).toBe('1450000');
    expect(result.fields.totalSf).toBe('17688');
    expect(result.fields.hasDock).toBe('yes');
    expect('UNKNOWN_KEY' in result.fields).toBe(false);
    expect(result.fieldCount).toBe(5);
  });

  it('returns error when Claude returns malformed JSON', async () => {
    const pdfParseFn = async () => ({ text: 'OM text' });
    const result = await extractOmFields(VALID_PDF_BUFFER, {
      apiKey: 'test-key',
      pdfParseFn,
      fetchImpl: mockFetch('not json at all') as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/malformed/i);
  });

  it('returns error on HTTP 503', async () => {
    const pdfParseFn = async () => ({ text: 'OM text' });
    const result = await extractOmFields(VALID_PDF_BUFFER, {
      apiKey: 'test-key',
      pdfParseFn,
      fetchImpl: mockFetch('', 503) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unavailable/i);
  });

  it('returns empty fields (not error) when Claude finds nothing', async () => {
    const pdfParseFn = async () => ({ text: 'OM text' });
    const result = await extractOmFields(VALID_PDF_BUFFER, {
      apiKey: 'test-key',
      pdfParseFn,
      fetchImpl: mockFetch('{}') as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fieldCount).toBe(0);
    expect(Object.keys(result.fields)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run tests/unit/om-extract.test.ts
```

Expected: `Cannot find module '../../server/warehouse/om-extract'`

- [ ] **Step 3: Implement `server/warehouse/om-extract.ts`**

```typescript
// server/warehouse/om-extract.ts
// @ts-expect-error -- pdf-parse has no type declarations
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

export type OmExtractResult =
  | { ok: true; fields: Record<string, string>; fieldCount: number }
  | { ok: false; error: string };

export interface OmExtractOptions {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  // Injectable for tests — avoids needing to vi.mock the pdf-parse module
  pdfParseFn?: (buffer: Buffer) => Promise<{ text: string }>;
}

// Fields Claude can reliably extract from a standard OM. Key = FormState key (string format).
const EXTRACTABLE_FIELDS = [
  { key: 'price',           desc: 'Asking/offering price in dollars. Number only, no $ or commas. OM synonyms: asking price, list price, offering price.' },
  { key: 'totalSf',         desc: 'Total gross building area in square feet. Number only. OM synonyms: GBA, gross building area, building size, total SF.' },
  { key: 'maxBuildingSf',   desc: 'Largest single building SF. If single building use same value as totalSf. OM synonyms: largest building, max building SF.' },
  { key: 'yearBuilt',       desc: 'Year the building was constructed (4-digit integer). OM synonyms: year built, constructed, vintage.' },
  { key: 'clearHeightFt',   desc: 'Interior clear ceiling height in feet. Number only. OM synonyms: clear height, clear ceiling height.' },
  { key: 'officePct',       desc: 'Office percentage of total building area, 0–100 (NOT decimal). OM synonyms: office percentage, office buildout, office ratio.' },
  { key: 'constructionType',desc: 'Output exactly one of: block-tilt-brick (masonry/tilt-up/block/brick), mixed, pemb (all-metal/pre-engineered), unknown.' },
  { key: 'hasDock',         desc: 'Whether the property has dock-high loading doors. Output: yes or no.' },
  { key: 'dockCount',       desc: 'Number of dock doors (integer). OM synonyms: dock doors, loading docks.' },
  { key: 'hasDriveIn',      desc: 'Whether the property has grade-level drive-in doors. Output: yes or no. OM synonyms: drive-in doors, grade-level doors.' },
  { key: 'driveInCount',    desc: 'Number of drive-in doors (integer). OM synonyms: grade-level door count.' },
  { key: 'truckCourtFt',    desc: 'Truck court depth in feet. Number only. OM synonyms: truck court depth, maneuvering depth.' },
  { key: 'inPlaceRentPsf',  desc: 'Current in-place rent in $/SF/year (NNN). Number only. OM synonyms: current rent, in-place rent, contract rent.' },
  { key: 'marketRentPsf',   desc: 'Market rent in $/SF/year (NNN). Number only. OM synonyms: market rent, asking rent.' },
  { key: 'waltYears',       desc: 'Weighted average lease term remaining in years (decimal ok). OM synonyms: WALT, weighted average lease term, remaining lease term.' },
] as const;

const VALID_KEYS = new Set(EXTRACTABLE_FIELDS.map((f) => f.key));

const SYSTEM =
  `You are a commercial real estate data extractor. Extract field values from the OM text.\n` +
  `Return ONLY a JSON object — no markdown, no explanation, no code fences.\n` +
  `Keys are the exact field names listed. Values are strings.\n` +
  `Rules:\n` +
  `- Include ONLY fields stated explicitly in the document with high confidence.\n` +
  `- Omit any field not clearly present. Do NOT guess or infer.\n` +
  `- Numbers: digits only, no currency symbols, no commas, no units.\n` +
  `- Percentages: 0–100 range (not decimal). Example: "15" not "0.15".\n` +
  `- hasDock / hasDriveIn: output exactly "yes" or "no".\n` +
  `- constructionType: output exactly one of the listed values.\n` +
  `- If a field is absent or ambiguous, omit it.`;

export async function extractOmFields(
  pdfBuffer: Buffer,
  opts: OmExtractOptions,
): Promise<OmExtractResult> {
  if (!opts.apiKey) {
    return { ok: false, error: 'AI extraction requires ANTHROPIC_API_KEY — start the Brain server with a key configured.' };
  }

  const parseFn = opts.pdfParseFn ?? ((buf: Buffer) => (pdfParse(buf) as Promise<{ text: string }>));

  let text: string;
  try {
    const parsed = await parseFn(pdfBuffer);
    text = parsed.text ?? '';
  } catch {
    return { ok: false, error: 'Failed to parse the PDF — the file may be corrupted or password-protected.' };
  }

  if (!text.trim()) {
    return { ok: false, error: 'No extractable text found — this may be a scanned/image-only PDF.' };
  }

  // Truncate to ~30 K chars (OMs are rarely longer as structured text)
  const body = text.length > 30_000 ? text.slice(0, 30_000) + '\n[truncated]' : text;

  const fieldManifest = EXTRACTABLE_FIELDS.map((f) => `- ${f.key}: ${f.desc}`).join('\n');
  const userPrompt = `Extract these fields from the OM text:\n${fieldManifest}\n\nOM TEXT:\n${body}`;

  const f = opts.fetchImpl ?? fetch;
  let res: { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> };
  try {
    res = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: opts.model ?? 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: SYSTEM,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
  } catch (e) {
    return { ok: false, error: `Network error reaching AI service: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (!res.ok) {
    if (res.status === 503 || res.status === 529) {
      return { ok: false, error: 'AI service temporarily unavailable — try again in a moment.' };
    }
    const detail = await res.text().catch(() => '');
    return { ok: false, error: `AI service error (${res.status}): ${detail.slice(0, 200)}` };
  }

  const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const textBlock = (json.content ?? []).find((b) => b.type === 'text');
  if (!textBlock?.text) {
    return { ok: false, error: 'AI service returned an empty extraction.' };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(textBlock.text);
  } catch {
    return { ok: false, error: 'AI returned malformed JSON — try again.' };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'AI returned unexpected response format — try again.' };
  }

  // Strip unknown keys and non-string values
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (VALID_KEYS.has(k) && typeof v === 'string' && v.trim() !== '') {
      fields[k] = v.trim();
    }
  }

  return { ok: true, fields, fieldCount: Object.keys(fields).length };
}
```

- [ ] **Step 4: Run tests — all should pass**

```bash
npx vitest run tests/unit/om-extract.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/warehouse/om-extract.ts tests/unit/om-extract.test.ts
git commit -m "feat: om-extract server logic — pdf-parse + Claude field extraction"
```

---

## Task 2: Add the server route (`server/index.ts`)

**Files:**
- Modify: `server/index.ts`

- [ ] **Step 1: Add the import at the top of `server/index.ts`**

After the existing imports (around line 26, after the `captureOccupancy` import), add:

```typescript
import { extractOmFields } from './warehouse/om-extract';
```

- [ ] **Step 2: Add the route after the `acquisition-input` route (around line 179)**

After the closing `});` of the `app.post('/api/actions/acquisition-input', ...)` block, add:

```typescript
app.post('/api/actions/om-extract', async (c) => {
  const MAX_BYTES = 25 * 1024 * 1024; // 25 MB
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ ok: false, error: 'Expected multipart/form-data with a PDF file.' }, 400);
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return c.json({ ok: false, error: 'No file field in request.' }, 400);
  }
  if (!file.name.toLowerCase().endsWith('.pdf')) {
    return c.json({ ok: false, error: 'Only PDF files are supported.' }, 400);
  }
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) {
    return c.json({ ok: false, error: 'File too large (max 25 MB).' }, 413);
  }
  const result = await extractOmFields(buf, {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001',
  });
  if (!result.ok) return c.json({ ok: false, error: result.error }, 422);
  return c.json({ ok: true, fields: result.fields, fieldCount: result.fieldCount });
});
```

- [ ] **Step 3: Typecheck to confirm no errors**

```bash
npx tsc --noEmit -p tsconfig.node.json
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add server/index.ts
git commit -m "feat: POST /api/actions/om-extract route"
```

---

## Task 3: Client helper (`src/modules/acquisitions/acquisition-score.ts`)

**Files:**
- Modify: `src/modules/acquisitions/acquisition-score.ts`

- [ ] **Step 1: Add the types and helper at the end of `acquisition-score.ts`**

Append after the final `}` of `inputToForm`:

```typescript
// ── OM field extraction client helper ────────────────────────────────────────

export interface OmExtractResult {
  fields: Record<string, string>;
  fieldCount: number;
}

export class OmExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OmExtractError';
  }
}

/** POST a PDF file to the OM extraction endpoint. Returns extracted FormState-format fields.
 *  Throws OmExtractError on any failure (network, server, or extraction error). */
export async function omExtractRequest(file: File): Promise<OmExtractResult> {
  const body = new FormData();
  body.append('file', file);
  let res: Response;
  try {
    res = await fetch('/api/actions/om-extract', { method: 'POST', body });
  } catch {
    throw new OmExtractError('Could not reach the Brain server.');
  }
  const data = (await res.json()) as {
    ok?: boolean;
    error?: string;
    fields?: Record<string, string>;
    fieldCount?: number;
  };
  if (!res.ok || !data.ok) {
    throw new OmExtractError(data.error ?? `Extraction failed (${res.status})`);
  }
  if (!data.fields) throw new OmExtractError('Malformed extraction response.');
  return { fields: data.fields, fieldCount: data.fieldCount ?? 0 };
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit -p tsconfig.json
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/modules/acquisitions/acquisition-score.ts
git commit -m "feat: omExtractRequest client helper + OmExtractResult/OmExtractError types"
```

---

## Task 4: The drawer component

**Files:**
- Create: `src/modules/acquisitions/OmImportDrawer.tsx`
- Create: `tests/unit/OmImportDrawer.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/OmImportDrawer.test.tsx`:

```typescript
// tests/unit/OmImportDrawer.test.tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { OmImportDrawer } from '../../src/modules/acquisitions/OmImportDrawer';
import { OmExtractError } from '../../src/modules/acquisitions/acquisition-score';

afterEach(() => cleanup());

const noop = () => {};

describe('OmImportDrawer', () => {
  it('does not render when open=false', () => {
    render(<OmImportDrawer open={false} onClose={noop} onApply={noop} />);
    expect(screen.queryByText(/OM Import/i)).toBeNull();
  });

  it('renders upload button in idle state', () => {
    render(<OmImportDrawer open={true} onClose={noop} onApply={noop} />);
    expect(screen.getByText(/OM Import/i)).toBeTruthy();
    expect(screen.getByText(/upload/i)).toBeTruthy();
  });

  it('shows extracting state while upload is in flight', async () => {
    let resolve!: (v: { fields: Record<string, string>; fieldCount: number }) => void;
    const extractFn = vi.fn(() => new Promise<{ fields: Record<string, string>; fieldCount: number }>((r) => { resolve = r; }));

    render(<OmImportDrawer open={true} onClose={noop} onApply={noop} extractFn={extractFn} />);

    // Simulate file selection via the hidden input
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['%PDF-1.4'], 'test.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText(/Extracting fields/i)).toBeTruthy());
    resolve({ fields: {}, fieldCount: 0 }); // unblock
  });

  it('shows extracted table and Apply/Discard when extraction succeeds', async () => {
    const fields = { price: '1450000', totalSf: '17688', yearBuilt: '1987' };
    const extractFn = vi.fn(async () => ({ fields, fieldCount: 3 }));
    const onApply = vi.fn();
    const onClose = vi.fn();

    render(<OmImportDrawer open={true} onClose={onClose} onApply={onApply} extractFn={extractFn} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['%PDF-1.4'], 'test.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText(/3 fields found/i)).toBeTruthy());
    expect(screen.getByText('1450000')).toBeTruthy();
    expect(screen.getByText('17688')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /apply to form/i }));
    expect(onApply).toHaveBeenCalledWith(fields);
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when Discard is clicked', async () => {
    const fields = { price: '1450000' };
    const extractFn = vi.fn(async () => ({ fields, fieldCount: 1 }));
    const onClose = vi.fn();

    render(<OmImportDrawer open={true} onClose={onClose} onApply={noop} extractFn={extractFn} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['%PDF'], 'test.pdf')] } });

    await waitFor(() => expect(screen.getByRole('button', { name: /discard/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /discard/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows error state when extraction throws OmExtractError', async () => {
    const extractFn = vi.fn(async (): Promise<{ fields: Record<string, string>; fieldCount: number }> => {
      throw new OmExtractError('AI service temporarily unavailable — try again in a moment.');
    });

    render(<OmImportDrawer open={true} onClose={noop} onApply={noop} extractFn={extractFn} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['%PDF'], 'test.pdf')] } });

    await waitFor(() => expect(screen.getByText(/unavailable/i)).toBeTruthy());
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run tests/unit/OmImportDrawer.test.tsx
```

Expected: `Cannot find module '../../src/modules/acquisitions/OmImportDrawer'`

- [ ] **Step 3: Implement `src/modules/acquisitions/OmImportDrawer.tsx`**

```tsx
// src/modules/acquisitions/OmImportDrawer.tsx
import { useRef, useState } from 'react';
import { FIELD_GROUPS, omExtractRequest, OmExtractError, type OmExtractResult } from './acquisition-score';

type DrawerState =
  | { phase: 'idle' }
  | { phase: 'uploading'; filename: string }
  | { phase: 'extracted'; filename: string; fields: Record<string, string>; fieldCount: number }
  | { phase: 'error'; message: string };

// key → human label from the shared field model
const FIELD_LABELS: Record<string, string> = {};
for (const group of FIELD_GROUPS) {
  for (const spec of group.fields) {
    FIELD_LABELS[spec.key] = spec.label;
  }
}

export function OmImportDrawer({
  open,
  onClose,
  onApply,
  extractFn = omExtractRequest,
}: {
  open: boolean;
  onClose: () => void;
  onApply: (fields: Record<string, string>) => void;
  extractFn?: (file: File) => Promise<OmExtractResult>;
}) {
  const [state, setState] = useState<DrawerState>({ phase: 'idle' });
  const inputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const handleFile = async (file: File) => {
    if (file.size > 25 * 1024 * 1024) {
      setState({ phase: 'error', message: 'File too large (max 25 MB).' });
      return;
    }
    setState({ phase: 'uploading', filename: file.name });
    try {
      const result = await extractFn(file);
      setState({ phase: 'extracted', filename: file.name, fields: result.fields, fieldCount: result.fieldCount });
    } catch (e) {
      setState({
        phase: 'error',
        message: e instanceof OmExtractError ? e.message : 'Extraction failed — try again.',
      });
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
    e.target.value = ''; // allow re-selecting the same file
  };

  const handleApply = () => {
    if (state.phase !== 'extracted') return;
    onApply(state.fields);
    setState({ phase: 'idle' });
    onClose();
  };

  const handleDiscard = () => {
    setState({ phase: 'idle' });
    onClose();
  };

  const drawerStyle: React.CSSProperties = {
    background: 'var(--surface-base)',
    border: '1px solid color-mix(in oklab, var(--accent) 35%, transparent)',
    borderRadius: 'var(--radius-sm)',
    overflow: 'hidden',
    marginBottom: '0.75rem',
  };

  const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0.375rem 0.75rem',
    borderBottom: '1px solid var(--border-strong)',
    background: 'var(--surface-overlay)',
  };

  const btnBase: React.CSSProperties = {
    background: 'var(--surface-overlay)',
    border: '1px solid var(--border-strong)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-primary)',
    fontSize: '0.7rem',
    padding: '0.2rem 0.5rem',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };

  const btnPrimary: React.CSSProperties = {
    ...btnBase,
    background: 'var(--accent)',
    borderColor: 'var(--accent)',
    color: '#fff',
  };

  return (
    <div style={drawerStyle}>
      {/* Single hidden file input — all states share it */}
      <input
        ref={inputRef}
        type="file"
        accept=".pdf"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />

      {/* Header */}
      <div style={headerStyle}>
        <span
          className="text-2xs font-semibold uppercase"
          style={{ letterSpacing: '0.08em', color: 'var(--accent)' }}
        >
          OM Import
        </span>
        {state.phase === 'uploading' && (
          <span className="text-2xs" style={{ color: 'var(--text-secondary)' }}>
            Extracting fields…
          </span>
        )}
        {state.phase === 'extracted' && (
          <span className="text-2xs" style={{ color: 'var(--color-pos)' }}>
            {state.fieldCount} field{state.fieldCount !== 1 ? 's' : ''} found
          </span>
        )}
      </div>

      {/* Body */}
      <div style={{ padding: '0.5rem 0.75rem' }}>
        {state.phase === 'idle' && (
          <button
            type="button"
            style={{ ...btnBase, width: '100%', textAlign: 'center' }}
            onClick={() => inputRef.current?.click()}
          >
            Drop PDF here or click to upload
          </button>
        )}

        {state.phase === 'uploading' && (
          <div>
            <div
              style={{
                height: '3px',
                background: 'var(--border-strong)',
                borderRadius: '2px',
                marginBottom: '6px',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  background: 'var(--accent)',
                  borderRadius: '2px',
                  width: '60%',
                }}
              />
            </div>
            <span className="text-2xs" style={{ color: 'var(--text-secondary)' }}>
              {state.filename}
            </span>
          </div>
        )}

        {state.phase === 'extracted' && (
          <>
            {state.fieldCount === 0 ? (
              <p className="text-2xs" style={{ color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
                No fields extracted — the OM may lack structured data.
              </p>
            ) : (
              <div style={{ maxHeight: '180px', overflowY: 'auto', marginBottom: '0.5rem' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.7rem' }}>
                  <thead>
                    <tr>
                      <th
                        style={{
                          textAlign: 'left',
                          padding: '0 0.5rem 0.25rem 0',
                          fontWeight: 600,
                          fontSize: '0.65rem',
                          textTransform: 'uppercase',
                          letterSpacing: '0.06em',
                          color: 'var(--text-tertiary)',
                        }}
                      >
                        Field
                      </th>
                      <th
                        style={{
                          textAlign: 'left',
                          padding: '0 0.5rem 0.25rem 0',
                          fontWeight: 600,
                          fontSize: '0.65rem',
                          textTransform: 'uppercase',
                          letterSpacing: '0.06em',
                          color: 'var(--text-tertiary)',
                        }}
                      >
                        Extracted
                      </th>
                      <th style={{ width: '1.25rem' }} />
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(state.fields).map(([key, value]) => (
                      <tr key={key} style={{ borderTop: '1px solid var(--border-strong)' }}>
                        <td
                          style={{ padding: '0.2rem 0.5rem 0.2rem 0', color: 'var(--color-info)' }}
                        >
                          {FIELD_LABELS[key] ?? key}
                        </td>
                        <td style={{ padding: '0.2rem 0.5rem 0.2rem 0', color: 'var(--text-primary)' }}>
                          {value}
                        </td>
                        <td style={{ color: 'var(--color-pos)', textAlign: 'center' }}>✓</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span
                className="text-2xs"
                style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-tertiary)' }}
              >
                {state.filename}
              </span>
              <button type="button" style={btnBase} onClick={handleDiscard}>
                Discard
              </button>
              <button
                type="button"
                style={state.fieldCount === 0 ? { ...btnPrimary, opacity: 0.5, cursor: 'not-allowed' } : btnPrimary}
                onClick={handleApply}
                disabled={state.fieldCount === 0}
              >
                Apply to Form
              </button>
            </div>
          </>
        )}

        {state.phase === 'error' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span
              className="text-2xs"
              style={{ flex: 1, color: 'var(--color-neg)' }}
            >
              {state.message}
            </span>
            <button
              type="button"
              style={btnBase}
              onClick={() => {
                setState({ phase: 'idle' });
                // Small delay so state settles before re-opening the picker
                setTimeout(() => inputRef.current?.click(), 50);
              }}
            >
              Try again
            </button>
            <button type="button" style={btnBase} onClick={handleDiscard}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests — all should pass**

```bash
npx vitest run tests/unit/OmImportDrawer.test.tsx
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/modules/acquisitions/OmImportDrawer.tsx tests/unit/OmImportDrawer.test.tsx
git commit -m "feat: OmImportDrawer component — upload, extracting, table review, apply/discard states"
```

---

## Task 5: Wire into `AcquisitionWorkbench.tsx`

**Files:**
- Modify: `src/modules/acquisitions/AcquisitionWorkbench.tsx`

- [ ] **Step 1: Add the import**

At the top of `AcquisitionWorkbench.tsx`, after the existing imports, add:

```typescript
import { OmImportDrawer } from './OmImportDrawer';
```

- [ ] **Step 2: Add `drawerOpen` state**

Inside the `AcquisitionWorkbench` function, after the existing `useState` declarations (around line 40), add:

```typescript
const [drawerOpen, setDrawerOpen] = useState(false);
```

- [ ] **Step 3: Replace the `CardHeader` trailing content**

The current `CardHeader` trailing (lines 98–113) is:

```typescript
trailing={
  <div className="flex items-center gap-2">
    {deal && (
      <button
        type="button"
        onClick={() => void onSave()}
        disabled={saveState === 'saving'}
        className="rounded-[var(--radius-sm)] px-2 py-1 text-2xs font-semibold"
        style={{ background: 'var(--accent-quiet)', border: '1px solid color-mix(in oklab, var(--accent) 35%, transparent)', color: 'var(--accent)' }}
      >
        {saveState === 'saving' ? 'Saving…' : saveState === 'ok' ? 'Saved ✓' : saveState === 'err' ? 'Save failed' : 'Save'}
      </button>
    )}
    <Badge tone="neutral">{deal ? deal.name : 'blank deal'}</Badge>
  </div>
}
```

Replace it with:

```typescript
trailing={
  <div className="flex items-center gap-2">
    <button
      type="button"
      onClick={() => setDrawerOpen((v) => !v)}
      className="rounded-[var(--radius-sm)] px-2 py-1 text-2xs font-semibold"
      style={{ background: 'var(--accent-quiet)', border: '1px solid color-mix(in oklab, var(--accent) 35%, transparent)', color: 'var(--accent)' }}
    >
      {drawerOpen ? 'Close OM Import' : 'Upload OM'}
    </button>
    {deal && (
      <button
        type="button"
        onClick={() => void onSave()}
        disabled={saveState === 'saving'}
        className="rounded-[var(--radius-sm)] px-2 py-1 text-2xs font-semibold"
        style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)' }}
      >
        {saveState === 'saving' ? 'Saving…' : saveState === 'ok' ? 'Saved ✓' : saveState === 'err' ? 'Save failed' : 'Save'}
      </button>
    )}
    <Badge tone="neutral">{deal ? deal.name : 'blank deal'}</Badge>
  </div>
}
```

- [ ] **Step 4: Add the drawer between `CardHeader` and the field groups**

The current body of the Card after `CardHeader` (line 115) is:

```typescript
<div className="flex flex-col gap-4 p-3">
  {FIELD_GROUPS.map((group) => (
```

Replace it with:

```typescript
{drawerOpen && (
  <div className="px-3 pt-3">
    <OmImportDrawer
      open={drawerOpen}
      onClose={() => setDrawerOpen(false)}
      onApply={(fields) => {
        setForm((f) => ({ ...f, ...fields }));
        setSaveState('idle');
        setDrawerOpen(false);
      }}
    />
  </div>
)}
<div className="flex flex-col gap-4 p-3">
  {FIELD_GROUPS.map((group) => (
```

- [ ] **Step 5: Typecheck and run the full test suite**

```bash
npx tsc --noEmit -p tsconfig.json && npx vitest run
```

Expected: 0 type errors, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/modules/acquisitions/AcquisitionWorkbench.tsx
git commit -m "feat: wire OmImportDrawer into AcquisitionWorkbench — Upload OM button + apply-to-form handler"
```

---

## Task 6: Gate + verify

**Files:** none (verification only)

- [ ] **Step 1: Run the full gate**

```bash
npm run gate
```

Expected: governance ✓ · typecheck ✓ · lint ✓ · test ✓ · reconcile ✓ · warehouse verify ✓ · warehouse drift ✓

- [ ] **Step 2: Start the dev server and do a manual smoke test**

```bash
npm run dev
```

1. Open the Command Center in the browser.
2. Navigate to the Acquisitions module.
3. Click **Upload OM** — drawer opens.
4. Select a real OM PDF — drawer transitions to "Extracting fields…"
5. Extraction completes — mini table shows field · value · ✓ rows.
6. Click **Apply to Form** — fields populate in the form, scoring debounce fires.
7. Click **Save** (with a deal selected) — persists correctly.
8. Click **Upload OM** again — drawer toggles closed.

- [ ] **Step 3: Stop the dev server**

`Ctrl+C` in the dev server terminal (prevents SQLite WAL lock).

- [ ] **Step 4: Final commit if any cleanup**

If any minor fixes were needed during smoke test:

```bash
git add -p
git commit -m "fix: om-upload smoke test cleanup"
```
