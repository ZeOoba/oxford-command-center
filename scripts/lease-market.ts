// scripts/lease-market.ts
//
// Lease Market Intelligence CLI (spec §3; fix round 1).
//   tsx scripts/lease-market.ts ingest [--dir <path>]          ingest every CoStar listings export in the intake folder, oldest first
//   tsx scripts/lease-market.ts compute [--as-of YYYY-MM-DD]   recompute signals + market-rent feed
// Exit 1 when any file fails to ingest or compute throws; 2 on bad usage.
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openWarehouse } from '../server/warehouse/db';
import { referenceDate } from '../server/config';
import { loadCostarHeaderMap, loadLeaseMarketConfig } from '../server/warehouse/lease-market/config';
import { ingestCostarListingsFile, localDateString, parseListingFileName } from '../server/warehouse/lease-market/ingest';
import { CostarParseError } from '../server/warehouse/lease-market/costar-parse';
import { screenOwners } from '../server/warehouse/lease-market/owner-screen';
import { runCompute } from '../server/warehouse/lease-market/compute';

// Repo-relative defaults are resolved from THIS FILE's location, never process.cwd() — the CLI
// must behave identically regardless of which directory it was launched from.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const DB_PATH = process.env.WAREHOUSE_DB ?? join(REPO_ROOT, 'data', 'warehouse', 'finance.sqlite');
const RAW_DIR = join(REPO_ROOT, 'data', 'lease-market', 'raw');
const DEFAULT_INTAKE =
  process.env.LEASE_MARKET_INTAKE ?? join(homedir(), 'OneDrive - Oxford Capital Partners', 'Claude_Workspace', 'lease-market-intake', 'costar');

const USAGE = 'usage: tsx scripts/lease-market.ts <ingest [--dir <path>] | compute [--as-of YYYY-MM-DD]>';

// Plain code-point comparison — never localeCompare, which is locale/case-sensitivity dependent
// and would reorder exports non-deterministically across machines.
function codePointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function listIntakeFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => ['.xlsx', '.csv'].includes(extname(f).toLowerCase()) && !f.startsWith('~$'))
    .map((f) => ({ f, date: parseListingFileName(f)?.exportDate ?? localDateString(statSync(join(dir, f)).mtime) }))
    .sort((a, b) => codePointCompare(a.date, b.date) || codePointCompare(a.f, b.f))
    .map((x) => x.f);
}

// A real calendar date, not just digits matching YYYY-MM-DD (rejects e.g. 2026-02-30).
// Mirrors ingest.ts's own isValidIsoDate; kept local rather than exported/shared since ingest.ts
// is a shared, concurrently-edited file and only its localDateString export was authorized here.
function isValidIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export type CliArgs =
  | { command: 'ingest'; dir: string | undefined }
  | { command: 'compute'; asOf: string | undefined }
  | { command: 'invalid'; message: string };

/**
 * Strict pure argument parser — no I/O, no process.exit. `argv` is `process.argv.slice(2)`. Walks
 * every token after the command ONE AT A TIME; each command accepts only its own flag (`ingest`
 * accepts `--dir`, `compute` accepts `--as-of`), in either `--flag value` or `--flag=value` form.
 * `invalid` (never a silent fallback, e.g. to DEFAULT_INTAKE) on: an unknown token, a stray
 * positional, the other command's flag, a repeated flag, an empty `--flag=` value, or a flag
 * immediately followed by another `--token` instead of a value.
 */
