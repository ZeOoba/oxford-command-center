// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildIndex, type DocChunk, type Embedder } from '../../server/sources/documents';
import { DocIndexClient, inProcessDocIndexTransport, type DocIndexTransport } from '../../server/sources/doc-index-client';
import type { DocIndexResponse } from '../../server/sources/doc-index-protocol';

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
const roots: string[] = [];
const clients: DocIndexClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
async function diskIndex(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'diclient-'));
  roots.push(root);
  const p = join(root, 'doc-index.sqlite');
  (await buildIndex(CHUNKS, fakeEmbedder, { dbPath: p })).close();
  return p;
}

describe('DocIndexClient over the in-process transport (the vitest-reachable path; the worker path is proven by scripts/doc-index-worker-smoke.ts)', () => {
  it('start() does no index work synchronously; ready resolves after exactly one handled message', async () => {
    const p = await diskIndex();
    const t = inProcessDocIndexTransport();
    const c = DocIndexClient.start(p, t);
    clients.push(c);
    expect(t.handled).toBe(0); // counted, not timed (memory: no-wallclock-assertions-in-tests)
    expect(c.info).toBeNull();
    const info = await c.ready;
    expect(t.handled).toBe(1);
    expect(info.chunkCount).toBe(3);
    expect(info.docs.map((d) => d.name)).toEqual(['REDACTED-659 Lease.pdf', 'Roof Warranty.pdf', 'Rent Schedule.pdf']);
    expect(c.builtAt).toBe(info.builtAt);
  });

  it('knn resolves the nearest chunk', async () => {
    const p = await diskIndex();
    const c = DocIndexClient.start(p, inProcessDocIndexTransport());
    clients.push(c);
    const [qv] = await fakeEmbedder(['renewal']);
    const rows = await c.knn(qv!, 3);
    expect(rows[0]!.chunk.docId).toBe('REDACTED-659');
  });

  it('a load failure rejects ready and every later knn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'diclient-missing-'));
    roots.push(root);
    const c = DocIndexClient.start(join(root, 'nope.sqlite'), inProcessDocIndexTransport());
    clients.push(c);
    await expect(c.ready).rejects.toThrow(/doc index load failed/);
    await expect(c.knn(new Float32Array([1, 0, 0]), 3)).rejects.toThrow(/doc index load failed/);
  });

  it('`opened` is not terminal: a load-error after opened still rejects ready', async () => {
    let onMsg: ((m: DocIndexResponse) => void) | null = null;
    const t: DocIndexTransport = {
      send: (msg) => {
        if (msg.type === 'load') {
          setImmediate(() => {
            onMsg?.({ type: 'opened', builtAt: '2026-01-01T00:00:00Z' });
            onMsg?.({ type: 'load-error', message: 'no such table: chunk_meta' });
          });
        }
      },
      onMessage: (cb) => {
        onMsg = cb;
      },
      onFailure: () => undefined,
      terminate: async () => undefined,
    };
    const c = DocIndexClient.start('ignored', t);
    clients.push(c);
    await expect(c.ready).rejects.toThrow(/doc index load failed: no such table/);
    expect(c.builtAt).toBe('2026-01-01T00:00:00Z');
    expect(c.info).toBeNull();
  });

  it('a transport failure rejects in-flight queries (a crashed worker never hangs a request)', async () => {
    let onMsg: ((m: DocIndexResponse) => void) | null = null;
    let onFail: ((e: Error) => void) | null = null;
    const t: DocIndexTransport = {
      send: (msg) => {
        if (msg.type === 'load') setImmediate(() => onMsg?.({ type: 'loaded', info: { docs: [], chunkCount: 1, builtAt: 'x', dim: 3 } }));
        // knn: never answered — simulate the worker dying mid-query
        if (msg.type === 'knn') setImmediate(() => onFail?.(new Error('doc-index worker exited (code 1)')));
      },
      onMessage: (cb) => {
        onMsg = cb;
      },
      onFailure: (cb) => {
        onFail = cb;
      },
      terminate: async () => undefined,
    };
    const c = DocIndexClient.start('ignored', t);
    clients.push(c);
    await c.ready;
    await expect(c.knn(new Float32Array([1, 0, 0]), 3)).rejects.toThrow('doc-index worker exited (code 1)');
  });

  it('a hung worker (alive, never answers) rejects knn at the per-request deadline instead of waiting forever', async () => {
    let onMsg: ((m: DocIndexResponse) => void) | null = null;
    const t: DocIndexTransport = {
      send: (msg) => {
        if (msg.type === 'load') setImmediate(() => onMsg?.({ type: 'loaded', info: { docs: [], chunkCount: 1, builtAt: 'x', dim: 3 } }));
        // knn: swallowed — the worker is stuck, not dead, so no 'error'/'exit' ever fires
      },
      onMessage: (cb) => {
        onMsg = cb;
      },
      onFailure: () => undefined,
      terminate: async () => undefined,
    };
    const c = DocIndexClient.start('ignored', t, { knnTimeoutMs: 20 });
    clients.push(c);
    await c.ready;
    await expect(c.knn(new Float32Array([1, 0, 0]), 3)).rejects.toThrow(/doc index query timed out after 20 ms/);
  });

  it('a late answer after the deadline is dropped, and the client still serves later queries', async () => {
    let onMsg: ((m: DocIndexResponse) => void) | null = null;
    const t: DocIndexTransport = {
      send: (msg) => {
        if (msg.type === 'load') setImmediate(() => onMsg?.({ type: 'loaded', info: { docs: [], chunkCount: 1, builtAt: 'x', dim: 3 } }));
        if (msg.type === 'knn' && msg.id === 1) setTimeout(() => onMsg?.({ type: 'knn-result', id: 1, rows: [] }), 60);
        if (msg.type === 'knn' && msg.id === 2) setImmediate(() => onMsg?.({ type: 'knn-result', id: 2, rows: [] }));
      },
      onMessage: (cb) => {
        onMsg = cb;
      },
      onFailure: () => undefined,
      terminate: async () => undefined,
    };
    const c = DocIndexClient.start('ignored', t, { knnTimeoutMs: 20 });
    clients.push(c);
    await c.ready;
    await expect(c.knn(new Float32Array([1, 0, 0]), 3)).rejects.toThrow(/timed out/);
    await expect(c.knn(new Float32Array([1, 0, 0]), 3)).resolves.toEqual([]);
    await new Promise((r) => setTimeout(r, 80)); // the stale id-1 answer arrives and must be ignored without throwing
  });

  it('the normal worker exit after close() is not reported as a failure', async () => {
    let onMsg: ((m: DocIndexResponse) => void) | null = null;
    let onFail: ((e: Error) => void) | null = null;
    const t: DocIndexTransport = {
      send: (msg) => {
        if (msg.type === 'load') setImmediate(() => onMsg?.({ type: 'loaded', info: { docs: [], chunkCount: 1, builtAt: 'x', dim: 3 } }));
        if (msg.type === 'close') setImmediate(() => onFail?.(new Error('doc-index worker exited (code 0)')));
      },
      onMessage: (cb) => {
        onMsg = cb;
      },
      onFailure: (cb) => {
        onFail = cb;
      },
      terminate: async () => undefined,
    };
    const failures: Error[] = [];
    const c = DocIndexClient.start('ignored', t, { onFailure: (e) => failures.push(e) });
    await c.ready;
    await c.close();
    await new Promise((r) => setImmediate(r));
    expect(failures).toEqual([]);
    expect(c.closed).toBe(true);
  });

  it('an unexpected worker exit while open IS reported once', async () => {
    let onMsg: ((m: DocIndexResponse) => void) | null = null;
    let onFail: ((e: Error) => void) | null = null;
    const t: DocIndexTransport = {
      send: (msg) => {
        if (msg.type === 'load') setImmediate(() => onMsg?.({ type: 'loaded', info: { docs: [], chunkCount: 1, builtAt: 'x', dim: 3 } }));
      },
      onMessage: (cb) => {
        onMsg = cb;
      },
      onFailure: (cb) => {
        onFail = cb;
      },
      terminate: async () => undefined,
    };
    const failures: Error[] = [];
    const c = DocIndexClient.start('ignored', t, { onFailure: (e) => failures.push(e) });
    clients.push(c);
    await c.ready;
    const fire = onFail as ((e: Error) => void) | null; // TS narrows the closure-assigned let to never
    fire?.(new Error('doc-index worker exited (code 1)'));
    fire?.(new Error('doc-index worker exited (code 1)')); // 'error' then 'exit' both fire on a crash
    expect(failures.map((e) => e.message)).toEqual(['doc-index worker exited (code 1)']);
    await expect(c.knn(new Float32Array([1, 0, 0]), 3)).rejects.toThrow(/exited \(code 1\)/);
  });
});
