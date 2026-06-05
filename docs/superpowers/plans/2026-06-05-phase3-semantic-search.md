# Command Center Phase 3 (⑤) — Semantic Document Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the Fuse.js lexical core of the document RAG with **local embeddings (transformers.js) + sqlite-vec vector search**, so a query like "ROFR" surfaces a "right of first refusal / preferential right to purchase" clause with no shared keywords — preserving the existing `searchDocuments`/`docStatus` agent contract, adding a hard confidentiality/personal **exclusion guard**, and adding an in-module semantic **search UI**. Server-only; no API cost.

**Architecture:** `server/sources/documents.ts` keeps `chunkText` (pure) and `docStatus` shape, but its search core becomes: lazy transformers.js embedder (`Xenova/all-MiniLM-L6-v2`, 384-dim, mean-pooled + normalized) → an in-memory **sqlite-vec** `vec0` index (better-sqlite3) → nearest-neighbor query → cited passages. The **embedder is injectable**, so unit tests run hermetically with a deterministic fake embedder (no model download — `npm run gate` stays fast and offline-safe); a separate **env-gated** test exercises the real model on a ROFR fixture (run locally, skipped in CI). A new `GET /api/documents/search` endpoint + a search box in `DocumentsModule` surface ranked, highlighted, doc-cited passages. **Validated:** the stack (deps `92fa443`) was smoke-tested — the real model ranked an RoFR clause #1 for query "ROFR preferential right to purchase" with zero shared keywords.

**Tech Stack:** Node 24 (ESM), `@huggingface/transformers`, `sqlite-vec` + `better-sqlite3`, Hono, React 19, Vitest, `noUncheckedIndexedAccess` ON.

**Scope decisions (locked):**
- **Fixtures-first** (Gabriel): build + test the engine against synthetic fixtures incl. a ROFR/preferential-right semantic test; `DOCUMENTS_DIR` is wired but pointed at a safe scope later.
- **Hard exclusion guard** (confidentiality): the indexer NEVER ingests any path matching the confidential codename or personal/estate folders — defense-in-depth regardless of `DOCUMENTS_DIR`.
- **Deferred (documented, not built):** page-level citations (pdf-parse exposes no per-page offsets — would need a per-page extractor); entity tags on passages; on-disk vector persistence (index rebuilds in-memory on Brain Server start — fine for the current corpus; re-embedding hundreds of chunks is acceptable, persistence is a later optimization).

## Key facts (from the codebase + stack validation)

- **Contract to preserve:** `searchDocuments(query, limit) => Promise<DocHit[]>` (injected into the agent as `opts.docSearch`) and `docStatus()` (consumed by `/api/documents` + `DocumentsModule`). `chunkText` is pure and stays. The mirror has no filesystem → server-only; nothing client-side imports `documents.ts` (the module fetches `/api/documents`).
- **CI safety:** `npm run gate` runs `vitest`. Unit tests MUST NOT load the real model (slow + network). The embedder is a parameter; tests pass a fake. sqlite-vec + better-sqlite3 ARE used in unit tests (in-memory, native, fast). The real-model test is guarded by `process.env.RUN_MODEL_TESTS` and skipped otherwise.
- **sqlite-vec usage (validated):** `import Database from 'better-sqlite3'; import * as sqliteVec from 'sqlite-vec'; const db = new Database(':memory:'); sqliteVec.load(db); db.exec('CREATE VIRTUAL TABLE v USING vec0(embedding float[384])'); db.prepare('INSERT INTO v(rowid, embedding) VALUES (?, ?)').run(BigInt(i), new Float32Array(vec)); db.prepare('SELECT rowid, distance FROM v WHERE embedding MATCH ? ORDER BY distance LIMIT ?').all(new Float32Array(q), limit)`. **rowid must be bound as `BigInt`.**
- **transformers.js (validated):** `const extract = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2'); const vec = Array.from((await extract(text, { pooling: 'mean', normalize: true })).data);` → 384 numbers.
- **DocumentsModule** today: KPI strip + corpus list + "Ask a document question" button; no in-module search box.

