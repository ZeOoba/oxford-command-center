# Semantic Document Search — Offline Persisted Lease Index — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline, with checkpoints) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Command Center semantic document search index ORA's real lease corpus (877 lease PDFs under per-property `Leases/` folders) via a **persisted, offline, batch-built** sqlite-vec index that never OOM-crashes the Brain Server.

**Architecture:** Three changes to `server/sources/documents.ts` plus one new offline script. (1) Tighten the corpus: drop obvious non-lease docs by filename (financial statements, rent rolls, P&Ls, disclosures), cap chunks-per-document, and coarsen chunking — cutting ~21.7k chunks to a few thousand. (2) Persist the index to an on-disk sqlite-vec DB holding BOTH vectors AND chunk metadata. (3) Build the index **offline in batches** (`npm run index:docs`) so embeddings are never held in one pass; the Brain Server loads the finished on-disk DB on startup instead of building on first request.

**Tech Stack:** TypeScript (ESM, `noUncheckedIndexedAccess`), better-sqlite3 + sqlite-vec, @huggingface/transformers (`Xenova/all-MiniLM-L6-v2`), pdf-parse, Hono server, tsx scripts, Vitest.

**Why this fixes the crash:** The native OOM (`0xC0000409`) comes from embedding all ~21.7k chunks in a single in-process pass on a memory-limited box. The offline script embeds in batches of ~48, inserts each batch straight into the on-disk DB, drops the batch, and yields to the event loop — peak memory stays flat regardless of total chunk count. Corpus-tightening is secondary (quality + load speed), not the crash fix.

**Hard constraints (verify continuously):**
- `npx tsc --noEmit -p tsconfig.json` MUST pass (`noUncheckedIndexedAccess` on). `npm run gate` (typecheck + lint + test + reconcile) MUST stay green. `npm run build` MUST succeed.
- Pure logic (non-lease predicate, per-doc cap, batching, persist/reload) is TDD with the existing deterministic fake embedder. No `transformers.js` in unit tests (Float32Array realm mismatch under Vitest — see the NOTE at the bottom of `documents.test.ts`).
- NEVER run the full ~21.7k-chunk build in-process to "test". Verify incrementally: unit tests → tiny-subset offline run → one full offline `index:docs` run → query spot-checks.
- NEVER write the confidential deal codename anywhere. The `(^|/)Leases(/)` include filter is the confidentiality boundary (that deal has no `Leases/` folder).
- Do NOT push or open the PR until Gabriel confirms.

---

## Corpus facts (verified 2026-06-05)
- `Leases/` folders live under the OneDrive root `C:\Users\Owner\OneDrive - Oxford Capital Partners (1)`. `find` shows 9 `Leases` dirs (the 7 named property folders + a `29000 Information Lane/Easton Technology Center - Due Diligence/Leases` + `Investment Candidates -- 2024/2920 Fourteenth/Leases`); 916 PDFs total under them.
- Non-lease noise confirmed by sampling: a `Financial Statements 2017, 2018, 2019 and 2020/` subfolder full of `...P&L.pdf`, plus `Current Rent Rolls 11.9.20.xlsb.pdf`, `Rent Roll -- Dec 2020.pdf`, `... Disclosure.pdf`. These are what we filter out.
- Legitimate lease components to KEEP: `Exhibit ...`, `Estoppel ...`, `Commencement Date Certificate ...`, `... Addendum ...`. Do NOT filter on "exhibit"/"estoppel"/"cam".

---

## File Structure

- **Modify** `server/sources/documents.ts` — add non-lease filter, per-doc cap, on-disk persisted/batched `buildIndex`, `loadDiskIndex`, `collectDocChunks` (extracted from `buildDocIndex`), `docIndexPath`, `warmDocIndex`; `ensureIndex` prefers the on-disk DB.
- **Modify** `tests/unit/documents.test.ts` — new tests for the predicate, the cap, persist/reload, and batching.
- **Create** `scripts/index-docs.ts` — offline list → extract → chunk → batch-embed → on-disk DB.
- **Modify** `package.json` — add `"index:docs"` script.
- **Modify** `.gitignore` — ignore `data/doc-index.sqlite*`.
- **Modify** `server/index.ts` — call `warmDocIndex()` in `main()`.
- **Modify** `.env` (gitignored) — set `DOCUMENTS_DIR` + `DOCUMENTS_PATH_INCLUDE` at the very end (Enable step).

---

## Task 1: Non-lease filename filter (corpus tightening)

**Files:**
- Modify: `server/sources/documents.ts` (near `pathIncludeRe` / `matchesIndexFilters`)
- Test: `tests/unit/documents.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/documents.test.ts` (extend the imports from `../../server/sources/documents` to include `isLikelyNonLease`):

