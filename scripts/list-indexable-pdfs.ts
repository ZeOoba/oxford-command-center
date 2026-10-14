import { loadEnvFile } from '../server/load-env';

// `--env <path>` loads that .env (a worktree has no .env of its own; point at the main checkout's).
// NOTE: ES module imports are hoisted, so `documents.ts` is loaded BEFORE this runs. That is safe only
// because documents.ts reads every DOCUMENTS_* setting lazily, inside functions (its size cap is a
// function for exactly this reason). Do not add an import-time read of the environment to documents.ts.
const envArg = process.argv.indexOf('--env');
if (envArg !== -1 && process.argv[envArg + 1]) loadEnvFile(process.argv[envArg + 1]);
loadEnvFile(); // this worktree's own .env, if any (fills only missing/empty keys)

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { listIndexablePdfs, listIndexableFiles, ocrCacheDir, reindexSafetyError } from '../server/sources/documents';

/**
 * OCR manifest — the in-scope PDF list `scripts/ocr-scanned-pdfs.py` works from.
 *
 *   npx tsx scripts/list-indexable-pdfs.ts --out <manifest.json> [--env <path-to-.env>]
 *
 * WHY this is a TS script and not a Python directory walk: the OCR step must read EXACTLY what the
 * indexer may read (same DOCUMENTS_EXCLUDE / DOCUMENTS_INCLUDE_DIRS / depth / file cap), or it could OCR
 * and cache paths the indexer is forbidden to ingest. The list therefore comes from the indexer's own
 * `listFiles` via `listIndexablePdfs`, and the cache key is computed here once (`ocrCacheKey`) so the
 * Python side never re-implements it. Applies the same fail-closed confidentiality guard as
 * `npm run index:docs`. Prints counts only — never env values. Read-only against the corpus.
 */
function main(): void {
  const outIdx = process.argv.indexOf('--out');
  const out = outIdx !== -1 ? process.argv[outIdx + 1] : undefined;
  if (!out) {
    console.error('✗ usage: tsx scripts/list-indexable-pdfs.ts --out <manifest.json> [--env <path>]');
    process.exit(1);
  }
  const dir = process.env.DOCUMENTS_DIR;
  if (!dir) {
    console.error('✗ DOCUMENTS_DIR is not set. Nothing to list.');
    process.exit(1);
  }
  const guardError = reindexSafetyError();
  if (guardError) {
    console.error(`✗ Manifest blocked (fail-closed confidentiality guard): ${guardError}`);
    process.exit(2);
  }
  const { truncated } = listIndexableFiles(dir);
  const pdfs = listIndexablePdfs(dir);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify({ generatedAt: new Date().toISOString(), dir, cacheDir: ocrCacheDir(), truncated, pdfs }, null, 0),
    'utf8',
  );
  const cached = pdfs.filter((p) => p.cached).length;
  console.log(`✓ ${pdfs.length} in-scope PDFs (${cached} already OCR-cached) → ${out}`);
  if (truncated) console.warn('  ⚠ file cap reached — the manifest covers only what the indexer would read; raise DOCUMENTS_MAX_FILES.');
}

main();
