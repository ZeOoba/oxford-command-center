# OneDrive Document Search Enablement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Broaden the Command Center's existing semantic document search from a Leases-only / PDF-only corpus to a safe, fail-closed search over the user's whole OneDrive (Word + Excel + CSV included), without exposing personal/estate/confidential material.

**Architecture:** All changes are surgical extensions to the already-built RAG engine in `server/sources/documents.ts` (list → extract → chunk → embed via transformers.js + sqlite-vec). We add Office/tabular extractors, a **fail-closed top-level folder allowlist** (`DOCUMENTS_INCLUDE_DIRS`), harden the confidentiality denylist, make the lease-only "non-lease" filter opt-out for general mode, make walk-depth configurable, and upgrade the Documents UI with folder facets. The actual reindex against the live drive is a final, RAM-gated, human-authorized step.

**Tech Stack:** Node + TypeScript, Hono Brain Server, better-sqlite3 + sqlite-vec, @huggingface/transformers (all-MiniLM-L6-v2), pdf-parse, **+ mammoth (.docx)**, **exceljs (.xlsx — already a dependency)**, Vitest, React 19 + Tailwind v4 client.

**Confidentiality note:** This work edits the document indexer's exclusion guard and will later read a drive containing wills/trusts/POAs and the confidential E. Fulton deal. The denylist hardening (Task 3) and fail-closed allowlist (Task 2) are safety-critical. The reindex (Task 7) is deferred until (a) Gabriel confirms the `DOCUMENTS_INCLUDE_DIRS` allowlist and (b) RAM is reclaimed.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `package.json` | deps | add `mammoth` |
| `server/sources/documents.ts` | RAG engine | extractors, allowlist, denylist, non-lease opt-out, depth, size guard |
| `tests/unit/documents.test.ts` | unit tests | update extension test; add allowlist / denylist / non-lease-mode / depth / xlsx tests |
| `tests/fixtures/` | test fixtures | (none — xlsx generated in-test; docx verified live) |
| `src/modules/documents/DocumentsModule.tsx` | Documents UI | folder facets + grouping + file-type chips |
| `.env` (gitignored) | runtime config | new keys + the allowlist (Gabriel confirms) |

All server changes live in ONE file (`documents.ts`) because they share the corpus-walk/extract responsibility — consistent with the existing structure.

---

### Task 1: Office + tabular extractors (.docx / .xlsx / .csv / .tsv)

**Files:**
- Modify: `package.json` (add `mammoth`)
- Modify: `server/sources/documents.ts` (`SUPPORTED` ~line 98; `extractFile` ~line 375; add `extractXlsxText`, `cellText`, size guard)
- Test: `tests/unit/documents.test.ts`

- [ ] **Step 1: Install the .docx extractor**

```bash
cd C:/Users/Owner/oxford-command-center
npm install mammoth
```
Expected: `mammoth` added to dependencies. (`exceljs` is already present; `.csv/.tsv` need no dependency.)

- [ ] **Step 2: Write the failing test for the new extension set**

Replace the existing test at `tests/unit/documents.test.ts:63-68` with:

```ts
  it('supports pdf/txt/md/docx/xlsx/csv/tsv, skipping legacy .doc and binary .pptx', () => {
    expect(matchesIndexFilters('PropA/Leases/x.pdf', null)).toBe(true);
    expect(matchesIndexFilters('PropA/Leases/x.txt', null)).toBe(true);
    expect(matchesIndexFilters('PropA/Leases/x.docx', null)).toBe(true);
    expect(matchesIndexFilters('PropA/Leases/x.xlsx', null)).toBe(true);
    expect(matchesIndexFilters('PropA/Leases/x.csv', null)).toBe(true);
    expect(matchesIndexFilters('PropA/Leases/x.tsv', null)).toBe(true);
    expect(matchesIndexFilters('PropA/Leases/x.doc', null)).toBe(false);   // legacy binary — unsupported
    expect(matchesIndexFilters('PropA/Leases/x.pptx', null)).toBe(false);  // not yet supported
  });
```