## File Structure

| File | Track | Responsibility |
|---|---|---|
| `server/sources/documents.ts` (modify) | A | Keep `chunkText`; add `isExcludedPath`, `Embedder` type, lazy real embedder, sqlite-vec index helpers; rewrite `buildDocIndex`/`searchDocuments` to vector search; extend `DocHit` with `score`; keep `docStatus` (+ `engine` field) |
| `tests/unit/documents.test.ts` (modify) | A | Keep `chunkText` tests; replace Fuse `searchChunks` tests with index plumbing (fake embedder) + `isExcludedPath` tests; add env-gated real-model ROFR test |
| `server/index.ts` (modify) | B | `GET /api/documents/search?q=&limit=` |
| `src/data/documents.ts` (create) | B | `useDocSearch()` query hook hitting the endpoint |
| `src/modules/documents/DocumentsModule.tsx` (modify) | B | Search box + ranked, highlighted, doc-cited passage results |

---

# TRACK A — Vector search engine

## Task A1: Exclusion guard + DocHit shape (pure, TDD)

**Files:** Modify `server/sources/documents.ts`; modify `tests/unit/documents.test.ts`.

- [ ] **Step 1: Write failing tests.** In `tests/unit/documents.test.ts`, keep the two `chunkText` tests. DELETE the `describe('searchChunks — lexical RAG over passages', ...)` block (Fuse is being removed). Add:

```typescript
import { isExcludedPath } from '../../server/sources/documents';

describe('isExcludedPath — confidentiality / personal guard', () => {
  it('excludes the confidential codename and personal/estate paths (case-insensitive)', () => {
    expect(isExcludedPath('E Fulton Street Due Dilligence Items/Phase II.pdf')).toBe(true);
    expect(isExcludedPath('deals/E. FULTON/psa.pdf')).toBe(true);
    expect(isExcludedPath('Estate Planning and Trust Documents/trust.pdf')).toBe(true);
    expect(isExcludedPath('Gabriel Documents/personal.pdf')).toBe(true);
    expect(isExcludedPath('GDG Properties EG Properties and personal info/x.pdf')).toBe(true);
  });
  it('allows ordinary property lease/PSA paths', () => {
    expect(isExcludedPath('1100 Rarig/Eurosort Lease.pdf')).toBe(false);
    expect(isExcludedPath('29000 Information Lane/Shore United PSA.pdf')).toBe(false);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/documents.test.ts` → FAIL (no `isExcludedPath`).

- [ ] **Step 3: Implement.** In `server/sources/documents.ts`: remove the `import Fuse from 'fuse.js'`, the `searchChunks` function, and the `condense` helper's Fuse coupling (keep `condense` — still used for snippets). Add near the top:

```typescript
/**
 * Confidentiality / personal exclusion guard (defense-in-depth). The indexer NEVER ingests any
 * path matching these — the confidential portfolio codename or personal/estate folders — regardless
 * of what DOCUMENTS_DIR points at. The AI agent searches + quotes this index, so this is a hard gate.
 */
const EXCLUDE_PATTERNS: RegExp[] = [
  /fulton/i,
  /estate planning/i,
  /trust documents/i,
  /gabriel documents/i,
  /gdg properties/i,
  /\bpersonal\b/i,
];
export function isExcludedPath(relPath: string): boolean {
  return EXCLUDE_PATTERNS.some((re) => re.test(relPath));
}
```

Extend `DocHit`:

```typescript
export interface DocHit {
  doc: string;
  snippet: string;
  score: number; // 0..1 similarity (1 = closest); derived from sqlite-vec distance
  docId: string;
  chunkIdx: number;
}
```

- [ ] **Step 4: Run** `npx vitest run tests/unit/documents.test.ts` → the `isExcludedPath` + `chunkText` tests PASS. (Other parts of the file may not yet compile if `searchChunks` was imported elsewhere — fixed in A2/A3. If `npx tsc` fails only on removed `searchChunks` references, proceed; A2 resolves them.)

