// scripts/lease-market.ts
//
// Lease Market Intelligence CLI (spec §3).
//   tsx scripts/lease-market.ts ingest [--dir <path>]          ingest every CoStar listings export in the intake folder, oldest first
//   tsx scripts/lease-market.ts compute [--as-of YYYY-MM-DD]   recompute signals + market-rent feed
// Exit 1 when any file fails to ingest or compute throws; 2 on bad usage.
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { openWarehouse } from '../server/warehouse/db';
import { referenceDate } from '../server/config';
import { loadCostarHeaderMap, loadLeaseMarketConfig } from '../server/warehouse/lease-market/config';
import { ingestCostarListingsFile, parseListingFileName } from '../server/warehouse/lease-market/ingest';
import { screenOwners } from '../server/warehouse/lease-market/owner-screen';
import { runCompute } from '../server/warehouse/lease-market/compute';

const DB_PATH = process.env.WAREHOUSE_DB ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite');
const RAW_DIR = join(process.cwd(), 'data', 'lease-market', 'raw');
const DEFAULT_INTAKE =
  process.env.LEASE_MARKET_INTAKE ?? join(homedir(), 'OneDrive - Oxford Capital Partners', 'Claude_Workspace', 'lease-market-intake', 'costar');

export function listIntakeFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => ['.xlsx', '.csv'].includes(extname(f).toLowerCase()) && !f.startsWith('~$'))
    .map((f) => ({ f, date: parseListingFileName(f)?.exportDate ?? statSync(join(dir, f)).mtime.toISOString().slice(0, 10) }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.f.localeCompare(b.f))
    .map((x) => x.f);
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function ingest(): Promise<number> {
  const dir = argValue('--dir') ?? DEFAULT_INTAKE;
  const config = loadLeaseMarketConfig();
  const headerMap = loadCostarHeaderMap();
  const files = listIntakeFiles(dir);
  const db = openWarehouse(DB_PATH);
  let failures = 0;
  try {
    for (const f of files) {
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
    }
  } finally {
    db.close();
  }
  console.log(`${files.length} file(s), ${failures} failed.`);
  return failures > 0 ? 1 : 0;
}

function compute(): number {
  const config = loadLeaseMarketConfig();
  const db = openWarehouse(DB_PATH);
  try {
    const r = runCompute(db, config, argValue('--as-of') ?? referenceDate());
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
  const cmd = process.argv[2];
  if (cmd === 'ingest') process.exitCode = await ingest();
  else if (cmd === 'compute') process.exitCode = compute();
  else {
    console.error('usage: tsx scripts/lease-market.ts <ingest [--dir <path>] | compute [--as-of YYYY-MM-DD]>');
    process.exitCode = 2;
  }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('lease-market.ts')) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  });
}
