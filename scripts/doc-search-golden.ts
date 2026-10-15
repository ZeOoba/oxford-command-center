import { readFileSync } from 'node:fs';
import { loadEnvFile } from '../server/load-env';

// `--env <path>` / `--index <path>` come before anything reads the environment; documents.ts reads its
// settings lazily (inside functions), so ES-import hoisting is harmless here.
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
};
const envPath = arg('--env');
if (envPath) loadEnvFile(envPath);
loadEnvFile();
process.env.DOC_INDEX_WORKER = '0'; // in-process transport: no worker thread needed for a one-shot script
if (arg('--index')) process.env.DOC_INDEX_PATH = arg('--index');

import { DocIndexClient, inProcessDocIndexTransport } from '../server/sources/doc-index-client';
import { docIndexPath, realEmbedder, searchDocuments, shapeHits } from '../server/sources/documents';

/**
 * Golden-query regression check for document search, against the LIVE on-disk index. Not part of
 * `npm run gate` (it needs the real index and the embedding model).
 *
 *   npx tsx scripts/doc-search-golden.ts [--env <path-to-.env>] [--index <doc-index.sqlite>] [--top 8]
 *
 * For each question in scripts/doc-search-golden.json it reports where the expected document first appears
 * (a case-insensitive substring of the path) under (a) the OLD behavior — plain vector top-5 — and (b) the
 * current `searchDocuments` pipeline (wide pool + entity-scoped pool + fusion). Exit 1 if the current
 * pipeline misses any question within the top N. Caveat: all but the first expectation are derived from file
 * names (so they exercise the path boost); only the REDACTED-659 case is a pure content check.
 */
interface Golden { query: string; expect: string; note?: string }

async function main(): Promise<void> {
  const top = Number(arg('--top')) || 8;
  const golden = JSON.parse(readFileSync(new URL('./doc-search-golden.json', import.meta.url), 'utf8')) as Golden[];
  const client = DocIndexClient.start(docIndexPath(), inProcessDocIndexTransport());
  await client.ready;
  const rankOf = (docs: string[], expect: string): number => {
    const i = docs.findIndex((d) => d.toLowerCase().includes(expect.toLowerCase()));
    return i === -1 ? -1 : i + 1;
  };
  let failures = 0;
  console.log(`index ${docIndexPath()} | top ${top}\n`);
  for (const g of golden) {
    const [qv] = await realEmbedder([g.query]);
    const oldHits = shapeHits(await client.knn(qv!, top), g.query); // the OLD behavior is plain vector search
    const newHits = await searchDocuments(g.query, top);
    const oldRank5 = rankOf(oldHits.slice(0, 5).map((h) => h.doc), g.expect); // what the agent used to see
    const oldRankN = rankOf(oldHits.map((h) => h.doc), g.expect); // same width as the new run (a fair comparison)
    const newRank = rankOf(newHits.map((h) => h.doc), g.expect);
    // A draft ranked ABOVE the expected document is a failure at any position, not only at #1.
    const draftAhead = newRank !== -1 && newHits.slice(0, newRank - 1).some((h) => h.draft === true);
    const ok = newRank !== -1 && !draftAhead;
    if (!ok) failures += 1;
    const fmt = (r: number): string => (r === -1 ? 'miss' : `#${r}`);
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  old top-5: ${fmt(oldRank5)}  old top-${top}: ${fmt(oldRankN)}  new top-${top}: ${newRank === -1 ? 'MISS' : '#' + newRank}${draftAhead ? ' (DRAFT ahead)' : ''}  | ${g.query}`,
    );
  }
  await client.close();
  console.log(`\n${golden.length - failures}/${golden.length} found by the current pipeline`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