- [ ] **Step 5: Commit.**

```bash
git add server/sources/documents.ts tests/unit/documents.test.ts
git commit -m "feat(search): confidentiality exclusion guard + scored DocHit shape"
```

## Task A2: Embedder + sqlite-vec index helpers (TDD with a fake embedder)

**Files:** Modify `server/sources/documents.ts`; modify `tests/unit/documents.test.ts`.

- [ ] **Step 1: Write failing tests.** Append to `tests/unit/documents.test.ts`:

```typescript
import { type DocChunk, type Embedder, buildIndex, queryIndex } from '../../server/sources/documents';

// Deterministic fake embedder: 3-dim vectors keyed on simple token presence — no model, fully hermetic.
const fakeEmbedder: Embedder = async (texts) =>
  texts.map((t) => {
    const l = t.toLowerCase();
    return new Float32Array([
      l.includes('renew') ? 1 : 0,
      l.includes('roof') ? 1 : 0,
      l.includes('rent') ? 1 : 0,
    ]);
  });

const CHUNKS: DocChunk[] = [
  { docId: 'eurosort', docName: 'Eurosort Lease.pdf', idx: 0, text: 'Tenant has one option to renew for five years (the renewal option).' },
  { docId: 'roof', docName: 'Roof Warranty.pdf', idx: 0, text: 'The membrane roof carries a 20-year warranty.' },
  { docId: 'rent', docName: 'Rent Schedule.pdf', idx: 0, text: 'Base rent escalates 3% annually.' },
];

describe('buildIndex / queryIndex — sqlite-vec vector search (fake embedder)', () => {
  it('ranks the semantically nearest chunk first and shapes a cited, scored DocHit', async () => {
    const index = await buildIndex(CHUNKS, fakeEmbedder);
    const hits = await queryIndex(index, 'renewal', fakeEmbedder, 3);
    expect(hits[0]!.doc).toBe('Eurosort Lease.pdf');
    expect(hits[0]!.docId).toBe('eurosort');
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score); // closer = higher score
    expect(hits[0]!.snippet.toLowerCase()).toContain('renew');
    index.close();
  });

  it('returns nothing for an empty query or empty index', async () => {
    const empty = await buildIndex([], fakeEmbedder);
    expect(await queryIndex(empty, 'renewal', fakeEmbedder, 3)).toEqual([]);
    empty.close();
    const index = await buildIndex(CHUNKS, fakeEmbedder);
    expect(await queryIndex(index, '   ', fakeEmbedder, 3)).toEqual([]);
    index.close();
  });
});
```

- [ ] **Step 2: Run** → FAIL (no `buildIndex`/`queryIndex`/`Embedder`).

- [ ] **Step 3: Implement.** Add to `server/sources/documents.ts`:

```typescript
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const EMBED_DIM_DEFAULT = 384; // all-MiniLM-L6-v2

/** Embeds a batch of texts → unit vectors. Injectable so tests run without the model. */
export type Embedder = (texts: string[]) => Promise<Float32Array[]>;

export interface VecIndex {
  db: import('better-sqlite3').Database;
  chunks: DocChunk[]; // rowid i ↔ chunks[i]
  dim: number;
  close: () => void;
}

/** Build an in-memory sqlite-vec index from chunks + their embeddings. */
export async function buildIndex(chunks: DocChunk[], embed: Embedder): Promise<VecIndex> {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  const vectors = chunks.length ? await embed(chunks.map((c) => c.text)) : [];
  const dim = vectors[0]?.length ?? EMBED_DIM_DEFAULT;
  db.exec(`CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding float[${dim}]);`);
  const ins = db.prepare('INSERT INTO vec_chunks(rowid, embedding) VALUES (?, ?)');
  vectors.forEach((v, i) => ins.run(BigInt(i), v));
  return { db, chunks, dim, close: () => db.close() };
}

/** Nearest-neighbor query → cited, scored passages (closest first). */
export async function queryIndex(index: VecIndex, query: string, embed: Embedder, limit = 5): Promise<DocHit[]> {
  const q = query.trim();
  if (!q || index.chunks.length === 0) return [];
  const [qv] = await embed([q]);
  if (!qv) return [];
  const rows = index.db
    .prepare('SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ? ORDER BY distance LIMIT ?')
    .all(qv, limit) as Array<{ rowid: bigint | number; distance: number }>;
  const hits: DocHit[] = [];
  for (const r of rows) {
    const chunk = index.chunks[Number(r.rowid)];
    if (!chunk) continue;
    hits.push({
      doc: chunk.docName,
      snippet: condense(chunk.text, q),
      score: 1 / (1 + r.distance), // distance→similarity (monotonic, 0..1)
      docId: chunk.docId,
      chunkIdx: chunk.idx,
    });
  }
  return hits;
}
```

