import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { extname, join } from 'node:path';
import Database, { type Database as BetterSQLite3Database } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
// pdf-parse ships no type declarations; the lib/ path avoids its debug-on-import index.
// @ts-expect-error -- no types for pdf-parse
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

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
  /trust documents/i,
  /gabriel documents/i,
  /gdg properties/i,
  /\bpersonal\b/i,
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

const SUPPORTED = new Set(['.pdf', '.txt', '.md']);
const CHUNK = 900;
const OVERLAP = 150;
const EMBED_DIM_DEFAULT = 384; // all-MiniLM-L6-v2

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
    if (ext === '.pdf') return (await pdfParse(readFileSync(path))).text;
    if (ext === '.txt' || ext === '.md') return readFileSync(path, 'utf8');
  } catch {
    /* unreadable/corrupt file → skip */
  }
  return '';
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

/** Max files to index before stopping (env `DOCUMENTS_MAX_FILES`, default 2000). Truncation is
 * reported (never silent) so a too-small cap is visible in the logs. */
export function maxFiles(): number {
  const n = Number(process.env.DOCUMENTS_MAX_FILES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2000;
}

/** Pure: should a relative file path be indexed? Supported extension + (optional) include filter.
 * Path separators are normalized to `/` before matching so the include pattern is OS-agnostic
 * (write `(^|/)Leases(/)` regardless of Windows `\` vs POSIX `/`). */
export function matchesIndexFilters(relPath: string, includeRe: RegExp | null): boolean {
  if (!SUPPORTED.has(extname(relPath).toLowerCase())) return false;
  const norm = relPath.replace(/\\/g, '/');
  if (includeRe && !includeRe.test(norm)) return false;
  if (isLikelyNonLease(norm)) return false;
  return true;
}

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
): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || files.length >= max) return;
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
      if (e.isDirectory()) walk(full, depth + 1);
      else if (matchesIndexFilters(rel, includeRe)) files.push(full);
    }
  };
  walk(root, 0);
  return { files, truncated };
}

let cache: { index: VecIndex | null; docs: Array<{ name: string; chunks: number }>; builtAt: string } | null = null;

export async function buildDocIndex(embed: Embedder = realEmbedder): Promise<void> {
  const dir = process.env.DOCUMENTS_DIR;
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) {
    cache = { index: await buildIndex([], embed), docs: [], builtAt: new Date().toISOString() };
    return;
  }
  const chunks: DocChunk[] = [];
  const docs: Array<{ name: string; chunks: number }> = [];
  const { files, truncated } = listFiles(dir); // exclusion + include filter applied here
  for (const file of files) {
    const docName = file.slice(dir.length).replace(/^[\\/]+/, '');
    const text = await extractFile(file);
    const pieces = chunkText(text);
    if (!pieces.length) continue;
    const docId = docName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    pieces.forEach((t, idx) => chunks.push({ docId, docName, idx, text: t }));
    docs.push({ name: docName, chunks: pieces.length });
  }
  if (truncated) {
    console.warn(
      `[documents] file cap (${maxFiles()}) reached under ${dir} — some documents are NOT indexed; raise DOCUMENTS_MAX_FILES.`,
    );
  }
  const filterNote = process.env.DOCUMENTS_PATH_INCLUDE ? ` matching /${process.env.DOCUMENTS_PATH_INCLUDE}/i` : '';
  console.log(`[documents] indexed ${docs.length} documents (${chunks.length} chunks)${filterNote} from ${dir}`);
  cache = { index: await buildIndex(chunks, embed), docs, builtAt: new Date().toISOString() };
}

async function ensureIndex() {
  if (!cache) await buildDocIndex();
  return cache!;
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
