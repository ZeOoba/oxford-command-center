// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { afterEach, describe, expect, it } from 'vitest';
import { buildIndex, embedMissing, loadDiskIndex, queryIndex, writeChunkPlan, type DocChunk, type Embedder } from '../../server/sources/documents';
import { createDocIndexHandler, knn, readIndexInfo, type DocIndexHandler } from '../../server/sources/doc-index-core';
import type { DocIndexRequest, DocIndexResponse, KnnRow } from '../../server/sources/doc-index-protocol';

// Same deterministic 3-dim fake embedder + corpus as tests/unit/documents.test.ts.
const fakeEmbedder: Embedder = async (texts) =>
  texts.map((t) => {
    const l = t.toLowerCase();
    return new Float32Array([l.includes('renew') ? 1 : 0, l.includes('roof') ? 1 : 0, l.includes('rent') ? 1 : 0]);
  });
const CHUNKS: DocChunk[] = [
  { docId: 'eurosort', docName: 'Eurosort Lease.pdf', idx: 0, text: 'Tenant has one option to renew for five years (the renewal option).' },
  { docId: 'roof', docName: 'Roof Warranty.pdf', idx: 0, text: 'The membrane roof carries a 20-year warranty.' },
  { docId: 'rent', docName: 'Rent Schedule.pdf', idx: 0, text: 'Base rent escalates 3% annually.' },
];

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function tempRoot(): string { const r = mkdtempSync(join(tmpdir(), 'dicore-')); roots.push(r); return r; }
async function diskIndex(): Promise<string> {
  const p = join(tempRoot(), 'doc-index.sqlite');
  (await buildIndex(CHUNKS, fakeEmbedder, { dbPath: p })).close();
  return p;
}
function openRo(p: string) { const db = new Database(p, { readonly: true, fileMustExist: true }); sqliteVec.load(db); return db; }
function run(h: DocIndexHandler, msg: DocIndexRequest): DocIndexResponse[] { const out: DocIndexResponse[] = []; h.handle(msg, (r) => out.push(r)); return out; }
const rowsOf = (r: DocIndexResponse | undefined): KnnRow[] => (r && r.type === 'knn-result' ? r.rows : []);

describe('doc-index-core — worker-side ops match the in-process path', () => {
  it('readIndexInfo equals loadDiskIndex docs / chunk count / builtAt', async () => {
    const p = await diskIndex();
    const legacy = loadDiskIndex(p);
    const db = openRo(p);
    try {
      const info = readIndexInfo(db);
      expect(info.docs).toEqual(legacy.docs);
      expect(info.chunkCount).toBe(legacy.index.chunks.length);
      expect(info.builtAt).toBe(legacy.builtAt);
      expect(info.dim).toBe(3);
    } finally { db.close(); legacy.index.close(); }
  });

  it('knn returns the same ranking as queryIndex', async () => {
    const p = await diskIndex();
    const legacy = loadDiskIndex(p);
    const db = openRo(p);
    try {
      const [qv] = await fakeEmbedder(['renewal']);
      const rows = knn(db, qv!, 3);
      const hits = await queryIndex(legacy.index, 'renewal', fakeEmbedder, 3);
      expect(rows.map((r) => r.chunk.docName)).toEqual(hits.map((h) => h.doc));
      expect(rows[0]!.chunk).toEqual(CHUNKS[0]);
    } finally { db.close(); legacy.index.close(); }
  });

  it('handler: knn before load → knn-error; load → opened then loaded; knn → knn-result; close is idempotent', async () => {
    const p = await diskIndex();
    const h = createDocIndexHandler();
    const [qv] = await fakeEmbedder(['roof']);
    expect(run(h, { type: 'knn', id: 1, vector: qv!, limit: 3 })).toEqual([{ type: 'knn-error', id: 1, message: 'index not loaded' }]);
    expect(run(h, { type: 'load', dbPath: p }).map((r) => r.type)).toEqual(['opened', 'loaded']);
    const [res] = run(h, { type: 'knn', id: 2, vector: qv!, limit: 1 });
    expect(res).toMatchObject({ type: 'knn-result', id: 2 });
    expect(rowsOf(res)[0]!.chunk.docName).toBe('Roof Warranty.pdf');
    expect(run(h, { type: 'close' })).toEqual([]);
    h.close();
  });

  it('a missing file is a load-error and is never created', () => {
    const missing = join(tempRoot(), 'nope.sqlite');
    const res = run(createDocIndexHandler(), { type: 'load', dbPath: missing });
    expect(res.map((r) => r.type)).toEqual(['load-error']);
    expect(existsSync(missing)).toBe(false);
  });

  it('a partially-embedded (resumable) index counts every planned chunk and only returns embedded ones', async () => {
    const p = join(tempRoot(), 'doc-index.sqlite');
    writeChunkPlan(p, CHUNKS, 3);
    await embedMissing(p, fakeEmbedder, { batchSize: 1, limit: 2 }); // Eurosort + Roof embedded; Rent planned only
    const h = createDocIndexHandler();
    const loaded = run(h, { type: 'load', dbPath: p })[1];
    expect(loaded).toMatchObject({ type: 'loaded', info: { chunkCount: 3 } });
    const [qv] = await fakeEmbedder(['rent']);
    expect(rowsOf(run(h, { type: 'knn', id: 1, vector: qv!, limit: 3 })[0]).map((r) => r.chunk.docName).sort()).toEqual(['Eurosort Lease.pdf', 'Roof Warranty.pdf']);
    h.close();
  });
});
