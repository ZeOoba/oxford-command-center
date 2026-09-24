import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { extname, join } from 'node:path';
import Database, { type Database as BetterSQLite3Database, type Statement } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { pdfToText } from '../lib/pdf-text';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';

/**
 * Document RAG (Phase 3 — semantic) — vector search over lease/PSA/OM text so the agent can
 * answer "what's the renewal option in the REDACTED-659 lease" with a cited passage. Embeddings via
 * transformers.js (Xenova/all-MiniLM-L6-v2, 384-dim, mean-pooled + normalized) stored in an
 * in-memory sqlite-vec index. No API cost; server-only.
 *
 * Graceful: with no DOCUMENTS_DIR (or an empty/missing folder) the index is empty and the agent's
 * search_documents tool reports "no documents indexed". Index runs locally on the Brain Server only
 * (the static mirror has no filesystem); never bundled into the Pages Function.
 *
 * Hard confidentiality guard: the indexer NEVER ingests any path matching personal/estate folders
 * or the confidential-deal patterns from the gitignored DOCUMENTS_EXCLUDE env var — isExcludedPath
 * is applied before extraction.
 */
export interface DocChunk {
  docId: string;
  docName: string;
  idx: number;
  text: string;
}
export interface DocHit {
  doc: string;
  snippet: string;
  score: number; // 0..1 similarity (1 = closest); derived from sqlite-vec distance
  docId: string;
  chunkIdx: number;
}

/**
 * Confidentiality / personal exclusion guard (defense-in-depth). The indexer NEVER ingests any
 * path matching these — personal/estate folders plus any confidential-deal patterns supplied via
 * the gitignored `DOCUMENTS_EXCLUDE` env var (comma-separated, case-insensitive) — regardless of
 * what DOCUMENTS_DIR points at. Confidential deal codenames live ONLY in env, never in source.
 * The AI agent searches + quotes this index, so this is a hard gate.
 */
const DEFAULT_EXCLUDE: RegExp[] = [
  /estate planning/i,
  /\b(?:gdg|crg) estate\b/i, // "GDG Estate 12-2022 and CRG Estate 03-2023" — precise, won't hit "real estate"
  /trust documents/i,
  /gabriel documents/i,
  /gdg properties/i,
  /(^|[\\/])pictures([\\/]|$)/i, // personal photo tree (no searchable text anyway)
  /\bpersonal\b/i,
  // Personal / family estate & financial material that lives inside otherwise-business folders (the
  // folder allowlist can't separate it). Deliberately precise so business look-alikes STAY indexed:
  // a commercial "Deed of Trust", "Real Estate" tax bills/forms, and the "REDACTED-700"
  // tenant are NOT matched. (2026-06-06 corpus audit: these slipped in via Loans/Muirkirk/Corporate.)
  /revocable trust/i, //         GDG Revocable Trust
  /irrevocable trust/i, //       Eric Goldberg Family Irrevocable Trust
  /private annuity/i,
  /goldberg annuity/i,
  /\beulogy\b/i,
  /\bgdg\b/i, //                 a principal's initials — personal/estate docs (GDG 1031, GDG tax return)
  /\bcrg\b/i,
  /1031 (?:deposit|exchange)/i,
  /tax return/i, //              personal/family-trust tax returns (errs toward privacy per Gabriel)
  /goldberg trust/i, //          family-trust named as a party in business loan/EIN docs. Precise
  /abrams trust/i, //            (adjacent words) so a commercial "Deed of Trust" or the property-
  /\bfam trust\b/i, //           owning "Eric Goldberg Family, LLC" is NOT caught.
  // Raw parcel-screening lead dumps enumerate many parcels incl. confidential/denylisted ones (e.g.
  // the E. Fulton target by address+owner), so keep these spreadsheets out of the searchable corpus.
  /motivated[\s_-]*leads/i,
  /parcel[\s_-]*screen/i,
];

/** Personal/estate defaults + any confidential patterns from `DOCUMENTS_EXCLUDE` (gitignored env). */
export function excludePatterns(): RegExp[] {
  const extra = (process.env.DOCUMENTS_EXCLUDE ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => new RegExp(s, 'i'));
  return [...DEFAULT_EXCLUDE, ...extra];
}

