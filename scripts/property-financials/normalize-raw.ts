// scripts/property-financials/normalize-raw.ts — raw P&L records -> monthly-long.csv (plan T9a, step 2).
//
//   npx tsx scripts/property-financials/normalize-raw.ts [--in <raw.json>] [--out <dir>] [--no-annual]
//
// --in     path to the raw records JSON ({ records: [[entity, period, layout, section, group, account,
//          amount, isTotal], ...] }); default: $PF_RAW_RECORDS. READ-ONLY — never written.
// --out    output directory (default scripts/property-financials/_out, gitignored). Writes
//          monthly-long.csv + normalize-report.json. Never writes into data/property-financials/.
// --no-annual  skip appending config/annual-statements.csv (the hand-normalised QuickBooks rows).
//
// Exit codes: 0 built (the diff summary against the committed CSV is informational); 2 unmapped
// accounts (report printed, nothing written); 1 any other error.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseMonthlyLong } from '../../src/analytics/property-financials/aggregate';
import { normalizeRecords, parseRawRecords, renderMonthlyLongCsv, sortMonthlyLongRows, UnmappedAccountsError } from '../../src/analytics/property-financials/normalize';
import { COMMITTED_CSV, CONFIG_DIR, DEFAULT_OUT_DIR, ensureOutDir, loadConfig, parseArgs, summarizeTextDiff, writeText } from './lib/io';

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const rawPath = typeof args.in === 'string' ? args.in : process.env.PF_RAW_RECORDS;
  if (!rawPath) {
    console.error('normalize-raw: pass --in <raw.json> or set PF_RAW_RECORDS');
    return 1;
  }
  if (!existsSync(rawPath)) {
    console.error(`normalize-raw: raw records file not found: ${rawPath}`);
    return 1;
  }
  const config = loadConfig({ mappingVersion: typeof args.mapping === 'string' ? args.mapping : undefined });
  const kinds = Object.fromEntries(config.registry.entities.map((e) => [e.id, e.kind]));
  const raw = parseRawRecords(JSON.parse(readFileSync(rawPath, 'utf8')));
  console.log(`normalize-raw: ${raw.length} raw records from ${rawPath}; mapping ${config.mapping.version} (${config.mappingFile})`);

  let result;
  try {
    result = normalizeRecords(raw, config.mapping, kinds);
  } catch (e) {
    if (e instanceof UnmappedAccountsError) {
      console.error(`normalize-raw: FAILED — ${e.message}`);
      console.error('Add a rule for each account to the mapping config (next version) and re-run. Nothing was written.');
      return 2;
    }
    throw e;
  }

  let rows = result.rows;
  const annualPath = resolve(CONFIG_DIR, 'annual-statements.csv');
  if (args['no-annual'] !== true && existsSync(annualPath)) {
    const annual = parseMonthlyLong(readFileSync(annualPath, 'utf8'));
    for (const r of annual) {
      if (!(r.entity in kinds)) throw new Error(`annual-statements.csv entity "${r.entity}" is not in the entity registry`);
      if (kinds[r.entity] !== 'annual') throw new Error(`annual-statements.csv entity "${r.entity}" is not kind=annual in the registry`);
    }
    // An annual entity whose QuickBooks statements were PARSED (parse-sources.ts, T9b) is already in
    // the raw records; the hand-normalised rows are only the fallback for entities that are not.
    const parsedAnnual = new Set(rows.map((r) => r.entity).filter((e) => kinds[e] === 'annual'));
    const fallback = annual.filter((r) => !parsedAnnual.has(r.entity));
    rows = [...rows, ...fallback];
    for (const e of [...parsedAnnual].sort()) console.log(`normalize-raw: ${e} came from parsed QuickBooks statements; its annual-statements.csv rows were not appended`);
    if (fallback.length > 0) console.log(`normalize-raw: appended ${fallback.length} hand-normalised annual-statement rows from ${annualPath}`);
  }
  const sorted = sortMonthlyLongRows(rows, kinds);
  const csv = renderMonthlyLongCsv(sorted);

  const outDir = ensureOutDir(typeof args.out === 'string' ? args.out : DEFAULT_OUT_DIR);
  const csvPath = resolve(outDir, 'monthly-long.csv');
  writeText(csvPath, csv);
  const report = {
    generated_from: rawPath,
    mapping_version: config.mapping.version,
    raw_records: raw.length,
    skipped_totals: result.skippedTotals,
    merged_duplicates: result.mergedDuplicates,
    rows_written: sorted.length,
    excluded_entities: result.excludedEntities,
    excluded_by_rule: result.excludedByRule,
    rule_counts: result.ruleCounts,
    rules_never_hit: config.mapping.rules.map((r) => r.id).filter((id) => !(id in result.ruleCounts) && !(id in result.excludedByRule)),
  };
  writeText(resolve(outDir, 'normalize-report.json'), `${JSON.stringify(report, null, 2)}\n`);

  console.log(`normalize-raw: wrote ${sorted.length} rows -> ${csvPath}`);
  console.log(`  totals skipped ${result.skippedTotals} · duplicates merged ${result.mergedDuplicates} · rules never hit ${report.rules_never_hit.length}`);
  for (const x of result.excludedEntities) console.log(`  EXCLUDED ENTITY ${x.entity} (${x.rows} rows; pattern /${x.pattern}/i): ${x.reason}`);
  console.log(summarizeTextDiff(csv, COMMITTED_CSV, 'monthly-long.csv'));
  console.log('Promotion is manual: review the diff, then copy _out/monthly-long.csv over data/property-financials/monthly-long.csv and run the reconcile tests.');
  return 0;
}

process.exitCode = main();
