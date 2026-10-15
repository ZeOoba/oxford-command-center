// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { afterEach, describe, expect, it } from 'vitest';
import { buildIndex, embedMissing, loadDiskIndex, queryIndex, writeChunkPlan, type DocChunk, type Embedder } from '../../server/sources/documents';
import { createDocIndexHandler, knn, readIndexInfo, scopedChunks, type DocIndexHandler } from '../../server/sources/doc-index-core';
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
const rowsOf = (r: DocIndexResponse | undefined): KnnRow[] => (r && (r.type === 'knn-result' || r.type === 'scoped-result') ? r.rows : []);

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

describe('scopedChunks — every embedded chunk of EXACTLY the named documents, scored against the query', () => {
  const EURO = 'Business\\55 New Plant Court\\Lease Eurosort 10-2022.pdf';
  const COMM = 'Business\\55 New Plant Court\\Eurosort Commission Agreement.docx';
  const IMH = 'Business\\IMH\\IMH Lease.docx';
  const PCT = 'Business\\X\\100%_match.pdf';
  const CORPUS: DocChunk[] = [
    { docId: 'e1', docName: EURO, idx: 0, text: 'Tenant has one option to renew for five years.' },
    { docId: 'e2', docName: EURO, idx: 1, text: 'The roof is the landlord responsibility.' },
    { docId: 'c1', docName: COMM, idx: 0, text: 'Commission rent is 4 percent.' },
    { docId: 'o1', docName: IMH, idx: 0, text: 'Tenant may renew once.' },
    { docId: 'u1', docName: PCT, idx: 0, text: 'Percent sign in a file name.' },
  ];
  async function corpusIndex(): Promise<string> {
    const p = join(tempRoot(), 'doc-index.sqlite');
    (await buildIndex(CORPUS, fakeEmbedder, { dbPath: p })).close();
    return p;
  }
  const names = (rows: KnnRow[]): string[] => rows.map((r) => `${r.chunk.docName.split('\\').pop()}#${r.chunk.idx}`).sort();

  it('returns every chunk of the named documents and nothing else; unknown names and repeats are harmless', async () => {
    const db = openRo(await corpusIndex());
    try {
      const [qv] = await fakeEmbedder(['renewal']);
      expect(names(scopedChunks(db, qv!, [EURO, COMM, EURO, 'Business\\Nope\\missing.pdf', ''], 100))).toEqual([
        'Eurosort Commission Agreement.docx#0',
        'Lease Eurosort 10-2022.pdf#0',
        'Lease Eurosort 10-2022.pdf#1',
      ]);
      expect(scopedChunks(db, qv!, [], 100)).toEqual([]);
    } finally { db.close(); }
  });

  it('distances equal the vector search distances for the same chunks (scores stay comparable), closest first', async () => {
    const db = openRo(await corpusIndex());
    try {
      const [qv] = await fakeEmbedder(['renewal']);
      const viaKnn = new Map(knn(db, qv!, 10).map((r) => [`${r.chunk.docName}#${r.chunk.idx}`, r.distance]));
      const rows = scopedChunks(db, qv!, [EURO, COMM], 100);
      for (const r of rows) expect(r.distance).toBeCloseTo(viaKnn.get(`${r.chunk.docName}#${r.chunk.idx}`)!, 4);
      expect(rows.map((r) => r.distance)).toEqual([...rows.map((r) => r.distance)].sort((a, b) => a - b));
    } finally { db.close(); }
  });

  it('names are matched by equality, never as patterns: "%" and "_" are literal and case matters', async () => {
    const db = openRo(await corpusIndex());
    try {
      const [qv] = await fakeEmbedder(['renewal']);
      expect(scopedChunks(db, qv!, [PCT], 100).map((r) => r.chunk.docId)).toEqual(['u1']);
      expect(scopedChunks(db, qv!, ['Business\\X\\100%'], 100)).toEqual([]); // a prefix is not a match
      expect(scopedChunks(db, qv!, ['Business\\X\\100_match.pdf'], 100)).toEqual([]); // "_" is not a wildcard
      expect(scopedChunks(db, qv!, [EURO.toLowerCase()], 100)).toEqual([]); // exact indexed spelling only
    } finally { db.close(); }
  });

  it('a scope larger than maxChunks yields no pool (the caller picked too broad a scope); exactly at the cap is fine', async () => {
    const db = openRo(await corpusIndex());
    try {
      const [qv] = await fakeEmbedder(['renewal']);
      expect(scopedChunks(db, qv!, [EURO, COMM], 2)).toEqual([]); // 3 chunks
      expect(scopedChunks(db, qv!, [EURO, COMM], 3)).toHaveLength(3);
      expect(scopedChunks(db, qv!, [EURO], 0)).toEqual([]);
    } finally { db.close(); }
  });

  it('handles far more names than SQLite allows bound variables in one statement (batched)', async () => {
    const db = openRo(await corpusIndex());
    try {
      const [qv] = await fakeEmbedder(['renewal']);
      // More names than the bound-variable limit of one statement (999 historically, 32,766 in current SQLite).
      const many = Array.from({ length: 40000 }, (_, i) => `Business\\Filler\\doc ${i}.pdf`);
      expect(names(scopedChunks(db, qv!, [...many.slice(0, 20000), EURO, ...many.slice(20000), IMH], 100))).toEqual([
        'IMH Lease.docx#0',
        'Lease Eurosort 10-2022.pdf#0',
        'Lease Eurosort 10-2022.pdf#1',
      ]);
    } finally { db.close(); }
  });

  it('chunks that were planned but never embedded are not returned', async () => {
    const p = join(tempRoot(), 'doc-index.sqlite');
    writeChunkPlan(p, CHUNKS, 3);
    await embedMissing(p, fakeEmbedder, { batchSize: 1, limit: 2 }); // Eurosort + Roof embedded; Rent planned only
    const db = openRo(p);
    try {
      const [qv] = await fakeEmbedder(['rent']);
      expect(scopedChunks(db, qv!, ['Rent Schedule.pdf'], 100)).toEqual([]); // no vector yet
      expect(scopedChunks(db, qv!, ['Eurosort Lease.pdf'], 100)).toHaveLength(1);
    } finally { db.close(); }
  });

  it('handler: scoped before load → scoped-error; after load → scoped-result with the same rows', async () => {
    const p = await corpusIndex();
    const h = createDocIndexHandler();
    const [qv] = await fakeEmbedder(['renewal']);
    expect(run(h, { type: 'scoped', id: 7, vector: qv!, docNames: [EURO], maxChunks: 100 })).toEqual([
      { type: 'scoped-error', id: 7, message: 'index not loaded' },
    ]);
    run(h, { type: 'load', dbPath: p });
    const [res] = run(h, { type: 'scoped', id: 8, vector: qv!, docNames: [EURO], maxChunks: 100 });
    expect(res).toMatchObject({ type: 'scoped-result', id: 8 });
    expect(rowsOf(res)).toHaveLength(2);
    h.close();
  });
});