export function isExcludedPath(relPath: string, patterns: RegExp[] = excludePatterns()): boolean {
  return patterns.some((re) => re.test(relPath));
}

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

/** Whether to drop obvious non-lease docs (financials/rent-rolls/disclosures). ON by default so the
 * lease corpus stays clean; set `DOCUMENTS_DROP_NONLEASE=0` for a GENERAL OneDrive corpus where those
 * documents are exactly what you want findable. */
export function dropNonLease(): boolean {
  return (process.env.DOCUMENTS_DROP_NONLEASE ?? '1') !== '0';
}

const SUPPORTED = new Set(['.pdf', '.txt', '.md', '.docx', '.xlsx', '.csv', '.tsv']);
const CHUNK = 1500;
const OVERLAP = 120;
const EMBED_DIM_DEFAULT = 384; // all-MiniLM-L6-v2
/** Skip files larger than this (env `DOCUMENTS_MAX_FILE_MB`, default 25) — memory safety on the box,
 * and a backstop against the giant master workbook ever slipping into the corpus. */
const MAX_FILE_BYTES = (Number(process.env.DOCUMENTS_MAX_FILE_MB) || 25) * 1024 * 1024;

/** Split text into overlapping chunks on paragraph boundaries where possible. Pure. */
export function chunkText(text: string, size = CHUNK, overlap = OVERLAP): string[] {
  const clean = text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const chunks: string[] = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(i + size, clean.length);
    if (end < clean.length) {
      const para = clean.lastIndexOf('\n\n', end);
      const sentence = clean.lastIndexOf('. ', end);
      const brk = Math.max(para, sentence);
      if (brk > i + size * 0.5) end = brk + 1;
    }
    chunks.push(clean.slice(i, end).trim());
    if (end >= clean.length) break;
    i = end - overlap;
  }
  return chunks.filter(Boolean);
}

/** A readable snippet centered on the first query-term hit (wide enough to keep nearby clauses). */
function condense(text: string, query: string, span = 700): string {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const p = lower.indexOf(t);
    if (p >= 0) { at = p; break; }
  }
  if (at < 0) return text.slice(0, span).trim() + (text.length > span ? '…' : '');
  const start = Math.max(0, at - span / 3);
  const end = Math.min(text.length, start + span);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

// ── Embedder type + sqlite-vec index helpers ────────────────────────────────────

/** Embeds a batch of texts → unit vectors. Injectable so tests run without the model. */
export type Embedder = (texts: string[]) => Promise<Float32Array[]>;

export interface VecIndex {
  db: BetterSQLite3Database;
  chunks: DocChunk[]; // rowid i ↔ chunks[i]
  dim: number;
  close: () => void;
}

