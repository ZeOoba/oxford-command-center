// scripts/property-financials/parse-sources.ts — statement files -> raw records (plan T9b, step 1).
//
//   npx tsx scripts/property-financials/parse-sources.ts [--source <dir>] [--converted <dir>] [--out <dir>] [--mapping vN]
//
// --source     the OneDrive statement folder (default: $PF_SOURCE_DIR, then config/sources.json's
//              sourceDirDefault). READ-ONLY — nothing is ever written there.
// --converted  directory of .xls -> .xlsx conversions named "<folder leaf>__<basename>.xlsx"
//              (default: $PF_CONVERTED_DIR; produced by convert-xls.ps1). Without it every binary
//              .xls is reported as unreadable (exit 4) — see README "Binary .xls exports".
// --out        output directory (default scripts/property-financials/_out, gitignored). Writes
//              raw-records.json ({ records: [[entity, period, layout, section, group, account,
//              amount, isTotal], ...] } — the exact input of normalize-raw.ts), parse-report.json
//              (coverage, unreadable / unsupported / excluded files, duplicates, cross-check) and
//              crosscheck-records.json (the annual statements of monthly entities; never in the CSV).
//
// Exit codes: 0 every file read and parsed; 4 one or more files unreadable / unsupported (outputs
// ARE written — the report names each file — but a dataset built from them is incomplete);
// 1 any other error (a parse failure names file › sheet › row and nothing is written).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RawRecord } from '../../src/analytics/property-financials/normalize';
import { normalizeRecords, UnmappedAccountsError } from '../../src/analytics/property-financials/normalize';
import { parseMonthlyLong, type MonthlyLongRow } from '../../src/analytics/property-financials/aggregate';
import { COMMITTED_CSV, CONFIG_DIR, DEFAULT_OUT_DIR, ensureOutDir, loadConfig, parseArgs, readJson, writeText } from './lib/io';
import { collectSourceRecords, parseSourcesConfig, resolveConvertedDir, resolveSourceDir, type CollectedSources } from './lib/sources';

function toTuple(r: RawRecord): [string, string, string, string | null, string | null, string, number, 0 | 1] {
  return [r.entity, r.period, r.layout, r.section, r.group, r.account, r.amount, r.isTotal ? 1 : 0];
}

interface CrossCheckLine {
  readonly entity: string;
  readonly period: string;
  readonly monthsCompared: string;
  readonly byLineType: Record<string, { statement: number; monthly: number; delta: number }>;
}