- [ ] **Step 4: Run** `npx vitest run tests/unit/documents.test.ts` → PASS. Then `npx tsc --noEmit -p tsconfig.json` and `npm run typecheck` (server tsconfig) → 0 errors.

- [ ] **Step 5: Commit.**

```bash
git add server/sources/documents.ts tests/unit/documents.test.ts
git commit -m "feat(search): sqlite-vec index build + nearest-neighbor query (injectable embedder)"
```

## Task A3: Wire the real embedder + rewrite buildDocIndex/searchDocuments

**Files:** Modify `server/sources/documents.ts`; modify `tests/unit/documents.test.ts` (env-gated real-model test).

- [ ] **Step 1: Implement the lazy real embedder + rewire.** Add:

```typescript
import { pipeline } from '@huggingface/transformers';

let _extractor: Awaited<ReturnType<typeof pipeline>> | null = null;
/** Lazy singleton transformers.js embedder (Xenova/all-MiniLM-L6-v2). No API cost; server-only. */
export const realEmbedder: Embedder = async (texts) => {
  if (!_extractor) _extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  const out: Float32Array[] = [];
  for (const t of texts) {
    const r = await _extractor(t, { pooling: 'mean', normalize: true });
    out.push(Float32Array.from(r.data as Iterable<number>));
  }
  return out;
};
```

Replace the module cache + `buildDocIndex`/`ensureIndex`/`searchDocuments` so they use `buildIndex`/`queryIndex` with `realEmbedder`, applying `isExcludedPath` during file listing. `buildDocIndex` becomes:

```typescript
let cache: { index: VecIndex | null; docs: Array<{ name: string; chunks: number }>; builtAt: string } | null = null;

export async function buildDocIndex(embed: Embedder = realEmbedder): Promise<void> {
  const dir = process.env.DOCUMENTS_DIR;
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) {
    cache = { index: await buildIndex([], embed), docs: [], builtAt: new Date().toISOString() };
    return;
  }
  const chunks: DocChunk[] = [];
  const docs: Array<{ name: string; chunks: number }> = [];
  for (const file of listFiles(dir)) {
    const docName = file.slice(dir.length).replace(/^[\\/]+/, '');
    if (isExcludedPath(docName)) continue; // confidentiality / personal guard
    const text = await extractFile(file);
    const pieces = chunkText(text);
    if (!pieces.length) continue;
    const docId = docName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    pieces.forEach((t, idx) => chunks.push({ docId, docName, idx, text: t }));
    docs.push({ name: docName, chunks: pieces.length });
  }
  cache = { index: await buildIndex(chunks, embed), docs, builtAt: new Date().toISOString() };
}

async function ensureIndex() {
  if (!cache) await buildDocIndex();
  return cache!;
}

export async function searchDocuments(query: string, limit = 5): Promise<DocHit[]> {
  const { index } = await ensureIndex();
  if (!index) return [];
  return queryIndex(index, query, realEmbedder, limit);
}
```

Update `docStatus` to report `chunks` from `index.chunks.length` and add an `engine: 'semantic (all-MiniLM-L6-v2 + sqlite-vec)'` field:

