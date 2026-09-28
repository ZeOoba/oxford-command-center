// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildIndex, docIndexBuiltAt, docStatus, resetDocCacheForTests, searchDocuments, setDocIndexTransportForTests, warmDocIndex,
  type DocChunk, type Embedder,
} from '../../server/sources/documents';
import { DOC_INDEX_KNN_TIMEOUT_MS, inProcessDocIndexTransport, type DocIndexTransport } from '../../server/sources/doc-index-client';
import type { DocIndexResponse } from '../../server/sources/doc-index-protocol';
import { DOC_INDEX_FAILURE_COOLDOWN_MS } from '../../server/sources/documents';

const fakeEmbedder: Embedder = async (texts) =>
  texts.map((t) => {
    const l = t.toLowerCase();
    return new Float32Array([l.includes('renew') ? 1 : 0, l.includes('roof') ? 1 : 0, l.includes('rent') ? 1 : 0]);
  });
const CHUNKS: DocChunk[] = [
  { docId: 'REDACTED-659', docName: 'REDACTED-659 Lease.pdf', idx: 0, text: 'Tenant has one option to renew for five years (the renewal option).' },
  { docId: 'roof', docName: 'Roof Warranty.pdf', idx: 0, text: 'The membrane roof carries a 20-year warranty.' },
  { docId: 'rent', docName: 'Rent Schedule.pdf', idx: 0, text: 'Base rent escalates 3% annually.' },
];
const prev = { path: process.env.DOC_INDEX_PATH, dir: process.env.DOCUMENTS_DIR, worker: process.env.DOC_INDEX_WORKER };
const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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
    expect(hits[0]).toMatchObject({ doc: 'REDACTED-659 Lease.pdf', docId: 'REDACTED-659', chunkIdx: 0 });
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

  it('a failed load rejects, is not cached, and retries only after the cooldown', async () => {
    const root = mkdtempSync(join(tmpdir(), 'diwire-bad-')); roots.push(root);
    const bad = join(root, 'doc-index.sqlite');
    writeFileSync(bad, 'not a sqlite database');
    process.env.DOC_INDEX_PATH = bad;
    const made = counting();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(warmDocIndex()).rejects.toThrow(/doc index load failed/);
    await expect(warmDocIndex()).rejects.toThrow(/cooling down/);
    expect(made).toHaveLength(1);
    expect(docIndexBuiltAt()).toBeNull();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + DOC_INDEX_FAILURE_COOLDOWN_MS);
    await expect(warmDocIndex()).rejects.toThrow(/doc index load failed/);
    expect(made).toHaveLength(2);
  });

  it('DOC_INDEX_WORKER=0 (rollback switch) runs the same protocol in-process', async () => {
    await diskIndexAtEnv();
    setDocIndexTransportForTests(null);
    process.env.DOC_INDEX_WORKER = '0';
    await warmDocIndex();
    expect(docIndexBuiltAt()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await searchDocuments('rent', 1, fakeEmbedder))[0]!.doc).toBe('Rent Schedule.pdf');
  });

  describe('a hung-but-alive worker is replaced, behind a short cooldown', () => {
    /** Fake worker: loads instantly; answers knn only when `answer` is true. setImmediate stays real. */
    function fakeWorkers(answer: () => boolean) {
      const made: Array<{ knnSends: number }> = [];
      setDocIndexTransportForTests((): DocIndexTransport => {
        const me = { knnSends: 0 };
        made.push(me);
        let onMsg: ((m: DocIndexResponse) => void) | null = null;
        return {
          send: (msg) => {
            if (msg.type === 'load') {
              setImmediate(() => onMsg?.({ type: 'loaded', info: { docs: [{ name: 'A.pdf', chunks: 1 }], chunkCount: 1, builtAt: '2026-01-01T00:00:00.000Z', dim: 3 } }));
            }
            if (msg.type === 'knn') {
              me.knnSends += 1;
              if (answer()) {
                const id = msg.id;
                setImmediate(() => onMsg?.({ type: 'knn-result', id, rows: [{ chunk: { docId: 'a', docName: 'A.pdf', idx: 0, text: 'alpha renew' }, distance: 0 }] }));
              }
            }
          },
          onMessage: (cb) => {
            onMsg = cb;
          },
          onFailure: () => undefined,
          terminate: async () => undefined,
        };
      });
      return made;
    }
    const tick = () => new Promise<void>((r) => setImmediate(r));
    const settle = async (n = 6) => { for (let i = 0; i < n; i += 1) await tick(); };

    it('first search rejects at the deadline; the cooldown rejects fast; then a fresh client is spawned', async () => {
      await diskIndexAtEnv();
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      let answer = false;
      const made = fakeWorkers(() => answer);

      const first = searchDocuments('renewal', 3, fakeEmbedder);
      first.catch(() => undefined);
      await settle();
      expect(made).toHaveLength(1);
      expect(made[0]!.knnSends).toBe(1);
      vi.advanceTimersByTime(DOC_INDEX_KNN_TIMEOUT_MS);
      await expect(first).rejects.toThrow(/timed out/);
      expect(errorLog).toHaveBeenCalledTimes(1);

      // Inside the cooldown: fast rejection, no respawn, no extra log line.
      vi.advanceTimersByTime(DOC_INDEX_FAILURE_COOLDOWN_MS - 1);
      await expect(searchDocuments('renewal', 3, fakeEmbedder)).rejects.toThrow(/cooling down/);
      await expect(docStatus()).rejects.toThrow(/cooling down/);
      expect(made).toHaveLength(1);
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(docIndexBuiltAt()).toBeNull();

      // Cooldown over: a fresh client answers.
      vi.advanceTimersByTime(1);
      answer = true;
      const hits = await searchDocuments('renewal', 3, fakeEmbedder);
      expect(made).toHaveLength(2);
      expect(made[0]!.knnSends).toBe(1); // the hung client was never reused
      expect(hits[0]).toMatchObject({ doc: 'A.pdf', docId: 'a', score: 1 });
      expect(docIndexBuiltAt()).toBe('2026-01-01T00:00:00.000Z');
    });

    it('a load-error (corrupt index) also starts the cooldown — no worker spawned per request', async () => {
      await diskIndexAtEnv();
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      let spawned = 0;
      setDocIndexTransportForTests((): DocIndexTransport => {
        spawned += 1;
        let onMsg: ((m: DocIndexResponse) => void) | null = null;
        return {
          send: (msg) => {
            if (msg.type === 'load') setImmediate(() => onMsg?.({ type: 'load-error', message: 'file is not a database' }));
          },
          onMessage: (cb) => {
            onMsg = cb;
          },
          onFailure: () => undefined,
          terminate: async () => undefined,
        };
      });

      await expect(searchDocuments('renewal', 3, fakeEmbedder)).rejects.toThrow(/not a database/);
      expect(spawned).toBe(1);
      expect(errorLog).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(DOC_INDEX_FAILURE_COOLDOWN_MS - 1);
      await expect(searchDocuments('renewal', 3, fakeEmbedder)).rejects.toThrow(/cooling down/);
      await expect(docStatus()).rejects.toThrow(/cooling down/);
      expect(spawned).toBe(1);
      expect(errorLog).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1);
      await expect(searchDocuments('renewal', 3, fakeEmbedder)).rejects.toThrow(/not a database/);
      expect(spawned).toBe(2);
    });

    it('DOC_INDEX_WORKER=0 in-process path is unaffected by the cooldown when nothing fails', async () => {
      await diskIndexAtEnv();
      process.env.DOC_INDEX_WORKER = '0';
      expect((await searchDocuments('rent', 1, fakeEmbedder))[0]!.doc).toBe('Rent Schedule.pdf');
      expect((await searchDocuments('roof', 1, fakeEmbedder))[0]!.doc).toBe('Roof Warranty.pdf');
    });
  });
});
