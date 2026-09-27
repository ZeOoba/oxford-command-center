// server/sources/doc-index-worker.ts — worker-thread entry for the document index (item 11, 2026-09-24).
// Spawned by workerTransport() (doc-index-client.ts). Owns the sqlite-vec handle for the process lifetime
// so no synchronous index I/O ever runs on the HTTP server's event loop. This entry is the ONLY message
// producer on the worker side: the core handler's switch has no default, so an unknown request type is
// silently ignored here rather than answered.
import { parentPort } from 'node:worker_threads';
import { createDocIndexHandler } from './doc-index-core';
import type { DocIndexRequest } from './doc-index-protocol';

const port = parentPort;
if (!port) throw new Error('doc-index-worker.ts must run as a worker thread (see doc-index-client.ts)');
const handler = createDocIndexHandler();
port.on('message', (msg: DocIndexRequest) => {
  handler.handle(msg, (res) => port.postMessage(res));
  if (msg.type === 'close') port.close();
});