```typescript
export async function docStatus(): Promise<{ configured: boolean; dir: string | null; documents: number; chunks: number; engine: string; docs: Array<{ name: string; chunks: number }>; builtAt: string }> {
  const { index, docs, builtAt } = await ensureIndex();
  return { configured: !!process.env.DOCUMENTS_DIR, dir: process.env.DOCUMENTS_DIR ?? null, documents: docs.length, chunks: index?.chunks.length ?? 0, engine: 'semantic (all-MiniLM-L6-v2 + sqlite-vec)', docs: docs.slice(0, 50), builtAt };
}
```

- [ ] **Step 2: Add the env-gated real-model semantic test.** Append to `tests/unit/documents.test.ts`:

```typescript
import { realEmbedder } from '../../server/sources/documents';

// Real-model semantic proof. Skipped in CI (no model download in `gate`); run locally with
// RUN_MODEL_TESTS=1 npx vitest run tests/unit/documents.test.ts
const maybe = process.env.RUN_MODEL_TESTS ? describe : describe.skip;
maybe('semantic retrieval (real all-MiniLM-L6-v2)', () => {
  it('finds the ROFR clause from a no-keyword-overlap query', async () => {
    const chunks: DocChunk[] = [
      { docId: 'a', docName: 'Lease A.pdf', idx: 0, text: 'Tenant shall have a right of first refusal to purchase the Premises on the same terms offered by a bona fide third party.' },
      { docId: 'b', docName: 'Lease B.pdf', idx: 0, text: 'Base rent shall escalate three percent on each anniversary of the commencement date.' },
      { docId: 'c', docName: 'Lease C.pdf', idx: 0, text: 'Landlord maintains the roof, foundation, and structural elements.' },
    ];
    const index = await buildIndex(chunks, realEmbedder);
    const hits = await queryIndex(index, 'ROFR preferential right to purchase', realEmbedder, 3);
    expect(hits[0]!.docId).toBe('a');
    index.close();
  }, 60_000);
});
```

- [ ] **Step 3: Verify.** `npx vitest run tests/unit/documents.test.ts` (real-model test SKIPS) → PASS. `npm run typecheck` → 0. Then run the real-model test locally: `RUN_MODEL_TESTS=1 npx vitest run tests/unit/documents.test.ts` → all PASS incl. ROFR.

- [ ] **Step 4: Confirm `search_documents` agent wiring still compiles.** `server/ai/agent.ts` calls `opts.docSearch(q, 5)` and `server/index.ts` passes `docSearch: searchDocuments`. The `DocHit` shape gained fields (additive) — the agent maps `{doc, snippet}`; confirm no type break. Run `npm run typecheck`.

- [ ] **Step 5: Commit.**

```bash
git add server/sources/documents.ts tests/unit/documents.test.ts
git commit -m "feat(search): transformers.js embeddings replace Fuse; exclusion-filtered indexing"
```

## Task A4: Gate + build safety

- [ ] **Step 1:** `npm run gate` → green (real-model test skipped; unit tests use fake embedder + real in-memory sqlite-vec). Paste summary.
- [ ] **Step 2:** `npm run build` → succeeds. **Confirm the client bundle does not include `better-sqlite3`/`@huggingface/transformers`/`sqlite-vec`** (documents.ts is server-only; nothing under `src/` imports it). If the build tries to bundle them, that means a client import leaked — find and remove it (report BLOCKED if unclear).
- [ ] **Step 3:** Commit nothing (verification only) unless a fix was needed.

---

# TRACK B — In-module semantic search UI

## Task B1: Search endpoint

**Files:** Modify `server/index.ts`.

- [ ] **Step 1: Implement.** The `/api/documents` route exists (calls `docStatus`). Add after it:

```typescript
app.get('/api/documents/search', async (c) => {
  const q = c.req.query('q') ?? '';
  const limit = Math.min(20, Math.max(1, Number(c.req.query('limit') ?? 8) || 8));
  if (!q.trim()) return c.json({ hits: [] });
  const hits = await searchDocuments(q, limit);
  return c.json({ hits });
});
```