Add an xlsx-extraction test in the `collectDocChunks` describe block (after line 197), and import ExcelJS + extractXlsxText at the top of the test file:

```ts
// add to the top imports
import ExcelJS from 'exceljs';
// add extractXlsxText to the documents import list

describe('extractXlsxText — flat cell-text dump for search', () => {
  it('extracts sheet name + non-empty cell values', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xlsx-'));
    try {
      const file = join(root, 'rent.xlsx');
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('RentRoll');
      ws.addRow(['Tenant', 'Suite', 'Annual Rent']);
      ws.addRow(['Eurosort', '100', 123450]);
      await wb.xlsx.writeFile(file);
      const text = await extractXlsxText(file);
      expect(text).toContain('RentRoll');
      expect(text).toContain('Eurosort');
      expect(text).toContain('123450');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/documents.test.ts -t "supports pdf"`
Expected: FAIL — `.docx/.xlsx/.csv/.tsv` currently return `false`; `extractXlsxText` is not exported.

- [ ] **Step 4: Implement the extractors**

In `server/sources/documents.ts`, add imports near the top (mirroring the existing pdf-parse comment style):

```ts
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
```

Widen `SUPPORTED` (line 98):

```ts
const SUPPORTED = new Set(['.pdf', '.txt', '.md', '.docx', '.xlsx', '.csv', '.tsv']);
```

Add a size cap constant near the other caps:

```ts
/** Skip files larger than this (env `DOCUMENTS_MAX_FILE_MB`, default 25) — memory safety on the box,
 * and a backstop against the giant master workbook ever slipping into the corpus. */
const MAX_FILE_BYTES = (Number(process.env.DOCUMENTS_MAX_FILE_MB) || 25) * 1024 * 1024;
```

Replace `extractFile` (line 375) with:

```ts
async function extractFile(path: string): Promise<string> {
  const ext = extname(path).toLowerCase();
  try {
    if (statSync(path).size > MAX_FILE_BYTES) return ''; // oversized → skip (memory safety)
    if (ext === '.pdf') return (await pdfParse(readFileSync(path))).text;
    if (ext === '.txt' || ext === '.md' || ext === '.csv' || ext === '.tsv') return readFileSync(path, 'utf8');
    if (ext === '.docx') return (await mammoth.extractRawText({ path })).value;
    if (ext === '.xlsx') return await extractXlsxText(path);
  } catch {
    /* unreadable/corrupt/locked file → skip */
  }
  return '';
}

/** Best-effort flat text of an .xlsx — sheet names + non-empty cell values — so a rent roll / NOI
 * calc / tax appeal workbook is findable by meaning. Exported for unit testing. */
export async function extractXlsxText(path: string): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const lines: string[] = [];
  wb.eachSheet((ws) => {
    lines.push(`# ${ws.name}`);
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = (row.values as unknown[]).slice(1).map(cellText).filter(Boolean);
      if (vals.length) lines.push(vals.join(' \t '));
    });
  });
  return lines.join('\n');
}

