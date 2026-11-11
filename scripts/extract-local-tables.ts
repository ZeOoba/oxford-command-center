// scripts/extract-local-tables.ts
//
// One-time rebuild of the gitignored operator tables under config/local/ from a commit that still
// tracked them (ruling 2026-11-10: real firm data is never tracked). Before that change the AR seed
// mappings were an inline CONFIRMED table in scripts/seed-ar-mappings.ts and the doc-search golden
// was scripts/doc-search-golden.json; both now live in config/local/. Run on a checkout that holds
// real data, right after pulling the untrack change, naming the pre-pull commit:
//
//   npx tsx scripts/extract-local-tables.ts ORIG_HEAD
//
// Never overwrites an existing file. See docs/ops/2026-11-11-real-data-untrack-pull-runbook.md.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

export function extractLocalTables(root: string, ref: string, log: (l: string) => void = console.log): string[] {
  const out: Array<[string, () => string]> = [
    ['config/local/ar-seed-mappings.json', () => JSON.stringify(parseConfirmedTable(show(root, ref, 'scripts/seed-ar-mappings.ts')), null, 2) + '\n'],
    ['config/local/doc-search-golden.json', () => {
      const raw = show(root, ref, 'scripts/doc-search-golden.json');
      JSON.parse(raw); // must be valid JSON before it is written
      return raw;
    }],
  ];
  const written: string[] = [];
  for (const [rel, body] of out) {
    const target = join(root, rel);
    if (existsSync(target)) {
      log(`[extract-local-tables] ${rel} already exists -- left untouched`);
      continue;
    }
    const text = body();
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
  try {
    extractLocalTables(process.cwd(), ref);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