Ensure `searchDocuments` is imported in `server/index.ts` (it already is — used for `docSearch`).

- [ ] **Step 2: Verify (fresh server).** `npm run typecheck` → 0. Start the Brain Server fresh; with no `DOCUMENTS_DIR` the index is empty:

```bash
curl -s "http://localhost:8911/api/documents/search?q=renewal%20option" 
# Expected: {"hits":[]}  (empty corpus, no error)
```

- [ ] **Step 3: Commit.**

```bash
git add server/index.ts
git commit -m "feat(search): GET /api/documents/search endpoint"
```

## Task B2: Search box + ranked passages in DocumentsModule

**Files:** Create `src/data/documents.ts`; modify `src/modules/documents/DocumentsModule.tsx`.

- [ ] **Step 1: Client hook.** Create `src/data/documents.ts`:

```typescript
import { useQuery } from '@tanstack/react-query';

export interface DocSearchHit { doc: string; snippet: string; score: number; docId: string; chunkIdx: number; }

async function fetchDocSearch(q: string): Promise<DocSearchHit[]> {
  if (!q.trim()) return [];
  const res = await fetch(`/api/documents/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error('Search unavailable (Brain Server only).');
  const json = (await res.json()) as { hits?: DocSearchHit[] };
  return json.hits ?? [];
}

export function useDocSearch(query: string) {
  return useQuery({
    queryKey: ['doc-search', query],
    queryFn: () => fetchDocSearch(query),
    enabled: query.trim().length > 2,
    staleTime: 60_000,
  });
}
```

- [ ] **Step 2: UI.** In `DocumentsModule.tsx`, add a search box + results card above the corpus list. Add imports: `useState` (already imported), `useDocSearch` from `@/data/documents`. Insert this block between the KPI grid and the "Document Corpus" `Card`:

```tsx
      <DocSearch />
```

And define the component at the bottom of the file (highlights query terms in each snippet):

```tsx
import { useDocSearch } from '@/data/documents';

function highlight(text: string, query: string): ReactNode {
  const terms = query.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (!terms.length) return text;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'ig');
  return text.split(re).map((part, i) =>
    re.test(part) ? <mark key={i} style={{ background: 'var(--accent-quiet)', color: 'var(--accent)', padding: '0 2px', borderRadius: 2 }}>{part}</mark> : <span key={i}>{part}</span>,
  );
}

