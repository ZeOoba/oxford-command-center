// server/sources/doc-index-protocol.ts — messages between the main thread and the doc-index worker
// (item 11, 2026-09-24). The worker owns the sqlite-vec handle; the main thread embeds and shapes hits.
import type { DocChunk } from './documents';

export interface DocIndexInfo {
  docs: Array<{ name: string; chunks: number }>;
  chunkCount: number;
  builtAt: string;
  dim: number;
}

export interface KnnRow {
  chunk: DocChunk;
  distance: number;
}

export type DocIndexRequest =
  | { type: 'load'; dbPath: string }
  | { type: 'knn'; id: number; vector: Float32Array; limit: number }
  /** Every embedded chunk of EXACTLY these documents (indexed names, as listed in `DocIndexInfo.docs`),
   *  scored against `vector`. `maxChunks` bounds the result: more chunks than that → [] (the caller picked
   *  too broad a scope). Entity detection lives in the caller (doc-rank.ts); the worker does no guessing. */
  | { type: 'scoped'; id: number; vector: Float32Array; docNames: string[]; maxChunks: number }
  | { type: 'close' };

export type DocIndexResponse =
  | { type: 'opened'; builtAt: string }
  | { type: 'loaded'; info: DocIndexInfo }
  | { type: 'load-error'; message: string }
  | { type: 'knn-result'; id: number; rows: KnnRow[] }
  | { type: 'knn-error'; id: number; message: string }
  | { type: 'scoped-result'; id: number; rows: KnnRow[] }
  | { type: 'scoped-error'; id: number; message: string };
