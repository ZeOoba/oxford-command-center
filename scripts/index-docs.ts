import { loadEnvFile } from '../server/load-env';
loadEnvFile(); // DOCUMENTS_DIR / DOCUMENTS_PATH_INCLUDE / caps from .env

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { collectDocChunks, buildIndex, realEmbedder, docIndexPath } from '../server/sources/documents';

/**
 * Offline document indexer. Lists → extracts → chunks the configured corpus, then embeds in batches
 * straight to the on-disk sqlite-vec DB at docIndexPath(). Batching + per-batch insert + event-loop
 * yields keep peak memory flat, so this completes on the memory-limited workstation where an
 * all-at-once in-process build OOM-crashes. Run with: `npm run index:docs`.
 */
const BATCH = Number(process.env.DOCUMENTS_EMBED_BATCH) || 48;

async function main(): Promise<void> {
  const dir = process.env.DOCUMENTS_DIR;
  if (!dir) {
    console.error('✗ DOCUMENTS_DIR is not set (.env). Nothing to index.');
    process.exit(1);
  }
  const out = docIndexPath();
  mkdirSync(dirname(out), { recursive: true });
  for (const suffix of ['', '-shm', '-wal']) {
    if (existsSync(out + suffix)) rmSync(out + suffix); // fresh rebuild (vec0 has no simple upsert)
  }

  console.log(`→ Corpus: ${dir}`);
  if (process.env.DOCUMENTS_PATH_INCLUDE) console.log(`  include: /${process.env.DOCUMENTS_PATH_INCLUDE}/i`);
  console.log('→ Listing + extracting + chunking (this reads every PDF once)…');
  const t0 = Date.now();
  const { chunks, docs, truncated } = await collectDocChunks();
  if (truncated) console.warn('  ⚠ file cap reached — raise DOCUMENTS_MAX_FILES if documents are missing.');
  console.log(`  ${docs.length} documents → ${chunks.length} chunks in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (!chunks.length) {
    console.error('✗ No chunks produced — check DOCUMENTS_DIR / DOCUMENTS_PATH_INCLUDE.');
    process.exit(1);
  }

  console.log(`→ Embedding in batches of ${BATCH} → ${out}`);
  const t1 = Date.now();
  let lastLogged = 0;
  const index = await buildIndex(chunks, realEmbedder, {
    dbPath: out,
    batchSize: BATCH,
    onProgress: (done, total) => {
      if (done - lastLogged >= BATCH * 10 || done === total) {
        lastLogged = done;
        const pct = Math.round((100 * done) / total);
        const rate = done / Math.max(1, (Date.now() - t1) / 1000);
        console.log(`  embedded ${done}/${total} (${pct}%) · ${rate.toFixed(0)} chunks/s`);
      }
    },
  });
  index.close();
  console.log(`✓ Index written: ${out} (${chunks.length} chunks, ${((Date.now() - t1) / 1000).toFixed(0)}s)`);
}

void main();