```ts
describe('isLikelyNonLease — corpus tightening (drops financials/rent-rolls/disclosures)', () => {
  it('drops obvious non-lease docs by filename', () => {
    expect(isLikelyNonLease('Sepich Portfolio/Leases/Financial Statements 2019/2019 Sepich I- P&L.pdf')).toBe(true);
    expect(isLikelyNonLease('Leases All properties/Leases/Rent Roll -- Dec 2020.pdf')).toBe(true);
    expect(isLikelyNonLease('Leases All properties/Leases/Current Rent Rolls 11.9.20.xlsb.pdf')).toBe(true);
    expect(isLikelyNonLease('Sepich Portfolio/Leases/2012 Zettler Agency Disclosure.pdf')).toBe(true);
  });
  it('keeps real leases and legitimate lease components', () => {
    expect(isLikelyNonLease('1100 Rarig/Leases/Tenant 155 LLC Lease.pdf')).toBe(false);
    expect(isLikelyNonLease('9050 Red Branch Rd/Leases/Exhibit Package -- Unit A Soccer Plant Lease 01-2025.pdf')).toBe(false);
    expect(isLikelyNonLease('1900 North Broadway/Leases/Commencement Date Certificate -- Exhibit D Baltimore Dialysis Lease.pdf')).toBe(false);
  });
  it('matches via separator normalization (Windows backslash paths)', () => {
    expect(isLikelyNonLease('Sepich Portfolio\\Leases\\Rent Roll -- Dec 2020.pdf')).toBe(true);
  });
});
```

And extend the existing `matchesIndexFilters` describe with a non-lease case:

```ts
  it('drops non-lease docs even under a Leases folder', () => {
    expect(matchesIndexFilters('Sepich Portfolio/Leases/2019 Sepich I- P&L.pdf', LEASES_RE)).toBe(false);
    expect(matchesIndexFilters('Sepich Portfolio/Leases/Rent Roll -- Dec 2020.pdf', LEASES_RE)).toBe(false);
    expect(matchesIndexFilters('1100 Rarig/Leases/Tenant 155 LLC Lease.pdf', LEASES_RE)).toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/documents.test.ts`
Expected: FAIL — `isLikelyNonLease is not exported` / non-lease `matchesIndexFilters` case returns `true`.

- [ ] **Step 3: Implement**

In `server/sources/documents.ts`, after the `DEFAULT_EXCLUDE` / `excludePatterns` block (keep that confidentiality guard untouched), add:

```ts
/**
 * Corpus-tightening filter (NOT a confidentiality gate — that is isExcludedPath). Drops obvious
 * NON-lease documents that live inside the per-property `Leases/` folders (financial statements,
 * rent rolls, P&Ls, agency disclosures) so the index holds actual lease text. Matches on the full
 * relative path (so a `Financial Statements .../` subfolder is dropped wholesale). Extend via the
 * gitignored `DOCUMENTS_NONLEASE_PATTERNS` env (comma-separated, case-insensitive). Keep this list
 * conservative — exhibits, estoppels, addenda and commencement certificates are real lease parts.
 */
const DEFAULT_NONLEASE: RegExp[] = [
  /financial statement/i,
  /\brent[\s_-]*rolls?\b/i,
  /\bp\s*&\s*l\b/i,
  /profit and loss/i,
  /\bdisclosure\b/i,
];

export function nonLeasePatterns(): RegExp[] {
  const extra = (process.env.DOCUMENTS_NONLEASE_PATTERNS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => new RegExp(s, 'i'));
  return [...DEFAULT_NONLEASE, ...extra];
}

/** True if a relative path looks like a non-lease doc and should be skipped. Separator-agnostic. */
export function isLikelyNonLease(relPath: string, patterns: RegExp[] = nonLeasePatterns()): boolean {
  const norm = relPath.replace(/\\/g, '/');
  return patterns.some((re) => re.test(norm));
}
```

Then wire it into `matchesIndexFilters`:

```ts
export function matchesIndexFilters(relPath: string, includeRe: RegExp | null): boolean {
  if (!SUPPORTED.has(extname(relPath).toLowerCase())) return false;
  const norm = relPath.replace(/\\/g, '/');
  if (includeRe && !includeRe.test(norm)) return false;
  if (isLikelyNonLease(norm)) return false;
  return true;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/documents.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/sources/documents.ts tests/unit/documents.test.ts
git commit -m "feat(documents): drop non-lease docs (financials/rent-rolls/disclosures) from index"
```

---

## Task 2: Chunk tuning + per-document cap