function DocSearch() {
  const [q, setQ] = useState('');
  const { data: hits, isFetching, isError } = useDocSearch(q);
  return (
    <Card>
      <CardHeader title="Semantic Search" trailing={<Badge tone="gold">embeddings + sqlite-vec</Badge>} />
      <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search clauses by meaning — e.g. ROFR, renewal option, environmental indemnity…"
          aria-label="Semantic document search"
          className="num h-9 w-full rounded-[var(--radius-sm)] px-3 text-sm outline-none"
          style={{ background: 'color-mix(in oklab, var(--surface-overlay) 60%, transparent)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
        />
      </div>
      <div className="flex flex-col">
        {isError ? (
          <div className="px-4 py-6 text-sm" style={{ color: 'var(--text-tertiary)' }}>Search runs on the local Brain Server only.</div>
        ) : q.trim().length <= 2 ? (
          <div className="px-4 py-6 text-2xs" style={{ color: 'var(--text-tertiary)' }}>Type a clause concept; results rank by meaning, not keywords.</div>
        ) : isFetching ? (
          <div className="px-4 py-6 text-2xs" style={{ color: 'var(--text-tertiary)' }}>Searching…</div>
        ) : !hits || hits.length === 0 ? (
          <div className="px-4 py-6 text-2xs" style={{ color: 'var(--text-tertiary)' }}>No passages found (or no documents indexed).</div>
        ) : (
          hits.map((h) => (
            <div key={`${h.docId}-${h.chunkIdx}`} className="px-4 py-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-2xs font-semibold" style={{ color: 'var(--text-secondary)' }}>{h.doc}</span>
                <span className="num text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{(h.score * 100).toFixed(0)}% match</span>
              </div>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--text-primary)' }}>{highlight(h.snippet, q)}</p>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
```

- [ ] **Step 2b:** Adjust the KPI strip's "Search" stat — change its `format` to read `'In-app + Ask'` (search is now also in-module). Minor copy tweak.

- [ ] **Step 3: Verify.** `npx tsc --noEmit -p tsconfig.json` → 0; `npx eslint src/modules/documents/DocumentsModule.tsx src/data/documents.ts` → clean.

- [ ] **Step 4: Commit.**

```bash
git add src/data/documents.ts src/modules/documents/DocumentsModule.tsx
git commit -m "feat(search): in-module semantic search box with ranked, highlighted passages"
```

## Task B3: Verify end-to-end (fresh server, real model, temp fixtures)

- [ ] **Step 1:** Create a throwaway fixtures dir with 2–3 `.txt` clause files (one containing "right of first refusal", one rent escalation, one roof). Start the Brain Server fresh with `DOCUMENTS_DIR` set to it: `DOCUMENTS_DIR=<tmp> node_modules\.bin\tsx server/index.ts`. (First search triggers the model load + embedding.)
- [ ] **Step 2:** `curl "http://localhost:8911/api/documents/search?q=ROFR"` → the right-of-first-refusal file ranks first. `curl http://localhost:8911/api/documents` → `engine` shows the semantic engine + chunk count.
- [ ] **Step 3:** In a fresh browser session, open `/documents`, type "ROFR" / "renewal option" in the search box → ranked passages with highlighted terms + doc name + % match. No console errors.
- [ ] **Step 4:** Delete the throwaway fixtures dir; confirm `git status` clean (fixtures were outside the repo or under gitignored `data/`).

---

# Final verification

- [ ] `npm run gate` green (real-model test skipped). `RUN_MODEL_TESTS=1 npx vitest run tests/unit/documents.test.ts` green locally (ROFR proof).
- [ ] `npm run build` succeeds; server-only deps not in the client bundle.
- [ ] `git status --porcelain` clean; `data/` gitignored.
- [ ] **Confidentiality:** `isExcludedPath` unit-tested to block the confidential codename + personal/estate folders; no confidential codename string committed in any new source/test/doc (the test references the codename only as an exclusion assertion — ensure the plan/docs use generic wording; the test file asserting the guard is acceptable as it is the guard's proof, but prefer a neutral fixture path like `'deals/CONFIDENTIAL-DEAL/psa.pdf'` + `/confidential-deal/i` if you want zero literal codename — **decision: use the literal in the test guard since it must match the real folder name; it is an internal test, never an external artifact**).
- [ ] Final review vs Phase 3 ⑤ design: embeddings replace Fuse ✓, sqlite-vec vector store ✓, built when DOCUMENTS_DIR set + graceful empty ✓, ranked passages w/ doc citation + highlight ✓ (page citation + entity tags deferred, documented), agent `search_documents` contract preserved ✓, server-only ✓.
- [ ] **Push + PR — pause for Gabriel's confirmation first.**

## Self-review notes
- **Contract preserved:** `searchDocuments`/`docStatus` signatures intact (DocHit additively extended); agent + `/api/documents` unaffected.
- **CI-safe:** unit tests inject a fake embedder (no model download); real-model test env-gated. sqlite-vec/better-sqlite3 run in-memory in tests (fast, native installed).
- **Confidentiality:** hard `isExcludedPath` guard applied in `buildDocIndex` before any file is read/embedded; unit-tested.
- **`noUncheckedIndexedAccess`:** `index.chunks[Number(r.rowid)]` guarded with `if (!chunk) continue`; `vectors[0]?.length`; `[qv]` destructure guarded with `if (!qv) return []`; test array access uses `!`.
- **Deferred (documented):** page citations, entity tags, on-disk vector persistence.
