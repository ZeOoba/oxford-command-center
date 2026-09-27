// scripts/doc-index-worker-smoke.ts — proves the REAL worker-thread path under tsx and measures the main
// thread's worst stall while the index loads (item 11). Not part of the gate (spawns a thread, touches disk).
//   npx tsx scripts/doc-index-worker-smoke.ts --fixture       # temp 3-chunk index (always available; default)
//   npx tsx scripts/doc-index-worker-smoke.ts <path>          # an explicit real index, opened read-only
// With no arguments the script builds and uses a temp fixture — it never opens the on-disk index implicitly.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { DocIndexClient } from '../server/sources/doc-index-client';
import { buildIndex, type Embedder } from '../server/sources/documents';

const explicit = process.argv.find((a, i) => i >= 2 && !a.startsWith('--'));
const fixture = process.argv.includes('--fixture') || explicit === undefined;
let cleanup: string | null = null;
let path = explicit ?? '';
if (fixture) {
  cleanup = mkdtempSync(join(tmpdir(), 'doc-index-smoke-'));
  path = join(cleanup, 'doc-index.sqlite');
  const embed: Embedder = async (texts) => texts.map((t) => new Float32Array([t.length % 2, 1, 0]));
  (
    await buildIndex(
      [
        { docId: 'a', docName: 'A.pdf', idx: 0, text: 'alpha' },
        { docId: 'b', docName: 'B.pdf', idx: 0, text: 'beta!' },
      ],
      embed,
      { dbPath: path },
    )
  ).close();
}

const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();
const t0 = Date.now();
const client = DocIndexClient.start(path);
try {
  const info = await client.ready;
  lag.disable();
  const rows = await client.knn(new Float32Array(Array.from({ length: info.dim }, (_, i) => (i === 0 ? 1 : 0))), 1);
  console.log(
    JSON.stringify({
      path,
      documents: info.docs.length,
      chunks: info.chunkCount,
      builtAt: info.builtAt,
      firstHit: rows[0]?.chunk.docName ?? null,
      loadMs: Date.now() - t0,
      maxMainThreadStallMs: Math.round(lag.max / 1e6),
    }),
  );
} finally {
  await client.close();
  if (cleanup) rmSync(cleanup, { recursive: true, force: true });
}
