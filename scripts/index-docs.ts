import { loadEnvFile } from '../server/load-env';
loadEnvFile(); // DOCUMENTS_DIR / DOCUMENTS_PATH_INCLUDE / caps from .env

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  collectDocChunks,
  writeChunkPlan,
  embedMissing,
  indexCounts,
  realEmbedder,
  docIndexPath,
  reindexSafetyError,
} from '../server/sources/documents';

/**
 * Offline document indexer — RESUMABLE & crash-safe.
 *
 * Phase A (first invocation, or with --replan): list → extract → chunk the corpus and persist every
 * chunk's metadata to the on-disk sqlite-vec DB at docIndexPath() (no vectors yet — cheap, text only).
 * Phase B (every invocation): embed up to DOCUMENTS_EMBED_LIMIT not-yet-embedded chunks in batches,
 * committing each batch and marking it done.
 *
 * Because the embedder's native working set grows over thousands of chunks and can OOM a memory-
 * limited box, run this in a LOOP of fresh processes so memory is fully released between slices:
 *
 *   while npm run index:docs; [ $? -eq 3 ]; do :; done     # bash: rc 3 = more remain, rc 0 = done
 *
 * Each run exits 0 when the index is complete, or 3 when chunks still remain (re-run to continue).
 */
const BATCH = Number(process.env.DOCUMENTS_EMBED_BATCH) || 48;
const LIMIT = Number(process.env.DOCUMENTS_EMBED_LIMIT) || 1000; // chunks embedded per process slice

async function main(): Promise<void> {
  const dir = process.env.DOCUMENTS_DIR;
  if (!dir) {
    console.error('✗ DOCUMENTS_DIR is not set (.env). Nothing to index.');
    process.exit(1);
  }
  // Fail-closed: never sweep a broad/confidential corpus without the allowlist + exclude configured.
  const guardError = reindexSafetyError();
  if (guardError) {
    console.error(`✗ Reindex blocked (fail-closed confidentiality guard): ${guardError}`);
    process.exit(2);
  }
  if (process.env.DOCUMENTS_ALLOW_UNSCOPED === '1') {
    console.warn('⚠ DOCUMENTS_ALLOW_UNSCOPED=1 — confidentiality scoping guard explicitly overridden.');
  }
  const out = docIndexPath();
  mkdirSync(dirname(out), { recursive: true });

  const replan = process.argv.includes('--replan');
  const planExists = existsSync(out) && !replan && indexCounts(out).planned > 0;

  if (!planExists) {
    console.log(`→ Corpus: ${dir}`);
    if (process.env.DOCUMENTS_PATH_INCLUDE) console.log(`  include: /${process.env.DOCUMENTS_PATH_INCLUDE}/i`);
    console.log('→ Planning: listing + extracting + chunking (reads every PDF once)…');
    const t0 = Date.now();
    const { chunks, docs, truncated } = await collectDocChunks();
    if (truncated) console.warn('  ⚠ file cap reached — raise DOCUMENTS_MAX_FILES if documents are missing.');
    console.log(`  ${docs.length} documents → ${chunks.length} chunks in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (!chunks.length) {
      console.error('✗ No chunks produced — check DOCUMENTS_DIR / DOCUMENTS_PATH_INCLUDE.');
      process.exit(1);
    }
    // Probe the embedder once to learn the true vector dim before creating the vec table.
    const [probe] = await realEmbedder(['dimension probe']);
    const dim = probe?.length ?? 384;
    writeChunkPlan(out, chunks, dim);
    console.log(`✓ Plan written: ${out} (${chunks.length} chunks, ${dim}-dim)`);
  }

  const before = indexCounts(out);
  console.log(`→ Embedding slice (limit ${LIMIT}, batch ${BATCH}) — ${before.embedded}/${before.planned} done, ${before.remaining} remaining`);
  const t1 = Date.now();
  let lastLogged = before.embedded;
  const { embedded, remaining } = await embedMissing(out, realEmbedder, {
    batchSize: BATCH,
    limit: LIMIT,
    onProgress: (done, total) => {
      if (done - lastLogged >= BATCH * 5 || done === total) {
        lastLogged = done;
        const pct = Math.round((100 * done) / total);
        const rate = (done - before.embedded) / Math.max(1, (Date.now() - t1) / 1000);
        console.log(`  embedded ${done}/${total} (${pct}%) · ${rate.toFixed(0)} chunks/s`);
      }
    },
  });
  const secs = ((Date.now() - t1) / 1000).toFixed(0);

  if (remaining > 0) {
    console.log(`◐ Slice done: +${embedded} this run, ${remaining} remaining (${secs}s). Re-run to continue.`);
    process.exit(3); // signal the driver loop: more work remains
  }
  console.log(`✓ Index complete: ${out} — all ${before.planned} chunks embedded (+${embedded} this run, ${secs}s).`);
}

void main();
