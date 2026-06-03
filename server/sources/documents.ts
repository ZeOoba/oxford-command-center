import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import Fuse from 'fuse.js';
// pdf-parse ships no type declarations; the lib/ path avoids its debug-on-import index.
// @ts-expect-error -- no types for pdf-parse
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

/**
 * Document RAG (Phase 6) — lexical search over lease/PSA/OM text so the agent can answer
 * "what's the renewal option in the REDACTED-659 lease" with a cited passage. Lexical-first (fuse.js,
 * already a dependency) over extracted PDF/text chunks — no embedding provider, no new credential.
 *
 * Graceful: with no DOCUMENTS_DIR (or an empty/missing folder) the index is empty and the agent's
 * search_documents tool reports "no documents indexed". Index runs locally on the Brain Server only
 * (the static mirror has no filesystem); never bundled into the Pages Function.
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
}

const SUPPORTED = new Set(['.pdf', '.txt', '.md']);
const CHUNK = 900;
const OVERLAP = 150;

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

/** Lexical search over chunks; returns top cited passages. Pure (index passed in). */
export function searchChunks(chunks: DocChunk[], query: string, limit = 5): DocHit[] {
  const q = query.trim();
  if (!q || chunks.length === 0) return [];
  const fuse = new Fuse(chunks, { keys: ['text'], includeScore: true, threshold: 0.45, ignoreLocation: true, minMatchCharLength: 3 });
  return fuse
    .search(q)
    .slice(0, limit)
    .map((r) => ({ doc: r.item.docName, snippet: condense(r.item.text, q) }));
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

let cache: { chunks: DocChunk[]; docs: Array<{ name: string; chunks: number }>; builtAt: string } | null = null;

export async function buildDocIndex(): Promise<void> {
  const dir = process.env.DOCUMENTS_DIR;
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) {
    cache = { chunks: [], docs: [], builtAt: new Date().toISOString() };
    return;
  }
  const chunks: DocChunk[] = [];
  const docs: Array<{ name: string; chunks: number }> = [];
  for (const file of listFiles(dir)) {
    const text = await extractFile(file);
    const pieces = chunkText(text);
    if (!pieces.length) continue;
    const docName = file.slice(dir.length).replace(/^[\\/]+/, '');
    const docId = docName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    pieces.forEach((t, idx) => chunks.push({ docId, docName, idx, text: t }));
    docs.push({ name: docName, chunks: pieces.length });
  }
  cache = { chunks, docs, builtAt: new Date().toISOString() };
}

async function ensureIndex() {
  if (!cache) await buildDocIndex();
  return cache!;
}

/** The injectable doc searcher handed to the agent (server only). */
export async function searchDocuments(query: string, limit = 5): Promise<DocHit[]> {
  const { chunks } = await ensureIndex();
  return searchChunks(chunks, query, limit);
}

export async function docStatus(): Promise<{ configured: boolean; dir: string | null; documents: number; chunks: number; docs: Array<{ name: string; chunks: number }>; builtAt: string }> {
  const { chunks, docs, builtAt } = await ensureIndex();
  return { configured: !!process.env.DOCUMENTS_DIR, dir: process.env.DOCUMENTS_DIR ?? null, documents: docs.length, chunks: chunks.length, docs: docs.slice(0, 50), builtAt };
}