/** Coerce one exceljs cell value (string | number | date | formula | richtext | hyperlink) to text. */
function cellText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o['text'] === 'string') return o['text'];
    if ('result' in o && o['result'] != null) return String(o['result']);
    if (Array.isArray(o['richText'])) return (o['richText'] as Array<{ text: string }>).map((r) => r.text).join('');
    if (o['hyperlink'] != null) return String(o['text'] ?? o['hyperlink']);
    return '';
  }
  return String(v);
}
```

`statSync` is already imported (line 1). If `tsconfig` `noUncheckedIndexedAccess` complains about the bracket access on `o`, the `in` guards above already satisfy it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/documents.test.ts -t "supports pdf"` then `-t "extractXlsxText"`
Expected: PASS both.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json server/sources/documents.ts tests/unit/documents.test.ts
git commit -m "feat(documents): index .docx/.xlsx/.csv/.tsv with size guard"
```

> **.docx note:** mammoth `.docx` extraction is verified against the live Brain Server by indexing a real Word doc from OneDrive and searching it (consistent with the existing real-model verification note at `documents.test.ts:332`), since generating a valid `.docx` binary in-test is not worth a fixture.

---

### Task 2: Fail-closed top-level folder allowlist (`DOCUMENTS_INCLUDE_DIRS`)

**Files:**
- Modify: `server/sources/documents.ts` (add `includeDirs()`; thread into `listFiles`)
- Test: `tests/unit/documents.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/documents.test.ts` inside a new describe block:

```ts
describe('DOCUMENTS_INCLUDE_DIRS — fail-closed top-level allowlist', () => {
  const prev = { dir: process.env.DOCUMENTS_DIR, inc: process.env.DOCUMENTS_PATH_INCLUDE, allow: process.env.DOCUMENTS_INCLUDE_DIRS, drop: process.env.DOCUMENTS_DROP_NONLEASE };
  afterEach(() => {
    process.env.DOCUMENTS_DIR = prev.dir; process.env.DOCUMENTS_PATH_INCLUDE = prev.inc;
    process.env.DOCUMENTS_INCLUDE_DIRS = prev.allow; process.env.DOCUMENTS_DROP_NONLEASE = prev.drop;
  });
  it('indexes ONLY allowlisted top-level folders, skipping unlisted + personal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'allow-'));
    try {
      mkdirSync(join(root, '6300 Sherriff Road'), { recursive: true });
      mkdirSync(join(root, 'Estate Planning and Trust Documents'), { recursive: true });
      mkdirSync(join(root, 'Pictures'), { recursive: true });
      writeFileSync(join(root, '6300 Sherriff Road', 'lease.txt'), 'Tenant renewal option clause text.');
      writeFileSync(join(root, 'Estate Planning and Trust Documents', 'will.txt'), 'last will and testament');
      writeFileSync(join(root, 'Pictures', 'note.txt'), 'family photo caption');

      process.env.DOCUMENTS_DIR = root;
      delete process.env.DOCUMENTS_PATH_INCLUDE;
      process.env.DOCUMENTS_DROP_NONLEASE = '0';
      process.env.DOCUMENTS_INCLUDE_DIRS = '6300 Sherriff Road';

      const { docs } = await collectDocChunks();
      expect(docs.length).toBe(1);
      expect(docs[0]!.name.replace(/\\/g, '/')).toBe('6300 Sherriff Road/lease.txt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/documents.test.ts -t "fail-closed"`
Expected: FAIL — all three folders index (no allowlist yet), `docs.length` is 3 (or 2 after estate exclusion), not 1.

- [ ] **Step 3: Implement the allowlist**

In `server/sources/documents.ts`, add after `pathIncludeRe()` (~line 401):

```ts
/** Top-level folder allowlist (env `DOCUMENTS_INCLUDE_DIRS`, comma-separated exact folder names
 * relative to DOCUMENTS_DIR, case-insensitive). When set, ONLY these top-level directories are
 * descended into — a FAIL-CLOSED scope so a broad DOCUMENTS_DIR (the whole OneDrive) never sweeps in
 * personal/unlisted folders. Unset → walk every top-level dir (legacy), still subject to excludes. */
export function includeDirs(): Set<string> | null {
  const raw = (process.env.DOCUMENTS_INCLUDE_DIRS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return raw.length ? new Set(raw.map((s) => s.toLowerCase())) : null;
}
```

Update `listFiles` (line 439) signature + the directory branch:

```ts
function listFiles(
  root: string,
  max = maxFiles(),
  includeRe = pathIncludeRe(),
  excludes = excludePatterns(),
  allow = includeDirs(),
  depthCap = maxDepth(),
): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;
  const walk = (dir: string, depth: number): void => {
    if (depth > depthCap || files.length >= max) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= max) { truncated = true; return; }
      const full = join(dir, e.name);
      const rel = full.slice(root.length).replace(/^[\\/]+/, '');
      if (isExcludedPath(rel, excludes)) continue;
      if (e.isDirectory()) {
        if (depth === 0 && allow && !allow.has(e.name.toLowerCase())) continue; // fail-closed top-level scope
        walk(full, depth + 1);
      } else if (matchesIndexFilters(rel, includeRe)) files.push(full);
    }
  };
  walk(root, 0);
  return { files, truncated };
}
```

(`maxDepth()` is added in Task 5; if executing tasks out of order, add it first or inline `6`.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/documents.test.ts -t "fail-closed"`
Expected: PASS — only `6300 Sherriff Road/lease.txt` indexed.

- [ ] **Step 5: Commit**

```bash
git add server/sources/documents.ts tests/unit/documents.test.ts
git commit -m "feat(documents): fail-closed DOCUMENTS_INCLUDE_DIRS top-level allowlist"
```

---

### Task 3: Harden the confidentiality denylist (defense-in-depth)

**Files:**
- Modify: `server/sources/documents.ts` (`DEFAULT_EXCLUDE` ~line 45)
- Test: `tests/unit/documents.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the existing `describe('isExcludedPath …')` block (after line 56):

```ts
  it('excludes the GDG/CRG estate folder and the Pictures tree (hardened)', () => {
    expect(isExcludedPath('GDG Estate 12-2022 and CRG Estate 03-2023/trust.pdf')).toBe(true);
    expect(isExcludedPath('Pictures/Business Pics/6860 Distribution Drive.JPG')).toBe(true);
    expect(isExcludedPath('Pictures/Lucy Camp 2003/photo.jpg')).toBe(true);
  });
  it('does NOT over-match legitimate "real estate" business paths', () => {
    expect(isExcludedPath('6300 Sherriff Road/2009-2011 real estate tax appeal results.pdf')).toBe(false);
    expect(isExcludedPath('Investment Candidates -- 2015/Eastside Plaza NOI CALC.xlsx')).toBe(false);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/documents.test.ts -t "hardened"`
Expected: FAIL — `GDG Estate …` and `Pictures/…` currently return `false`.

- [ ] **Step 3: Implement the hardened denylist**

Replace `DEFAULT_EXCLUDE` (line 45) with:

```ts
const DEFAULT_EXCLUDE: RegExp[] = [
  /estate planning/i,
  /\b(?:gdg|crg) estate\b/i,            // "GDG Estate 12-2022 and CRG Estate 03-2023"
  /trust documents/i,
  /gabriel documents/i,
  /gdg properties/i,
  /(^|[\\/])pictures([\\/]|$)/i,        // personal photo tree (no searchable text anyway)
  /\bpersonal\b/i,
];
```

The patterns are deliberately precise (`\b(?:gdg|crg) estate\b`, not a blanket `\bestate\b`) so legitimate "real estate" business documents are NOT excluded — proven by the over-match test.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/documents.test.ts -t "isExcludedPath"`
Expected: PASS all (new + existing).

- [ ] **Step 5: Commit**

```bash
git add server/sources/documents.ts tests/unit/documents.test.ts
git commit -m "feat(documents): harden personal/estate exclusion (GDG/CRG estate, Pictures)"
```

> E. Fulton stays excluded via the gitignored `DOCUMENTS_EXCLUDE` env var (its codename is never hardcoded). Verify `DOCUMENTS_EXCLUDE` is set before reindex (Task 7).

---

### Task 4: Non-lease filter opt-out (general OneDrive mode)

**Files:**
- Modify: `server/sources/documents.ts` (`matchesIndexFilters` ~line 426; add `dropNonLease()`)
- Test: `tests/unit/documents.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside the `describe('matchesIndexFilters …')` block:

```ts
  it('keeps financials/rent-rolls when the non-lease filter is OFF (general OneDrive mode)', () => {
    const pnl = '6300 Sherriff Road/2018 6300 Sheriff Road LLC P&L.pdf';
    expect(matchesIndexFilters(pnl, null, true)).toBe(false);  // lease mode drops it
    expect(matchesIndexFilters(pnl, null, false)).toBe(true);  // general mode keeps it
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/documents.test.ts -t "general OneDrive mode"`
Expected: FAIL — `matchesIndexFilters` takes only 2 args; the 3rd is ignored.

- [ ] **Step 3: Implement the opt-out**

Add near the other env knobs in `server/sources/documents.ts`:

```ts
/** Whether to drop obvious non-lease docs (financials/rent-rolls/disclosures). ON by default so the
 * lease corpus stays clean; set `DOCUMENTS_DROP_NONLEASE=0` for a GENERAL OneDrive corpus where those
 * documents are exactly what you want findable. */
export function dropNonLease(): boolean {
  return (process.env.DOCUMENTS_DROP_NONLEASE ?? '1') !== '0';
}
```

Replace `matchesIndexFilters` (line 426) with:

```ts
export function matchesIndexFilters(relPath: string, includeRe: RegExp | null, drop = dropNonLease()): boolean {
  if (!SUPPORTED.has(extname(relPath).toLowerCase())) return false;
  const norm = relPath.replace(/\\/g, '/');
  if (includeRe && !includeRe.test(norm)) return false;
  if (drop && isLikelyNonLease(norm)) return false;
  return true;
}
```

The default param reads the env, so every existing call site and test (which pass 2 args) is unchanged.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/documents.test.ts -t "matchesIndexFilters"`
Expected: PASS all.

- [ ] **Step 5: Commit**

```bash
git add server/sources/documents.ts tests/unit/documents.test.ts
git commit -m "feat(documents): DOCUMENTS_DROP_NONLEASE opt-out for general corpus"
```

---

### Task 5: Configurable walk depth (`DOCUMENTS_MAX_DEPTH`)

**Files:**
- Modify: `server/sources/documents.ts` (add `maxDepth()`; used by `listFiles` in Task 2)
- Test: `tests/unit/documents.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the `describe('env knobs …')` block:

```ts
  it('maxDepth defaults to 6 and honors a valid override; ignores nonsense', () => {
    const p = process.env.DOCUMENTS_MAX_DEPTH;
    delete process.env.DOCUMENTS_MAX_DEPTH;
    expect(maxDepth()).toBe(6);
    process.env.DOCUMENTS_MAX_DEPTH = '9';
    expect(maxDepth()).toBe(9);
    process.env.DOCUMENTS_MAX_DEPTH = 'nonsense';
    expect(maxDepth()).toBe(6);
    process.env.DOCUMENTS_MAX_DEPTH = p;
  });
```

Add `maxDepth` to the import list at the top of the test file.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/documents.test.ts -t "maxDepth"`
Expected: FAIL — `maxDepth` is not exported.

- [ ] **Step 3: Implement**

Add near `maxFiles()` in `server/sources/documents.ts`:

```ts
/** Max directory recursion depth (env `DOCUMENTS_MAX_DEPTH`, default 6). Raise for deeply nested
 * OneDrive trees. */
export function maxDepth(): number {
  const n = Number(process.env.DOCUMENTS_MAX_DEPTH);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 6;
}
```

(The `listFiles` change in Task 2 already consumes `depthCap = maxDepth()` and uses `if (depth > depthCap …)` instead of the hardcoded `6`.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/documents.test.ts -t "maxDepth"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/sources/documents.ts tests/unit/documents.test.ts
git commit -m "feat(documents): configurable DOCUMENTS_MAX_DEPTH"
```

---

### Task 6: Documents UI — folder facets, grouping, file-type chips

**Files:**
- Modify: `src/modules/documents/DocumentsModule.tsx` (the `DocSearch` component, ~line 105)
- Verify: browser (Brain Server running)

- [ ] **Step 1: Add folder/type derivation + facet UI**

In `src/modules/documents/DocumentsModule.tsx`, replace the `DocSearch` results body so each hit shows its top-level folder + file type, and add folder filter chips derived from the result set. Add these helpers above `DocSearch`:

```ts
function folderOf(docPath: string): string {
  const norm = docPath.replace(/\\/g, '/');
  const seg = norm.split('/');
  return seg.length > 1 ? seg[0]! : '(root)';
}
function extOf(docPath: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(docPath);
  return m ? m[1]!.toUpperCase() : '';
}
```

Replace the `DocSearch` component body (keep the `Card`/`CardHeader`/input) with results that group by folder and offer a folder filter. Inside `DocSearch`, after the `useDocSearch` call:

```ts
  const [folder, setFolder] = useState<string | null>(null);
  const folders = [...new Set((hits ?? []).map((h) => folderOf(h.doc)))].sort();
  const shown = folder ? (hits ?? []).filter((h) => folderOf(h.doc) === folder) : (hits ?? []);
```

And render folder chips above the results list when there are hits:

```tsx
{hits && hits.length > 0 && folders.length > 1 && (
  <div className="flex flex-wrap gap-1.5 px-4 py-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
    <button onClick={() => setFolder(null)} className="num rounded-full px-2.5 py-0.5 text-2xs"
      style={folder === null
        ? { background: 'var(--accent-quiet)', color: 'var(--accent)', border: '1px solid color-mix(in oklab, var(--accent) 40%, transparent)' }
        : { color: 'var(--text-tertiary)', border: '1px solid var(--border-subtle)' }}>
      All ({hits.length})
    </button>
    {folders.map((f) => (
      <button key={f} onClick={() => setFolder(f)} className="num rounded-full px-2.5 py-0.5 text-2xs"
        style={folder === f
          ? { background: 'var(--accent-quiet)', color: 'var(--accent)', border: '1px solid color-mix(in oklab, var(--accent) 40%, transparent)' }
          : { color: 'var(--text-tertiary)', border: '1px solid var(--border-subtle)' }}>
        {f}
      </button>
    ))}
  </div>
)}
```

In the hit row (the `hits.map(...)` block), change the per-hit header to show the folder + file-type chip, and map over `shown` instead of `hits`:

```tsx
<div className="mb-1 flex items-center justify-between gap-2">
  <span className="truncate text-2xs font-semibold" style={{ color: 'var(--text-secondary)' }}>{h.doc}</span>
  <span className="num shrink-0 text-[10px] tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
    {extOf(h.doc)} · {(h.score * 100).toFixed(0)}%
  </span>
</div>
```

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: 0 errors, 0 warnings.

- [ ] **Step 3: Browser-verify (Brain Server running, a small test corpus indexed)**

Start `npm run dev`, open Documents, search a term that spans folders; confirm: folder chips appear, clicking one filters results, each hit shows `DOCX/PDF/XLSX · NN%`. (Use preview tools; screenshot for proof.)

- [ ] **Step 4: Commit**

```bash
git add src/modules/documents/DocumentsModule.tsx
git commit -m "feat(documents): folder facets + file-type chips in search results"
```

---

### Task 7: Config + reindex runbook (RAM-gated, human-authorized) — NOT auto-run

**Files:**
- Modify: `.env` (gitignored) — Gabriel confirms the allowlist
- Manual: run the offline indexer under reclaimed RAM

- [ ] **Step 1: Set the `.env` keys** (Gabriel confirms `DOCUMENTS_INCLUDE_DIRS`)

```ini
# Point the corpus at the whole OneDrive, scoped fail-closed by the allowlist below.
DOCUMENTS_DIR=C:\Users\Owner\OneDrive - Oxford Capital Partners (1)
# Switch off the lease-only tightening so financials/rent-rolls/PSAs are findable.
DOCUMENTS_DROP_NONLEASE=0
# Drop the Leases-only path filter (allowlist now does the scoping).
# DOCUMENTS_PATH_INCLUDE=        ← leave unset/commented
# FAIL-CLOSED allowlist — ONLY these top-level folders become AI-searchable. CONFIRM/EDIT:
DOCUMENTS_INCLUDE_DIRS=<comma-separated top-level business folders — see proposal below>
# Bigger corpus → raise caps.
DOCUMENTS_MAX_FILES=8000
DOCUMENTS_MAX_DEPTH=8
# Confidential-deal exclusion (codename lives ONLY here, never in source) — keep set.
DOCUMENTS_EXCLUDE=<E. Fulton codename / patterns>
```

**Proposed `DOCUMENTS_INCLUDE_DIRS` (Gabriel confirms before reindex):** every per-property address folder (e.g. `6300 Sherriff Road`, `55 New Plant Court`, …) + deal folders (`Investment Candidates -- 2015`) + `Master Lease Database`. **Exclude:** `eric spreadsheets` (already the structured data source via `parse.ts`), `Pictures`, `Estate Planning and Trust Documents`, `GDG Estate 12-2022 and CRG Estate 03-2023`, anything personal. (The exact full top-level list should be generated from the drive and ticked off — see Step 2.)

- [ ] **Step 2: Generate the candidate top-level folder list** (one-time, read-only, run under reclaimed RAM)

```bash
# PowerShell — lists ONLY top-level folder names for the allowlist
Get-ChildItem -Directory "C:\Users\Owner\OneDrive - Oxford Capital Partners (1)" | Select-Object -ExpandProperty Name
```
Gabriel ticks which to include → fill `DOCUMENTS_INCLUDE_DIRS`.

- [ ] **Step 3: Build the index** (RAM-heavy — run under `/solo` or a lean CLI; resumable loop)

```bash
# bash: rc 3 = more remain, rc 0 = done
while npm run index:docs; [ $? -eq 3 ]; do :; done
```
Watch the log: it prints `→ Corpus: …`, document/chunk counts, and embed progress. Truncation (file cap) is logged, never silent.

- [ ] **Step 4: Review the indexed corpus (confidentiality gate)**

Open the Documents module → review the "Document Corpus" list. Confirm: NO estate/trust/personal/E. Fulton documents present. If any slipped in, add a denylist pattern (Task 3) or tighten the allowlist and rebuild. Only then is the feature "done."

- [ ] **Step 5: Final gate + PR**

```bash
npm run gate      # typecheck + lint + test + reconcile — must be green
```
Open a PR (repo uses PRs — never push to `main` without Gabriel's OK). Do NOT commit `.env`, `data/doc-index.sqlite` (both gitignored).

---

## Self-Review

**1. Spec coverage:**
- Office/tabular extractors → Task 1 ✓
- "Search all OneDrive" fail-closed scope → Task 2 (allowlist) + Task 7 (config) ✓
- Confidentiality gap (GDG/CRG estate, Pictures) → Task 3 ✓
- Financials/rent-rolls findable (non-lease opt-out) → Task 4 ✓
- Deep trees → Task 5 ✓
- "Easily search" UX → Task 6 (facets) ✓
- Reindex + human authorization + RAM gating → Task 7 ✓
- "Incorporate accurate data later" → out of scope by Gabriel's instruction ("don't worry about the data yet"); ingestion adapters (`server/sources/{notion-deals,m365-tasks,quickbooks}.ts`) remain a separate future plan. ✓ (intentional gap)

**2. Placeholder scan:** All code steps contain complete code. The only intentional human-input blanks are `DOCUMENTS_INCLUDE_DIRS` and `DOCUMENTS_EXCLUDE` values (Gabriel's confidential choices — correctly NOT hardcoded).

**3. Type consistency:** `includeDirs(): Set<string> | null`, `dropNonLease(): boolean`, `maxDepth(): number`, `extractXlsxText(path): Promise<string>`, `matchesIndexFilters(relPath, includeRe, drop?)` — names/signatures consistent across Tasks 1–6 and the `listFiles` threading in Task 2.

**Risk notes:**
- `.xlsx` extraction reads whole-file; the `MAX_FILE_BYTES` guard + excluding `eric spreadsheets` keeps the giant master workbook out. Business workbooks (rent rolls/NOI calcs) are small.
- Reindex memory is the real constraint — hence the resumable fresh-process loop and the RAM gate. Do NOT run Task 7 Step 3 at ~300 MB free.
- Embedding 5k–15k+ chunks takes time; the loop is resumable and crash-safe (existing design).