export function parseArgs(argv: string[]): CliArgs {
  const [command, ...rest] = argv;
  if (command !== 'ingest' && command !== 'compute') {
    return { command: 'invalid', message: USAGE };
  }

  const flagName = command === 'ingest' ? '--dir' : '--as-of';
  const flagEq = `${flagName}=`;
  let value: string | undefined;
  let i = 0;
  while (i < rest.length) {
    const token = rest[i]!;
    if (token === flagName) {
      if (value !== undefined) return { command: 'invalid', message: USAGE }; // repeated flag
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) return { command: 'invalid', message: USAGE };
      value = next;
      i += 2;
      continue;
    }
    if (token.startsWith(flagEq)) {
      if (value !== undefined) return { command: 'invalid', message: USAGE }; // repeated flag
      const v = token.slice(flagEq.length);
      if (v === '') return { command: 'invalid', message: USAGE }; // empty --flag= value
      value = v;
      i += 1;
      continue;
    }
    // Unknown token: a stray positional, the other command's flag, or a misspelled flag.
    return { command: 'invalid', message: USAGE };
  }

  if (command === 'compute' && value !== undefined && !isValidIsoDate(value)) {
    return { command: 'invalid', message: USAGE };
  }

  return command === 'ingest' ? { command: 'ingest', dir: value } : { command: 'compute', asOf: value };
}

export async function ingest(dir: string): Promise<number> {
  const config = loadLeaseMarketConfig();
  const headerMap = loadCostarHeaderMap();
  const files = listIntakeFiles(dir);
  const db = openWarehouse(DB_PATH);
  let failures = 0;
  let attempted = 0;
  try {
    for (const f of files) {
      attempted++;
      try {
        const r = await ingestCostarListingsFile(db, join(dir, f), {
          config,
          headerMap,
          rawDir: RAW_DIR,
          now: () => new Date().toISOString(),
          screen: (names) => screenOwners(names, config.ownerScreenModulePath),
        });
        if (r.status === 'failed') failures++;
        const events = JSON.stringify(Object.fromEntries(Object.entries(r.events).filter(([, n]) => n > 0)));
        console.log(
          `${r.status.padEnd(9)} ${f} market=${r.marketId ?? '?'} ${r.completeness ?? '-'} +${r.insertedSpaces} ~${r.updatedSpaces} props+${r.newProperties} skip=${r.skipped} missing=${r.markedMissing} removed=${r.markedRemoved} events=${events}` +
            (r.partialReason ? ` | partial: ${r.partialReason}` : '') +
            (r.error ? ` | ERROR: ${r.error}` : ''),
        );
      } catch (e) {
        // A thrown (not caught-and-reported) ingest failure is unexpected — stop the loop rather
        // than risk ingesting later files out of order against a landing history that skipped one.
        failures++;
        const message = e instanceof Error ? e.message : String(e);
        // CostarParseError is an expected, already-descriptive failure mode -- no stack needed.
        // Anything else is unexpected, so append the stack for debuggability.
        const stack = !(e instanceof CostarParseError) && e instanceof Error && e.stack ? `\n${e.stack}` : '';
        console.error(`failed ${f} | ERROR: ${message}${stack}`);
        break;
      }
    }
  } finally {
    db.close();
  }
  const notAttempted = files.length - attempted;
  console.log(`${files.length} file(s), ${failures} failed${notAttempted > 0 ? `, ${notAttempted} not attempted` : ''}.`);
  return failures > 0 ? 1 : 0;
}

function compute(asOf: string): number {
  const config = loadLeaseMarketConfig();
  const db = openWarehouse(DB_PATH);
  try {
    const r = runCompute(db, config, asOf);
    console.log(
      `signals=${r.signals} ${JSON.stringify(r.byKind)} radar=${r.radarCandidates} feed=${r.feedRows}` +
        (r.withheldMarkets.length ? ` | candidates withheld: ${r.withheldMarkets.join(', ')}` : ''),
    );
    return 0;
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.command === 'invalid') {
    console.error(parsed.message);
    process.exitCode = 2;
    return;
  }
  if (parsed.command === 'ingest') {
    process.exitCode = await ingest(parsed.dir ?? DEFAULT_INTAKE);
  } else {
    process.exitCode = compute(parsed.asOf ?? referenceDate());
  }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('lease-market.ts')) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  });
}