/** Annual statement (normalised) vs the committed CSV's monthly rows for the same calendar window, per line type. */
function crossCheck(got: CollectedSources, mappingVersion: string, kinds: Record<string, 'monthly' | 'annual'>): { lines: CrossCheckLine[]; unmapped: string | null } {
  const config = loadConfig({ mappingVersion });
  let xrows: MonthlyLongRow[];
  try {
    xrows = normalizeRecords(got.crosscheck, config.mapping, kinds).rows;
  } catch (e) {
    if (e instanceof UnmappedAccountsError) return { lines: [], unmapped: e.message };
    throw e;
  }
  const csv = parseMonthlyLong(readFileSync(COMMITTED_CSV, 'utf8'));
  const sum = (rs: readonly MonthlyLongRow[], pred: (r: MonthlyLongRow) => boolean, lt: string): number =>
    rs.filter((r) => pred(r) && r.line_type === lt).reduce((a, r) => a + r.amount_usd, 0);
  const periods = [...new Set(xrows.map((r) => `${r.entity}\u0001${r.period}`))].sort();
  const lines: CrossCheckLine[] = [];
  for (const key of periods) {
    const [entity, period] = key.split('\u0001') as [string, string];
    const year = period.slice(0, 4);
    const thru = /thru (\d{4}-\d{2})/.exec(period)?.[1] ?? `${year}-12`;
    const inWindow = (r: MonthlyLongRow) => r.entity === entity && r.period >= `${year}-01` && r.period <= thru;
    const statement = (r: MonthlyLongRow) => r.entity === entity && r.period === period;
    const byLineType: CrossCheckLine['byLineType'] = {};
    for (const lt of ['rev', 'opex', 'capex', 'dist', 'debt', 'nonop', 'inctax', 'noncash']) {
      const a = Math.round(sum(xrows, statement, lt) * 100) / 100;
      const b = Math.round(sum(csv, inWindow, lt) * 100) / 100;
      if (a !== 0 || b !== 0) byLineType[lt] = { statement: a, monthly: b, delta: Math.round((a - b) * 100) / 100 };
    }
    lines.push({ entity, period, monthsCompared: `${year}-01..${thru}`, byLineType });
  }
  return { lines, unmapped: null };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = parseSourcesConfig(readJson(resolve(CONFIG_DIR, 'sources.json')));
  const sourceDir = resolveSourceDir(cfg, typeof args.source === 'string' ? args.source : undefined);
  const convertedDir = resolveConvertedDir(cfg, typeof args.converted === 'string' ? args.converted : undefined);
  const config = loadConfig({ mappingVersion: typeof args.mapping === 'string' ? args.mapping : undefined });
  const kinds = Object.fromEntries(config.registry.entities.map((e) => [e.id, e.kind]));
  console.log(`parse-sources: reading ${sourceDir}${convertedDir ? ` (converted .xls from ${convertedDir})` : ' (no --converted dir: binary .xls will be reported as unreadable)'}`);

  const got = await collectSourceRecords(cfg, { sourceDir, convertedDir, mapping: config.mapping, registry: config.registry });
  const rep = got.report;
  console.log(`parse-sources: ${rep.files.length} statement file(s) parsed -> ${got.dataset.length} dataset records, ${got.crosscheck.length} cross-check records`);
  for (const c of rep.coverage) console.log(`  ${c.role === 'dataset' ? 'DATASET   ' : 'CROSSCHECK'} ${c.entity.padEnd(24)} ${c.files} file(s) · ${c.periods.length} period(s) ${c.periods[0] ?? ''}${c.periods.length > 1 ? ` .. ${c.periods[c.periods.length - 1]}` : ''}`);
  for (const x of rep.excluded) console.log(`  EXCLUDED    ${x.file} — entity "${x.entity}" matches /${x.pattern}/i: ${x.reason}`);
  for (const x of rep.unsupported) console.log(`  UNSUPPORTED ${x.file} — ${x.reason}`);
  for (const x of rep.unreadable) console.log(`  UNREADABLE  ${x.file} — ${x.reason}`);
  for (const d of rep.duplicatePeriods) console.log(`  DUPLICATE   ${d} (identical records, kept once)`);
  const empty = rep.files.filter((f) => f.emptyReason !== null);
  for (const f of empty) console.log(`  EMPTY       ${f.file} — ${f.emptyReason} (${f.periods[0]}..${f.periods[f.periods.length - 1]})`);
  const ignoredHeaders = [...new Set(rep.files.flatMap((f) => f.ignoredHeaders))];
  if (ignoredHeaders.length) console.log(`  note: CF headers not promoted to a group (mixed case): ${ignoredHeaders.join(' | ')}`);
  const unmatchedTotals = rep.files.reduce((a, f) => a + f.unmatchedTotals.length, 0);
  if (unmatchedTotals > 0) {
    const labels = [...new Set(rep.files.flatMap((f) => f.unmatchedTotals))];
    console.log(`  note: ${unmatchedTotals} CF TOTAL line(s) name no opened group and were not verified: ${labels.join(' | ')}`);
  }

  const xc = crossCheck(got, config.mapping.version, kinds);
  if (xc.unmapped) console.log(`parse-sources: cross-check records have unmapped accounts (the dataset records are unaffected):\n${xc.unmapped}`);
  for (const l of xc.lines) {
    const cells = Object.entries(l.byLineType).map(([lt, v]) => `${lt} ${v.statement.toFixed(0)}${v.delta === 0 ? '' : ` (monthly ${v.monthly.toFixed(0)}, Δ ${v.delta.toFixed(0)})`}`);
    console.log(`  XCHECK ${l.entity} ${l.period} vs CSV ${l.monthsCompared}: ${cells.join(' · ')}`);
  }

  const outDir = ensureOutDir(typeof args.out === 'string' ? args.out : DEFAULT_OUT_DIR);
  writeText(resolve(outDir, 'raw-records.json'), `${JSON.stringify({ records: got.dataset.map(toTuple) })}\n`);
  writeText(resolve(outDir, 'crosscheck-records.json'), `${JSON.stringify({ records: got.crosscheck.map(toTuple) })}\n`);
  writeText(resolve(outDir, 'parse-report.json'), `${JSON.stringify({ ...rep, unmatchedTotals, mappingVersion: config.mapping.version, crossCheck: xc.lines, crossCheckUnmapped: xc.unmapped }, null, 2)}\n`);
  console.log(`parse-sources: wrote ${resolve(outDir, 'raw-records.json')} (+ parse-report.json, crosscheck-records.json)`);
  console.log('Next: npx tsx scripts/property-financials/normalize-raw.ts --in scripts/property-financials/_out/raw-records.json');
  if (rep.unreadable.length > 0 || rep.unsupported.length > 0) {
    console.error(`parse-sources: ${rep.unreadable.length} unreadable + ${rep.unsupported.length} unsupported file(s) — the raw records are INCOMPLETE until each is converted or ruled out (see parse-report.json).`);
    return 4;
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(`parse-sources: FAILED — ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  },
);
