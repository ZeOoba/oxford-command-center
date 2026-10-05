// scripts/property-financials/build-dataset.ts — monthly-long.csv + config -> dataset.json (plan T9a, step 4).
//
//   npx tsx scripts/property-financials/build-dataset.ts [--csv <monthly-long.csv>] [--out <dir>] [--generated YYYY-MM-DD]
//
// --csv        input CSV (default data/property-financials/monthly-long.csv; pass _out/monthly-long.csv
//              to build from a fresh normalisation).
// --out        output directory (default scripts/property-financials/_out, gitignored). Writes
//              dataset.json. Never writes into data/property-financials/.
// --generated  override meta.generated (default: the value in config/curated/meta.json, so builds are
//              deterministic; pass today's date when promoting a refresh).
//
// The built dataset is validated through the strict contract before it is written; a contract
// refusal (e.g. an entity the architect-owned constants do not yet admit) exits 3 with the issue list.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parsePropertyFinancialsDataset } from '../../src/contracts/property-financials';
import { parseMonthlyLong } from '../../src/analytics/property-financials/aggregate';
import { buildDataset } from '../../src/analytics/property-financials/build-dataset';
import { COMMITTED_CSV, COMMITTED_DATASET, DEFAULT_OUT_DIR, ensureOutDir, loadConfig, parseArgs, summarizeJsonDiff, writeText } from './lib/io';

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const csvPath = resolve(typeof args.csv === 'string' ? args.csv : COMMITTED_CSV);
  const config = loadConfig({
    mappingVersion: typeof args.mapping === 'string' ? args.mapping : undefined,
    derivationVersion: typeof args.derivation === 'string' ? args.derivation : undefined,
  });
  const curated = typeof args.generated === 'string' ? { ...config.curated, meta: { ...config.curated.meta, generated: args.generated } } : config.curated;
  const rows = parseMonthlyLong(readFileSync(csvPath, 'utf8'));
  console.log(`build-dataset: ${rows.length} rows from ${csvPath}; as_of ${curated.meta.as_of}; mapping ${config.mapping.version}; derivation ${config.derivation.version}`);

  const built = buildDataset({ rows, registry: config.registry, curated, derivation: config.derivation, categories: config.mapping.categories });
  const json = `${JSON.stringify(built, null, 1)}\n`;
  try {
    parsePropertyFinancialsDataset(JSON.parse(json));
  } catch (e) {
    console.error(`build-dataset: built dataset FAILS the contract — ${(e as Error).message}`);
    console.error('Nothing was written. A new entity or a rolled year needs the contract constants updated (architect-owned src/contracts/property-financials.ts).');
    return 3;
  }

  const outDir = ensureOutDir(typeof args.out === 'string' ? args.out : DEFAULT_OUT_DIR);
  const outPath = resolve(outDir, 'dataset.json');
  writeText(outPath, json);
  console.log(`build-dataset: wrote ${outPath} (${json.length.toLocaleString('en-US')} bytes); contract OK`);
  console.log(summarizeJsonDiff(built, COMMITTED_DATASET, 'dataset.json'));
  console.log('Promotion is manual: review the diff, then copy _out/dataset.json over data/property-financials/dataset.json and run the property-financials tests.');
  return 0;
}

process.exitCode = main();