**Files:**
- Modify: `server/sources/documents.ts` (`CHUNK`/`OVERLAP` constants; new `maxChunksPerDoc`)
- Test: `tests/unit/documents.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the `env knobs` describe (or a new one) in `tests/unit/documents.test.ts` (extend imports with `maxChunksPerDoc`):

```ts
describe('maxChunksPerDoc — per-document chunk cap', () => {
  const prev = process.env.DOCUMENTS_MAX_CHUNKS_PER_DOC;
  afterEach(() => { process.env.DOCUMENTS_MAX_CHUNKS_PER_DOC = prev; });
  it('defaults to 25 and honors a valid override; ignores nonsense', () => {
    delete process.env.DOCUMENTS_MAX_CHUNKS_PER_DOC;
    expect(maxChunksPerDoc()).toBe(25);
    process.env.DOCUMENTS_MAX_CHUNKS_PER_DOC = '8';
    expect(maxChunksPerDoc()).toBe(8);
    process.env.DOCUMENTS_MAX_CHUNKS_PER_DOC = 'nonsense';
    expect(maxChunksPerDoc()).toBe(25);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/documents.test.ts -t maxChunksPerDoc`
Expected: FAIL — `maxChunksPerDoc is not exported`.

- [ ] **Step 3: Implement**

In `server/sources/documents.ts`, change the chunk constants (coarser chunks, less overlap → fewer chunks):

```ts
const CHUNK = 1500;
const OVERLAP = 120;
```

And add near `maxFiles`:

```ts
/** Max chunks indexed per document (env `DOCUMENTS_MAX_CHUNKS_PER_DOC`, default 25). Bounds the
 * worst case from a long PDF that slipped past the non-lease filter. */
export function maxChunksPerDoc(): number {
  const n = Number(process.env.DOCUMENTS_MAX_CHUNKS_PER_DOC);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 25;
}
```

(The cap is applied in Task 3 inside `collectDocChunks`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/documents.test.ts -t maxChunksPerDoc`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/sources/documents.ts tests/unit/documents.test.ts
git commit -m "feat(documents): coarser chunking + per-doc chunk cap (DOCUMENTS_MAX_CHUNKS_PER_DOC)"
```

---

## Task 3: Extract `collectDocChunks` (list → extract → chunk → cap)

**Files:**
- Modify: `server/sources/documents.ts` (extract from `buildDocIndex`)
- Test: `tests/unit/documents.test.ts`

This refactors the inline pipeline in `buildDocIndex` into a reusable, separately-testable function so the offline script can feed its chunks into a batched build. Behavior is identical except for applying the per-doc cap.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/documents.test.ts` (extend imports with `collectDocChunks`):

```ts
describe('collectDocChunks — list+extract+chunk with per-doc cap', () => {
  const prev = { dir: process.env.DOCUMENTS_DIR, inc: process.env.DOCUMENTS_PATH_INCLUDE, cap: process.env.DOCUMENTS_MAX_CHUNKS_PER_DOC };
  afterEach(() => {
    process.env.DOCUMENTS_DIR = prev.dir;
    process.env.DOCUMENTS_PATH_INCLUDE = prev.inc;
    process.env.DOCUMENTS_MAX_CHUNKS_PER_DOC = prev.cap;
  });
  it('caps chunks per document and skips non-lease + excluded files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'collect-'));
    try {
      mkdirSync(join(root, 'PropA', 'Leases'), { recursive: true });
      // Long lease text → many chunks before the cap.
      const long = Array.from({ length: 80 }, (_, i) => `Section ${i}. ` + 'lorem ipsum dolor sit amet renew. '.repeat(4)).join('\n\n');
      writeFileSync(join(root, 'PropA', 'Leases', 'big-lease.txt'), long);
      writeFileSync(join(root, 'PropA', 'Leases', 'Rent Roll -- Dec 2020.txt'), 'rent roll table'); // non-lease → skipped

      process.env.DOCUMENTS_DIR = root;
      process.env.DOCUMENTS_PATH_INCLUDE = '(^|/)Leases(/)';
      process.env.DOCUMENTS_MAX_CHUNKS_PER_DOC = '3';

      const { chunks, docs } = await collectDocChunks();
      expect(docs.length).toBe(1); // rent roll skipped
      expect(docs[0]!.chunks).toBe(3); // capped
      expect(chunks.length).toBe(3);
      expect(chunks.every((c) => c.docName.replace(/\\/g, '/') === 'PropA/Leases/big-lease.txt')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/documents.test.ts -t collectDocChunks`
Expected: FAIL — `collectDocChunks is not exported`.

- [ ] **Step 3: Implement**

In `server/sources/documents.ts`, add (above `buildDocIndex`):

```ts
/**
 * List → extract → chunk the configured corpus (DOCUMENTS_DIR + include/exclude filters), applying
 * the per-document chunk cap. Pure of any embedding/DB work so the offline indexer can batch-embed
 * the result. Returns empty when no (or a missing) DOCUMENTS_DIR.
 */
export async function collectDocChunks(
  dir: string | undefined = process.env.DOCUMENTS_DIR,
): Promise<{ chunks: DocChunk[]; docs: Array<{ name: string; chunks: number }>; truncated: boolean }> {
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) {
    return { chunks: [], docs: [], truncated: false };
  }
  const cap = maxChunksPerDoc();
  const chunks: DocChunk[] = [];
  const docs: Array<{ name: string; chunks: number }> = [];
  const { files, truncated } = listFiles(dir);
  for (const file of files) {
    const docName = file.slice(dir.length).replace(/^[\\/]+/, '');
    const text = await extractFile(file);
    const pieces = chunkText(text).slice(0, cap);
    if (!pieces.length) continue;
    const docId = docName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    pieces.forEach((t, idx) => chunks.push({ docId, docName, idx, text: t }));
    docs.push({ name: docName, chunks: pieces.length });
  }
  return { chunks, docs, truncated };
}
```

Then replace the body of `buildDocIndex` to use it (preserves the existing log + truncation warning + cache shape):

```ts
export async function buildDocIndex(embed: Embedder = realEmbedder): Promise<void> {
  const { chunks, docs, truncated } = await collectDocChunks();
  if (truncated) {
    console.warn(
      `[documents] file cap (${maxFiles()}) reached under ${process.env.DOCUMENTS_DIR} — some documents are NOT indexed; raise DOCUMENTS_MAX_FILES.`,
    );
  }
  const filterNote = process.env.DOCUMENTS_PATH_INCLUDE ? ` matching /${process.env.DOCUMENTS_PATH_INCLUDE}/i` : '';
  console.log(`[documents] indexed ${docs.length} documents (${chunks.length} chunks)${filterNote}`);
  cache = { index: await buildIndex(chunks, embed), docs, builtAt: new Date().toISOString() };
}
```

- [ ] **Step 4: Run tests to verify they pass (full file — confirms the refactor didn't break the existing buildDocIndex test)**

Run: `npx vitest run tests/unit/documents.test.ts`
Expected: PASS (including the pre-existing `buildDocIndex — Leases-only include filter` test).

- [ ] **Step 5: Commit**

```bash
git add server/sources/documents.ts tests/unit/documents.test.ts
git commit -m "refactor(documents): extract collectDocChunks (list/extract/chunk/cap) from buildDocIndex"
```

---

## Task 4: On-disk persisted + batched `buildIndex` + `loadDiskIndex`

**Files:**
- Modify: `server/sources/documents.ts` (`buildIndex`, new `loadDiskIndex`, `docIndexPath`)
- Test: `tests/unit/documents.test.ts`

This is the core fix. `buildIndex` gains an options object: `{ dbPath?, batchSize?, onProgress? }`. When `dbPath` is set it writes a file-backed DB persisting BOTH the vectors (`vec_chunks`) AND the chunk metadata (`chunk_meta`) plus a small `index_info` table (dim + builtAt). Embedding happens in batches, each inserted then dropped — never all-at-once. `loadDiskIndex` reopens that DB and reconstructs a `VecIndex` whose `chunks[i]` aligns with `rowid i`, so `queryIndex` is unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/documents.test.ts` (extend imports with `loadDiskIndex`, `docIndexPath`; `mkdtempSync`/`join`/`rmSync` already imported):

```ts
describe('buildIndex on-disk — persist + reload + batched embedding (fake embedder)', () => {
  it('persists vectors + metadata to disk and reloads into a queryable index', async () => {
    const root = mkdtempSync(join(tmpdir(), 'diskidx-'));
    try {
      const dbPath = join(root, 'doc-index.sqlite');
      const built = await buildIndex(CHUNKS, fakeEmbedder, { dbPath });
      built.close(); // close the writer before reopening

      const { index, docs, builtAt } = loadDiskIndex(dbPath);
      expect(index.chunks.length).toBe(3);
      expect(docs.length).toBe(3); // Tenant 155 LLC, Roof, Rent
      expect(builtAt).toMatch(/\d{4}-\d{2}-\d{2}T/); // ISO timestamp persisted

      const hits = await queryIndex(index, 'renewal', fakeEmbedder, 3);
      expect(hits[0]!.doc).toBe('Tenant 155 LLC Lease.pdf');
      expect(hits[0]!.docId).toBe('tenant 155 llc');
      expect(hits[0]!.snippet.toLowerCase()).toContain('renew');
      index.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('embeds in batches (never one pass) and still ranks correctly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'batchidx-'));
    try {
      const dbPath = join(root, 'doc-index.sqlite');
      const sizes: number[] = [];
      const spy: Embedder = async (texts) => {
        sizes.push(texts.length);
        return fakeEmbedder(texts);
      };
      let lastDone = 0;
      const built = await buildIndex(CHUNKS, spy, {
        dbPath,
        batchSize: 1,
        onProgress: (done, total) => {
          expect(total).toBe(3);
          lastDone = done;
        },
      });
      built.close();
      expect(Math.max(...sizes)).toBeLessThanOrEqual(1); // no single-pass embed of all 3
      expect(lastDone).toBe(3); // progress reached the end

      const { index } = loadDiskIndex(dbPath);
      const hits = await queryIndex(index, 'roof', fakeEmbedder, 3);
      expect(hits[0]!.doc).toBe('Roof Warranty.pdf');
      index.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('docIndexPath defaults under data/ and honors DOC_INDEX_PATH', () => {
    const prev = process.env.DOC_INDEX_PATH;
    try {
      delete process.env.DOC_INDEX_PATH;
      expect(docIndexPath().replace(/\\/g, '/')).toMatch(/\/data\/doc-index\.sqlite$/);
      process.env.DOC_INDEX_PATH = '/tmp/custom-index.sqlite';
      expect(docIndexPath()).toBe('/tmp/custom-index.sqlite');
    } finally {
      process.env.DOC_INDEX_PATH = prev;
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/documents.test.ts -t on-disk`
Expected: FAIL — `loadDiskIndex` / `docIndexPath` not exported and `buildIndex` rejects the 3rd arg.

- [ ] **Step 3: Implement**

In `server/sources/documents.ts`:

(a) Update the import on line 2 to add `dirname`:

```ts
import { dirname, extname, join } from 'node:path';
```

(b) Add a path helper near `maxFiles`/`maxChunksPerDoc`:

```ts
/** On-disk index location (env `DOC_INDEX_PATH`, default `<cwd>/data/doc-index.sqlite`). Gitignored;
 * built offline by `npm run index:docs`, loaded by the Brain Server on start. */
export function docIndexPath(): string {
  return process.env.DOC_INDEX_PATH ?? join(process.cwd(), 'data', 'doc-index.sqlite');
}
```

(c) Replace the `buildIndex` function (lines ~121-131) with the batched, optionally-on-disk version + a private schema helper. Keep `VecIndex`/`DocChunk`/`Embedder` types unchanged:

```ts
/** Create the sqlite-vec table + metadata + info tables on a freshly opened DB. */
function createIndexSchema(db: BetterSQLite3Database, dim: number): void {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[${dim}]);`);
  db.exec(
    `CREATE TABLE IF NOT EXISTS chunk_meta (rowid INTEGER PRIMARY KEY, docId TEXT, docName TEXT, idx INTEGER, text TEXT);`,
  );
  db.exec(`CREATE TABLE IF NOT EXISTS index_info (k TEXT PRIMARY KEY, v TEXT);`);
}

export interface BuildIndexOpts {
  /** When set, build a file-backed DB at this path (persisted). Omit for an in-memory index. */
  dbPath?: string;
  /** Chunks embedded per batch (default = all at once; the offline indexer passes a small batch). */
  batchSize?: number;
  /** Progress callback: (chunksDone, total). */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Build a sqlite-vec index from chunks + their embeddings. In-memory by default; pass `dbPath` to
 * persist BOTH vectors (vec_chunks) and chunk metadata (chunk_meta) to disk so the server can reload
 * it without re-embedding. Embedding is done in batches (each inserted then dropped) so peak memory
 * stays flat — this is what lets the offline indexer build ~thousands of chunks without OOM.
 */
export async function buildIndex(
  chunks: DocChunk[],
  embed: Embedder,
  opts: BuildIndexOpts = {},
): Promise<VecIndex> {
  const { dbPath, onProgress } = opts;
  const batchSize = opts.batchSize && opts.batchSize > 0 ? Math.floor(opts.batchSize) : Math.max(1, chunks.length);
  const db = new Database(dbPath ?? ':memory:');
  sqliteVec.load(db);

  let dim = EMBED_DIM_DEFAULT;
  let schemaReady = false;
  if (chunks.length === 0) {
    createIndexSchema(db, dim);
    schemaReady = true;
  }

  let insVec: ReturnType<BetterSQLite3Database['prepare']> | null = null;
  let insMeta: ReturnType<BetterSQLite3Database['prepare']> | null = null;
  for (let start = 0; start < chunks.length; start += batchSize) {
    const batch = chunks.slice(start, start + batchSize);
    const vectors = await embed(batch.map((c) => c.text));
    if (!schemaReady) {
      dim = vectors[0]?.length ?? EMBED_DIM_DEFAULT;
      createIndexSchema(db, dim);
      insVec = db.prepare('INSERT INTO vec_chunks(rowid, embedding) VALUES (?, ?)');
      insMeta = db.prepare('INSERT INTO chunk_meta(rowid, docId, docName, idx, text) VALUES (?, ?, ?, ?, ?)');
      schemaReady = true;
    }
    const v = insVec!;
    const m = insMeta!;
    const tx = db.transaction(() => {
      batch.forEach((c, j) => {
        const rowid = start + j;
        const vec = vectors[j];
        if (!vec) return;
        v.run(BigInt(rowid), vec);
        m.run(rowid, c.docId, c.docName, c.idx, c.text);
      });
    });
    tx();
    onProgress?.(Math.min(start + batchSize, chunks.length), chunks.length);
    await new Promise<void>((resolve) => setImmediate(resolve)); // yield between batches (memory relief)
  }

  const info = db.prepare('INSERT OR REPLACE INTO index_info(k, v) VALUES (?, ?)');
  info.run('dim', String(dim));
  info.run('builtAt', new Date().toISOString());

  return { db, chunks, dim, close: () => db.close() };
}
```

(d) Add `loadDiskIndex` right after `buildIndex`:

```ts
/** Reopen a persisted on-disk index → a queryable VecIndex (+ docs + builtAt for status). `chunks[i]`
 * is ordered by rowid so it aligns with the vec_chunks rowids queryIndex looks up. */
export function loadDiskIndex(dbPath: string): {
  index: VecIndex;
  docs: Array<{ name: string; chunks: number }>;
  builtAt: string;
} {
  const db = new Database(dbPath);
  sqliteVec.load(db);
  const rows = db
    .prepare('SELECT rowid, docId, docName, idx, text FROM chunk_meta ORDER BY rowid')
    .all() as Array<{ rowid: number; docId: string; docName: string; idx: number; text: string }>;
  const chunks: DocChunk[] = rows.map((r) => ({ docId: r.docId, docName: r.docName, idx: r.idx, text: r.text }));
  const dimRow = db.prepare(`SELECT v FROM index_info WHERE k = 'dim'`).get() as { v: string } | undefined;
  const builtRow = db.prepare(`SELECT v FROM index_info WHERE k = 'builtAt'`).get() as { v: string } | undefined;
  const dim = Number(dimRow?.v ?? EMBED_DIM_DEFAULT);
  const counts = new Map<string, number>();
  for (const c of chunks) counts.set(c.docName, (counts.get(c.docName) ?? 0) + 1);
  const docs = [...counts.entries()].map(([name, n]) => ({ name, chunks: n }));
  return { index: { db, chunks, dim, close: () => db.close() }, docs, builtAt: builtRow?.v ?? '' };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/documents.test.ts`
Expected: PASS (all describes, incl. the new on-disk ones and the pre-existing in-memory `buildIndex / queryIndex` test — note that test calls `buildIndex(CHUNKS, fakeEmbedder)` with no opts, which still works = single batch in-memory).

- [ ] **Step 5: Typecheck (noUncheckedIndexedAccess gate)**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/sources/documents.ts tests/unit/documents.test.ts
git commit -m "feat(documents): persisted on-disk sqlite-vec index + batched buildIndex + loadDiskIndex"
```

---

## Task 5: Server loads on-disk index on start (`warmDocIndex` + `ensureIndex`)

**Files:**
- Modify: `server/sources/documents.ts` (`ensureIndex`, new `warmDocIndex`)
- Modify: `server/index.ts` (call `warmDocIndex` in `main`)
- Modify: `.gitignore`

`ensureIndex` prefers the on-disk DB. `warmDocIndex` (called at startup) loads the disk index if present (fast); if absent but `DOCUMENTS_DIR` is set, it does NOT trigger the big in-process build — it logs guidance to run `npm run index:docs` and serves an empty index (no startup OOM). The agent's `searchDocuments`/`docStatus` contract and `/api/documents*` endpoints are unchanged.

- [ ] **Step 1: Implement `ensureIndex` + `warmDocIndex`**

In `server/sources/documents.ts`, replace `ensureIndex` (the small function near the bottom) with:

```ts
async function ensureIndex() {
  if (cache) return cache;
  const p = docIndexPath();
  if (existsSync(p)) {
    const { index, docs, builtAt } = loadDiskIndex(p);
    cache = { index, docs, builtAt };
    console.log(`[documents] loaded on-disk index — ${docs.length} documents, ${index.chunks.length} chunks (${p})`);
  } else {
    await buildDocIndex(); // in-memory fallback (empty when DOCUMENTS_DIR unset)
  }
  return cache!;
}

/**
 * Startup warm-up. Loads the persisted on-disk index if present (fast, no embedding). If it's absent
 * but a corpus is configured, we deliberately do NOT build the full corpus in-process (that OOM-
 * crashes the box) — we log guidance to run `npm run index:docs` and serve an empty index.
 */
export async function warmDocIndex(): Promise<void> {
  const p = docIndexPath();
  if (existsSync(p)) {
    await ensureIndex();
    return;
  }
  if (process.env.DOCUMENTS_DIR) {
    console.warn(
      `[documents] no on-disk index at ${p} — run \`npm run index:docs\` to build it. Serving an EMPTY document index until then.`,
    );
    cache = { index: await buildIndex([], realEmbedder), docs: [], builtAt: new Date().toISOString() };
  }
  // No DOCUMENTS_DIR → leave cache null; first request lazily builds an empty index (harmless).
}
```

- [ ] **Step 2: Wire into the server**

In `server/index.ts`, update the import on line 17:

```ts
import { searchDocuments, docStatus, warmDocIndex } from './sources/documents';
```

And in `main()` (after `brain.startWatching();`, before `serve(...)`):

```ts
async function main() {
  await brain.refresh('startup');
  brain.startWatching();
  await warmDocIndex();
  serve({ fetch: app.fetch, port: SERVER_PORT, hostname: '127.0.0.1' }, (info) => {
    console.log(`◆ Oxford Brain Server — http://127.0.0.1:${info.port} (localhost only)`);
    console.log(`  Watching: ${brain.getState().workbookPath}`);
  });
}
```

- [ ] **Step 3: Gitignore the on-disk index**

Append to `.gitignore`:

```
# Persisted document RAG index — built offline by `npm run index:docs`, never committed
data/doc-index.sqlite
data/doc-index.sqlite-shm
data/doc-index.sqlite-wal
```

- [ ] **Step 4: Typecheck + full test + lint**

Run: `npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.node.json`
Expected: no errors.
Run: `npx vitest run tests/unit/documents.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/sources/documents.ts server/index.ts .gitignore
git commit -m "feat(documents): load persisted index on start; never full-build in-process"
```

---

## Task 6: Offline indexer script `scripts/index-docs.ts`

**Files:**
- Create: `scripts/index-docs.ts`
- Modify: `package.json` (add `index:docs` script)

- [ ] **Step 1: Create the script**

Create `scripts/index-docs.ts`:

```ts
import { loadEnvFile } from '../server/load-env';
loadEnvFile(); // DOCUMENTS_DIR / DOCUMENTS_PATH_INCLUDE / caps from .env

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { collectDocChunks, buildIndex, realEmbedder, docIndexPath } from '../server/sources/documents';

/**
 * Offline document indexer. Lists → extracts → chunks the configured corpus, then embeds in batches
 * straight to the on-disk sqlite-vec DB at docIndexPath(). Batching + per-batch insert + event-loop
 * yields keep peak memory flat, so this completes on the memory-limited workstation where an
 * all-at-once in-process build OOM-crashes. Run with: `npm run index:docs`.
 */
const BATCH = Number(process.env.DOCUMENTS_EMBED_BATCH) || 48;

async function main(): Promise<void> {
  const dir = process.env.DOCUMENTS_DIR;
  if (!dir) {
    console.error('✗ DOCUMENTS_DIR is not set (.env). Nothing to index.');
    process.exit(1);
  }
  const out = docIndexPath();
  mkdirSync(dirname(out), { recursive: true });
  for (const suffix of ['', '-shm', '-wal']) {
    if (existsSync(out + suffix)) rmSync(out + suffix); // fresh rebuild (vec0 has no simple upsert)
  }

  console.log(`→ Corpus: ${dir}`);
  if (process.env.DOCUMENTS_PATH_INCLUDE) console.log(`  include: /${process.env.DOCUMENTS_PATH_INCLUDE}/i`);
  console.log('→ Listing + extracting + chunking (this reads every PDF once)…');
  const t0 = Date.now();
  const { chunks, docs, truncated } = await collectDocChunks();
  if (truncated) console.warn('  ⚠ file cap reached — raise DOCUMENTS_MAX_FILES if documents are missing.');
  console.log(`  ${docs.length} documents → ${chunks.length} chunks in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (!chunks.length) {
    console.error('✗ No chunks produced — check DOCUMENTS_DIR / DOCUMENTS_PATH_INCLUDE.');
    process.exit(1);
  }

  console.log(`→ Embedding in batches of ${BATCH} → ${out}`);
  const t1 = Date.now();
  let lastLogged = 0;
  const index = await buildIndex(chunks, realEmbedder, {
    dbPath: out,
    batchSize: BATCH,
    onProgress: (done, total) => {
      if (done - lastLogged >= BATCH * 10 || done === total) {
        lastLogged = done;
        const pct = Math.round((100 * done) / total);
        const rate = done / Math.max(1, (Date.now() - t1) / 1000);
        console.log(`  embedded ${done}/${total} (${pct}%) · ${rate.toFixed(0)} chunks/s`);
      }
    },
  });
  index.close();
  console.log(`✓ Index written: ${out} (${chunks.length} chunks, ${((Date.now() - t1) / 1000).toFixed(0)}s)`);
}

void main();
```

- [ ] **Step 2: Add the npm script**

In `package.json` `scripts`, add after `"bake"`:

```json
    "index:docs": "tsx scripts/index-docs.ts",
```

- [ ] **Step 3: Typecheck the script (it's in tsconfig.node.json's `scripts` include)**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add scripts/index-docs.ts package.json
git commit -m "feat(documents): offline batched indexer (npm run index:docs) → persisted on-disk index"
```

---

## Task 7: Gate + incremental build verification (NO full in-process build)

**Files:** none (verification only)

- [ ] **Step 1: Full gate**

Run: `npm run gate`
Expected: typecheck + lint + test + reconcile all green.

- [ ] **Step 2: Tiny-subset offline smoke test (proves the script end-to-end without the full corpus)**

Point the indexer at ONE property's Leases folder with a tight cap, to a throwaway DB path. PowerShell:

```powershell
cd "C:\Users\Owner\oxford-command-center"
$env:DOCUMENTS_DIR = "C:\Users\Owner\OneDrive - Oxford Capital Partners (1)\1100 Rarig"
$env:DOCUMENTS_PATH_INCLUDE = "(^|/)Leases(/)"
$env:DOCUMENTS_MAX_FILES = "8"
$env:DOC_INDEX_PATH = "C:\Users\Owner\oxford-command-center\data\doc-index-smoke.sqlite"
npm run index:docs
```
Expected: lists a handful of docs, embeds to 100%, "✓ Index written". If this completes, the pipeline + batching + persistence all work on the real model. Clean up: `Remove-Item $env:DOC_INDEX_PATH*` and `Remove-Item Env:DOCUMENTS_DIR,Env:DOCUMENTS_PATH_INCLUDE,Env:DOCUMENTS_MAX_FILES,Env:DOC_INDEX_PATH`.

- [ ] **Step 3: Full offline build (the real run — batched, will not OOM)**

```powershell
cd "C:\Users\Owner\oxford-command-center"
$env:DOCUMENTS_DIR = "C:\Users\Owner\OneDrive - Oxford Capital Partners (1)"
$env:DOCUMENTS_PATH_INCLUDE = "(^|/)Leases(/)"
npm run index:docs
```
Expected: ~877 lease docs → a few thousand chunks (non-lease docs dropped, per-doc cap applied), embedding progresses to 100%, "✓ Index written: …data/doc-index.sqlite". The process should EXIT 0 (no `0xC0000409`).

**If the chunk count is still high** (e.g. >8k) or memory feels strained, re-run with a tighter cap — no code change needed:
```powershell
$env:DOCUMENTS_MAX_CHUNKS_PER_DOC = "15"   # then re-run npm run index:docs
```

- [ ] **Step 4: Spot-check queries against the built index (offline, no server)**

Create a throwaway query check (or use a one-off tsx -e). Simplest — a temporary script `scripts/_query-check.ts` (delete after):

```ts
import { loadEnvFile } from '../server/load-env';
loadEnvFile();
import { loadDiskIndex, queryIndex, realEmbedder, docIndexPath } from '../server/sources/documents';
async function main() {
  const { index, docs } = loadDiskIndex(docIndexPath());
  console.log(`loaded ${docs.length} docs / ${index.chunks.length} chunks`);
  for (const q of ['right of first refusal', 'personal guaranty', 'renewal option']) {
    const hits = await queryIndex(index, q, realEmbedder, 3);
    console.log(`\nQ: ${q}`);
    for (const h of hits) console.log(`  [${h.score.toFixed(3)}] ${h.doc} — ${h.snippet.slice(0, 120)}…`);
  }
  index.close();
}
void main();
```
Run: `npx tsx scripts/_query-check.ts`
Expected: each query returns cited passages from actual lease PDFs (doc names are real lease filenames; snippets contain the relevant clause language). Then delete the throwaway: `Remove-Item scripts\_query-check.ts`.

- [ ] **Step 5: Checkpoint with the requester**

Report the chunk count, build time, exit status, and the three query results. Confirm they look right before enabling on the server.

---

## Task 8: Enable on the Brain Server + verify endpoints

**Files:** Modify `.env` (gitignored)

- [ ] **Step 1: Set the corpus env in `.env`**

Edit `C:\Users\Owner\oxford-command-center\.env` — set the (currently empty) `DOCUMENTS_DIR` line and add the include filter (FORWARD SLASHES ONLY in the include — the matcher normalizes separators; backslashes get mangled):

```
DOCUMENTS_DIR=C:\Users\Owner\OneDrive - Oxford Capital Partners (1)
DOCUMENTS_PATH_INCLUDE=(^|/)Leases(/)
```

- [ ] **Step 2: Restart the Brain Server and confirm it loads the on-disk index**

Start the server (per the repo's usual dev command, e.g. `npm run dev:server`). Expected startup log line:
`[documents] loaded on-disk index — <N> documents, <M> chunks (…data/doc-index.sqlite)`
(NOT "no on-disk index" and NOT a long embedding pause — it loads, it does not rebuild.)

- [ ] **Step 3: Hit the endpoints**

```powershell
curl.exe "http://127.0.0.1:8911/api/documents"
curl.exe "http://127.0.0.1:8911/api/documents/search?q=right%20of%20first%20refusal&limit=5"
```
Expected: `/api/documents` shows `configured: true`, the indexed `documents`/`chunks` counts, and `engine: "semantic (all-MiniLM-L6-v2 + sqlite-vec)"`. `/api/documents/search` returns `hits` with real lease `doc` names + cited `snippet`s.

- [ ] **Step 4: Confirm the agent tool path works**

Verify a chat query that routes through `search_documents` (e.g. "what does the lease say about right of first refusal?") returns a cited passage. (The agent's `docSearch` is wired to `searchDocuments` in `server/index.ts:182`.)

- [ ] **Step 5: Final gate**

Run: `npm run gate` and `npm run build`
Expected: both green (the `.env` change is gitignored; no source regressions).

---

## Task 9: PR (ONLY after Gabriel confirms)

- [ ] **Step 1: Push the branch** — `git push -u origin feat/cc-docs-leases-indexing` (CI `gate` runs on push).
- [ ] **Step 2: Open the PR** via `gh pr create` with a body summarizing: corpus tightening (non-lease filter + per-doc cap + coarser chunks), persisted on-disk sqlite-vec index, offline batched `index:docs` builder (the OOM fix), and server load-on-start. Note that `.env` and `data/doc-index.sqlite` are gitignored (not in the diff) and the confidential boundary is the `(^|/)Leases(/)` include filter.
- [ ] **Step 3:** Do NOT merge until CI `gate` is green and Gabriel approves.

---

## Self-Review

**Spec coverage:**
- "Tighten the corpus (skip non-lease by filename / cap chunks-per-doc / tune chunking)" → Tasks 1, 2, 3. ✓
- "Change buildIndex to support on-disk sqlite-vec, persisting vectors AND chunk metadata" → Task 4 (`vec_chunks` + `chunk_meta` + `index_info`). ✓
- "Add scripts/index-docs.ts (npm run index:docs), batched embed, progress, memory yields, writes data/doc-index.sqlite gitignored" → Tasks 6, 5 (gitignore). ✓
- "Brain Server loads on-disk index on start if present; keep searchDocuments/docStatus + /api/documents* working" → Task 5 (`warmDocIndex`, `ensureIndex`; endpoints/agent contract untouched). ✓
- "TDD where logic is pure" → Tasks 1–4 all add unit tests with the fake embedder. ✓
- "noUncheckedIndexedAccess tsc passes; gate green; build succeeds" → typecheck steps in Tasks 4/5/6; Tasks 7/8 run `gate` + `build`. ✓
- "Verify incrementally, never full in-process build" → Task 7 (tiny subset → full offline → query check); `warmDocIndex` refuses the in-process full build. ✓
- "Enable .env (forward-slash include), restart, confirm /documents + search" → Task 8. ✓
- "Push + PR only after confirming with Gabriel" → Task 9 gated. ✓
- Confidentiality: no codename written anywhere; include filter is the boundary; `isExcludedPath` unchanged. ✓

**Type consistency:** `buildIndex(chunks, embed, opts?)` used consistently; `loadDiskIndex` returns `{ index: VecIndex, docs, builtAt }` matching the `cache` shape consumed by `ensureIndex`/`docStatus`; `collectDocChunks` returns `{ chunks, docs, truncated }` consumed by `buildDocIndex` and the script; `chunks[i]` aligns with `rowid i` so `queryIndex` (`index.chunks[Number(r.rowid)]`) is unchanged. ✓

**Placeholder scan:** every code step contains complete code; commands have expected output. ✓
