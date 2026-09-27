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
  // The .ts entry relies on tsx execArgv inheritance (dev:server / dev:server:once / tsx watch); a compiled
  // or plain-`node` start cannot resolve it — run with DOC_INDEX_WORKER=0 there (in-process rollback path).
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

type Pending = { resolve: (rows: KnnRow[]) => void; reject: (err: Error) => void; timer: NodeJS.Timeout };

/** Per-query deadline. No HTTP route in server/index.ts bounds a request, so this is the only thing that
 *  stops a hung (alive but silent) worker from pinning /api/documents/search forever; a dead worker is
 *  caught earlier by onFailure. A real 50k-chunk knn returns in tens of ms — 30 s is a generous ceiling. */
export const DOC_INDEX_KNN_TIMEOUT_MS = 30_000;

export interface DocIndexClientOptions {
  knnTimeoutMs?: number;
  /** Called once on an UNEXPECTED transport failure (worker crash/exit while open). The exit that
   *  follows close() is normal and is never reported here. */
  onFailure?: (err: Error) => void;
}

export class DocIndexClient {
  readonly ready: Promise<DocIndexInfo>;
  private readonly transport: DocIndexTransport;
  private readonly knnTimeoutMs: number;
  private readonly onUnexpectedFailure: ((err: Error) => void) | undefined;
  private builtAtValue: string | null = null;
  private infoValue: DocIndexInfo | null = null;
  private failure: Error | null = null;
  private closedValue = false;
  private rejectReady: ((err: Error) => void) | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  private constructor(transport: DocIndexTransport, dbPath: string, opts: DocIndexClientOptions) {
    this.transport = transport;
    this.knnTimeoutMs = opts.knnTimeoutMs ?? DOC_INDEX_KNN_TIMEOUT_MS;
    this.onUnexpectedFailure = opts.onFailure;
    let resolveReady: ((info: DocIndexInfo) => void) | null = null;
    this.ready = new Promise<DocIndexInfo>((resolve, reject) => {
      resolveReady = resolve;
      this.rejectReady = reject;
    });
    const rejectReady = (err: Error): void => this.rejectReady?.(err);
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
      // After close() the worker's 'exit' is the expected teardown, not a failure — stay silent.
      if (this.closedValue) return;
      const first = this.failure === null;
      this.fail(err);
      rejectReady?.(err);
      if (first) this.onUnexpectedFailure?.(err); // a crash fires 'error' AND 'exit' — report once
    });
    transport.send({ type: 'load', dbPath });
  }

  static start(dbPath: string, transport: DocIndexTransport = workerTransport(), opts: DocIndexClientOptions = {}): DocIndexClient {
    return new DocIndexClient(transport, dbPath, opts);
  }

  /** True once close() was called: later transport failures are teardown noise, not errors. */
  get closed(): boolean {
    return this.closedValue;
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
    if (this.closedValue) throw new Error('doc index client is closed');
    const id = this.nextId++;
    return new Promise<KnnRow[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        // A late answer for this id is dropped by settle() (no pending entry) — the client stays usable.
        this.settle(id, (p) => p.reject(new Error(`doc index query timed out after ${this.knnTimeoutMs} ms (worker unresponsive)`)));
      }, this.knnTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send({ type: 'knn', id, vector, limit });
    });
  }

  async close(): Promise<void> {
    if (this.closedValue) return;
    this.closedValue = true;
    const err = new Error('doc index client closed');
    this.fail(err);
    this.rejectReady?.(err); // a close() during a cold load must not leave `ready` pending forever
    this.transport.send({ type: 'close' });
    await this.transport.terminate();
  }

  private settle(id: number, fn: (p: Pending) => void): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    fn(p);
  }

  private fail(err: Error): void {
    this.failure ??= err;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
