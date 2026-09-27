// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildIndex, docIndexBuiltAt, docStatus, resetDocCacheForTests, searchDocuments, setDocIndexTransportForTests, warmDocIndex,
  type DocChunk, type Embedder,
} from '../../server/sources/documents';
import { inProcessDocIndexTransport } from '../../server/sources/doc-index-client';

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
const prev = { path: process.env.DOC_INDEX_PATH, dir: process.env.DOCUMENTS_DIR, worker: process.env.DOC_INDEX_WORKER };
const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
const roots: string[] = [];
afterEach(() => {
  resetDocCacheForTests();
  setDocIndexTransportForTests(null);
  restore('DOC_INDEX_PATH', prev.path); restore('DOCUMENTS_DIR', prev.dir); restore('DOC_INDEX_WORKER', prev.worker);
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
async function diskIndexAtEnv(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'diwire-')); roots.push(root);
  const p = join(root, 'doc-index.sqlite');
  (await buildIndex(CHUNKS, fakeEmbedder, { dbPath: p })).close();
  process.env.DOC_INDEX_PATH = p;
  delete process.env.DOCUMENTS_DIR;
  return p;
}
function counting() {
  const made: Array<ReturnType<typeof inProcessDocIndexTransport>> = [];
  setDocIndexTransportForTests(() => { const t = inProcessDocIndexTransport(); made.push(t); return t; });
  return made;
}

describe('documents.ts over DocIndexClient (item 11)', () => {
  it('warmDocIndex hands the disk load to the transport and does none of it on the calling tick', async () => {
    await diskIndexAtEnv();
    const made = counting();
    const pending = warmDocIndex();
    expect(made).toHaveLength(1);
    expect(made[0]!.handled).toBe(0); // counted, not timed
    await pending;
    expect(made[0]!.handled).toBe(1);
    expect(docIndexBuiltAt()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('search and status go through the client', async () => {
    await diskIndexAtEnv();
    counting();
    const hits = await searchDocuments('renewal', 3, fakeEmbedder);
    expect(hits[0]).toMatchObject({ doc: 'Eurosort Lease.pdf', docId: 'eurosort', chunkIdx: 0 });
    expect(hits[0]!.snippet.toLowerCase()).toContain('renew');
    expect(hits[0]!.score).toBeGreaterThan(0);
    expect(hits[0]!.score).toBeLessThanOrEqual(1);
    const s = await docStatus();
    expect(s).toMatchObject({ documents: 3, chunks: 3 });
  });

  it('concurrent first callers share ONE load', async () => {
    await diskIndexAtEnv();
    const made = counting();
    await Promise.all([searchDocuments('roof', 1, fakeEmbedder), docStatus(), warmDocIndex()]);
    expect(made).toHaveLength(1);
  });

  it('a failed load rejects, is not cached, and the next call retries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'diwire-bad-')); roots.push(root);
    const bad = join(root, 'doc-index.sqlite');
    writeFileSync(bad, 'not a sqlite database');
    process.env.DOC_INDEX_PATH = bad;
    const made = counting();
    await expect(warmDocIndex()).rejects.toThrow(/doc index load failed/);
    await expect(warmDocIndex()).rejects.toThrow(/doc index load failed/);
    expect(made).toHaveLength(2);
    expect(docIndexBuiltAt()).toBeNull();
  });

  it('DOC_INDEX_WORKER=0 (rollback switch) runs the same protocol in-process', async () => {
    await diskIndexAtEnv();
    setDocIndexTransportForTests(null);
    process.env.DOC_INDEX_WORKER = '0';
    await warmDocIndex();
    expect(docIndexBuiltAt()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await searchDocuments('rent', 1, fakeEmbedder))[0]!.doc).toBe('Rent Schedule.pdf');
  });
});
