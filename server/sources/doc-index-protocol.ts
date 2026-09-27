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
  | { type: 'close' };

export type DocIndexResponse =
  | { type: 'opened'; builtAt: string }
  | { type: 'loaded'; info: DocIndexInfo }
  | { type: 'load-error'; message: string }
  | { type: 'knn-result'; id: number; rows: KnnRow[] }
  | { type: 'knn-error'; id: number; message: string };
