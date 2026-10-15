// server/sources/doc-index-core.ts
//
// Worker-side document-index operations (item 11, 2026-09-24). Runs inside the doc-index worker thread
// (doc-index-worker.ts) — or in-process behind DOC_INDEX_WORKER=0 / in tests — and is the ONLY code that
// touches the on-disk sqlite-vec file on the server path. Opened read-only + fileMustExist: serving never
// writes the index and never creates an empty one. Unlike the legacy loadDiskIndex it does not hold every
// chunk's text in memory: a query reads just its ≤ limit hit rows by rowid (also more correct than the
// old chunks[rowid] array-index assumption).
import Database, { type Database as BetterSQLite3Database } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { DocIndexInfo, DocIndexRequest, DocIndexResponse, KnnRow } from './doc-index-protocol';

const EMBED_DIM_DEFAULT = 384; // all-MiniLM-L6-v2 — same default as documents.ts
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function readBuiltAt(db: BetterSQLite3Database): string {
  const row = db.prepare(`SELECT v FROM index_info WHERE k = 'builtAt'`).get() as { v: string } | undefined;
  return row?.v ?? '';
}

/** Per-document chunk counts in first-appearance (rowid) order — identical to loadDiskIndex's `docs`. */
export function readIndexInfo(db: BetterSQLite3Database): DocIndexInfo {
  const docs = db
    .prepare('SELECT docName AS name, COUNT(*) AS chunks FROM chunk_meta GROUP BY docName ORDER BY MIN(rowid)')
    .all() as Array<{ name: string; chunks: number }>;
  const dimRow = db.prepare(`SELECT v FROM index_info WHERE k = 'dim'`).get() as { v: string } | undefined;
  return {
    docs,
    chunkCount: docs.reduce((n, d) => n + d.chunks, 0),
    builtAt: readBuiltAt(db),
    dim: Number(dimRow?.v ?? EMBED_DIM_DEFAULT),
  };
}

/** Nearest neighbours → chunk + distance, closest first. Planned-but-unembedded chunks never match. */
export function knn(db: BetterSQLite3Database, vector: Float32Array, limit: number): KnnRow[] {
  const hits = db
    .prepare('SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ? ORDER BY distance LIMIT ?')
    .all(vector, limit) as Array<{ rowid: bigint | number; distance: number }>;
  const meta = db.prepare('SELECT docId, docName, idx, text FROM chunk_meta WHERE rowid = ?');
  const out: KnnRow[] = [];
  for (const h of hits) {
    const m = meta.get(Number(h.rowid)) as { docId: string; docName: string; idx: number; text: string } | undefined;
    if (m) out.push({ chunk: { docId: m.docId, docName: m.docName, idx: m.idx, text: m.text }, distance: h.distance });
  }
  return out;
}

/** sqlite-vec returns a Float32 blob; copy it out (a Buffer view's byteOffset need not be 4-aligned). */
function blobToVector(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}

function l2(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    s += d * d;
  }
  return Math.sqrt(s);
}

/** SQLite allows 999 bound variables per statement by default; stay well under it. */
const SCOPED_NAME_BATCH = 400;

/**
 * Entity-scoped candidates: every EMBEDDED chunk of EXACTLY the named documents (the indexed names, as listed in
 * `DocIndexInfo.docs`; equality, so `%`/`_` are literal), scored by L2 distance to `vector` — exactly the metric
 * the vec0 table uses, so scores stay comparable with `knn`. The caller (doc-rank.ts `pickEntities`) decides which
 * documents; this does no matching of its own. More than `maxChunks` chunks means the caller picked too broad a
 * scope and yields []. Closest first.
 */
export function scopedChunks(db: BetterSQLite3Database, vector: Float32Array, docNames: readonly string[], maxChunks: number): KnnRow[] {
  const names = [...new Set(docNames)].filter((n) => n.length > 0);
  if (names.length === 0 || maxChunks <= 0) return [];
  const rows: Array<{ rowid: number; docId: string; docName: string; idx: number; text: string }> = [];
  for (let i = 0; i < names.length; i += SCOPED_NAME_BATCH) {
    const batch = names.slice(i, i + SCOPED_NAME_BATCH);
    const found = db
      .prepare(`SELECT rowid, docId, docName, idx, text FROM chunk_meta WHERE docName IN (${batch.map(() => '?').join(',')})`)
      .all(...batch) as typeof rows;
    rows.push(...found);
    if (rows.length > maxChunks) return []; // the caller picked too broad a scope
  }
  const getVec = db.prepare('SELECT embedding FROM vec_chunks WHERE rowid = ?');
  const out: KnnRow[] = [];
  for (const r of rows) {
    const v = getVec.get(r.rowid) as { embedding: Buffer } | undefined;
    if (!v) continue; // planned but not yet embedded (resumable build): never matches
    out.push({ chunk: { docId: r.docId, docName: r.docName, idx: r.idx, text: r.text }, distance: l2(vector, blobToVector(v.embedding)) });
  }
  return out.sort((a, b) => a.distance - b.distance);
}

export interface DocIndexHandler {
  /** `emit` is called as soon as each response is ready — the worker posts `opened` BEFORE the
   *  chunk-count scan, so /api/health can report the build time during a cold load. */
  handle(msg: DocIndexRequest, emit: (res: DocIndexResponse) => void): void;
  close(): void;
}

export function createDocIndexHandler(): DocIndexHandler {
  let db: BetterSQLite3Database | null = null;
  const close = (): void => {
    db?.close();
    db = null;
  };
  return {
    handle(msg, emit) {
      switch (msg.type) {
        case 'load': {
          close();
          try {
            const next = new Database(msg.dbPath, { readonly: true, fileMustExist: true });
            try {
              sqliteVec.load(next);
            } catch (e) {
              next.close();
              throw e;
            }
            db = next;
            emit({ type: 'opened', builtAt: readBuiltAt(next) });
            emit({ type: 'loaded', info: readIndexInfo(next) });
          } catch (e) {
            close();
            emit({ type: 'load-error', message: errMsg(e) });
          }
          return;
        }
        case 'knn': {
          if (!db) {
            emit({ type: 'knn-error', id: msg.id, message: 'index not loaded' });
            return;
          }
          try {
            emit({ type: 'knn-result', id: msg.id, rows: knn(db, msg.vector, msg.limit) });
          } catch (e) {
            emit({ type: 'knn-error', id: msg.id, message: errMsg(e) });
          }
          return;
        }
        case 'scoped': {
          if (!db) {
            emit({ type: 'scoped-error', id: msg.id, message: 'index not loaded' });
            return;
          }
          try {
            emit({ type: 'scoped-result', id: msg.id, rows: scopedChunks(db, msg.vector, msg.docNames, msg.maxChunks) });
          } catch (e) {
            emit({ type: 'scoped-error', id: msg.id, message: errMsg(e) });
          }
          return;
        }
        case 'close':
          close();
          return;
      }
    },
    close,
  };
}