/** Create the sqlite-vec table + metadata + info tables on a freshly opened DB. */
function createIndexSchema(db: BetterSQLite3Database, dim: number): void {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[${dim}]);`);
  db.exec(
    `CREATE TABLE IF NOT EXISTS chunk_meta (rowid INTEGER PRIMARY KEY, docId TEXT, docName TEXT, idx INTEGER, text TEXT, embedded INTEGER NOT NULL DEFAULT 0);`,
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

  let insVec: Statement<unknown[]> | null = null;
  let insMeta: Statement<unknown[]> | null = null;
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

// ── Resumable, crash-safe on-disk build (Phase A: plan · Phase B: embed missing) ────────────────
// The single-shot buildIndex grows the embedder's native working set across thousands of chunks and
// can OOM on a memory-limited box. The resumable path splits the work: writeChunkPlan persists all
// chunk metadata once (cheap, text only); embedMissing then embeds only not-yet-embedded chunks in
// bounded batches, committing each batch. Run embedMissing repeatedly — ideally in FRESH processes
// (each `npm run index:docs` invocation) — so native memory is fully released between slices. A
// crash loses at most the in-flight batch; the next run resumes from the DB.

/** Phase A — persist every chunk's metadata (no vectors yet) to a fresh on-disk DB with the given
 * embedding dim. Wipes any prior plan/vectors at this path. Low memory: holds text only. */
export function writeChunkPlan(dbPath: string, chunks: DocChunk[], dim: number): void {
  const db = new Database(dbPath);
  try {
    sqliteVec.load(db);
    db.exec('DROP TABLE IF EXISTS vec_chunks;');
    db.exec('DROP TABLE IF EXISTS chunk_meta;');
    db.exec('DROP TABLE IF EXISTS index_info;');
    createIndexSchema(db, dim);
    const insMeta = db.prepare('INSERT INTO chunk_meta(rowid, docId, docName, idx, text, embedded) VALUES (?, ?, ?, ?, ?, 0)');
    const tx = db.transaction(() => {
      chunks.forEach((c, i) => insMeta.run(i, c.docId, c.docName, c.idx, c.text));
    });
    tx();
    const info = db.prepare('INSERT OR REPLACE INTO index_info(k, v) VALUES (?, ?)');
    info.run('dim', String(dim));
    info.run('planned', String(chunks.length));
    info.run('builtAt', new Date().toISOString());
  } finally {
    db.close();
  }
}

/** planned / embedded / remaining counts for a planned on-disk DB. */
export function indexCounts(dbPath: string): { planned: number; embedded: number; remaining: number } {
  const db = new Database(dbPath);
  try {
    const planned = (db.prepare('SELECT COUNT(*) AS n FROM chunk_meta').get() as { n: number }).n;
    const embedded = (db.prepare('SELECT COUNT(*) AS n FROM chunk_meta WHERE embedded = 1').get() as { n: number }).n;
    return { planned, embedded, remaining: planned - embedded };
  } finally {
    db.close();
  }
}

/** Phase B — embed up to `limit` not-yet-embedded chunks (batched, each batch committed), marking
 * them done. Returns { embedded, remaining }. Safe to call repeatedly until remaining === 0. */
export async function embedMissing(
  dbPath: string,
  embed: Embedder,
  opts: { batchSize?: number; limit?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ embedded: number; remaining: number }> {
  const batchSize = opts.batchSize && opts.batchSize > 0 ? Math.floor(opts.batchSize) : 48;
  const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : -1; // -1 = all remaining
  const db = new Database(dbPath);
  try {
    sqliteVec.load(db);
    const total = (db.prepare('SELECT COUNT(*) AS n FROM chunk_meta').get() as { n: number }).n;
    const todo = db
      .prepare('SELECT rowid, text FROM chunk_meta WHERE embedded = 0 ORDER BY rowid LIMIT ?')
      .all(limit) as Array<{ rowid: number; text: string }>;
    const insVec = db.prepare('INSERT OR REPLACE INTO vec_chunks(rowid, embedding) VALUES (?, ?)');
    const markDone = db.prepare('UPDATE chunk_meta SET embedded = 1 WHERE rowid = ?');
    let embedded = (db.prepare('SELECT COUNT(*) AS n FROM chunk_meta WHERE embedded = 1').get() as { n: number }).n;
    for (let s = 0; s < todo.length; s += batchSize) {
      const batch = todo.slice(s, s + batchSize);
      const vectors = await embed(batch.map((b) => b.text));
      const tx = db.transaction(() => {
        batch.forEach((b, j) => {
          const vec = vectors[j];
          if (!vec) return;
          insVec.run(BigInt(b.rowid), vec);
          markDone.run(b.rowid);
        });
      });
      tx();
      embedded += batch.length;
      opts.onProgress?.(embedded, total);
      await new Promise<void>((resolve) => setImmediate(resolve)); // yield (memory relief)
    }
    const remaining = (db.prepare('SELECT COUNT(*) AS n FROM chunk_meta WHERE embedded = 0').get() as { n: number }).n;
    return { embedded: todo.length, remaining };
  } finally {
    db.close();
  }
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

// ── Real embedder (lazy singleton, transformers.js) ─────────────────────────────

let _extractor: FeatureExtractionPipeline | null = null;
/** Lazy singleton transformers.js embedder (Xenova/all-MiniLM-L6-v2). No API cost; server-only. */
export const realEmbedder: Embedder = async (texts) => {
  if (!_extractor) _extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2') as FeatureExtractionPipeline;
  const out: Float32Array[] = [];
  for (const t of texts) {
    const r = await _extractor(t, { pooling: 'mean', normalize: true });
    out.push(Float32Array.from(r.data as Iterable<number>));
  }
  return out;
};

// ── index build (server-only; reads the local DOCUMENTS_DIR) ────────────────────
async function extractFile(path: string): Promise<string> {
  const ext = extname(path).toLowerCase();
  try {
    if (statSync(path).size > MAX_FILE_BYTES) return ''; // oversized → skip (memory safety)
    if (ext === '.pdf') return (await pdfToText(readFileSync(path))).text;
    if (ext === '.txt' || ext === '.md' || ext === '.csv' || ext === '.tsv') return readFileSync(path, 'utf8');
    if (ext === '.docx') return (await mammoth.extractRawText({ path })).value;
    if (ext === '.xlsx') return await extractXlsxText(path);
  } catch {
    /* unreadable/corrupt/locked file → skip */
  }
  return '';
}

/** Best-effort flat text of an .xlsx — sheet names + non-empty cell values — so a rent roll / NOI
 * calc / tax-appeal workbook is findable by meaning. Exported for unit testing. */
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

/**
 * Optional path-include filter from `DOCUMENTS_PATH_INCLUDE` (regex, case-insensitive). When set,
 * only files whose path (relative to DOCUMENTS_DIR) matches are indexed — e.g.
 * `(^|[\\/])Leases([\\/])` to index ONLY the per-property `Leases` folders and nothing else under
 * the root. Unset → index every supported file (original behavior). This keeps a broad DOCUMENTS_DIR
 * (e.g. a whole drive) from sweeping in non-lease and confidential material.
 */
export function pathIncludeRe(): RegExp | null {
  const raw = process.env.DOCUMENTS_PATH_INCLUDE?.trim();
  if (!raw) return null;
  try {
    return new RegExp(raw, 'i');
  } catch {
    return null;
  }
}

/** Top-level folder allowlist (env `DOCUMENTS_INCLUDE_DIRS`, PIPE-separated exact folder names
 * relative to DOCUMENTS_DIR, case-insensitive). Pipe (not comma) because real property folder names
 * contain commas (e.g. "3883 Livingston, LLC"); `|` is illegal in Windows paths so it can never
 * collide. When set, ONLY these top-level directories are descended into — a FAIL-CLOSED scope so a
 * broad DOCUMENTS_DIR (the whole OneDrive) never sweeps in personal/unlisted folders. A loose FILE
 * sitting directly at that same top level is excluded outright too (it can never itself be an
 * allowlisted directory) — see `listFiles`. Unset → walk every top-level dir (legacy) and index
 * top-level loose files too, still subject to excludes. */
export function includeDirs(): Set<string> | null {
  const raw = (process.env.DOCUMENTS_INCLUDE_DIRS ?? '').split('|').map((s) => s.trim()).filter(Boolean);
  return raw.length ? new Set(raw.map((s) => s.toLowerCase())) : null;
}

/**
 * Fail-closed pre-reindex confidentiality guard. The offline indexer reads `DOCUMENTS_DIR`, which may
 * point at the whole OneDrive — containing confidential deals and personal/estate
 * material. To prevent an UNSCOPED sweep (the 2026-06-06 incident: the entire drive was indexed with
 * neither the allowlist nor `DOCUMENTS_EXCLUDE` set, embedding ~99 confidential due-diligence docs), the indexer
 * refuses to run unless the confidentiality controls are configured:
 *   - `DOCUMENTS_EXCLUDE` (confidential-deal patterns) MUST be non-empty, AND
 *   - the corpus MUST be scoped — either `DOCUMENTS_INCLUDE_DIRS` (allowlist) or `DOCUMENTS_PATH_INCLUDE`.
 * Returns a human-readable reason to abort, or `null` when safe. Override with `DOCUMENTS_ALLOW_UNSCOPED=1`
 * (the caller logs it — never silent) for a deliberately narrow / non-confidential corpus.
 */
export function reindexSafetyError(env: NodeJS.ProcessEnv = process.env): string | null {
  if ((env.DOCUMENTS_ALLOW_UNSCOPED ?? '').trim() === '1') return null;
  const hasExclude = (env.DOCUMENTS_EXCLUDE ?? '').split(',').map((s) => s.trim()).filter(Boolean).length > 0;
  const hasAllow = (env.DOCUMENTS_INCLUDE_DIRS ?? '').split('|').map((s) => s.trim()).filter(Boolean).length > 0;
  const hasPathNarrow = (env.DOCUMENTS_PATH_INCLUDE ?? '').trim().length > 0;
  if (!hasExclude) {
    return 'DOCUMENTS_EXCLUDE is empty — refusing to index. The corpus may contain confidential deals; set the exclude patterns (mirror ~/.claude/hooks/confidential-terms.json) or set DOCUMENTS_ALLOW_UNSCOPED=1 to override.';
  }
  if (!hasAllow && !hasPathNarrow) {
    return 'No corpus scoping — set DOCUMENTS_INCLUDE_DIRS (top-level allowlist) or DOCUMENTS_PATH_INCLUDE, or DOCUMENTS_ALLOW_UNSCOPED=1 to override. Refusing a broad unscoped sweep.';
  }
  return null;
}

/** Max files to index before stopping (env `DOCUMENTS_MAX_FILES`, default 2000). Truncation is
 * reported (never silent) so a too-small cap is visible in the logs. */
export function maxFiles(): number {
  const n = Number(process.env.DOCUMENTS_MAX_FILES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2000;
}

/** Max directory recursion depth (env `DOCUMENTS_MAX_DEPTH`, default 6). Raise for deeply nested
 * OneDrive trees. */
export function maxDepth(): number {
  const n = Number(process.env.DOCUMENTS_MAX_DEPTH);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 6;
}

/** Max chunks indexed per document (env `DOCUMENTS_MAX_CHUNKS_PER_DOC`, default 25). Bounds the
 * worst case from a long PDF that slipped past the non-lease filter. */
export function maxChunksPerDoc(): number {
  const n = Number(process.env.DOCUMENTS_MAX_CHUNKS_PER_DOC);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 25;
}

/** On-disk index location (env `DOC_INDEX_PATH`, default `<cwd>/data/doc-index.sqlite`). Gitignored;
 * built offline by `npm run index:docs`, loaded by the Brain Server on start. */
export function docIndexPath(): string {
  return process.env.DOC_INDEX_PATH ?? join(process.cwd(), 'data', 'doc-index.sqlite');
}

/** Pure: should a relative file path be indexed? Supported extension + (optional) include filter.
 * Path separators are normalized to `/` before matching so the include pattern is OS-agnostic
 * (write `(^|/)Leases(/)` regardless of Windows `\` vs POSIX `/`). */
export function matchesIndexFilters(relPath: string, includeRe: RegExp | null, drop = dropNonLease()): boolean {
  if (!SUPPORTED.has(extname(relPath).toLowerCase())) return false;
  const norm = relPath.replace(/\\/g, '/');
  if (includeRe && !includeRe.test(norm)) return false;
  if (drop && isLikelyNonLease(norm)) return false;
  return true;
}

/**
 * Top-level directory names that are transparent to the allowlist scope check — their children are
 * evaluated against `DOCUMENTS_INCLUDE_DIRS` as if they sat directly under `DOCUMENTS_DIR`, instead
 * of being blocked outright for not being in the allowlist themselves. Exists because the 2026-07-17
 * OneDrive Business/Personal split nested the entire business corpus one level deeper, under
 * `Business\`, without moving `DOCUMENTS_DIR` (which stays at OneDrive root so folders that were
 * deliberately left at root, e.g. the unclassified `Muirkirk 2013 Refinancing`, stay reachable too).
 * Deliberately does NOT include `Personal` — that must keep failing the allowlist check outright.
 */
const PASSTHROUGH_TOP_LEVEL_DIRS = new Set(['business']);

/**
 * Recursively collect indexable files under `root`, pruning excluded paths (directories AND files,
 * so e.g. an estate/confidential folder is never descended into) and applying the optional include
 * filter. Stops at `max` files and flags truncation (never silently drops).
 */
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
      return; // unreadable directory → skip
    }
    for (const e of entries) {
      if (files.length >= max) {
        truncated = true;
        return;
      }
      const full = join(dir, e.name);
      const rel = full.slice(root.length).replace(/^[\\/]+/, '');
      if (isExcludedPath(rel, excludes)) continue; // prune excluded dirs + files (defense-in-depth)
      if (e.isDirectory()) {
        const isPassthrough = depth === 0 && PASSTHROUGH_TOP_LEVEL_DIRS.has(e.name.toLowerCase());
        if (depth === 0 && !isPassthrough && allow && !allow.has(e.name.toLowerCase())) continue; // fail-closed top-level scope
        walk(full, isPassthrough ? depth : depth + 1); // passthrough: children re-checked against the allowlist at effective depth 0
      } else {
        // Fail-closed: with an allowlist active, a loose file sitting directly at this effective
        // top level is never itself an allowlisted directory, so it can never pass the scope check
        // above — index it only from inside an allowlisted folder. Applies at any depth the
        // allowlist check applies at (depth 0, or inside a passthrough dir like Business\ which is
        // walked at unchanged depth), not just literal depth 0.
        if (depth === 0 && allow) continue;
        if (matchesIndexFilters(rel, includeRe)) files.push(full);
      }
    }
  };
  walk(root, 0);
  return { files, truncated };
}

// `fromDisk` distinguishes a real, persisted index (builtAt is a meaningful timestamp for freshness
// reporting) from an in-memory fallback/empty index (builtAt is just "when this process stood up a
// placeholder" and must never be reported as the index's actual build time — see docIndexBuiltAt).
let cache: { index: VecIndex | null; docs: Array<{ name: string; chunks: number }>; builtAt: string; fromDisk: boolean } | null = null;

/** Test-only: clear the module-level index cache so a test can start from a known-empty state.
 * Closes any open sqlite handle first — otherwise a Windows temp-dir cleanup right after a
 * disk-loaded-index test EPERMs on the still-open file. */
export function resetDocCacheForTests(): void {
  cache?.index?.close();
  cache = null;
}

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
  const { files, truncated } = listFiles(dir); // exclusion + include filter applied here
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

export async function buildDocIndex(embed: Embedder = realEmbedder): Promise<void> {
  const { chunks, docs, truncated } = await collectDocChunks();
  if (truncated) {
    console.warn(
      `[documents] file cap (${maxFiles()}) reached under ${process.env.DOCUMENTS_DIR} — some documents are NOT indexed; raise DOCUMENTS_MAX_FILES.`,
    );
  }
  const filterNote = process.env.DOCUMENTS_PATH_INCLUDE ? ` matching /${process.env.DOCUMENTS_PATH_INCLUDE}/i` : '';
  console.log(`[documents] indexed ${docs.length} documents (${chunks.length} chunks)${filterNote}`);
  cache = { index: await buildIndex(chunks, embed), docs, builtAt: new Date().toISOString(), fromDisk: false };
}

async function ensureIndex() {
  if (cache) return cache;
  const p = docIndexPath();
  if (existsSync(p)) {
    const { index, docs, builtAt } = loadDiskIndex(p);
    cache = { index, docs, builtAt, fromDisk: true };
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
    cache = { index: await buildIndex([], realEmbedder), docs: [], builtAt: new Date().toISOString(), fromDisk: false };
  }
  // No DOCUMENTS_DIR → leave cache null; first request lazily builds an empty index (harmless).
}

/** The injectable doc searcher handed to the agent (server only). */
export async function searchDocuments(query: string, limit = 5): Promise<DocHit[]> {
  const { index } = await ensureIndex();
  if (!index) return [];
  return queryIndex(index, query, realEmbedder, limit);
}

export async function docStatus(): Promise<{ configured: boolean; dir: string | null; documents: number; chunks: number; engine: string; docs: Array<{ name: string; chunks: number }>; builtAt: string }> {
  const { index, docs, builtAt } = await ensureIndex();
  return { configured: !!process.env.DOCUMENTS_DIR, dir: process.env.DOCUMENTS_DIR ?? null, documents: docs.length, chunks: index?.chunks.length ?? 0, engine: 'semantic (all-MiniLM-L6-v2 + sqlite-vec)', docs: docs.slice(0, 50), builtAt };
}

/** Build time of the loaded index, WITHOUT forcing a load (safe for /api/health). Only a
 * disk-loaded index has a meaningful build time — an in-memory fallback/empty index stamps
 * `builtAt` with "now" purely as a placeholder, which must never read as fresh (I-1, 2026-09-23
 * review). */
export function docIndexBuiltAt(): string | null {
  return cache?.fromDisk ? cache.builtAt : null;
}
