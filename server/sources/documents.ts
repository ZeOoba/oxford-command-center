import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import Database, { type Database as BetterSQLite3Database } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
// pdf-parse ships no type declarations; the lib/ path avoids its debug-on-import index.
// @ts-expect-error -- no types for pdf-parse
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

/**
 * Document RAG (Phase 3 — semantic) — vector search over lease/PSA/OM text so the agent can
 * answer "what's the renewal option in the Eurosort lease" with a cited passage. Embeddings via
 * transformers.js (Xenova/all-MiniLM-L6-v2, 384-dim, mean-pooled + normalized) stored in an
 * in-memory sqlite-vec index. No API cost; server-only.
 *
 * Graceful: with no DOCUMENTS_DIR (or an empty/missing folder) the index is empty and the agent's
 * search_documents tool reports "no documents indexed". Index runs locally on the Brain Server only
 * (the static mirror has no filesystem); never bundled into the Pages Function.
 *
 * Hard confidentiality guard: the indexer NEVER ingests any path matching the confidential
 * portfolio codename or personal/estate folders — isExcludedPath is applied before extraction.
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

function listFiles(dir: string, depth = 0): string[] {
  if (depth > 4) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full, depth + 1));
    else if (SUPPORTED.has(extname(e.name).toLowerCase())) out.push(full);
    if (out.length > 500) break;
  }
  return out;
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
