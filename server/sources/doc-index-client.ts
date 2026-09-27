// server/sources/doc-index-client.ts
//
// Main-thread side of the document index (item 11, 2026-09-24). DocIndexClient speaks the doc-index
// protocol over a transport: workerTransport() (default — a worker thread owns the sqlite-vec handle, so
// a cold ~179 MB load never blocks /api/health) or inProcessDocIndexTransport() (DOC_INDEX_WORKER=0
// rollback switch, and the vitest path — vitest's fork workers cannot load a .ts Worker entry). The
// in-process transport runs the SAME handler on the main thread, deferred by setImmediate: behaviourally
// the pre-2026-09-24 path (it blocks the loop while it works), kept deliberately as the escape hatch.
import { Worker } from 'node:worker_threads';
import { createDocIndexHandler } from './doc-index-core';
import type { DocIndexInfo, DocIndexRequest, DocIndexResponse, KnnRow } from './doc-index-protocol';

export interface DocIndexTransport {
  send(msg: DocIndexRequest): void;
  onMessage(cb: (msg: DocIndexResponse) => void): void;
  /** A worker 'error' or 'exit' — every in-flight and future query must reject, never hang. */
  onFailure(cb: (err: Error) => void): void;
  terminate(): Promise<void>;
}

export function workerTransport(): DocIndexTransport {
  // Under tsx the worker inherits the parent's execArgv (tsx's loader), so a .ts entry resolves.
  const w = new Worker(new URL('./doc-index-worker.ts', import.meta.url));
  return {
    send: (msg) => w.postMessage(msg),
    onMessage: (cb) => {
      w.on('message', cb);
    },
    onFailure: (cb) => {
      w.on('error', cb);
      w.on('exit', (code) => cb(new Error(`doc-index worker exited (code ${code})`)));
    },
    terminate: async () => {
      await w.terminate();
    },
  };
}

export function inProcessDocIndexTransport(): DocIndexTransport & { readonly handled: number } {
  const handler = createDocIndexHandler();
  let onMsg: ((m: DocIndexResponse) => void) | null = null;
  let onFail: ((e: Error) => void) | null = null;
  let handled = 0;
  return {
    get handled() {
      return handled;
    },
    send(msg) {
      setImmediate(() => {
        handled += 1;
        handler.handle(msg, (res) => onMsg?.(res));
      });
    },
    onMessage(cb) {
      onMsg = cb;
    },
    onFailure(cb) {
      onFail = cb;
    },
    async terminate() {
      handler.close(); // synchronous: the file handle is released before this call returns
      onFail?.(new Error('doc-index transport terminated'));
    },
  };
}

type Pending = { resolve: (rows: KnnRow[]) => void; reject: (err: Error) => void };

export class DocIndexClient {
  readonly ready: Promise<DocIndexInfo>;
  private readonly transport: DocIndexTransport;
  private builtAtValue: string | null = null;
  private infoValue: DocIndexInfo | null = null;
  private failure: Error | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  private constructor(transport: DocIndexTransport, dbPath: string) {
    this.transport = transport;
    let resolveReady: ((info: DocIndexInfo) => void) | null = null;
    let rejectReady: ((err: Error) => void) | null = null;
    this.ready = new Promise<DocIndexInfo>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Callers await `ready`; this only stops an early failure being reported as unhandled before one attaches.
    this.ready.catch(() => undefined);
    transport.onMessage((m) => {
      switch (m.type) {
        case 'opened':
          // Not terminal: the worker may still emit `load-error` (readIndexInfo failure after open).
          this.builtAtValue = m.builtAt || null;
          break;
        case 'loaded':
          this.infoValue = m.info;
          this.builtAtValue = m.info.builtAt || null;
          resolveReady?.(m.info);
          break;
        case 'load-error': {
          const err = new Error(`doc index load failed: ${m.message}`);
          this.fail(err);
          rejectReady?.(err);
          break;
        }
        case 'knn-result':
          this.settle(m.id, (p) => p.resolve(m.rows));
          break;
        case 'knn-error':
          this.settle(m.id, (p) => p.reject(new Error(m.message)));
          break;
      }
    });
    transport.onFailure((err) => {
      this.fail(err);
      rejectReady?.(err);
    });
    transport.send({ type: 'load', dbPath });
  }

  static start(dbPath: string, transport: DocIndexTransport = workerTransport()): DocIndexClient {
    return new DocIndexClient(transport, dbPath);
  }

  /** Build time as soon as the worker has opened the file (before the chunk-count scan finishes). */
  get builtAt(): string | null {
    return this.builtAtValue;
  }

  get info(): DocIndexInfo | null {
    return this.infoValue;
  }

  async knn(vector: Float32Array, limit: number): Promise<KnnRow[]> {
    await this.ready;
    if (this.failure) throw this.failure;
    const id = this.nextId++;
    return new Promise<KnnRow[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport.send({ type: 'knn', id, vector, limit });
    });
  }

  async close(): Promise<void> {
    this.transport.send({ type: 'close' });
    await this.transport.terminate();
  }

  private settle(id: number, fn: (p: Pending) => void): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    fn(p);
  }

  private fail(err: Error): void {
    this.failure ??= err;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
