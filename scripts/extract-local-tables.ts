// scripts/extract-local-tables.ts
//
// One-time rebuild of the gitignored operator tables under config/local/ from a commit that still
// tracked them (ruling 2026-11-10: real firm data is never tracked). Before that change the AR seed
// mappings were an inline CONFIRMED table in scripts/seed-ar-mappings.ts, the doc-search golden was
// scripts/doc-search-golden.json, the lease-term roster was LEASE_TERM_SEEDS in
// server/warehouse/lease-terms.ts and the PCA overlay tables were exports of
// src/modules/property-condition/pca-overlay.ts; all four now live in config/local/. Run on a checkout that holds
// real data, right after pulling the untrack change, naming the pre-pull commit:
//
//   npx tsx scripts/extract-local-tables.ts ORIG_HEAD
//
// Never overwrites an existing file. See docs/ops/2026-11-11-real-data-untrack-pull-runbook.md.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ArSeedTable {
  confirmed: Array<{ name: string; leaseId: string; why: string }>;
}

/** Parse the inline `CONFIRMED` table (an array of [name, leaseId, why] string-literal tuples) out of
 *  the pre-change seed-ar-mappings.ts source. Throws when the table cannot be found or a row is not
 *  three plain string literals: a partial table must never be written. */
export function parseConfirmedTable(source: string): ArSeedTable {
  const start = source.indexOf('const CONFIRMED');
  if (start < 0) throw new Error('extract-local-tables: no `const CONFIRMED` table in the source');
  const open = source.indexOf('= [', start);
  const close = source.indexOf('\n];', open);
  if (open < 0 || close < 0) throw new Error('extract-local-tables: CONFIRMED table is not a `= [ ... ];` literal');
  const body = source
    .slice(open + 3, close)
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
  const str = String.raw`'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"`;
  const row = new RegExp(String.raw`\[\s*(${str})\s*,\s*(${str})\s*,\s*(${str})\s*,?\s*\]`, 'g');
  const lit = (s: string): string => (s.startsWith('"') ? (JSON.parse(s) as string) : (JSON.parse('"' + s.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"') + '"') as string));
  const confirmed: ArSeedTable['confirmed'] = [];
  for (const m of body.matchAll(row)) confirmed.push({ name: lit(m[1]!), leaseId: lit(m[2]!), why: lit(m[3]!) });
  const opened = (body.match(/\[/g) ?? []).length;
  if (confirmed.length === 0 || opened !== confirmed.length) {
    throw new Error(`extract-local-tables: parsed ${confirmed.length} of ${opened} CONFIRMED row(s) -- refusing to write a partial table`);
  }
  return { confirmed };
}

function show(root: string, ref: string, path: string): string {
  return execFileSync('git', ['show', `${ref}:${path}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Import a module as it was at `ref`: its source is written beside the current file (so relative
 *  imports resolve), imported, then moved out to the OS temp dir. */
async function importFromRef(root: string, ref: string, path: string): Promise<Record<string, unknown>> {
  const tmp = join(root, dirname(path), `.extract-${process.pid}-${basename(path)}`);
  writeFileSync(tmp, show(root, ref, path));
  try {
    return (await import(pathToFileURL(tmp).href)) as Record<string, unknown>;
  } finally {
    renameSync(tmp, join(tmpdir(), `occ-extract-${process.pid}-${Date.now()}-${basename(path)}`));
  }
}

export async function extractLocalTables(root: string, ref: string, log: (l: string) => void = console.log): Promise<string[]> {
  const out: Array<[string, () => string | Promise<string>]> = [
    ['config/local/ar-seed-mappings.json', () => JSON.stringify(parseConfirmedTable(show(root, ref, 'scripts/seed-ar-mappings.ts')), null, 2) + '\n'],
    ['config/local/doc-search-golden.json', () => {
      const raw = show(root, ref, 'scripts/doc-search-golden.json');
      JSON.parse(raw); // must be valid JSON before it is written
      return raw;
    }],
    ['config/local/lease-term-seeds.json', async () => {
      const m = await importFromRef(root, ref, 'server/warehouse/lease-terms.ts');
      if (!Array.isArray(m['LEASE_TERM_SEEDS'])) throw new Error(`extract-local-tables: no LEASE_TERM_SEEDS array in server/warehouse/lease-terms.ts at ${ref}`);
      return JSON.stringify(m['LEASE_TERM_SEEDS'], null, 2) + '\n';
    }],
    ['config/local/pca-overlay.json', async () => {
      const m = await importFromRef(root, ref, 'src/modules/property-condition/pca-overlay.ts');
      const t = { overlay: m['PCA_OVERLAY'], infoLaneDetail: m['INFO_LANE_DETAIL'], extraAssetFacts: m['EXTRA_ASSET_FACTS'], issues: m['PCA_ISSUES'] };
      for (const [k, v] of Object.entries(t)) if (v == null) throw new Error(`extract-local-tables: pca-overlay.ts at ${ref} has no ${k} export`);
      return JSON.stringify(t, null, 2) + '\n';
    }],
  ];
  const written: string[] = [];
  for (const [rel, body] of out) {
    const target = join(root, rel);
    if (existsSync(target)) {
      log(`[extract-local-tables] ${rel} already exists -- left untouched`);
      continue;
    }
    const text = await body();
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    written.push(rel);
    log(`[extract-local-tables] wrote ${rel} from ${ref}`);
  }
  return written;
}

if (process.argv[1] && /extract-local-tables\.ts$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const ref = process.argv[2];
  if (!ref) {
    console.error('usage: npx tsx scripts/extract-local-tables.ts <pre-pull ref, e.g. ORIG_HEAD>');
    process.exit(2);
  }
  extractLocalTables(process.cwd(), ref).catch((e: unknown) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
